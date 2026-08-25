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
  encodeFunctionData,
  http,
  keccak256,
  parseAbiParameters,
  stringToHex,
  zeroAddress,
  type Abi,
  type Address,
  type Hex
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

interface Artifact { abi: Abi; bytecode: Hex }
interface SolcOutput {
  contracts?: Record<string, Record<string, {
    abi: Abi;
    evm: { bytecode: { object: string } };
  }>>;
  errors?: Array<{ severity: string; formattedMessage: string }>;
}

const MNEMONIC = "test test test test test test test test test test test junk";
const chain = defineChain({
  id: 1_337,
  name: "SCOPL revenue tests",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1"] } }
});

function compileContracts(): Record<string, Artifact> {
  const names = [
    "ScoplReferralRewards",
    "ScoplRevenueDistributor",
    "ScoplBuybackVault",
    "ScoplRouterSwapAdapter"
  ];
  const sources = Object.fromEntries(names.map((name) => [
    `${name}.sol`,
    { content: readFileSync(resolve(process.cwd(), `contracts/${name}.sol`), "utf8") }
  ]));
  sources["ScoplRevenueMocks.sol"] = {
    content: readFileSync(
      resolve(process.cwd(), "contracts/test/ScoplRevenueMocks.sol"),
      "utf8"
    )
  };
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } }
    }
  }))) as SolcOutput;
  const failures = (output.errors ?? []).filter((error) => error.severity === "error");
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

describe.sequential("SCOPL simplified revenue infrastructure", () => {
  let anvil: ChildProcess;
  let rpcUrl: string;
  let publicClient: ReturnType<typeof createPublicClient>;
  let wallets: Array<ReturnType<typeof createWalletClient>>;
  let addresses: Address[];
  let snapshot: string;
  let contracts: Record<string, Address>;

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

  async function balance(token: Address, account: Address) {
    return read<bigint>("MockRevenueToken", token, "balanceOf", [account]);
  }

  async function fundBackedWeth(amount: bigint) {
    await write("MockRevenueToken", contracts.weth, "deposit", [], 0, amount);
    await write("MockRevenueToken", contracts.weth, "transfer", [
      contracts.buyback, amount
    ]);
  }

  async function configurePonsBuyback(
    curve: Address,
    pairToken: Address,
    phase = 0
  ) {
    await write("MockPonsFactory", contracts.ponsFactory, "setLaunch", [
      contracts.scopl, curve, pairToken, 3_000, 60, phase
    ]);
    await write("ScoplBuybackVault", contracts.buyback, "setExecutor", [
      addresses[1], true
    ]);
    await write("ScoplBuybackVault", contracts.buyback, "configureBuyback", [
      contracts.scopl
    ]);
    await write("ScoplBuybackVault", contracts.buyback, "finalizeBuybackConfiguration");
  }

  beforeAll(async () => {
    const port = 21_500 + process.pid % 1_000;
    rpcUrl = `http://127.0.0.1:${port}`;
    anvil = spawn(process.execPath, [
      resolve(process.cwd(), "node_modules/@foundry-rs/anvil/bin.mjs"),
      "--port", String(port), "--chain-id", String(chain.id),
      "--mnemonic", MNEMONIC, "--silent"
    ], { stdio: "ignore", windowsHide: true });
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        await rpc("eth_chainId");
        break;
      } catch {
        if (attempt === 49) throw new Error("Anvil did not start");
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

    const weth = await deploy("MockRevenueToken");
    const scopl = await deploy("MockRevenueToken");
    const ponsFactory = await deploy("MockPonsFactory", [addresses[5]]);
    const rewards = await deploy("ScoplReferralRewards", [addresses[0]]);
    const buyback = await deploy("ScoplBuybackVault", [
      addresses[0], addresses[5], weth, ponsFactory, 100n
    ]);
    const distributor = await deploy("ScoplRevenueDistributor", [
      addresses[0], addresses[5], weth, rewards, buyback, addresses[4]
    ]);
    const source = await deploy("MockRevenueSource");
    const token = await deploy("MockRevenueToken");
    const buybackAdapter = await deploy("MockBuybackAdapter");
    const permit2 = await deploy("MockRevenuePermit2");
    const aggregationRouter = await deploy("MockAggregationRouter", [permit2]);
    const routerAdapter = await deploy("ScoplRouterSwapAdapter", [
      buyback, aggregationRouter, permit2, weth
    ]);
    const fundingHash = await wallets[0].sendTransaction({
      to: aggregationRouter,
      value: 10_000n
    } as never);
    await publicClient.waitForTransactionReceipt({ hash: fundingHash });
    await write("ScoplReferralRewards", rewards, "setRevenueCreditorAllowed", [
      distributor, true
    ]);
    await write("ScoplRevenueDistributor", distributor, "setRevenueSource", [
      source, 0, true
    ]);
    contracts = {
      weth, rewards, buyback, distributor, source, token, scopl,
      buybackAdapter, permit2, aggregationRouter, routerAdapter, ponsFactory
    };
    snapshot = await rpc("evm_snapshot") as string;
  }, 60_000);

  beforeEach(async () => {
    await rpc("evm_revert", [snapshot]);
    snapshot = await rpc("evm_snapshot") as string;
  });

  afterAll(() => anvil.kill());

  it("splits referred revenue in its original token and supports direct claims", async () => {
    await write("ScoplReferralRewards", contracts.rewards, "bindReferrer", [
      addresses[2]
    ], 1);
    await write("MockRevenueToken", contracts.token, "mint", [contracts.source, 1_000n]);
    await write("MockRevenueSource", contracts.source, "distributeToken", [
      contracts.distributor,
      keccak256(stringToHex("referred-token")),
      addresses[1],
      contracts.token,
      1_000n
    ]);

    expect(await balance(contracts.token, contracts.rewards)).toBe(300n);
    expect(await balance(contracts.token, contracts.buyback)).toBe(500n);
    expect(await balance(contracts.token, addresses[4])).toBe(200n);
    expect(await read("ScoplReferralRewards", contracts.rewards, "claimable", [
      addresses[2], contracts.token
    ])).toEqual([300n, 0n, 300n]);

    await write("ScoplReferralRewards", contracts.rewards, "claim", [contracts.token], 2);
    expect(await balance(contracts.token, addresses[2])).toBe(300n);
    expect(await balance(contracts.token, contracts.rewards)).toBe(0n);
  });

  it("sends an absent referrer's full 30% share to operations", async () => {
    await write("MockRevenueToken", contracts.token, "mint", [contracts.source, 1_000n]);
    await write("MockRevenueSource", contracts.source, "distributeToken", [
      contracts.distributor,
      keccak256(stringToHex("no-referrer")),
      addresses[3],
      contracts.token,
      1_000n
    ]);
    expect(await balance(contracts.token, contracts.rewards)).toBe(0n);
    expect(await balance(contracts.token, contracts.buyback)).toBe(500n);
    expect(await balance(contracts.token, addresses[4])).toBe(500n);
  });

  it("wraps native revenue and performs the same per-token split", async () => {
    await write("ScoplReferralRewards", contracts.rewards, "bindReferrer", [
      addresses[2]
    ], 1);
    await write("MockRevenueSource", contracts.source, "distributeNative", [
      contracts.distributor,
      keccak256(stringToHex("native")),
      addresses[1]
    ], 0, 1_000n);
    expect(await balance(contracts.weth, contracts.rewards)).toBe(300n);
    expect(await balance(contracts.weth, contracts.buyback)).toBe(500n);
    expect(await balance(contracts.weth, addresses[4])).toBe(200n);
  });

  it("redirects a failed referral credit to operations without blocking revenue", async () => {
    await write("ScoplReferralRewards", contracts.rewards, "bindReferrer", [
      addresses[2]
    ], 1);
    await write("ScoplReferralRewards", contracts.rewards, "setRevenueCreditorAllowed", [
      contracts.distributor, false
    ]);
    await write("MockRevenueToken", contracts.token, "mint", [contracts.source, 1_000n]);
    await write("MockRevenueSource", contracts.source, "distributeToken", [
      contracts.distributor,
      keccak256(stringToHex("failed-credit")),
      addresses[1],
      contracts.token,
      1_000n
    ]);
    expect(await balance(contracts.token, contracts.rewards)).toBe(0n);
    expect(await balance(contracts.token, contracts.buyback)).toBe(500n);
    expect(await balance(contracts.token, addresses[4])).toBe(500n);
  });

  it("honors frozen manager attribution after the referral destination changes", async () => {
    const replacementRewards = await deploy("ScoplReferralRewards", [addresses[0]]);
    await write("ScoplReferralRewards", replacementRewards, "setRevenueCreditorAllowed", [
      contracts.distributor, true
    ]);
    await write("ScoplRevenueDistributor", contracts.distributor, "setDestinations", [
      replacementRewards, contracts.buyback, addresses[4]
    ]);
    await write("MockRevenueToken", contracts.token, "mint", [contracts.source, 1_000n]);
    await write("MockRevenueSource", contracts.source, "distributeAttributedToken", [
      contracts.distributor,
      keccak256(stringToHex("frozen-referrer")),
      addresses[1],
      addresses[2],
      contracts.token,
      1_000n
    ]);
    expect(await balance(contracts.token, replacementRewards)).toBe(300n);
    expect(await read("ScoplReferralRewards", replacementRewards, "claimable", [
      addresses[2], contracts.token
    ])).toEqual([300n, 0n, 300n]);
  });

  it("rejects duplicate IDs and unauthorized revenue sources", async () => {
    const revenueId = keccak256(stringToHex("unique"));
    await write("MockRevenueToken", contracts.token, "mint", [contracts.source, 2_000n]);
    await write("MockRevenueSource", contracts.source, "distributeToken", [
      contracts.distributor, revenueId, addresses[3], contracts.token, 1_000n
    ]);
    await expect(write("MockRevenueSource", contracts.source, "distributeToken", [
      contracts.distributor, revenueId, addresses[3], contracts.token, 1_000n
    ])).rejects.toThrow();

    await write("MockRevenueToken", contracts.token, "mint", [addresses[0], 1_000n]);
    await write("MockRevenueToken", contracts.token, "approve", [
      contracts.distributor, 1_000n
    ]);
    await expect(write("ScoplRevenueDistributor", contracts.distributor, "distribute", [
      keccak256(stringToHex("unauthorized")), addresses[0], contracts.token, 1_000n
    ])).rejects.toThrow();
  });

  it("accumulates buyback assets safely before SCOPL is configured", async () => {
    await write("MockRevenueToken", contracts.token, "mint", [contracts.source, 2_000n]);
    await write("MockRevenueSource", contracts.source, "distributeToken", [
      contracts.distributor,
      keccak256(stringToHex("reserve-one")),
      addresses[3],
      contracts.token,
      2_000n
    ]);
    expect(await balance(contracts.token, contracts.buyback)).toBe(1_000n);
    expect(await read("ScoplBuybackVault", contracts.buyback, "buybackConfigured"))
      .toBe(false);
    expect(await read("ScoplBuybackVault", contracts.buyback, "buybackToken"))
      .toBe(zeroAddress);
  });

  it("consolidates into WETH, buys SCOPL, and reimburses its keeper", async () => {
    await write("ScoplBuybackVault", contracts.buyback, "setAdapter", [
      contracts.buybackAdapter, true
    ]);
    await write("ScoplBuybackVault", contracts.buyback, "setExecutor", [
      addresses[1], true
    ]);
    await write("ScoplBuybackVault", contracts.buyback, "configureBuyback", [
      contracts.scopl
    ]);
    await write("ScoplBuybackVault", contracts.buyback, "finalizeBuybackConfiguration");

    // Native revenue supplies fully backed WETH for both the buyback and the
    // fixed native keeper reimbursements.
    await write("MockRevenueSource", contracts.source, "distributeNative", [
      contracts.distributor,
      keccak256(stringToHex("buyback-gas")),
      addresses[3]
    ], 0, 1_000n);
    await write("MockRevenueToken", contracts.token, "mint", [contracts.buyback, 1_000n]);
    await expect(write("ScoplBuybackVault", contracts.buyback, "executeSwap", [
      contracts.buybackAdapter,
      contracts.token,
      contracts.scopl,
      1n,
      1n,
      encodeAbiParameters(parseAbiParameters("uint256"), [1n])
    ], 1)).rejects.toThrow();
    const keeperBalanceBefore = await publicClient.getBalance({ address: addresses[1] });
    const consolidationReceipt = await write("ScoplBuybackVault", contracts.buyback, "executeSwap", [
      contracts.buybackAdapter,
      contracts.token,
      contracts.weth,
      1_000n,
      800n,
      encodeAbiParameters(parseAbiParameters("uint256"), [900n])
    ], 1);
    expect(await balance(contracts.weth, contracts.buyback)).toBe(1_300n);

    const buyReceipt = await write("ScoplBuybackVault", contracts.buyback, "executeSwap", [
      contracts.buybackAdapter,
      contracts.weth,
      contracts.scopl,
      1_200n,
      800n,
      encodeAbiParameters(parseAbiParameters("uint256"), [1_000n])
    ], 1);
    const keeperBalanceAfter = await publicClient.getBalance({ address: addresses[1] });
    const keeperGasSpent =
      consolidationReceipt.gasUsed * consolidationReceipt.effectiveGasPrice +
      buyReceipt.gasUsed * buyReceipt.effectiveGasPrice;
    expect(await balance(contracts.weth, contracts.buyback)).toBe(0n);
    expect(await balance(contracts.scopl, contracts.buyback)).toBe(1_000n);
    expect(keeperBalanceAfter + keeperGasSpent - keeperBalanceBefore).toBe(200n);
  });

  it("wraps V4-native output and unwraps WETH input inside the pinned adapter", async () => {
    await write("ScoplBuybackVault", contracts.buyback, "setAdapter", [
      contracts.routerAdapter, true
    ]);
    await write("ScoplBuybackVault", contracts.buyback, "setExecutor", [
      addresses[1], true
    ]);
    await write("ScoplBuybackVault", contracts.buyback, "configureBuyback", [
      contracts.scopl
    ]);
    await write("ScoplBuybackVault", contracts.buyback, "finalizeBuybackConfiguration");
    await write("MockRevenueSource", contracts.source, "distributeNative", [
      contracts.distributor,
      keccak256(stringToHex("native-v4-buyback")),
      addresses[3]
    ], 0, 2_000n);
    await write("MockRevenueToken", contracts.token, "mint", [contracts.buyback, 1_000n]);

    const tokenForNative = encodeFunctionData({
      abi: artifacts.MockAggregationRouter.abi,
      functionName: "swapTokenForNative",
      args: [contracts.token, 1_000n, 900n]
    });
    await write("ScoplBuybackVault", contracts.buyback, "executeSwap", [
      contracts.routerAdapter,
      contracts.token,
      contracts.weth,
      1_000n,
      800n,
      encodeAbiParameters(
        parseAbiParameters("uint8 nativeMode,bytes routerData"),
        [1, tokenForNative]
      )
    ], 1);
    expect(await balance(contracts.weth, contracts.buyback)).toBe(1_800n);

    const nativeForToken = encodeFunctionData({
      abi: artifacts.MockAggregationRouter.abi,
      functionName: "swapNativeForToken",
      args: [contracts.scopl, 1_000n]
    });
    await write("ScoplBuybackVault", contracts.buyback, "executeSwap", [
      contracts.routerAdapter,
      contracts.weth,
      contracts.scopl,
      1_700n,
      800n,
      encodeAbiParameters(
        parseAbiParameters("uint8 nativeMode,bytes routerData"),
        [2, nativeForToken]
      )
    ], 1);
    expect(await balance(contracts.weth, contracts.buyback)).toBe(0n);
    expect(await balance(contracts.scopl, contracts.buyback)).toBe(1_000n);
  });

  it("buys SCOPL directly from a native-ETH Pons curve", async () => {
    const curve = await deploy("MockPonsCurve", [contracts.scopl, zeroAddress]);
    await write("MockPonsCurve", curve, "configure", [
      10_000n, 1_000_000n, 900_000n, 300n, 200n, 100n
    ]);
    await configurePonsBuyback(curve, zeroAddress);
    await fundBackedWeth(1_100n);

    await write("ScoplBuybackVault", contracts.buyback, "executePonsCurveBuy", [
      1_000n, 70_000n
    ], 1);

    expect(await balance(contracts.scopl, contracts.buyback)).toBe(85_923n);
    expect(await balance(contracts.weth, contracts.buyback)).toBe(0n);
  });

  it("buys SCOPL from an ERC20-quoted Pons curve", async () => {
    const quoteToken = await deploy("MockRevenueToken");
    const curve = await deploy("MockPonsCurve", [contracts.scopl, quoteToken]);
    await write("MockPonsCurve", curve, "configure", [
      5_000n, 500_000n, 400_000n, 250n, 150n, 0n
    ]);
    await configurePonsBuyback(curve, quoteToken);
    await write("MockRevenueToken", quoteToken, "mint", [contracts.buyback, 1_000n]);
    await fundBackedWeth(100n);

    await write("ScoplBuybackVault", contracts.buyback, "executePonsCurveBuy", [
      1_000n, 75_000n
    ], 1);

    expect(await balance(contracts.scopl, contracts.buyback)).toBe(80_536n);
    expect(await balance(quoteToken, contracts.buyback)).toBe(0n);
  });

  it("keeps a final clamped Pons curve refund in the SCOPL vault", async () => {
    const quoteToken = await deploy("MockRevenueToken");
    const curve = await deploy("MockPonsCurve", [contracts.scopl, quoteToken]);
    await write("MockPonsCurve", curve, "configure", [
      1_000n, 1_000n, 10n, 500n, 200n, 100n
    ]);
    await configurePonsBuyback(curve, quoteToken);
    await write("MockRevenueToken", quoteToken, "mint", [contracts.buyback, 1_000n]);
    await fundBackedWeth(100n);

    await write("ScoplBuybackVault", contracts.buyback, "executePonsCurveBuy", [
      1_000n, 700n
    ], 1);

    expect(await balance(contracts.scopl, contracts.buyback)).toBe(10n);
    expect(await balance(quoteToken, contracts.buyback)).toBe(988n);
    expect(await read("MockPonsCurve", curve, "readyToGraduate")).toBe(true);
  });

  it("rewraps a native final-fill Pons refund for the next cycle", async () => {
    const curve = await deploy("MockPonsCurve", [contracts.scopl, zeroAddress]);
    await write("MockPonsCurve", curve, "configure", [
      1_000n, 1_000n, 10n, 500n, 200n, 100n
    ]);
    await configurePonsBuyback(curve, zeroAddress);
    await fundBackedWeth(1_100n);

    await write("ScoplBuybackVault", contracts.buyback, "executePonsCurveBuy", [
      1_000n, 700n
    ], 1);

    expect(await balance(contracts.scopl, contracts.buyback)).toBe(10n);
    expect(await balance(contracts.weth, contracts.buyback)).toBe(988n);
  });

  it("advances Pons graduation one live Factory phase per keeper cycle", async () => {
    const curve = await deploy("MockPonsCurve", [contracts.scopl, zeroAddress]);
    await write("MockPonsCurve", curve, "configure", [
      1_000n, 1_000n, 0n, 0n, 0n, 0n
    ]);
    await configurePonsBuyback(curve, zeroAddress);
    await fundBackedWeth(200n);

    await write("ScoplBuybackVault", contracts.buyback, "advancePonsGraduation", [], 1);
    let launch = await read<{ phase: number }>(
      "MockPonsFactory", contracts.ponsFactory, "getLaunchedToken", [contracts.scopl]
    );
    expect(Number(launch.phase)).toBe(1);

    await write("ScoplBuybackVault", contracts.buyback, "advancePonsGraduation", [], 1);
    launch = await read<{ phase: number }>(
      "MockPonsFactory", contracts.ponsFactory, "getLaunchedToken", [contracts.scopl]
    );
    expect(Number(launch.phase)).toBe(2);
    expect(await balance(contracts.weth, contracts.buyback)).toBe(0n);
  });

  it("routes into the Pons quote asset then buys through the graduated path", async () => {
    const quoteToken = await deploy("MockRevenueToken");
    const curve = await deploy("MockPonsCurve", [contracts.scopl, quoteToken]);
    await configurePonsBuyback(curve, quoteToken, 2);
    await write("ScoplBuybackVault", contracts.buyback, "setAdapter", [
      contracts.buybackAdapter, true
    ]);
    await fundBackedWeth(1_200n);

    await write("ScoplBuybackVault", contracts.buyback, "executeSwap", [
      contracts.buybackAdapter,
      contracts.weth,
      quoteToken,
      1_000n,
      850n,
      encodeAbiParameters(parseAbiParameters("uint256"), [900n])
    ], 1);
    await write("ScoplBuybackVault", contracts.buyback, "executeSwap", [
      contracts.buybackAdapter,
      quoteToken,
      contracts.scopl,
      900n,
      750n,
      encodeAbiParameters(parseAbiParameters("uint256"), [800n])
    ], 1);

    expect(await balance(contracts.scopl, contracts.buyback)).toBe(800n);
    expect(await balance(contracts.weth, contracts.buyback)).toBe(0n);
  });

  it("rejects a Pons curve buy outside the caller's protected price", async () => {
    const quoteToken = await deploy("MockRevenueToken");
    const curve = await deploy("MockPonsCurve", [contracts.scopl, quoteToken]);
    await write("MockPonsCurve", curve, "configure", [
      10_000n, 1_000_000n, 900_000n, 300n, 200n, 100n
    ]);
    await configurePonsBuyback(curve, quoteToken);
    await write("MockRevenueToken", quoteToken, "mint", [contracts.buyback, 1_000n]);
    await fundBackedWeth(100n);

    await expect(write(
      "ScoplBuybackVault",
      contracts.buyback,
      "executePonsCurveBuy",
      [1_000n, 90_000n],
      1
    )).rejects.toThrow();
    expect(await balance(contracts.scopl, contracts.buyback)).toBe(0n);
    expect(await balance(quoteToken, contracts.buyback)).toBe(1_000n);
  });

  it("cannot bypass the live pre-graduation curve with a router purchase", async () => {
    const curve = await deploy("MockPonsCurve", [contracts.scopl, zeroAddress]);
    await write("MockPonsCurve", curve, "configure", [
      10_000n, 1_000_000n, 900_000n, 0n, 0n, 0n
    ]);
    await configurePonsBuyback(curve, zeroAddress);
    await write("ScoplBuybackVault", contracts.buyback, "setAdapter", [
      contracts.buybackAdapter, true
    ]);
    await fundBackedWeth(1_100n);

    await expect(write("ScoplBuybackVault", contracts.buyback, "executeSwap", [
      contracts.buybackAdapter,
      contracts.weth,
      contracts.scopl,
      1_000n,
      800n,
      encodeAbiParameters(parseAbiParameters("uint256"), [900n])
    ], 1)).rejects.toThrow();
  });
});
