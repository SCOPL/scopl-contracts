// @vitest-environment node

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import solc from "solc";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  http,
  type Abi,
  type Address,
  type Hex
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

interface SolcOutput {
  contracts?: Record<string, Record<string, {
    abi: Abi;
    evm: { bytecode: { object: string } };
  }>>;
  errors?: Array<{ severity: string; formattedMessage: string }>;
}

const MNEMONIC =
  "test test test test test test test test test test test junk";
const chain = defineChain({
  id: 1_337,
  name: "SCOPL contract tests",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1"] } }
});

function compileContracts(): Record<string, Artifact> {
  const sources = {
    "ScoplFeeRouter.sol": {
      content: readFileSync(
        resolve(process.cwd(), "contracts/ScoplFeeRouter.sol"),
        "utf8"
      )
    },
    "ScoplReferralRewards.sol": {
      content: readFileSync(
        resolve(process.cwd(), "contracts/ScoplReferralRewards.sol"),
        "utf8"
      )
    },
    "ScoplFeeRouterMocks.sol": {
      content: readFileSync(
        resolve(process.cwd(), "contracts/test/ScoplFeeRouterMocks.sol"),
        "utf8"
      )
    }
  };
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      outputSelection: {
        "*": { "*": ["abi", "evm.bytecode.object"] }
      }
    }
  }))) as SolcOutput;
  const failures = (output.errors ?? [])
    .filter((error) => error.severity === "error");
  expect(failures.map((error) => error.formattedMessage)).toEqual([]);

  const artifacts: Record<string, Artifact> = {};
  for (const contracts of Object.values(output.contracts ?? {})) {
    for (const [name, contract] of Object.entries(contracts)) {
      artifacts[name] = {
        abi: contract.abi,
        bytecode: `0x${contract.evm.bytecode.object}`
      };
    }
  }
  return artifacts;
}

const artifacts = compileContracts();

describe.sequential("ScoplFeeRouter EVM behavior", () => {
  let anvil: ChildProcess;
  let rpcUrl: string;
  let publicClient: ReturnType<typeof createPublicClient>;
  let wallets: Array<ReturnType<typeof createWalletClient>>;
  let addresses: Address[];
  let contracts: {
    token0: Address;
    token1: Address;
    weth: Address;
    brokenToken: Address;
    gasBombToken: Address;
    v3: Address;
    v4: Address;
    router: Address;
    distributor: Address;
    referralRewards: Address;
  };
  let snapshot: string;

  async function rpc(method: string, params: unknown[] = []) {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params
      })
    });
    const payload = await response.json() as {
      result?: unknown;
      error?: { message: string };
    };
    if (payload.error) throw new Error(payload.error.message);
    return payload.result;
  }

  async function waitForAnvil() {
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        await rpc("eth_chainId");
        return;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
    }
    throw new Error("Anvil did not start");
  }

  async function deploy(
    name: string,
    args: readonly unknown[] = []
  ): Promise<Address> {
    const artifact = artifacts[name];
    const hash = await wallets[0].deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args
    } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error(`${name} deployment failed`);
    return receipt.contractAddress;
  }

  async function write(
    name: string,
    address: Address,
    functionName: string,
    args: readonly unknown[] = [],
    accountIndex = 0,
    value?: bigint
  ) {
    const hash = await wallets[accountIndex].writeContract({
      address,
      abi: artifacts[name].abi,
      functionName,
      args,
      value
    } as never);
    return publicClient.waitForTransactionReceipt({ hash });
  }

  async function read<T>(
    name: string,
    address: Address,
    functionName: string,
    args: readonly unknown[] = []
  ): Promise<T> {
    return publicClient.readContract({
      address,
      abi: artifacts[name].abi,
      functionName,
      args
    }) as Promise<T>;
  }

  async function balance(token: Address, account: Address): Promise<bigint> {
    return read("MockERC20", token, "balanceOf", [account]);
  }

  async function mintAndApproveV3(
    tokenId: bigint,
    liquidity = 100n
  ) {
    await write("MockV3PositionManager", contracts.v3, "mintPosition", [
      tokenId,
      addresses[1],
      contracts.token0,
      contracts.token1,
      liquidity
    ]);
    await write(
      "MockV3PositionManager",
      contracts.v3,
      "approve",
      [contracts.router, tokenId],
      1
    );
  }

  async function mintAndApproveV4(
    tokenId: bigint,
    liquidity = 100n,
    currency0 = contracts.token0,
    currency1 = contracts.token1
  ) {
    await write("MockV4PositionManager", contracts.v4, "mintPosition", [
      tokenId,
      addresses[1],
      currency0,
      currency1,
      liquidity
    ]);
    await write(
      "MockV4PositionManager",
      contracts.v4,
      "approve",
      [contracts.router, tokenId],
      1
    );
  }

  beforeAll(async () => {
    const port = 18_545 + process.pid % 1_000;
    rpcUrl = `http://127.0.0.1:${port}`;
    const executable = resolve(
      process.cwd(),
      "node_modules/@foundry-rs/anvil/bin.mjs"
    );
    anvil = spawn(process.execPath, [
      executable,
      "--port",
      String(port),
      "--chain-id",
      String(chain.id),
      "--mnemonic",
      MNEMONIC,
      "--silent"
    ], {
      stdio: "ignore",
      windowsHide: true
    });
    await waitForAnvil();
    const transport = http(rpcUrl);
    publicClient = createPublicClient({ chain, transport });
    wallets = Array.from({ length: 6 }, (_, index) =>
      createWalletClient({
        account: mnemonicToAccount(MNEMONIC, { addressIndex: index }),
        chain,
        transport
      })
    );
    addresses = wallets.map((wallet) => wallet.account?.address as Address);

    const token0 = await deploy("MockERC20", ["Token Zero", "TK0", 18]);
    const token1 = await deploy("MockERC20", ["Token One", "TK1", 18]);
    const weth = await deploy("MockWETH");
    const brokenToken = await deploy("BrokenBalanceToken");
    const gasBombToken = await deploy("GasBombBalanceToken");
    const v3 = await deploy("MockV3PositionManager");
    const v4 = await deploy("MockV4PositionManager");
    const distributor = await deploy("MockRevenueDistributor", [addresses[2]]);
    const router = await deploy("ScoplFeeRouter", [
      addresses[0],
      distributor,
      v3,
      v4,
      weth
    ]);
    const referralRewards = await deploy("ScoplReferralRewards", [addresses[0]]);
    await write(
      "ScoplReferralRewards",
      referralRewards,
      "setRevenueCreditorAllowed",
      [distributor, true]
    );
    await write(
      "MockRevenueDistributor",
      distributor,
      "setReferralRewards",
      [referralRewards]
    );
    contracts = {
      token0,
      token1,
      weth,
      brokenToken,
      gasBombToken,
      v3,
      v4,
      router,
      distributor,
      referralRewards
    };
    expect(await read<boolean>(
      "ScoplFeeRouter",
      contracts.router,
      "paused"
    )).toBe(false);
    snapshot = await rpc("evm_snapshot") as string;
  }, 60_000);

  beforeEach(async () => {
    await rpc("evm_revert", [snapshot]);
    snapshot = await rpc("evm_snapshot") as string;
  });

  afterAll(() => {
    anvil.kill();
  });

  it("hard-caps protocol fees at 5% and validates contract dependencies", async () => {
    expect(await read<number>(
      "ScoplFeeRouter",
      contracts.router,
      "MAX_FEE_BPS"
    )).toBe(500);

    await expect(write(
      "ScoplFeeRouter",
      contracts.router,
      "setFeeConfiguration",
      [contracts.token0, 501]
    )).rejects.toThrow();
    const maximum = (1n << 256n) - 1n;
    const preview = await read<readonly [bigint, bigint]>(
      "ScoplFeeRouter",
      contracts.router,
      "previewFee",
      [addresses[1], maximum]
    );
    expect(preview[0] + preview[1]).toBe(maximum);
    expect(preview[0]).toBe(
      maximum / 10_000n * 500n + maximum % 10_000n * 500n / 10_000n
    );

    await expect(wallets[0].deployContract({
      abi: artifacts.ScoplFeeRouter.abi,
      bytecode: artifacts.ScoplFeeRouter.bytecode,
      args: [
        addresses[0],
        addresses[2],
        addresses[3],
        contracts.v4,
        contracts.weth
      ]
    } as never)).rejects.toThrow();
  });

  it("protects governance with owner checks and two-step ownership transfer", async () => {
    await expect(write(
      "ScoplFeeRouter",
      contracts.router,
      "setRevenueDistributor",
      [addresses[3]],
      1
    )).rejects.toThrow();
    await write("ScoplFeeRouter", contracts.router, "transferOwnership", [
      addresses[3]
    ]);
    expect(await read<Address>(
      "ScoplFeeRouter",
      contracts.router,
      "owner"
    )).toBe(addresses[0]);
    await expect(write(
      "ScoplFeeRouter",
      contracts.router,
      "acceptOwnership",
      [],
      1
    )).rejects.toThrow();
    await write(
      "ScoplFeeRouter",
      contracts.router,
      "acceptOwnership",
      [],
      3
    );
    expect(await read<Address>(
      "ScoplFeeRouter",
      contracts.router,
      "owner"
    )).toBe(addresses[3]);
  });

  it("charges exactly 5% on the first v3 claim", async () => {
    const tokenId = 1n;
    await write("MockV3PositionManager", contracts.v3, "mintPosition", [
      tokenId,
      addresses[1],
      contracts.token0,
      contracts.token1,
      100n
    ]);
    await write("MockV3PositionManager", contracts.v3, "accrueFees", [
      tokenId,
      80n,
      120n
    ]);
    await write(
      "MockV3PositionManager",
      contracts.v3,
      "approve",
      [contracts.router, tokenId],
      1
    );
    const receipt = await write(
      "ScoplFeeRouter",
      contracts.router,
      "claimV3",
      [tokenId, false],
      1
    );

    expect(await balance(contracts.token0, addresses[1])).toBe(76n);
    expect(await balance(contracts.token1, addresses[1])).toBe(114n);
    expect(await balance(contracts.token0, addresses[2])).toBe(4n);
    expect(await balance(contracts.token1, addresses[2])).toBe(6n);
    expect(await balance(contracts.token0, contracts.router)).toBe(0n);
    const decodedEvents = receipt.logs
      .map((log) => {
        try {
          return decodeEventLog({
            abi: artifacts.ScoplFeeRouter.abi,
            data: log.data,
            topics: log.topics
          });
        } catch {
          return null;
        }
      });
    const claimEvent = decodedEvents
      .find((event) => event?.eventName === "FeesClaimed");
    const feeEvents = decodedEvents
      .filter((event) => event?.eventName === "FeeCharged");
    expect(claimEvent).not.toBeNull();
    expect(feeEvents).toHaveLength(2);
  });

  it("accrues and pays LP-claim referral revenue in the fee token", async () => {
    await write(
      "ScoplReferralRewards",
      contracts.referralRewards,
      "bindReferrer",
      [addresses[3]],
      1
    );
    await mintAndApproveV3(77n);
    await write("MockV3PositionManager", contracts.v3, "accrueFees", [
      77n,
      1_000n,
      0n
    ]);
    await write(
      "ScoplFeeRouter",
      contracts.router,
      "claimV3",
      [77n, false],
      1
    );

    expect(await balance(contracts.token0, addresses[1])).toBe(950n);
    expect(await balance(contracts.token0, addresses[2])).toBe(35n);
    expect(await balance(
      contracts.token0,
      contracts.referralRewards
    )).toBe(15n);
    expect(await read<readonly [bigint, bigint, bigint]>(
      "ScoplReferralRewards",
      contracts.referralRewards,
      "claimable",
      [addresses[3], contracts.token0]
    )).toEqual([15n, 0n, 15n]);

    await write(
      "ScoplReferralRewards",
      contracts.referralRewards,
      "claim",
      [contracts.token0],
      3
    );
    expect(await balance(contracts.token0, addresses[3])).toBe(15n);

  });

  it("can require approved referrers", async () => {
    await write(
      "ScoplReferralRewards",
      contracts.referralRewards,
      "setReferrerApprovalRequired",
      [true]
    );
    await expect(write(
      "ScoplReferralRewards",
      contracts.referralRewards,
      "bindReferrer",
      [addresses[3]],
      4
    )).rejects.toThrow();
    await write(
      "ScoplReferralRewards",
      contracts.referralRewards,
      "setReferrerApprovals",
      [[addresses[3]], true]
    );
    await write(
      "ScoplReferralRewards",
      contracts.referralRewards,
      "bindReferrer",
      [addresses[3]],
      4
    );
    expect(await read<Address>(
      "ScoplReferralRewards",
      contracts.referralRewards,
      "referrerOf",
      [addresses[4]]
    )).toBe(addresses[3]);
  });

  it("falls back to treasury when referral accounting is unavailable", async () => {
    const revertingRewards = await deploy("RevertingReferralRewards");
    await write(
      "MockRevenueDistributor",
      contracts.distributor,
      "setReferralRewards",
      [revertingRewards]
    );
    const tokenId = 13n;
    await mintAndApproveV3(tokenId);
    await write("MockV3PositionManager", contracts.v3, "accrueFees", [
      tokenId,
      100n,
      0n
    ]);

    await write(
      "ScoplFeeRouter",
      contracts.router,
      "claimV3",
      [tokenId, false],
      1
    );
    expect(await balance(contracts.token0, addresses[1])).toBe(95n);
    expect(await balance(contracts.token0, addresses[2])).toBe(5n);
  });

  it("claims mixed v3/v4 fees atomically in one batch", async () => {
    await mintAndApproveV3(101n);
    await mintAndApproveV3(102n);
    await mintAndApproveV4(103n);
    await write("MockV3PositionManager", contracts.v3, "accrueFees", [
      101n,
      100n,
      200n
    ]);
    await write("MockV3PositionManager", contracts.v3, "accrueFees", [
      102n,
      40n,
      60n
    ]);
    await write("MockV4PositionManager", contracts.v4, "accrueFees", [
      103n,
      80n,
      120n
    ]);

    const receipt = await write(
      "ScoplFeeRouter",
      contracts.router,
      "claimAll",
      [
        [101n, 102n],
        [103n],
        BigInt(Math.floor(Date.now() / 1_000) + 3_600),
        false
      ],
      1
    );

    expect(await balance(contracts.token0, addresses[1])).toBe(209n);
    expect(await balance(contracts.token1, addresses[1])).toBe(361n);
    expect(await balance(contracts.token0, addresses[2])).toBe(11n);
    expect(await balance(contracts.token1, addresses[2])).toBe(19n);
    const events = receipt.logs.flatMap((log) => {
      try {
        return [decodeEventLog({
          abi: artifacts.ScoplFeeRouter.abi,
          data: log.data,
          topics: log.topics
        })];
      } catch {
        return [];
      }
    });
    expect(events.filter((event) => event.eventName === "FeesClaimed"))
      .toHaveLength(3);
    expect(events.some((event) => event.eventName === "FeesBatchClaimed"))
      .toBe(true);
  });

  it("charges only accrued fees and returns v3 principal untouched", async () => {
    const tokenId = 2n;
    await mintAndApproveV3(tokenId);
    await write("MockV3PositionManager", contracts.v3, "accrueFees", [
      tokenId,
      100n,
      200n
    ]);
    await write("MockV3PositionManager", contracts.v3, "setPrincipal", [
      tokenId,
      1_000n,
      2_000n
    ]);
    await write(
      "ScoplFeeRouter",
      contracts.router,
      "removeV3",
      [
        tokenId,
        40n,
        400n,
        800n,
        BigInt(Math.floor(Date.now() / 1_000) + 3_600),
        false,
        false
      ],
      1
    );

    expect(await balance(contracts.token0, addresses[1])).toBe(495n);
    expect(await balance(contracts.token1, addresses[1])).toBe(990n);
    expect(await balance(contracts.token0, addresses[2])).toBe(5n);
    expect(await balance(contracts.token1, addresses[2])).toBe(10n);
    const position = await read<readonly unknown[]>(
      "MockV3PositionManager",
      contracts.v3,
      "positions",
      [tokenId]
    );
    expect(position[7]).toBe(60n);
  });

  it("never charges principal already checkpointed in v3 tokensOwed", async () => {
    const tokenId = 12n;
    await mintAndApproveV3(tokenId);
    await write("MockV3PositionManager", contracts.v3, "setPrincipal", [
      tokenId,
      1_000n,
      2_000n
    ]);
    await write("MockV3PositionManager", contracts.v3, "accrueFees", [
      tokenId,
      100n,
      200n
    ]);
    await write(
      "MockV3PositionManager",
      contracts.v3,
      "decreaseLiquidity",
      [{
        tokenId,
        liquidity: 50n,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline: BigInt(Math.floor(Date.now() / 1_000) + 3_600)
      }],
      1
    );

    await write(
      "ScoplFeeRouter",
      contracts.router,
      "claimV3",
      [tokenId, false],
      1
    );
    expect(await balance(contracts.token0, addresses[1])).toBe(600n);
    expect(await balance(contracts.token1, addresses[1])).toBe(1_200n);
    expect(await balance(contracts.token0, addresses[2])).toBe(0n);
    expect(await balance(contracts.token1, addresses[2])).toBe(0n);

    await write("MockV3PositionManager", contracts.v3, "accrueFees", [
      tokenId,
      100n,
      0n
    ]);
    await write(
      "ScoplFeeRouter",
      contracts.router,
      "claimV3",
      [tokenId, false],
      1
    );
    expect(await balance(contracts.token0, addresses[1])).toBe(695n);
    expect(await balance(contracts.token0, addresses[2])).toBe(5n);
  });

  it("rolls back fee collection when principal slippage checks fail", async () => {
    const tokenId = 11n;
    await mintAndApproveV3(tokenId);
    await write("MockV3PositionManager", contracts.v3, "accrueFees", [
      tokenId,
      100n,
      200n
    ]);
    await write("MockV3PositionManager", contracts.v3, "setPrincipal", [
      tokenId,
      1_000n,
      2_000n
    ]);
    await expect(write(
      "ScoplFeeRouter",
      contracts.router,
      "removeV3",
      [
        tokenId,
        50n,
        1_000n,
        2_000n,
        BigInt(Math.floor(Date.now() / 1_000) + 3_600),
        false,
        false
      ],
      1
    )).rejects.toThrow();

    expect(await balance(contracts.token0, addresses[1])).toBe(0n);
    expect(await balance(contracts.token0, addresses[2])).toBe(0n);
    const position = await read<readonly unknown[]>(
      "MockV3PositionManager",
      contracts.v3,
      "positions",
      [tokenId]
    );
    expect(position[7]).toBe(100n);
    await write(
      "ScoplFeeRouter",
      contracts.router,
      "claimV3",
      [tokenId, false],
      1
    );
    expect(await balance(contracts.token0, addresses[1])).toBe(95n);
  });

  it("charges first-use v4 fees and returns full-removal principal", async () => {
    const tokenId = 3n;
    await mintAndApproveV4(tokenId);
    await write("MockV4PositionManager", contracts.v4, "accrueFees", [
      tokenId,
      60n,
      140n
    ]);
    await write("MockV4PositionManager", contracts.v4, "setPrincipal", [
      tokenId,
      600n,
      1_400n
    ]);
    await write(
      "ScoplFeeRouter",
      contracts.router,
      "removeV4",
      [
        tokenId,
        100n,
        600n,
        1_400n,
        BigInt(Math.floor(Date.now() / 1_000) + 3_600),
        false,
        true
      ],
      1
    );

    expect(await balance(contracts.token0, addresses[1])).toBe(657n);
    expect(await balance(contracts.token1, addresses[1])).toBe(1_533n);
    expect(await balance(contracts.token0, addresses[2])).toBe(3n);
    expect(await balance(contracts.token1, addresses[2])).toBe(7n);
    await expect(read<Address>(
      "MockV4PositionManager",
      contracts.v4,
      "ownerOf",
      [tokenId]
    )).rejects.toThrow();
  });

  it("supports v4 native-currency fees without retaining ETH", async () => {
    const tokenId = 4n;
    await mintAndApproveV4(
      tokenId,
      100n,
      "0x0000000000000000000000000000000000000000",
      contracts.token1
    );
    const treasuryBefore = await publicClient.getBalance({
      address: addresses[2]
    });
    await write(
      "MockV4PositionManager",
      contracts.v4,
      "accrueFees",
      [tokenId, 1_000n, 100n],
      0,
      1_000n
    );
    await write(
      "ScoplFeeRouter",
      contracts.router,
      "claimV4",
      [tokenId, BigInt(Math.floor(Date.now() / 1_000) + 3_600), false],
      1
    );

    expect(await publicClient.getBalance({ address: addresses[2] }))
      .toBe(treasuryBefore + 50n);
    expect(await publicClient.getBalance({ address: contracts.router })).toBe(0n);
    expect(await balance(contracts.token1, addresses[2])).toBe(5n);
  });

  it("unwraps WETH for users while keeping the treasury fee in WETH", async () => {
    const tokenId = 12n;
    await write("MockV3PositionManager", contracts.v3, "mintPosition", [
      tokenId,
      addresses[1],
      contracts.weth,
      contracts.token1,
      100n
    ]);
    await write(
      "MockV3PositionManager",
      contracts.v3,
      "approve",
      [contracts.router, tokenId],
      1
    );
    const depositHash = await wallets[0].sendTransaction({
      to: contracts.weth,
      value: 1_000n
    } as never);
    await publicClient.waitForTransactionReceipt({ hash: depositHash });
    await write("MockERC20", contracts.weth, "transfer", [
      contracts.v3,
      1_000n
    ]);
    await write("MockV3PositionManager", contracts.v3, "accrueFees", [
      tokenId,
      1_000n,
      0n
    ]);
    await write(
      "ScoplFeeRouter",
      contracts.router,
      "claimV3",
      [tokenId, true],
      1
    );

    expect(await balance(contracts.weth, addresses[2])).toBe(50n);
    expect(await balance(contracts.weth, addresses[1])).toBe(0n);
    expect(await publicClient.getBalance({ address: contracts.weth })).toBe(50n);
    expect(await publicClient.getBalance({ address: contracts.router })).toBe(0n);
    await expect(wallets[1].sendTransaction({
      to: contracts.router,
      value: 1n
    } as never)).rejects.toThrow();
  });

  it("pauses user actions while leaving recovery explicit and owner-only", async () => {
    const tokenId = 5n;
    await mintAndApproveV3(tokenId);
    await write("MockERC20", contracts.token0, "mint", [
      contracts.router,
      55n
    ]);
    await write("ScoplFeeRouter", contracts.router, "pause");

    await expect(write(
      "ScoplFeeRouter",
      contracts.router,
      "claimV3",
      [tokenId, false],
      1
    )).rejects.toThrow();
    await expect(write(
      "ScoplFeeRouter",
      contracts.router,
      "recoverAsset",
      [contracts.token0, addresses[3], 55n],
      1
    )).rejects.toThrow();
    await write("ScoplFeeRouter", contracts.router, "recoverAsset", [
      contracts.token0,
      addresses[3],
      55n
    ]);
    expect(await balance(contracts.token0, addresses[3])).toBe(55n);

    await write("ScoplFeeRouter", contracts.router, "unpause");
    await write(
      "ScoplFeeRouter",
      contracts.router,
      "claimV3",
      [tokenId, false],
      1
    );
  });

  it("uses the base fee if the future SCOPL token balance check breaks", async () => {
    await write("ScoplFeeRouter", contracts.router, "setFeeConfiguration", [
      contracts.brokenToken,
      500
    ]);
    expect(await read<number>(
      "ScoplFeeRouter",
      contracts.router,
      "feeBpsFor",
      [addresses[1]]
    )).toBe(500);

    await write("ScoplFeeRouter", contracts.router, "setFeeConfiguration", [
      contracts.token0,
      500
    ]);
    await write("ScoplFeeRouter", contracts.router, "setDiscountTier", [
      0,
      1_000n,
      250
    ]);
    await write("MockERC20", contracts.token0, "mint", [
      addresses[1],
      1_000n
    ]);
    expect(await read<number>(
      "ScoplFeeRouter",
      contracts.router,
      "feeBpsFor",
      [addresses[1]]
    )).toBe(250);
  });

  it("applies configurable SCOPL balance tiers below the 5% ceiling", async () => {
    await write("ScoplFeeRouter", contracts.router, "setFeeSchedule", [
      contracts.token0,
      500,
      [100n, 1_000n, 10_000n],
      [400, 250, 0]
    ]);

    await write("MockERC20", contracts.token0, "mint", [addresses[2], 100n]);
    await write("MockERC20", contracts.token0, "mint", [addresses[3], 1_000n]);
    await write("MockERC20", contracts.token0, "mint", [addresses[4], 10_000n]);

    const effectiveFee = (user: Address) => read<number>(
      "ScoplFeeRouter",
      contracts.router,
      "feeBpsFor",
      [user]
    );
    expect(await effectiveFee(addresses[1])).toBe(500);
    expect(await effectiveFee(addresses[2])).toBe(400);
    expect(await effectiveFee(addresses[3])).toBe(250);
    expect(await effectiveFee(addresses[4])).toBe(0);

    await write("ScoplFeeRouter", contracts.router, "setFeeConfiguration", [
      contracts.token0,
      300
    ]);
    expect(await effectiveFee(addresses[1])).toBe(300);
    expect(await effectiveFee(addresses[2])).toBe(300);
    expect(await effectiveFee(addresses[3])).toBe(250);
    expect(await effectiveFee(addresses[4])).toBe(0);

    await expect(write(
      "ScoplFeeRouter",
      contracts.router,
      "setDiscountTier",
      [0, 100n, 301]
    )).rejects.toThrow();
  });

  it("uses one production LP-claim tier: 1,000 SCOPL unlocks free claims", async () => {
    await write("ScoplFeeRouter", contracts.router, "setFeeSchedule", [
      contracts.token0,
      500,
      [1_000n, 0n, 0n],
      [0, 0, 0]
    ]);
    await write("MockERC20", contracts.token0, "mint", [addresses[2], 999n]);
    await write("MockERC20", contracts.token0, "mint", [addresses[3], 1_000n]);

    expect(await read<number>(
      "ScoplFeeRouter",
      contracts.router,
      "feeBpsFor",
      [addresses[2]]
    )).toBe(500);
    expect(await read<number>(
      "ScoplFeeRouter",
      contracts.router,
      "feeBpsFor",
      [addresses[3]]
    )).toBe(0);
    expect(await read<readonly [bigint, number]>(
      "ScoplFeeRouter",
      contracts.router,
      "discountTiers",
      [1n]
    )).toEqual([0n, 0]);
  });

  it("sets fee schedules atomically and rejects ambiguous tier ordering", async () => {
    await write("ScoplFeeRouter", contracts.router, "setFeeSchedule", [
      contracts.token0,
      450,
      [100n, 1_000n, 0n],
      [300, 100, 0]
    ]);
    expect(await read<number>(
      "ScoplFeeRouter",
      contracts.router,
      "baseFeeBps"
    )).toBe(450);
    expect(await read<readonly [bigint, number]>(
      "ScoplFeeRouter",
      contracts.router,
      "discountTiers",
      [1n]
    )).toEqual([1_000n, 100]);

    await expect(write(
      "ScoplFeeRouter",
      contracts.router,
      "setFeeSchedule",
      [contracts.token0, 500, [1_000n, 100n, 0n], [400, 300, 0]]
    )).rejects.toThrow();
    await expect(write(
      "ScoplFeeRouter",
      contracts.router,
      "setFeeSchedule",
      [contracts.token0, 500, [100n, 0n, 1_000n], [400, 0, 200]]
    )).rejects.toThrow();
    await expect(write(
      "ScoplFeeRouter",
      contracts.router,
      "setFeeSchedule",
      [contracts.token0, 500, [100n, 1_000n, 0n], [300, 400, 0]]
    )).rejects.toThrow();
  });

  it("falls back to the base fee when the SCOPL balance call exhausts its gas", async () => {
    await write("ScoplFeeRouter", contracts.router, "setFeeConfiguration", [
      contracts.gasBombToken,
      375
    ]);
    expect(await read<number>(
      "ScoplFeeRouter",
      contracts.router,
      "feeBpsFor",
      [addresses[1]]
    )).toBe(375);
  });

  it("snapshots one discount rate before either pool token is paid", async () => {
    const tokenId = 11n;
    await write("ScoplFeeRouter", contracts.router, "setFeeSchedule", [
      contracts.token0,
      500,
      [90n, 0n, 0n],
      [0, 0, 0]
    ]);
    await mintAndApproveV3(tokenId);
    await write("MockV3PositionManager", contracts.v3, "accrueFees", [
      tokenId,
      100n,
      100n
    ]);

    await write(
      "ScoplFeeRouter",
      contracts.router,
      "claimV3",
      [tokenId, false],
      1
    );

    expect(await balance(contracts.token0, addresses[2])).toBe(5n);
    expect(await balance(contracts.token1, addresses[2])).toBe(5n);
    expect(await balance(contracts.token0, addresses[1])).toBe(95n);
    expect(await balance(contracts.token1, addresses[1])).toBe(95n);
    expect(await read<number>(
      "ScoplFeeRouter",
      contracts.router,
      "feeBpsFor",
      [addresses[1]]
    )).toBe(0);
  });

  it("uses current liquidity while enforcing current NFT ownership", async () => {
    const tokenId = 6n;
    await mintAndApproveV3(tokenId);
    await write("MockV3PositionManager", contracts.v3, "forceLiquidity", [
      tokenId,
      99n
    ]);
    await write("MockV3PositionManager", contracts.v3, "accrueFees", [
      tokenId,
      100n,
      0n
    ]);
    await write(
      "ScoplFeeRouter",
      contracts.router,
      "claimV3",
      [tokenId, false],
      1
    );
    expect(await balance(contracts.token0, addresses[1])).toBe(95n);

    const nextTokenId = 7n;
    await mintAndApproveV3(nextTokenId);
    await write("MockV3PositionManager", contracts.v3, "accrueFees", [
      nextTokenId,
      100n,
      0n
    ]);
    await write(
      "MockV3PositionManager",
      contracts.v3,
      "transferPosition",
      [nextTokenId, addresses[3]],
      1
    );
    await expect(write(
      "ScoplFeeRouter",
      contracts.router,
      "claimV3",
      [nextTokenId, false],
      1
    )).rejects.toThrow();
    await write(
      "MockV3PositionManager",
      contracts.v3,
      "approve",
      [contracts.router, nextTokenId],
      3
    );
    await write(
      "ScoplFeeRouter",
      contracts.router,
      "claimV3",
      [nextTokenId, false],
      3
    );
    expect(await balance(contracts.token0, addresses[3])).toBe(95n);
  });

  it("rolls back failed payouts and blocks token-callback reentrancy", async () => {
    const tokenId = 8n;
    await mintAndApproveV3(tokenId);
    await write("MockV3PositionManager", contracts.v3, "accrueFees", [
      tokenId,
      100n,
      0n
    ]);
    await write("MockERC20", contracts.token0, "setFailTransfers", [true]);
    await expect(write(
      "ScoplFeeRouter",
      contracts.router,
      "claimV3",
      [tokenId, false],
      1
    )).rejects.toThrow();
    expect(await balance(contracts.token0, addresses[1])).toBe(0n);

    await write("MockERC20", contracts.token0, "setFailTransfers", [false]);
    const callback = encodeFunctionData({
      abi: artifacts.ScoplFeeRouter.abi,
      functionName: "claimV3",
      args: [tokenId, false]
    });
    await write("MockERC20", contracts.token0, "setCallback", [
      contracts.router,
      callback
    ]);
    await write(
      "ScoplFeeRouter",
      contracts.router,
      "claimV3",
      [tokenId, false],
      1
    );
    expect(await read<boolean>(
      "MockERC20",
      contracts.token0,
      "callbackAttempted"
    )).toBe(true);
    expect(await read<boolean>(
      "MockERC20",
      contracts.token0,
      "callbackSucceeded"
    )).toBe(false);
  });

  it("charges against actual receipts for fee-on-transfer pool tokens", async () => {
    const tokenId = 9n;
    await mintAndApproveV3(tokenId);
    await write("MockERC20", contracts.token0, "setTransferFeeBps", [1_000]);
    await write("MockV3PositionManager", contracts.v3, "accrueFees", [
      tokenId,
      100n,
      0n
    ]);
    await write(
      "ScoplFeeRouter",
      contracts.router,
      "claimV3",
      [tokenId, false],
      1
    );

    expect(await balance(contracts.token0, contracts.router)).toBe(0n);
    expect(await balance(contracts.token0, addresses[2])).toBe(4n);
    expect(await balance(contracts.token0, addresses[1])).toBe(78n);
  });

  it("preserves the fee bound and zero router residue across varied claims", async () => {
    const tokenId = 10n;
    await mintAndApproveV3(tokenId);
    let expectedTreasury = 0n;
    let expectedUser = 0n;
    const amounts = [
      0n, 1n, 19n, 20n, 21n, 99n, 100n, 101n, 999n, 10_000n,
      1_000_003n, 4_294_967_291n
    ];
    for (const amount of amounts) {
      await write("MockV3PositionManager", contracts.v3, "accrueFees", [
        tokenId,
        amount,
        0n
      ]);
      await write(
        "ScoplFeeRouter",
        contracts.router,
        "claimV3",
        [tokenId, false],
        1
      );
      const fee = amount * 500n / 10_000n;
      expectedTreasury += fee;
      expectedUser += amount - fee;
    }

    expect(await balance(contracts.token0, addresses[2])).toBe(expectedTreasury);
    expect(await balance(contracts.token0, addresses[1])).toBe(expectedUser);
    expect(await balance(contracts.token0, contracts.router)).toBe(0n);
  }, 30_000);
});
