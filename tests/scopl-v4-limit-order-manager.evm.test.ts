// @vitest-environment node

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import solc from "solc";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbiParameters,
  parseEther,
  type Abi,
  type Address,
  type Hex
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

interface Artifact { abi: Abi; bytecode: Hex }

const MNEMONIC = "test test test test test test test test test test test junk";
const chain = defineChain({
  id: 1_340,
  name: "SCOPL V4 limit order tests",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1"] } }
});
const RESERVE = parseEther("0.001");

function compileContracts(): Record<string, Artifact> {
  const files = [
    "ScoplV4LimitOrderManager.sol",
    "ScoplReferralRewards.sol",
    "test/ScoplV4LimitOrderManagerMocks.sol"
  ];
  const sources = Object.fromEntries(files.map((file) => [file, {
    content: readFileSync(resolve(process.cwd(), "contracts", file), "utf8")
  }]));
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } }
    }
  }))) as {
    contracts?: Record<string, Record<string, {
      abi: Abi;
      evm: { bytecode: { object: string } };
    }>>;
    errors?: Array<{ severity: string; formattedMessage: string }>;
  };
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

describe.sequential("ScoplV4LimitOrderManager EVM behavior", () => {
  let anvil: ChildProcess;
  let rpcUrl: string;
  let publicClient: ReturnType<typeof createPublicClient>;
  let wallets: Array<ReturnType<typeof createWalletClient>>;
  let addresses: Address[];
  let contracts: Record<string, Address>;
  let key: {
    currency0: Address;
    currency1: Address;
    fee: number;
    tickSpacing: number;
    hooks: Address;
  };
  let poolId: Hex;
  let snapshot: string;

  async function rpc(method: string, params: unknown[] = []) {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    const payload = await response.json() as {
      result?: unknown;
      error?: { message: string };
    };
    if (payload.error) throw new Error(payload.error.message);
    return payload.result;
  }

  async function deploy(name: string, args: readonly unknown[] = []) {
    const hash = await wallets[0].deployContract({
      abi: artifacts[name].abi,
      bytecode: artifacts[name].bytecode,
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

  function makePoolId(poolKey: typeof key): Hex {
    return keccak256(encodeAbiParameters(
      parseAbiParameters("(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)"),
      [poolKey]
    ));
  }

  async function approveUser() {
    for (const token of [contracts.token0, contracts.token1]) {
      await write("V4LimitOrderMockERC20", token, "approve", [
        contracts.manager,
        2n ** 256n - 1n
      ], 1);
    }
    await write(
      "V4LimitOrderMockPositionManager",
      contracts.positionManager,
      "setApprovalForAll",
      [contracts.manager, true],
      1
    );
  }

  function createParams(overrides: Record<string, unknown> = {}) {
    return {
      key,
      tokenIn: contracts.token0,
      tokenOut: contracts.token1,
      tickLower: 60,
      tickUpper: 120,
      amountIn: 10_000n,
      amountInMinimum: 9_950n,
      liquidity: 5_000n,
      gasReserve: RESERVE,
      deadline: BigInt(Math.floor(Date.now() / 1_000) + 3_600),
      hookData: "0x",
      integrationId: `0x${"00".repeat(32)}`,
      optionalReferrer: "0x0000000000000000000000000000000000000000",
      tierAttestation: {
        user: "0x0000000000000000000000000000000000000000",
        destinationChainId: 0n,
        beneficiaryShareBps: 0,
        expiry: 0
      },
      tierSignature: "0x",
      ...overrides
    };
  }

  beforeAll(async () => {
    const port = 26_000 + process.pid % 1_000;
    rpcUrl = `http://127.0.0.1:${port}`;
    const executable = resolve(
      process.cwd(),
      "node_modules/@foundry-rs/anvil/bin.mjs"
    );
    anvil = spawn(process.execPath, [
      executable,
      "--port", String(port),
      "--chain-id", String(chain.id),
      "--mnemonic", MNEMONIC,
      "--silent"
    ], { stdio: "ignore", windowsHide: true });
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        await rpc("eth_chainId");
        break;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
    }
    const transport = http(rpcUrl);
    publicClient = createPublicClient({ chain, transport });
    wallets = Array.from({ length: 6 }, (_, index) => createWalletClient({
      account: mnemonicToAccount(MNEMONIC, { addressIndex: index }),
      chain,
      transport
    }));
    addresses = wallets.map((wallet) => wallet.account?.address as Address);

    const first = await deploy("V4LimitOrderMockERC20", ["First", "ONE", 18]);
    const second = await deploy("V4LimitOrderMockERC20", ["Second", "TWO", 18]);
    const [token0, token1] = first.toLowerCase() < second.toLowerCase()
      ? [first, second]
      : [second, first];
    const poolManager = await deploy("V4LimitOrderMockPoolManager");
    const permit2 = await deploy("V4LimitOrderMockPermit2");
    contracts = {
      token0,
      token1,
      weth: await deploy("V4LimitOrderMockWETH"),
      permit2,
      stateView: await deploy("V4LimitOrderMockStateView", [poolManager]),
      poolManager
    };
    contracts.positionManager = await deploy(
      "V4LimitOrderMockPositionManager",
      [contracts.permit2, contracts.poolManager]
    );
    await write(
      "V4LimitOrderMockStateView",
      contracts.stateView,
      "setPositionManager",
      [contracts.positionManager]
    );
    contracts.hook = await deploy("V4LimitOrderMockHook");
    contracts.distributor = await deploy(
      "V4LimitOrderMockRevenueDistributor",
      [addresses[4]]
    );
    contracts.policy = await deploy("V4LimitOrderMockPolicy");
    await write("V4LimitOrderMockPolicy", contracts.policy, "setIntegrationRecipient", [addresses[5]]);
    contracts.manager = await deploy("ScoplV4LimitOrderManager", [
      addresses[0],
      contracts.distributor,
      contracts.policy,
      contracts.positionManager,
      contracts.stateView,
      contracts.poolManager,
      contracts.permit2,
      contracts.weth,
      RESERVE
    ]);
    contracts.referral = await deploy("ScoplReferralRewards", [addresses[0]]);
    await write(
      "ScoplReferralRewards",
      contracts.referral,
      "setRevenueCreditorAllowed",
      [contracts.distributor, true]
    );
    await write(
      "V4LimitOrderMockRevenueDistributor",
      contracts.distributor,
      "setReferralRewards",
      [contracts.referral]
    );
    key = {
      currency0: token0,
      currency1: token1,
      fee: 3_000,
      tickSpacing: 60,
      hooks: "0x0000000000000000000000000000000000000000"
    };
    poolId = makePoolId(key);
    await write("V4LimitOrderMockStateView", contracts.stateView, "setSlot0", [
      poolId,
      2n ** 96n,
      0
    ]);
    await write("V4LimitOrderMockERC20", token0, "mint", [addresses[1], 1_000_000n]);
    await write("V4LimitOrderMockERC20", token1, "mint", [addresses[1], 1_000_000n]);
    await approveUser();
    snapshot = await rpc("evm_snapshot") as string;
  }, 60_000);

  beforeEach(async () => {
    await rpc("evm_revert", [snapshot]);
    snapshot = await rpc("evm_snapshot") as string;
  });

  afterAll(() => anvil?.kill("SIGTERM"));

  it("rejects V4 dependencies that do not share one PoolManager and Permit2", async () => {
    const otherPoolManager = await deploy("V4LimitOrderMockPoolManager");
    await expect(deploy("ScoplV4LimitOrderManager", [
      addresses[0],
      contracts.distributor,
      contracts.policy,
      contracts.positionManager,
      contracts.stateView,
      otherPoolManager,
      contracts.permit2,
      contracts.weth,
      RESERVE
    ])).rejects.toThrow();

    const otherPermit2 = await deploy("V4LimitOrderMockPermit2");
    await expect(deploy("ScoplV4LimitOrderManager", [
      addresses[0],
      contracts.distributor,
      contracts.policy,
      contracts.positionManager,
      contracts.stateView,
      contracts.poolManager,
      otherPermit2,
      contracts.weth,
      RESERVE
    ])).rejects.toThrow();
  });

  it("creates an ERC-20 v4 position owned by the user", async () => {
    await write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "createOrder",
      [createParams()],
      1,
      RESERVE
    );
    expect(await read<Address>(
      "V4LimitOrderMockPositionManager",
      contracts.positionManager,
      "ownerOf",
      [1n]
    )).toBe(addresses[1]);
    const order = await read<readonly unknown[]>(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "orders",
      [1n]
    );
    expect(order[0]).toBe(addresses[1]);
    expect(order[5]).toBe(5_000n);
    expect(order[6]).toBe(10_000n);
    expect(await read<boolean>(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "isExecutable",
      [1n]
    )).toBe(false);
    expect(await read<bigint>(
      "V4LimitOrderMockERC20",
      contracts.token0,
      "allowance",
      [contracts.manager, contracts.permit2]
    )).toBe(0n);
  });

  it("supports tokens whose Permit2 allowance is fixed at infinity", async () => {
    await write(
      "V4LimitOrderMockERC20",
      contracts.token0,
      "setFixedInfiniteAllowanceSpender",
      [contracts.permit2]
    );

    await write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "createOrder",
      [createParams()],
      1,
      RESERVE
    );

    expect(await read<Address>(
      "V4LimitOrderMockPositionManager",
      contracts.positionManager,
      "ownerOf",
      [1n]
    )).toBe(addresses[1]);
    expect(await read<bigint>(
      "V4LimitOrderMockERC20",
      contracts.token0,
      "allowance",
      [contracts.manager, contracts.permit2]
    )).toBe(2n ** 256n - 1n);
    const permitAllowance = await read<readonly [bigint, number]>(
      "V4LimitOrderMockPermit2",
      contracts.permit2,
      "allowances",
      [contracts.manager, contracts.token0, contracts.positionManager]
    );
    expect(permitAllowance[0]).toBe(0n);
  });

  it("combines native ETH and existing WETH for a native-currency V4 order", async () => {
    const amountIn = parseEther("0.01");
    const nativeFunding = parseEther("0.004");
    const wrappedFunding = amountIn - nativeFunding;
    const nativeKey = {
      ...key,
      currency0: "0x0000000000000000000000000000000000000000" as Address
    };
    const nativePoolId = makePoolId(nativeKey);
    await write("V4LimitOrderMockStateView", contracts.stateView, "setSlot0", [
      nativePoolId,
      2n ** 96n,
      0
    ]);
    await write("V4LimitOrderMockWETH", contracts.weth, "deposit", [], 0, wrappedFunding);
    await write("V4LimitOrderMockWETH", contracts.weth, "mint", [
      addresses[1],
      wrappedFunding
    ]);
    await write("V4LimitOrderMockWETH", contracts.weth, "approve", [
      contracts.manager,
      2n ** 256n - 1n
    ], 1);

    await write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "createOrder",
      [createParams({
        key: nativeKey,
        tokenIn: nativeKey.currency0,
        tokenOut: nativeKey.currency1,
        amountIn,
        amountInMinimum: amountIn,
        liquidity: 5_000n
      })],
      1,
      nativeFunding + RESERVE
    );

    expect(await read<bigint>(
      "V4LimitOrderMockERC20",
      contracts.weth,
      "balanceOf",
      [addresses[1]]
    )).toBe(0n);
    expect(await publicClient.getBalance({ address: contracts.manager })).toBe(RESERVE);

    await write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "cancelOrder",
      [1n],
      1
    );
    expect(await read<bigint>(
      "V4LimitOrderMockERC20",
      contracts.weth,
      "balanceOf",
      [addresses[1]]
    )).toBe(0n);
    expect(await publicClient.getBalance({ address: contracts.manager })).toBe(0n);
  });

  it("executes after the range is crossed without taxing principal", async () => {
    await write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "createOrder",
      [createParams()],
      1,
      RESERVE
    );
    await write("V4LimitOrderMockERC20", contracts.token1, "mint", [
      contracts.positionManager,
      20_000n
    ]);
    await write(
      "V4LimitOrderMockPositionManager",
      contracts.positionManager,
      "setWithdrawal",
      [1n, 0n, 20_000n]
    );
    await write("V4LimitOrderMockStateView", contracts.stateView, "setSlot0", [
      poolId,
      2n ** 96n,
      120
    ]);
    const beforeOwner = await read<bigint>(
      "V4LimitOrderMockERC20", contracts.token1, "balanceOf", [addresses[1]]
    );
    const beforeTreasury = await read<bigint>(
      "V4LimitOrderMockERC20", contracts.token1, "balanceOf", [addresses[4]]
    );
    await write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "executeOrder",
      [1n],
      2
    );
    expect(await read<bigint>(
      "V4LimitOrderMockERC20", contracts.token1, "balanceOf", [addresses[1]]
    ) - beforeOwner).toBe(20_000n);
    expect(await read<bigint>(
      "V4LimitOrderMockERC20", contracts.token1, "balanceOf", [addresses[4]]
    ) - beforeTreasury).toBe(0n);
    expect(await publicClient.getBalance({ address: contracts.manager })).toBe(0n);
  });

  it("splits V4 generated LP fees under immutable direct economics", async () => {
    await write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "createOrder",
      [createParams()],
      1,
      RESERVE
    );
    await write("V4LimitOrderMockERC20", contracts.token1, "mint", [
      contracts.positionManager,
      20_000n
    ]);
    await write(
      "V4LimitOrderMockPositionManager",
      contracts.positionManager,
      "setWithdrawal",
      [1n, 0n, 20_000n]
    );
    await write(
      "V4LimitOrderMockPositionManager",
      contracts.positionManager,
      "accrueFees",
      [1n, 25n, 100n]
    );
    await write("V4LimitOrderMockStateView", contracts.stateView, "setSlot0", [
      poolId,
      2n ** 96n,
      120
    ]);
    const ownerBefore = await read<bigint>(
      "V4LimitOrderMockERC20", contracts.token1, "balanceOf", [addresses[1]]
    );
    await write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "executeOrder",
      [1n],
      2
    );
    expect(await read<bigint>(
      "V4LimitOrderMockERC20", contracts.token1, "balanceOf", [addresses[1]]
    ) - ownerBefore).toBe(20_010n);
    expect(await read<bigint>(
      "V4LimitOrderMockERC20", contracts.token0, "balanceOf", [addresses[4]]
    )).toBe(23n);
    expect(await read<bigint>(
      "V4LimitOrderMockERC20", contracts.token1, "balanceOf", [addresses[4]]
    )).toBe(90n);
  });

  it("pays V4 integration LP fees to user/integrator/protocol and excludes referrals", async () => {
    const integrationId: Hex = `0x${"42".repeat(32)}`;
    await write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "createOrder",
      [createParams({ integrationId })],
      1,
      RESERVE
    );
    await write("V4LimitOrderMockERC20", contracts.token1, "mint", [
      contracts.positionManager, 20_000n
    ]);
    await write("V4LimitOrderMockPositionManager", contracts.positionManager, "setWithdrawal", [
      1n, 0n, 20_000n
    ]);
    await write("V4LimitOrderMockPositionManager", contracts.positionManager, "accrueFees", [
      1n, 0n, 100n
    ]);
    await write("V4LimitOrderMockStateView", contracts.stateView, "setSlot0", [
      poolId, 2n ** 96n, 120
    ]);
    const ownerBefore = await read<bigint>(
      "V4LimitOrderMockERC20", contracts.token1, "balanceOf", [addresses[1]]
    );
    await write("ScoplV4LimitOrderManager", contracts.manager, "executeOrder", [1n], 2);
    expect(await read<bigint>(
      "V4LimitOrderMockERC20", contracts.token1, "balanceOf", [addresses[1]]
    ) - ownerBefore).toBe(20_025n);
    expect(await read<bigint>(
      "V4LimitOrderMockERC20", contracts.token1, "balanceOf", [addresses[5]]
    )).toBe(50n);
    expect(await read<bigint>(
      "V4LimitOrderMockERC20", contracts.token1, "balanceOf", [addresses[4]]
    )).toBe(25n);
    expect(await read<readonly [number, Hex, Address, number, Address, number, number, Address]>(
      "ScoplV4LimitOrderManager", contracts.manager, "orderEconomics", [1n]
    )).toEqual([
      1, integrationId, addresses[1], 2_500, addresses[5], 5_000, 2_500,
      "0x0000000000000000000000000000000000000000"
    ]);
  });

  it("makes a V4 order non-executable after its owner claims LP fees", async () => {
    await write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "createOrder",
      [createParams()],
      1,
      RESERVE
    );
    await write(
      "V4LimitOrderMockPositionManager",
      contracts.positionManager,
      "accrueFees",
      [1n, 25n, 100n]
    );
    await write(
      "V4LimitOrderMockPositionManager",
      contracts.positionManager,
      "claimFees",
      [1n],
      1
    );
    await write("V4LimitOrderMockStateView", contracts.stateView, "setSlot0", [
      poolId,
      2n ** 96n,
      120
    ]);
    expect(await read<boolean>(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "isExecutable",
      [1n]
    )).toBe(false);
    await expect(write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "executeOrder",
      [1n],
      2
    )).rejects.toThrow();
  });

  it("splits V4 LP fees on cancellation and returns principal", async () => {
    await write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "createOrder",
      [createParams()],
      1,
      RESERVE
    );
    await write(
      "V4LimitOrderMockPositionManager",
      contracts.positionManager,
      "accrueFees",
      [1n, 25n, 100n]
    );
    const owner0Before = await read<bigint>(
      "V4LimitOrderMockERC20", contracts.token0, "balanceOf", [addresses[1]]
    );
    const owner1Before = await read<bigint>(
      "V4LimitOrderMockERC20", contracts.token1, "balanceOf", [addresses[1]]
    );
    await write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "cancelOrder",
      [1n],
      1
    );
    expect(await read<bigint>(
      "V4LimitOrderMockERC20", contracts.token0, "balanceOf", [addresses[1]]
    ) - owner0Before).toBe(10_002n);
    expect(await read<bigint>(
      "V4LimitOrderMockERC20", contracts.token1, "balanceOf", [addresses[1]]
    ) - owner1Before).toBe(10n);
    expect(await read<bigint>(
      "V4LimitOrderMockERC20", contracts.token0, "balanceOf", [addresses[4]]
    )).toBe(23n);
    expect(await read<bigint>(
      "V4LimitOrderMockERC20", contracts.token1, "balanceOf", [addresses[4]]
    )).toBe(90n);
  });

  it("unwraps ERC-20 WETH output so the V4 user receives native ETH", async () => {
    const pairedToken = contracts.token0;
    const [currency0, currency1] = pairedToken.toLowerCase() < contracts.weth.toLowerCase()
      ? [pairedToken, contracts.weth]
      : [contracts.weth, pairedToken];
    const wethKey = { ...key, currency0, currency1 };
    const wethPoolId = makePoolId(wethKey);
    const sellToken0 = pairedToken.toLowerCase() === currency0.toLowerCase();
    const tickLower = sellToken0 ? 60 : -120;
    const tickUpper = sellToken0 ? 120 : -60;
    await write("V4LimitOrderMockStateView", contracts.stateView, "setSlot0", [
      wethPoolId,
      2n ** 96n,
      0
    ]);
    await write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "createOrder",
      [createParams({
        key: wethKey,
        tokenIn: pairedToken,
        tokenOut: contracts.weth,
        tickLower,
        tickUpper
      })],
      1,
      RESERVE
    );
    await write("V4LimitOrderMockWETH", contracts.weth, "deposit", [], 0, 20_000n);
    await write("V4LimitOrderMockWETH", contracts.weth, "mint", [
      contracts.positionManager,
      20_000n
    ]);
    await write(
      "V4LimitOrderMockPositionManager",
      contracts.positionManager,
      "setWithdrawal",
      [1n, currency0 === contracts.weth ? 20_000n : 0n, currency1 === contracts.weth ? 20_000n : 0n]
    );
    await write("V4LimitOrderMockStateView", contracts.stateView, "setSlot0", [
      wethPoolId,
      2n ** 96n,
      sellToken0 ? tickUpper : tickLower - 1
    ]);
    const ownerNativeBefore = await publicClient.getBalance({
      address: addresses[1]
    });
    await write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "executeOrder",
      [1n],
      2
    );
    expect(await publicClient.getBalance({ address: addresses[1] }))
      .toBe(ownerNativeBefore + 20_000n);
    expect(await read<bigint>(
      "V4LimitOrderMockERC20",
      contracts.weth,
      "balanceOf",
      [addresses[1]]
    )).toBe(0n);
    expect(await read<bigint>(
      "V4LimitOrderMockERC20",
      contracts.weth,
      "balanceOf",
      [addresses[4]]
    )).toBe(0n);
  });

  it("rejects custom hooks until governance enables them", async () => {
    const hookedKey = { ...key, hooks: contracts.hook };
    const hookedPoolId = makePoolId(hookedKey);
    await write("V4LimitOrderMockStateView", contracts.stateView, "setSlot0", [
      hookedPoolId,
      2n ** 96n,
      0
    ]);
    await expect(write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "createOrder",
      [createParams({ key: hookedKey, hookData: "0x1234" })],
      1,
      RESERVE
    )).rejects.toThrow();
    await write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "setHookPolicy",
      [contracts.hook, true, keccak256("0x1234")]
    );
    expect(await read<Hex>(
      "ScoplV4LimitOrderManager", contracts.manager, "allowedHookCodeHash", [contracts.hook]
    )).not.toBe(`0x${"00".repeat(32)}`);
    await write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "createOrder",
      [createParams({ key: hookedKey, hookData: "0x1234" })],
      1,
      RESERVE
    );
    expect(await read<Hex>(
      "ScoplV4LimitOrderManager", contracts.manager, "getOrderHookData", [1n]
    )).toBe("0x1234");
    await write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "setHookAllowed",
      [contracts.hook, false]
    );
    await write("V4LimitOrderMockStateView", contracts.stateView, "setSlot0", [
      hookedPoolId,
      2n ** 96n,
      120
    ]);
    expect(await read<boolean>(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "isExecutable",
      [1n]
    )).toBe(false);
    await expect(write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "executeOrder",
      [1n],
      2
    )).rejects.toThrow();
    await write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "cancelOrder",
      [1n],
      1
    );
  });

  it("rejects a custom hook whose runtime code changes after approval", async () => {
    const hookedKey = { ...key, hooks: contracts.hook };
    const hookedPoolId = makePoolId(hookedKey);
    await write("V4LimitOrderMockStateView", contracts.stateView, "setSlot0", [
      hookedPoolId, 2n ** 96n, 0
    ]);
    await write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "setHookPolicy",
      [contracts.hook, true, keccak256("0x1234")]
    );
    await rpc("anvil_setCode", [contracts.hook, "0x60006000fd"]);
    await expect(write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "createOrder",
      [createParams({ key: hookedKey, hookData: "0x1234" })],
      1,
      RESERVE
    )).rejects.toThrow();
  });

  it("execution pause blocks fills without trapping cancellation", async () => {
    await write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "createOrder",
      [createParams()],
      1,
      RESERVE
    );
    await write("V4LimitOrderMockStateView", contracts.stateView, "setSlot0", [
      poolId,
      2n ** 96n,
      120
    ]);
    await write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "setExecutionPaused",
      [true]
    );
    expect(await read<boolean>(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "isExecutable",
      [1n]
    )).toBe(false);
    await expect(write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "executeOrder",
      [1n],
      2
    )).rejects.toThrow();
    await write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "cancelOrder",
      [1n],
      1
    );
  });

  it("keeps native ETH input separate from the keeper reserve", async () => {
    const nativeAmount = parseEther("0.01");
    const nativeKey = {
      ...key,
      currency0: "0x0000000000000000000000000000000000000000" as Address
    };
    const nativePoolId = makePoolId(nativeKey);
    await write("V4LimitOrderMockStateView", contracts.stateView, "setSlot0", [
      nativePoolId,
      2n ** 96n,
      0
    ]);
    await write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "createOrder",
      [createParams({
        key: nativeKey,
        tokenIn: nativeKey.currency0,
        amountIn: nativeAmount,
        amountInMinimum: nativeAmount,
        liquidity: 5_000n
      })],
      1,
      nativeAmount + RESERVE
    );
    await write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "cancelOrder",
      [1n],
      1
    );
    expect(await publicClient.getBalance({ address: contracts.manager })).toBe(0n);
  });

  it("settles native ETH principal entirely to the owner", async () => {
    const nativeOutput = parseEther("0.02");
    const nativeKey = {
      ...key,
      currency0: "0x0000000000000000000000000000000000000000" as Address
    };
    const nativePoolId = makePoolId(nativeKey);
    await write("V4LimitOrderMockStateView", contracts.stateView, "setSlot0", [
      nativePoolId,
      2n ** 96n,
      120
    ]);
    await write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "createOrder",
      [createParams({
        key: nativeKey,
        tokenIn: nativeKey.currency1,
        tokenOut: nativeKey.currency0,
        tickLower: 0,
        tickUpper: 60
      })],
      1,
      RESERVE
    );
    await wallets[0].sendTransaction({
      account: wallets[0].account!,
      chain,
      to: contracts.positionManager,
      value: nativeOutput
    } as never);
    await write(
      "V4LimitOrderMockPositionManager",
      contracts.positionManager,
      "setWithdrawal",
      [1n, nativeOutput, 0n]
    );
    await write("V4LimitOrderMockStateView", contracts.stateView, "setSlot0", [
      nativePoolId,
      2n ** 96n,
      -1
    ]);
    const ownerNativeBefore = await publicClient.getBalance({
      address: addresses[1]
    });
    await write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "executeOrder",
      [1n],
      2
    );
    expect(await publicClient.getBalance({ address: addresses[1] }))
      .toBe(ownerNativeBefore + nativeOutput);
    expect(await read<bigint>(
      "V4LimitOrderMockERC20", contracts.weth, "balanceOf", [addresses[4]]
    )).toBe(0n);
  });

  it("lets the owner choose WETH for native V4 principal", async () => {
    const nativeOutput = parseEther("0.02");
    const nativeKey = {
      ...key,
      currency0: "0x0000000000000000000000000000000000000000" as Address
    };
    const nativePoolId = makePoolId(nativeKey);
    await write("ScoplV4LimitOrderManager", contracts.manager, "setPreferWrappedNative", [
      true
    ], 1);
    await write("V4LimitOrderMockStateView", contracts.stateView, "setSlot0", [
      nativePoolId, 2n ** 96n, 120
    ]);
    await write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "createOrder",
      [createParams({
        key: nativeKey,
        tokenIn: nativeKey.currency1,
        tokenOut: nativeKey.currency0,
        tickLower: 0,
        tickUpper: 60
      })],
      1,
      RESERVE
    );
    const fundingHash = await wallets[0].sendTransaction({
      account: wallets[0].account!, chain,
      to: contracts.positionManager, value: nativeOutput
    } as never);
    await publicClient.waitForTransactionReceipt({ hash: fundingHash });
    await write("V4LimitOrderMockPositionManager", contracts.positionManager, "setWithdrawal", [
      1n, nativeOutput, 0n
    ]);
    await write("V4LimitOrderMockStateView", contracts.stateView, "setSlot0", [
      nativePoolId, 2n ** 96n, -1
    ]);
    const wrappedBefore = await read<bigint>(
      "V4LimitOrderMockERC20", contracts.weth, "balanceOf", [addresses[1]]
    );
    await write("ScoplV4LimitOrderManager", contracts.manager, "executeOrder", [1n], 2);
    expect(await read<bigint>(
      "V4LimitOrderMockERC20", contracts.weth, "balanceOf", [addresses[1]]
    ) - wrappedBefore).toBe(nativeOutput);
  });

  it("funds V4 referral rewards from only the protocol LP-fee share", async () => {
    await write(
      "V4LimitOrderMockPolicy",
      contracts.policy,
      "setDirectPolicy",
      [5_000, addresses[3]]
    );
    await write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "createOrder",
      [createParams()],
      1,
      RESERVE
    );
    await write("V4LimitOrderMockERC20", contracts.token1, "mint", [
      contracts.positionManager,
      20_000n
    ]);
    await write(
      "V4LimitOrderMockPositionManager",
      contracts.positionManager,
      "setWithdrawal",
      [1n, 0n, 20_000n]
    );
    await write(
      "V4LimitOrderMockPositionManager",
      contracts.positionManager,
      "accrueFees",
      [1n, 0n, 100n]
    );
    await write("V4LimitOrderMockStateView", contracts.stateView, "setSlot0", [
      poolId,
      2n ** 96n,
      120
    ]);
    await write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "executeOrder",
      [1n],
      2
    );
    expect(await read<readonly [bigint, bigint, bigint]>(
      "ScoplReferralRewards",
      contracts.referral,
      "claimable",
      [addresses[3], contracts.token1]
    )).toEqual([0n, 15n, 15n]);
    expect(await read<bigint>(
      "V4LimitOrderMockERC20", contracts.token1, "balanceOf", [addresses[4]]
    )).toBe(35n);
  });

  it("marks an order stale if the user changes its v4 liquidity", async () => {
    await write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "createOrder",
      [createParams()],
      1,
      RESERVE
    );
    await write(
      "V4LimitOrderMockPositionManager",
      contracts.positionManager,
      "setLiquidity",
      [1n, 4_999n]
    );
    await write(
      "ScoplV4LimitOrderManager",
      contracts.manager,
      "markOrderStale",
      [1n],
      3
    );
    expect(await publicClient.getBalance({ address: contracts.manager })).toBe(0n);
  });
});
