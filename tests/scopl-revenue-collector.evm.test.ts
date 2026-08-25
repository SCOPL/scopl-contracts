// @vitest-environment node

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import solc from "solc";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  stringToHex,
  type Abi,
  type Address,
  type Hex
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

interface Artifact { abi: Abi; bytecode: Hex }
const MNEMONIC = "test test test test test test test test test test test junk";
const chain = defineChain({
  id: 1_342,
  name: "SCOPL revenue collector tests",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1"] } }
});

function compile(): Record<string, Artifact> {
  const files = [
    "ScoplRevenueCollector.sol",
    "ScoplRevenueDistributor.sol",
    "ScoplReferralRewards.sol",
    "test/ScoplRevenueMocks.sol"
  ];
  const sources = Object.fromEntries(files.map((file) => [file, {
    content: readFileSync(resolve(process.cwd(), "contracts", file), "utf8")
  }]));
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity", sources,
    settings: {
      optimizer: { enabled: true, runs: 200 }, viaIR: true,
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } }
    }
  }))) as {
    contracts?: Record<string, Record<string, { abi: Abi; evm: { bytecode: { object: string } } }>>;
    errors?: Array<{ severity: string; formattedMessage: string }>;
  };
  expect((output.errors ?? []).filter((item) => item.severity === "error")
    .map((item) => item.formattedMessage)).toEqual([]);
  const result: Record<string, Artifact> = {};
  for (const group of Object.values(output.contracts ?? {})) {
    for (const [name, contract] of Object.entries(group)) {
      result[name] = { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` };
    }
  }
  return result;
}

const artifacts = compile();

describe.sequential("ScoplRevenueCollector EVM behavior", () => {
  let anvil: ChildProcess;
  let rpcUrl: string;
  let publicClient: ReturnType<typeof createPublicClient>;
  let wallets: Array<ReturnType<typeof createWalletClient>>;
  let addresses: Address[];
  let contracts: Record<string, Address>;
  let snapshot: string;

  async function rpc(method: string, params: unknown[] = []) {
    const response = await fetch(rpcUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    const body = await response.json() as { result?: unknown; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result;
  }

  async function deploy(name: string, args: readonly unknown[] = []) {
    const hash = await wallets[0].deployContract({
      abi: artifacts[name].abi, bytecode: artifacts[name].bytecode, args
    } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error(`${name} deployment failed`);
    return receipt.contractAddress;
  }

  async function write(
    name: string, address: Address, functionName: string,
    args: readonly unknown[] = [], accountIndex = 0
  ) {
    const hash = await wallets[accountIndex].writeContract({
      address, abi: artifacts[name].abi, functionName, args
    } as never);
    return publicClient.waitForTransactionReceipt({ hash });
  }

  async function read<T>(name: string, address: Address, functionName: string, args: readonly unknown[] = []) {
    return publicClient.readContract({ address, abi: artifacts[name].abi, functionName, args }) as Promise<T>;
  }

  async function balance(token: Address, owner: Address) {
    return read<bigint>("MockRevenueToken", token, "balanceOf", [owner]);
  }

  beforeAll(async () => {
    const port = 28_000 + process.pid % 1_000;
    rpcUrl = `http://127.0.0.1:${port}`;
    anvil = spawn(process.execPath, [
      resolve(process.cwd(), "node_modules/@foundry-rs/anvil/bin.mjs"),
      "--port", String(port), "--chain-id", String(chain.id),
      "--mnemonic", MNEMONIC, "--silent"
    ], { stdio: "ignore", windowsHide: true });
    for (let attempt = 0; attempt < 50; attempt++) {
      try { await rpc("eth_chainId"); break; } catch {
        await new Promise((done) => setTimeout(done, 100));
      }
    }
    const transport = http(rpcUrl);
    publicClient = createPublicClient({ chain, transport });
    wallets = Array.from({ length: 6 }, (_, index) => createWalletClient({
      account: mnemonicToAccount(MNEMONIC, { addressIndex: index }), chain, transport
    }));
    addresses = wallets.map((wallet) => wallet.account!.address);
    const weth = await deploy("MockRevenueToken");
    const token = await deploy("MockRevenueToken");
    const source = await deploy("MockRevenueSource");
    const adapter = await deploy("MockCollectorAdapter");
    const provider = await deploy("MockCollectorBridgeProvider");
    const referrals = await deploy("ScoplReferralRewards", [addresses[0]]);
    const collector = await deploy("ScoplRevenueCollector", [
      addresses[0], weth, 4_663n, addresses[5]
    ]);
    const distributor = await deploy("ScoplRevenueDistributor", [
      addresses[0], addresses[0], weth, referrals, source, addresses[4]
    ]);
    contracts = { weth, token, source, adapter, provider, referrals, collector, distributor };
    await write("ScoplRevenueCollector", collector, "setRevenueSource", [source, true]);
    await write("ScoplRevenueCollector", collector, "setNormalizer", [addresses[1], true]);
    await write("ScoplRevenueCollector", collector, "setBridgeExecutor", [addresses[2], true]);
    await write("ScoplRevenueCollector", collector, "setAdapter", [adapter, true]);
    await write("ScoplRevenueCollector", collector, "setBridgeProvider", [provider, true]);
    await write("ScoplRevenueDistributor", distributor, "setRevenueSource", [source, 1, true]);
    await write("ScoplRevenueDistributor", distributor, "setBuybackCollector", [collector]);
    await write("ScoplRevenueCollector", collector, "setRevenueSource", [distributor, true]);
    await write("ScoplReferralRewards", referrals, "setRevenueCreditorAllowed", [distributor, true]);
    snapshot = await rpc("evm_snapshot") as string;
  }, 60_000);

  beforeEach(async () => {
    await rpc("evm_revert", [snapshot]);
    snapshot = await rpc("evm_snapshot") as string;
  });

  afterAll(() => anvil?.kill("SIGTERM"));

  it("accepts only exact, unique buyback deposits from approved sources", async () => {
    const id = keccak256(stringToHex("deposit"));
    await write("MockRevenueToken", contracts.token, "mint", [contracts.source, 1_000n]);
    await write("MockRevenueSource", contracts.source, "depositCollector", [
      contracts.collector, id, contracts.token, 1_000n
    ]);
    expect(await read<bigint>(
      "ScoplRevenueCollector", contracts.collector, "accountedBuybackBalance", [contracts.token]
    )).toBe(1_000n);
    await expect(write("MockRevenueSource", contracts.source, "depositCollector", [
      contracts.collector, id, contracts.token, 1n
    ])).rejects.toThrow();
    await expect(write("ScoplRevenueCollector", contracts.collector, "depositBuyback", [
      keccak256(stringToHex("unauthorized")), contracts.token, 1n
    ], 3)).rejects.toThrow();
  });

  it("normalizes accounted fee assets to WETH with exact balance deltas", async () => {
    await write("MockRevenueToken", contracts.token, "mint", [contracts.source, 1_000n]);
    await write("MockRevenueSource", contracts.source, "depositCollector", [
      contracts.collector, keccak256(stringToHex("normalize-deposit")), contracts.token, 1_000n
    ]);
    await write("MockCollectorAdapter", contracts.adapter, "setAmountOut", [800n]);
    await write("ScoplRevenueCollector", contracts.collector, "normalizeToWeth", [
      keccak256(stringToHex("normalization")), contracts.token, 1_000n,
      contracts.adapter, 790n, "0x"
    ], 1);
    expect(await read<bigint>(
      "ScoplRevenueCollector", contracts.collector, "accountedBuybackBalance", [contracts.token]
    )).toBe(0n);
    expect(await read<bigint>(
      "ScoplRevenueCollector", contracts.collector, "accountedBuybackBalance", [contracts.weth]
    )).toBe(800n);
  });

  it("rejects unauthorized adapters, slippage, duplicate normalizations, and unaccounted assets", async () => {
    await write("MockRevenueToken", contracts.token, "mint", [contracts.source, 1_000n]);
    await write("MockRevenueSource", contracts.source, "depositCollector", [
      contracts.collector, keccak256(stringToHex("negative-deposit")), contracts.token, 1_000n
    ]);
    const normalizationId = keccak256(stringToHex("negative-normalization"));
    await write("MockCollectorAdapter", contracts.adapter, "setAmountOut", [700n]);
    await expect(write("ScoplRevenueCollector", contracts.collector, "normalizeToWeth", [
      normalizationId, contracts.token, 1_000n, contracts.source, 600n, "0x"
    ], 1)).rejects.toThrow();
    await expect(write("ScoplRevenueCollector", contracts.collector, "normalizeToWeth", [
      normalizationId, contracts.token, 1_000n, contracts.adapter, 701n, "0x"
    ], 1)).rejects.toThrow();
    await write("ScoplRevenueCollector", contracts.collector, "normalizeToWeth", [
      normalizationId, contracts.token, 1_000n, contracts.adapter, 700n, "0x"
    ], 1);
    await expect(write("ScoplRevenueCollector", contracts.collector, "normalizeToWeth", [
      normalizationId, contracts.token, 1n, contracts.adapter, 1n, "0x"
    ], 1)).rejects.toThrow();
  });

  it("bridges only accounted WETH through an allowlisted replaceable provider", async () => {
    await write("MockRevenueToken", contracts.weth, "mint", [contracts.source, 900n]);
    await write("MockRevenueSource", contracts.source, "depositCollector", [
      contracts.collector, keccak256(stringToHex("weth-deposit")), contracts.weth, 900n
    ]);
    const sweepId = keccak256(stringToHex("sweep"));
    await write("ScoplRevenueCollector", contracts.collector, "bridgeWeth", [
      sweepId, 800n, contracts.provider, "0x1234"
    ], 2);
    expect(await balance(contracts.weth, contracts.provider)).toBe(800n);
    expect(await read<bigint>(
      "MockCollectorBridgeProvider", contracts.provider, "lastDestinationChainId"
    )).toBe(4_663n);
    expect(await read<Address>(
      "MockCollectorBridgeProvider", contracts.provider, "lastDestinationVault"
    )).toBe(addresses[5]);
    expect(await read<bigint>(
      "ScoplRevenueCollector", contracts.collector, "accountedBuybackBalance", [contracts.weth]
    )).toBe(100n);
    await expect(write("ScoplRevenueCollector", contracts.collector, "bridgeWeth", [
      sweepId, 1n, contracts.provider, "0x"
    ], 2)).rejects.toThrow();
  });

  it("routes only the distributor buyback allocation into the collector", async () => {
    await write("ScoplReferralRewards", contracts.referrals, "bindReferrer", [addresses[3]], 1);
    await write("MockRevenueToken", contracts.token, "mint", [contracts.source, 1_000n]);
    await write("MockRevenueSource", contracts.source, "distributeAttributedToken", [
      contracts.distributor, keccak256(stringToHex("integration-revenue")),
      addresses[1], "0x0000000000000000000000000000000000000000",
      contracts.token, 1_000n
    ]);
    expect(await balance(contracts.token, contracts.collector)).toBe(500n);
    expect(await balance(contracts.token, addresses[4])).toBe(500n);
    expect(await balance(contracts.token, contracts.referrals)).toBe(0n);
  });

  it("pauses movement and permits recovery of excess only", async () => {
    await write("MockRevenueToken", contracts.weth, "mint", [contracts.source, 500n]);
    await write("MockRevenueSource", contracts.source, "depositCollector", [
      contracts.collector, keccak256(stringToHex("pause-deposit")), contracts.weth, 400n
    ]);
    await write("MockRevenueToken", contracts.weth, "mint", [contracts.collector, 100n]);
    await write("ScoplRevenueCollector", contracts.collector, "setPaused", [true]);
    await expect(write("ScoplRevenueCollector", contracts.collector, "bridgeWeth", [
      keccak256(stringToHex("paused-sweep")), 1n, contracts.provider, "0x"
    ], 2)).rejects.toThrow();
    await expect(write("ScoplRevenueCollector", contracts.collector, "recoverExcess", [
      contracts.weth, addresses[3], 101n
    ])).rejects.toThrow();
    await write("ScoplRevenueCollector", contracts.collector, "recoverExcess", [
      contracts.weth, addresses[3], 100n
    ]);
    expect(await balance(contracts.weth, addresses[3])).toBe(100n);
    expect(await read<bigint>(
      "ScoplRevenueCollector", contracts.collector, "accountedBuybackBalance", [contracts.weth]
    )).toBe(400n);
  });
});
