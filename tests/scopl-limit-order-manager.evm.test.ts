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
  parseEther,
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

const MNEMONIC =
  "test test test test test test test test test test test junk";
const chain = defineChain({
  id: 1_339,
  name: "SCOPL limit order tests",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1"] } }
});
const RESERVE = parseEther("0.001");

function compileContracts(): Record<string, Artifact> {
  const sources = Object.fromEntries([
    "ScoplLimitOrderManager.sol",
    "ScoplReferralRewards.sol",
    "test/ScoplLimitOrderManagerMocks.sol"
  ].map((file) => [file, {
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

describe.sequential("ScoplLimitOrderManager EVM behavior", () => {
  let anvil: ChildProcess;
  let rpcUrl: string;
  let publicClient: ReturnType<typeof createPublicClient>;
  let wallets: Array<ReturnType<typeof createWalletClient>>;
  let addresses: Address[];
  let contracts: {
    token0: Address;
    token1: Address;
    scopl: Address;
    weth: Address;
    factory: Address;
    pool: Address;
    npm: Address;
    manager: Address;
    policy: Address;
    distributor: Address;
    referral: Address;
  };
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

  async function deploy(
    name: string,
    args: readonly unknown[] = []
  ): Promise<Address> {
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

  async function balance(token: Address, owner: Address) {
    return read<bigint>("LimitOrderMockERC20", token, "balanceOf", [owner]);
  }

  async function approveUser(approveNft = true) {
    for (const token of [contracts.token0, contracts.token1]) {
      await write("LimitOrderMockERC20", token, "approve", [
        contracts.manager,
        2n ** 256n - 1n
      ], 1);
    }
    if (approveNft) {
      await write(
        "LimitOrderMockPositionManager",
        contracts.npm,
        "setApprovalForAll",
        [contracts.manager, true],
        1
      );
    }
  }

  function createParams({
    tokenIn = contracts.token0,
    tokenOut = contracts.token1,
    tickLower = 60,
    tickUpper = 120,
    amountIn = 10_000n,
    integrationId = `0x${"00".repeat(32)}`,
    optionalReferrer = "0x0000000000000000000000000000000000000000"
  }: Partial<{
    tokenIn: Address;
    tokenOut: Address;
    tickLower: number;
    tickUpper: number;
    amountIn: bigint;
    integrationId: Hex;
    optionalReferrer: Address;
  }> = {}) {
    return {
      tokenIn,
      tokenOut,
      fee: 3_000,
      tickLower,
      tickUpper,
      amountIn,
      amountInMinimum: amountIn * 98n / 100n,
      deadline: BigInt(Math.floor(Date.now() / 1_000) + 3_600),
      integrationId,
      optionalReferrer,
      tierAttestation: {
        user: "0x0000000000000000000000000000000000000000",
        destinationChainId: 0n,
        beneficiaryShareBps: 0,
        expiry: 0
      },
      tierSignature: "0x"
    };
  }

  async function createOrder(params = createParams()) {
    return write(
      "ScoplLimitOrderManager",
      contracts.manager,
      "createOrder",
      [params],
      1,
      RESERVE
    );
  }

  beforeAll(async () => {
    const port = 19_545 + process.pid % 1_000;
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

    const first = await deploy("LimitOrderMockERC20", ["First", "ONE", 6]);
    const second = await deploy("LimitOrderMockERC20", ["Second", "TWO", 18]);
    const [token0, token1] = first.toLowerCase() < second.toLowerCase()
      ? [first, second]
      : [second, first];
    const weth = await deploy("LimitOrderMockWETH");
    const scopl = await deploy("LimitOrderMockERC20", ["SCOPL", "SCOPL", 18]);
    const factory = await deploy("LimitOrderMockFactory");
    const pool = await deploy("LimitOrderMockPool", [60, 0]);
    const npm = await deploy("LimitOrderMockPositionManager", [factory, weth]);
    await write("LimitOrderMockFactory", factory, "setPool", [
      token0,
      token1,
      3_000,
      pool
    ]);
    const distributor = await deploy(
      "LimitOrderMockRevenueDistributor",
      [addresses[2]]
    );
    const policy = await deploy("LimitOrderMockPolicy");
    await write("LimitOrderMockPolicy", policy, "setIntegrationRecipient", [addresses[5]]);
    const manager = await deploy("ScoplLimitOrderManager", [
      addresses[0],
      distributor,
      policy,
      factory,
      npm,
      weth,
      RESERVE
    ]);
    const referral = await deploy("ScoplReferralRewards", [addresses[0]]);
    await write("ScoplReferralRewards", referral, "setRevenueCreditorAllowed", [
      distributor, true
    ]);
    await write("LimitOrderMockRevenueDistributor", distributor, "setReferralRewards", [
      referral
    ]);
    contracts = {
      token0,
      token1,
      scopl,
      weth,
      factory,
      pool,
      npm,
      manager,
      policy,
      distributor,
      referral
    };
    for (const token of [token0, token1]) {
      await write("LimitOrderMockERC20", token, "mint", [addresses[1], 1_000_000n]);
    }
    snapshot = await rpc("evm_snapshot") as string;
  }, 60_000);

  beforeEach(async () => {
    await rpc("evm_revert", [snapshot]);
    snapshot = await rpc("evm_snapshot") as string;
  });

  afterAll(() => anvil.kill());

  it("rejects position managers bound to different V3 dependencies", async () => {
    const otherFactory = await deploy("LimitOrderMockFactory");
    await expect(deploy("ScoplLimitOrderManager", [
      addresses[0],
      contracts.distributor,
      contracts.policy,
      otherFactory,
      contracts.npm,
      contracts.weth,
      RESERVE
    ])).rejects.toThrow();

    const otherWeth = await deploy("LimitOrderMockWETH");
    await expect(deploy("ScoplLimitOrderManager", [
      addresses[0],
      contracts.distributor,
      contracts.policy,
      contracts.factory,
      contracts.npm,
      otherWeth,
      RESERVE
    ])).rejects.toThrow();
  });

  it("creates a token0 sell as a user-owned, one-spacing NFT and refunds dust", async () => {
    await approveUser();
    const before = await balance(contracts.token0, addresses[1]);
    await createOrder();
    const order = await read<readonly unknown[]>(
      "ScoplLimitOrderManager",
      contracts.manager,
      "orders",
      [1n]
    );
    expect(order[0]).toBe(addresses[1]);
    expect((order[2] as string).toLowerCase()).toBe(contracts.token0.toLowerCase());
    expect((order[3] as string).toLowerCase()).toBe(contracts.token1.toLowerCase());
    expect(order[11]).toBe(60);
    expect(order[12]).toBe(120);
    expect(order[13]).toBe(true);
    expect(await balance(contracts.token0, addresses[1])).toBe(before - 9_900n);
    expect(await read<Address>(
      "LimitOrderMockPositionManager",
      contracts.npm,
      "ownerOf",
      [1n]
    )).toBe(addresses[1]);
    expect(await read<bigint>(
      "ScoplLimitOrderManager",
      contracts.manager,
      "activeOrderCount",
      [addresses[1]]
    )).toBe(1n);
  });

  it("combines native ETH and existing WETH in one V3 order transaction", async () => {
    const amountIn = parseEther("0.01");
    const nativeFunding = parseEther("0.004");
    const wrappedFunding = amountIn - nativeFunding;
    const pairedToken = contracts.token0;
    const sellToken0 = contracts.weth.toLowerCase() < pairedToken.toLowerCase();
    const tickLower = sellToken0 ? 60 : -120;
    const tickUpper = sellToken0 ? 120 : -60;
    const mixedPool = await deploy("LimitOrderMockPool", [60, 0]);
    await write("LimitOrderMockFactory", contracts.factory, "setPool", [
      contracts.weth,
      pairedToken,
      3_000,
      mixedPool
    ]);
    await write("LimitOrderMockWETH", contracts.weth, "deposit", [], 0, wrappedFunding);
    await write("LimitOrderMockWETH", contracts.weth, "mint", [
      addresses[1],
      wrappedFunding
    ]);
    await write("LimitOrderMockWETH", contracts.weth, "approve", [
      contracts.manager,
      2n ** 256n - 1n
    ], 1);
    await write(
      "LimitOrderMockPositionManager",
      contracts.npm,
      "setApprovalForAll",
      [contracts.manager, true],
      1
    );

    await write(
      "ScoplLimitOrderManager",
      contracts.manager,
      "createOrderFromNative",
      [createParams({
        tokenIn: contracts.weth,
        tokenOut: pairedToken,
        tickLower,
        tickUpper,
        amountIn
      }), RESERVE],
      1,
      nativeFunding + RESERVE
    );

    const order = await read<readonly unknown[]>(
      "ScoplLimitOrderManager",
      contracts.manager,
      "orders",
      [1n]
    );
    expect(order[7]).toBe(amountIn - amountIn / 100n);
    expect(await balance(contracts.weth, addresses[1])).toBe(0n);
    expect(await publicClient.getBalance({ address: contracts.manager })).toBe(RESERVE);

    await write(
      "ScoplLimitOrderManager",
      contracts.manager,
      "cancelOrder",
      [1n],
      1
    );
    expect(await balance(contracts.weth, addresses[1])).toBe(0n);
    expect(await publicClient.getBalance({ address: contracts.manager })).toBe(0n);
  });

  it("rejects missing NFT approval, overlapping ranges, bad spacing, and low reserve", async () => {
    await approveUser(false);
    await expect(createOrder()).rejects.toThrow();
    await approveUser(true);
    await expect(createOrder(createParams({ tickLower: 0, tickUpper: 60 })))
      .rejects.toThrow();
    await expect(createOrder(createParams({ tickLower: 61, tickUpper: 121 })))
      .rejects.toThrow();
    await expect(write(
      "ScoplLimitOrderManager",
      contracts.manager,
      "createOrder",
      [createParams()],
      1,
      RESERVE - 1n
    )).rejects.toThrow();
  });

  it("executes only at the fully crossed boundary and never taxes principal", async () => {
    await approveUser();
    await createOrder();
    await write("LimitOrderMockPositionManager", contracts.npm, "accrueFees", [
      1n,
      25n,
      100n
    ]);
    expect(await read<boolean>(
      "ScoplLimitOrderManager",
      contracts.manager,
      "isExecutable",
      [1n]
    )).toBe(false);
    await write("LimitOrderMockPool", contracts.pool, "setTick", [119]);
    await expect(write(
      "ScoplLimitOrderManager",
      contracts.manager,
      "executeOrder",
      [1n],
      3
    )).rejects.toThrow();
    await write("LimitOrderMockPool", contracts.pool, "setTick", [120]);
    expect(await read<boolean>(
      "ScoplLimitOrderManager",
      contracts.manager,
      "isExecutable",
      [1n]
    )).toBe(true);
    const ownerBefore = await balance(contracts.token1, addresses[1]);
    await write(
      "ScoplLimitOrderManager",
      contracts.manager,
      "executeOrder",
      [1n],
      3
    );
    expect(await balance(contracts.token1, addresses[2])).toBe(90n);
    expect(await balance(contracts.token1, addresses[1])).toBe(ownerBefore + 9_910n);
    expect(await balance(contracts.token0, addresses[1])).toBe(990_102n);
    expect(await publicClient.getBalance({ address: contracts.manager })).toBe(0n);
    await expect(write(
      "ScoplLimitOrderManager",
      contracts.manager,
      "executeOrder",
      [1n],
      4
    )).rejects.toThrow();
  });

  it("stores direct economics and splits only generated LP fees", async () => {
    await approveUser();
    await createOrder();
    await write("LimitOrderMockPositionManager", contracts.npm, "accrueFees", [
      1n,
      25n,
      100n
    ]);
    await write("LimitOrderMockPool", contracts.pool, "setTick", [120]);
    const ownerOutputBefore = await balance(contracts.token1, addresses[1]);
    await write(
      "ScoplLimitOrderManager",
      contracts.manager,
      "executeOrder",
      [1n],
      3
    );
    expect(await balance(contracts.token1, addresses[1]) - ownerOutputBefore)
      .toBe(9_910n);
    expect(await balance(contracts.token0, addresses[2])).toBe(23n);
    expect(await balance(contracts.token1, addresses[2])).toBe(90n);
    expect(await read<readonly [number, Hex, Address, number, Address, number, number, Address]>(
      "ScoplLimitOrderManager",
      contracts.manager,
      "orderEconomics",
      [1n]
    )).toEqual([
      0,
      `0x${"00".repeat(32)}`,
      addresses[1],
      1_000,
      "0x0000000000000000000000000000000000000000",
      0,
      9_000,
      "0x0000000000000000000000000000000000000000"
    ]);
  });

  it("freezes registered integration economics and excludes referral input", async () => {
    await approveUser();
    const integrationId: Hex = `0x${"42".repeat(32)}`;
    await createOrder(createParams({ integrationId, optionalReferrer: addresses[3] }));
    await write("LimitOrderMockPolicy", contracts.policy, "setIntegrationPolicy", [
      addresses[4], 5_000
    ]);
    await write("LimitOrderMockPositionManager", contracts.npm, "accrueFees", [
      1n, 0n, 100n
    ]);
    await write("LimitOrderMockPool", contracts.pool, "setTick", [120]);
    const ownerBefore = await balance(contracts.token1, addresses[1]);
    await write("ScoplLimitOrderManager", contracts.manager, "executeOrder", [1n], 3);
    expect(await balance(contracts.token1, addresses[1]) - ownerBefore).toBe(9_925n);
    expect(await balance(contracts.token1, addresses[5])).toBe(50n);
    expect(await balance(contracts.token1, addresses[4])).toBe(0n);
    expect(await balance(contracts.token1, addresses[2])).toBe(25n);
    expect(await balance(contracts.token1, contracts.referral)).toBe(0n);
    expect(await read<readonly [number, Hex, Address, number, Address, number, number, Address]>(
      "ScoplLimitOrderManager",
      contracts.manager,
      "orderEconomics",
      [1n]
    )).toEqual([
      1,
      integrationId,
      addresses[1],
      2_500,
      addresses[5],
      5_000,
      2_500,
      "0x0000000000000000000000000000000000000000"
    ]);
  });

  it.each([
    [0, 0n, 75n, 26n],
    [2_500, 25n, 50n, 26n],
    [5_000, 50n, 25n, 26n],
    [7_500, 75n, 0n, 26n]
  ])("settles integration userShare %s with exact rounding", async (
    userShareBps,
    expectedUser,
    expectedIntegrator,
    expectedProtocol
  ) => {
    await write("LimitOrderMockPolicy", contracts.policy, "setIntegrationPolicy", [
      addresses[5], userShareBps
    ]);
    await approveUser();
    await createOrder(createParams({ integrationId: `0x${"42".repeat(32)}` }));
    await write("LimitOrderMockPositionManager", contracts.npm, "accrueFees", [
      1n, 0n, 101n
    ]);
    await write("LimitOrderMockPool", contracts.pool, "setTick", [120]);
    const ownerBefore = await balance(contracts.token1, addresses[1]);
    await write("ScoplLimitOrderManager", contracts.manager, "executeOrder", [1n], 3);
    expect(await balance(contracts.token1, addresses[1]) - ownerBefore)
      .toBe(9_900n + expectedUser);
    expect(await balance(contracts.token1, addresses[5])).toBe(expectedIntegrator);
    expect(await balance(contracts.token1, addresses[2])).toBe(expectedProtocol);
  });

  it("makes an order non-executable after its owner claims LP fees", async () => {
    await approveUser();
    await createOrder();
    await write("LimitOrderMockPositionManager", contracts.npm, "accrueFees", [
      1n,
      25n,
      100n
    ]);
    await write(
      "LimitOrderMockPositionManager",
      contracts.npm,
      "collect",
      [{
        tokenId: 1n,
        recipient: addresses[1],
        amount0Max: 2n ** 128n - 1n,
        amount1Max: 2n ** 128n - 1n
      }],
      1
    );
    await write("LimitOrderMockPool", contracts.pool, "setTick", [120]);
    expect(await read<boolean>(
      "ScoplLimitOrderManager",
      contracts.manager,
      "isExecutable",
      [1n]
    )).toBe(false);
    await expect(write(
      "ScoplLimitOrderManager",
      contracts.manager,
      "executeOrder",
      [1n],
      3
    )).rejects.toThrow();
  });

  it("splits accrued LP fees on cancellation while returning all principal", async () => {
    await approveUser();
    await createOrder();
    await write("LimitOrderMockPositionManager", contracts.npm, "accrueFees", [
      1n,
      25n,
      100n
    ]);
    const owner0Before = await balance(contracts.token0, addresses[1]);
    const owner1Before = await balance(contracts.token1, addresses[1]);
    await write(
      "ScoplLimitOrderManager",
      contracts.manager,
      "cancelOrder",
      [1n],
      1
    );
    expect(await balance(contracts.token0, addresses[1]) - owner0Before)
      .toBe(9_902n);
    expect(await balance(contracts.token1, addresses[1]) - owner1Before)
      .toBe(10n);
    expect(await balance(contracts.token0, addresses[2])).toBe(23n);
    expect(await balance(contracts.token1, addresses[2])).toBe(90n);
  });

  it("supports the inverse token1 direction and strict lower-bound execution", async () => {
    await approveUser();
    await createOrder(createParams({
      tokenIn: contracts.token1,
      tokenOut: contracts.token0,
      tickLower: -120,
      tickUpper: -60
    }));
    await write("LimitOrderMockPool", contracts.pool, "setTick", [-120]);
    expect(await read<boolean>(
      "ScoplLimitOrderManager",
      contracts.manager,
      "isExecutable",
      [1n]
    )).toBe(false);
    await write("LimitOrderMockPool", contracts.pool, "setTick", [-121]);
    expect(await read<boolean>(
      "ScoplLimitOrderManager",
      contracts.manager,
      "isExecutable",
      [1n]
    )).toBe(true);
    await write(
      "ScoplLimitOrderManager",
      contracts.manager,
      "executeOrder",
      [1n],
      3
    );
    expect(await balance(contracts.token0, addresses[2])).toBe(0n);
  });

  it("unwraps V3 WETH proceeds so the user receives native ETH", async () => {
    const pairedToken = contracts.token0;
    const sellToken0 = pairedToken.toLowerCase() < contracts.weth.toLowerCase();
    const tickLower = sellToken0 ? 60 : -120;
    const tickUpper = sellToken0 ? 120 : -60;
    const wethPool = await deploy("LimitOrderMockPool", [60, 0]);
    await write("LimitOrderMockFactory", contracts.factory, "setPool", [
      pairedToken,
      contracts.weth,
      3_000,
      wethPool
    ]);
    await write("LimitOrderMockWETH", contracts.weth, "deposit", [], 0, 10_000n);
    await approveUser();
    await createOrder(createParams({
      tokenIn: pairedToken,
      tokenOut: contracts.weth,
      tickLower,
      tickUpper
    }));
    await write(
      "LimitOrderMockPool",
      wethPool,
      "setTick",
      [sellToken0 ? tickUpper : tickLower - 1]
    );
    const ownerNativeBefore = await publicClient.getBalance({
      address: addresses[1]
    });
    await write(
      "ScoplLimitOrderManager",
      contracts.manager,
      "executeOrder",
      [1n],
      3
    );
    expect(await publicClient.getBalance({ address: addresses[1] }))
      .toBe(ownerNativeBefore + 9_900n);
    expect(await balance(contracts.weth, addresses[1])).toBe(0n);
    expect(await balance(contracts.weth, addresses[2])).toBe(0n);
  });

  it("funds claimable referral rewards from the protocol LP-fee share", async () => {
    await approveUser();
    await write(
      "LimitOrderMockPolicy",
      contracts.policy,
      "setDirectPolicy",
      [5_000, addresses[4]]
    );
    await createOrder();
    await write("LimitOrderMockPositionManager", contracts.npm, "accrueFees", [
      1n, 0n, 100n
    ]);
    await write("LimitOrderMockPool", contracts.pool, "setTick", [120]);
    await write(
      "ScoplLimitOrderManager",
      contracts.manager,
      "executeOrder",
      [1n],
      3
    );
    expect(await balance(contracts.token1, addresses[2])).toBe(35n);
    expect(await balance(contracts.token1, contracts.referral)).toBe(15n);
    expect(await read<readonly [bigint, bigint, bigint]>(
      "ScoplReferralRewards",
      contracts.referral,
      "claimable",
      [addresses[4], contracts.token1]
    )).toEqual([0n, 15n, 15n]);
  });

  it("keeps the creation-time policy immutable when policy tiers later change", async () => {
    await write(
      "LimitOrderMockPolicy", contracts.policy, "setDirectPolicy", [7_500, addresses[4]]
    );
    await approveUser();
    await createOrder();
    await write(
      "LimitOrderMockPolicy", contracts.policy, "setDirectPolicy", [5_000, addresses[5]]
    );
    await createOrder();
    expect(await read<readonly [number, Hex, Address, number, Address, number, number, Address]>(
      "ScoplLimitOrderManager", contracts.manager, "orderEconomics", [2n]
    )).toEqual([
      0, `0x${"00".repeat(32)}`, addresses[1], 5_000,
      "0x0000000000000000000000000000000000000000", 0, 5_000, addresses[5]
    ]);
    await write("LimitOrderMockPositionManager", contracts.npm, "accrueFees", [
      1n, 0n, 100n
    ]);
    await write("LimitOrderMockPool", contracts.pool, "setTick", [120]);
    await write(
      "ScoplLimitOrderManager",
      contracts.manager,
      "executeOrder",
      [1n],
      3
    );
    expect(await balance(contracts.token1, addresses[2])).toBe(18n);
    expect(await balance(contracts.token1, addresses[1])).toBe(1_009_975n);
  });

  it("executes normally when the referral module is unavailable", async () => {
    const revertingReferral = await deploy("RevertingLimitOrderReferral");
    await write(
      "LimitOrderMockRevenueDistributor",
      contracts.distributor,
      "setReferralRewards",
      [revertingReferral]
    );
    await approveUser();
    await write(
      "LimitOrderMockPolicy", contracts.policy, "setDirectPolicy", [5_000, addresses[4]]
    );
    await createOrder();
    await write("LimitOrderMockPositionManager", contracts.npm, "accrueFees", [
      1n, 0n, 100n
    ]);
    await write("LimitOrderMockPool", contracts.pool, "setTick", [120]);
    await write(
      "ScoplLimitOrderManager",
      contracts.manager,
      "executeOrder",
      [1n],
      3
    );
    expect(await balance(contracts.token1, addresses[2])).toBe(50n);
    expect(await balance(contracts.token1, addresses[1])).toBe(1_009_950n);
  });

  it("lets a contract keeper choose WETH for its reserve reward", async () => {
    const keeper = await deploy("CreditWithdrawingKeeper");
    await write(
      "CreditWithdrawingKeeper",
      keeper,
      "setWrappedPreference",
      [contracts.manager, true]
    );
    await approveUser();
    await createOrder();
    await write("LimitOrderMockPool", contracts.pool, "setTick", [120]);
    await write(
      "CreditWithdrawingKeeper",
      keeper,
      "execute",
      [contracts.manager, 1n],
      3
    );
    expect(await balance(contracts.weth, keeper)).toBe(RESERVE);
    expect(await publicClient.getBalance({ address: contracts.manager })).toBe(0n);
  });

  it("tracks reversal risk without treating a past crossing as final", async () => {
    await approveUser();
    await createOrder();
    await write("LimitOrderMockPool", contracts.pool, "setTick", [120]);
    expect(await read<boolean>(
      "ScoplLimitOrderManager",
      contracts.manager,
      "isExecutable",
      [1n]
    )).toBe(true);
    await write("LimitOrderMockPool", contracts.pool, "setTick", [90]);
    expect(await read<boolean>(
      "ScoplLimitOrderManager",
      contracts.manager,
      "isExecutable",
      [1n]
    )).toBe(false);
    await write("LimitOrderMockPool", contracts.pool, "setTick", [121]);
    expect(await read<boolean>(
      "ScoplLimitOrderManager",
      contracts.manager,
      "isExecutable",
      [1n]
    )).toBe(true);
  });

  it("cancels inside the range with both assets, no fee, and reserve refund", async () => {
    await approveUser();
    await createOrder();
    await write("LimitOrderMockPool", contracts.pool, "setTick", [90]);
    const treasury0 = await balance(contracts.token0, addresses[2]);
    const treasury1 = await balance(contracts.token1, addresses[2]);
    await write(
      "ScoplLimitOrderManager",
      contracts.manager,
      "cancelOrder",
      [1n],
      1
    );
    expect(await balance(contracts.token0, addresses[1])).toBe(995_050n);
    expect(await balance(contracts.token1, addresses[1])).toBe(1_004_950n);
    expect(await balance(contracts.token0, addresses[2])).toBe(treasury0);
    expect(await balance(contracts.token1, addresses[2])).toBe(treasury1);
    expect(await publicClient.getBalance({ address: contracts.manager })).toBe(0n);
    expect(await read<bigint>(
      "ScoplLimitOrderManager",
      contracts.manager,
      "activeOrderCount",
      [addresses[1]]
    )).toBe(0n);
  });

  it("marks transferred or approval-revoked NFTs stale and only credits the recorded owner", async () => {
    await approveUser();
    await createOrder();
    await write(
      "LimitOrderMockPositionManager",
      contracts.npm,
      "transferPosition",
      [1n, addresses[4]],
      1
    );
    expect(await read<boolean>(
      "ScoplLimitOrderManager",
      contracts.manager,
      "isExecutable",
      [1n]
    )).toBe(false);
    await write(
      "ScoplLimitOrderManager",
      contracts.manager,
      "markOrderStale",
      [1n],
      5
    );
    expect(await publicClient.getBalance({ address: contracts.manager })).toBe(0n);
  });

  it("creation and execution pauses cannot trap cancellation", async () => {
    await approveUser();
    await createOrder();
    await write("ScoplLimitOrderManager", contracts.manager, "setPaused", [true]);
    await expect(createOrder()).rejects.toThrow();
    await write(
      "ScoplLimitOrderManager",
      contracts.manager,
      "setExecutionPaused",
      [true]
    );
    await write("LimitOrderMockPool", contracts.pool, "setTick", [120]);
    await expect(write(
      "ScoplLimitOrderManager",
      contracts.manager,
      "executeOrder",
      [1n],
      2
    )).rejects.toThrow();
    await write(
      "ScoplLimitOrderManager",
      contracts.manager,
      "cancelOrder",
      [1n],
      1
    );
  });

  it("paginates historical owner orders", async () => {
    await approveUser();
    await createOrder();
    expect(await read<bigint>(
      "ScoplLimitOrderManager",
      contracts.manager,
      "getOrderCountByOwner",
      [addresses[1]]
    )).toBe(1n);
    expect(await read<readonly bigint[]>(
      "ScoplLimitOrderManager",
      contracts.manager,
      "getOrdersByOwnerPage",
      [addresses[1], 0n, 20n]
    )).toEqual([1n]);
  });

  it("hard-caps beneficiary economics at 75% and protects recipients", async () => {
    expect(await read<number>(
      "ScoplLimitOrderManager",
      contracts.manager,
      "MAX_BENEFICIARY_SHARE_BPS"
    )).toBe(7_500);
    expect(await read<number>(
      "ScoplLimitOrderManager",
      contracts.manager,
      "MIN_PROTOCOL_SHARE_BPS"
    )).toBe(2_500);
    await expect(write(
      "ScoplLimitOrderManager",
      contracts.manager,
      "setRevenueDistributor",
      [addresses[5]],
      1
    )).rejects.toThrow();
  });
});
