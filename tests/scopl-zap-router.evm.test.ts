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
  encodePacked,
  http,
  keccak256,
  parseAbiParameters,
  type Abi,
  type Address,
  type Hex
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { maximumLiquidityForZap } from "./helpers/zap-liquidity";

interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

const MNEMONIC =
  "test test test test test test test test test test test junk";
const chain = defineChain({
  id: 1_340,
  name: "SCOPL zap tests",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1"] } }
});

function compileContracts(): Record<string, Artifact> {
  const sources = Object.fromEntries([
    "ScoplZapRouter.sol",
    "test/ScoplZapRouterMocks.sol"
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

describe.sequential("ScoplZapRouter EVM behavior", () => {
  let anvil: ChildProcess;
  let rpcUrl: string;
  let publicClient: ReturnType<typeof createPublicClient>;
  let wallets: Array<ReturnType<typeof createWalletClient>>;
  let addresses: Address[];
  let contracts: {
    token0: Address;
    token1: Address;
    source: Address;
    permit2: Address;
    v3SwapRouter: Address;
    v3PositionManager: Address;
    v4PositionManager: Address;
    v4StateView: Address;
    universalRouter: Address;
    weth: Address;
    zap: Address;
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

  async function balance(token: Address, owner: Address) {
    return read<bigint>("ZapMockERC20", token, "balanceOf", [owner]);
  }

  function deadline() {
    return BigInt(Math.floor(Date.now() / 1_000) + 3_600);
  }

  function v3Params(overrides: Record<string, unknown> = {}) {
    return {
      token0: contracts.token0,
      token1: contracts.token1,
      sourceToken: contracts.token0,
      preparationPath: "0x",
      preparationAmountOutMinimum: 0n,
      fee: 3_000,
      tickLower: -60,
      tickUpper: 60,
      zeroForOne: true,
      amountIn: 1_000n,
      swapAmountIn: 400n,
      amountOutMinimum: 400n,
      amount0Min: 0n,
      amount1Min: 0n,
      deadline: deadline(),
      ...overrides
    };
  }

  function v4Params(overrides: Record<string, unknown> = {}) {
    return {
      key: {
        currency0: contracts.token0,
        currency1: contracts.token1,
        fee: 3_000,
        tickSpacing: 60,
        hooks: "0x0000000000000000000000000000000000000000" as Address
      },
      sourceToken: contracts.token0,
      preparationPath: "0x",
      preparationAmountOutMinimum: 0n,
      tickLower: -60,
      tickUpper: 60,
      zeroForOne: true,
      amountIn: 1_000n,
      swapAmountIn: 400n,
      amountOutMinimum: 400n,
      minimumLiquidity: 1n,
      minimumSqrtPriceX96: (2n ** 96n) - 1n,
      maximumSqrtPriceX96: (2n ** 96n) + 1n,
      deadline: deadline(),
      hookData: "0x",
      ...overrides
    };
  }

  function poolId(key: ReturnType<typeof v4Params>["key"]): Hex {
    return keccak256(encodeAbiParameters(
      parseAbiParameters(
        "address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks"
      ),
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
    ));
  }

  beforeAll(async () => {
    const port = 27_000 + process.pid % 1_000;
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
    wallets = Array.from({ length: 3 }, (_, index) => createWalletClient({
      account: mnemonicToAccount(MNEMONIC, { addressIndex: index }),
      chain,
      transport
    }));
    addresses = wallets.map((wallet) => wallet.account?.address as Address);

    const token0 = await deploy("ZapMockERC20");
    const token1 = await deploy("ZapMockERC20");
    const source = await deploy("ZapMockERC20");
    const permit2 = await deploy("ZapMockPermit2");
    const poolManager = await deploy("ZapMockPoolManager");
    const v3SwapRouter = await deploy("ZapMockV3SwapRouter");
    const v3PositionManager = await deploy("ZapMockV3PositionManager");
    const v4PositionManager = await deploy("ZapMockV4PositionManager", [
      permit2,
      poolManager
    ]);
    const v4StateView = await deploy("ZapMockV4StateView", [poolManager]);
    const universalRouter = await deploy("ZapMockUniversalRouter", [permit2]);
    const weth = await deploy("ZapMockWETH");
    const zap = await deploy("ScoplZapRouter", [
      addresses[0],
      v3SwapRouter,
      v3PositionManager,
      v4PositionManager,
      v4StateView,
      universalRouter,
      permit2,
      weth
    ]);
    contracts = {
      token0,
      token1,
      source,
      permit2,
      v3SwapRouter,
      v3PositionManager,
      v4PositionManager,
      v4StateView,
      universalRouter,
      weth,
      zap
    };
    const defaultKey = v4Params().key;
    const nativeKey = {
      ...defaultKey,
      currency0: "0x0000000000000000000000000000000000000000" as Address
    };
    for (const key of [defaultKey, nativeKey]) {
      await write("ZapMockV4StateView", v4StateView, "setSlot0", [
        poolId(key),
        2n ** 96n
      ]);
    }
    for (const token of [token0, source]) {
      await write("ZapMockERC20", token, "mint", [addresses[1], 10_000n]);
      await write("ZapMockERC20", token, "approve", [zap, 10_000n], 1);
    }
    await write("ZapMockWETH", weth, "deposit", [], 1, 10_000n);
    await write("ZapMockWETH", weth, "approve", [zap, 10_000n], 1);
    const routerFundingHash = await wallets[0].sendTransaction({
      to: universalRouter,
      value: 10_000n
    } as never);
    await publicClient.waitForTransactionReceipt({ hash: routerFundingHash });
    snapshot = await rpc("evm_snapshot") as string;
  }, 60_000);

  beforeEach(async () => {
    await rpc("evm_revert", [snapshot]);
    snapshot = await rpc("evm_snapshot") as string;
  });

  afterAll(() => anvil.kill());

  it("zaps a pool token into a user-owned V3 NFT and refunds unused assets", async () => {
    await write("ScoplZapRouter", contracts.zap, "zapV3", [v3Params()], 1);
    expect(await balance(contracts.token0, addresses[1])).toBe(9_150n);
    expect(await balance(contracts.token1, addresses[1])).toBe(100n);
    expect(await read<Address>(
      "ZapMockV3PositionManager",
      contracts.v3PositionManager,
      "ownerOf",
      [1n]
    )).toBe(addresses[1]);
    expect(await balance(contracts.token0, contracts.zap)).toBe(0n);
    expect(await balance(contracts.token1, contracts.zap)).toBe(0n);
    expect(await read<bigint>(
      "ZapMockERC20", contracts.token0, "allowance",
      [contracts.zap, contracts.v3SwapRouter]
    )).toBe(0n);
    expect(await read<bigint>(
      "ZapMockERC20", contracts.token0, "allowance",
      [contracts.zap, contracts.v3PositionManager]
    )).toBe(0n);
    expect(await read<bigint>(
      "ZapMockERC20", contracts.token1, "allowance",
      [contracts.zap, contracts.v3PositionManager]
    )).toBe(0n);
  });

  it("prepares an external source token through a validated V3 path", async () => {
    const path = encodePacked(
      ["address", "uint24", "address"],
      [contracts.source, 3_000, contracts.token0]
    );
    await write("ScoplZapRouter", contracts.zap, "zapV3", [v3Params({
      sourceToken: contracts.source,
      preparationPath: path,
      preparationAmountOutMinimum: 1_000n
    })], 1);
    expect(await balance(contracts.source, addresses[1])).toBe(9_000n);
    expect(await read<Address>(
      "ZapMockV3PositionManager",
      contracts.v3PositionManager,
      "ownerOf",
      [1n]
    )).toBe(addresses[1]);
    expect(await read<bigint>(
      "ZapMockERC20", contracts.source, "allowance",
      [contracts.zap, contracts.v3SwapRouter]
    )).toBe(0n);
  });

  it("executes the V4 action plan, mints to the user, and refunds both sides", async () => {
    const params = v4Params();
    const [quotedMaximum] = await read<[bigint, bigint]>(
      "ScoplZapRouter",
      contracts.zap,
      "previewV4Liquidity",
      [
        params.key,
        params.tickLower,
        params.tickUpper,
        600n,
        400n
      ]
    );
    await write("ScoplZapRouter", contracts.zap, "zapV4", [params], 1);
    expect(await balance(contracts.token0, addresses[1])).toBe(9_150n);
    expect(await balance(contracts.token1, addresses[1])).toBe(100n);
    expect(await read<Address>(
      "ZapMockV4PositionManager",
      contracts.v4PositionManager,
      "ownerOf",
      [1n]
    )).toBe(addresses[1]);
    expect(await read<bigint>(
      "ZapMockV4PositionManager",
      contracts.v4PositionManager,
      "lastLiquidity"
    )).toBe(quotedMaximum);
    for (const token of [contracts.token0, contracts.token1]) {
      expect(await read<bigint>(
        "ZapMockERC20", token, "allowance",
        [contracts.zap, contracts.permit2]
      )).toBe(0n);
      expect(await read<bigint>(
        "ZapMockPermit2", contracts.permit2, "allowance",
        [contracts.zap, token, contracts.v4PositionManager]
      )).toBe(0n);
    }
    expect(await read<bigint>(
      "ZapMockPermit2", contracts.permit2, "allowance",
      [contracts.zap, contracts.token0, contracts.universalRouter]
    )).toBe(0n);
  });

  it("checks the post-swap V4 price before minting", async () => {
    const params = v4Params();
    const postSwapPrice = params.maximumSqrtPriceX96 + 1n;
    await write(
      "ZapMockUniversalRouter",
      contracts.universalRouter,
      "setPostSwapPrice",
      [contracts.v4StateView, poolId(params.key), postSwapPrice]
    );
    await expect(write(
      "ScoplZapRouter",
      contracts.zap,
      "zapV4",
      [params],
      1
    )).rejects.toThrow();
    expect(await balance(contracts.token0, addresses[1])).toBe(10_000n);
    expect(await read<bigint>(
      "ZapMockV4StateView",
      contracts.v4StateView,
      "sqrtPriceX96Of",
      [poolId(params.key)]
    )).toBe(2n ** 96n);
  });

  it("treats tolerance as a minimum guarantee and reverts below it", async () => {
    const params = v4Params();
    const [maximum] = await read<[bigint, bigint]>(
      "ScoplZapRouter",
      contracts.zap,
      "previewV4Liquidity",
      [
        params.key,
        params.tickLower,
        params.tickUpper,
        600n,
        400n
      ]
    );
    await expect(write(
      "ScoplZapRouter",
      contracts.zap,
      "zapV4",
      [{ ...params, minimumLiquidity: maximum + 1n }],
      1
    )).rejects.toThrow();
    expect(await balance(contracts.token0, addresses[1])).toBe(10_000n);
  });

  it("matches the client maximum-liquidity math across price regions", async () => {
    const key = v4Params().key;
    const cases = [
      { tickLower: -600, tickUpper: 600, amount0: 600n, amount1: 400n },
      { tickLower: 60, tickUpper: 600, amount0: 1_000n, amount1: 0n },
      { tickLower: -600, tickUpper: -60, amount0: 0n, amount1: 1_000n }
    ];
    for (const item of cases) {
      const [onchain] = await read<[bigint, bigint]>(
        "ScoplZapRouter",
        contracts.zap,
        "previewV4Liquidity",
        [
          key,
          item.tickLower,
          item.tickUpper,
          item.amount0,
          item.amount1
        ]
      );
      expect(onchain).toBe(maximumLiquidityForZap({
        sqrtPriceX96: 2n ** 96n,
        tickLower: item.tickLower,
        tickUpper: item.tickUpper,
        amount0: item.amount0,
        amount1: item.amount1
      }));
    }
  });

  it("mints an ordinary V4 position at the execution-time maximum", async () => {
    await write("ZapMockERC20", contracts.token1, "mint", [addresses[1], 400n]);
    await write("ZapMockERC20", contracts.token1, "approve", [contracts.zap, 400n], 1);
    const zap = v4Params();
    const mint = {
      key: zap.key,
      tickLower: zap.tickLower,
      tickUpper: zap.tickUpper,
      amount0Max: 600n,
      amount1Max: 400n,
      minimumLiquidity: 1n,
      minimumSqrtPriceX96: (2n ** 96n) - 1n,
      maximumSqrtPriceX96: (2n ** 96n) + 1n,
      useNativeForWeth: false,
      deadline: deadline(),
      hookData: "0x"
    };
    const [maximum] = await read<[bigint, bigint]>(
      "ScoplZapRouter",
      contracts.zap,
      "previewV4Liquidity",
      [
        mint.key,
        mint.tickLower,
        mint.tickUpper,
        mint.amount0Max,
        mint.amount1Max
      ]
    );
    await write("ScoplZapRouter", contracts.zap, "mintV4", [mint], 1);
    expect(await read<bigint>(
      "ZapMockV4PositionManager",
      contracts.v4PositionManager,
      "lastLiquidity"
    )).toBe(maximum);
    expect(await read<Address>(
      "ZapMockV4PositionManager",
      contracts.v4PositionManager,
      "ownerOf",
      [1n]
    )).toBe(addresses[1]);
  });

  it("rejects a direct V4 mint outside the caller's price bounds", async () => {
    await write("ZapMockERC20", contracts.token1, "mint", [addresses[1], 400n]);
    await write("ZapMockERC20", contracts.token1, "approve", [contracts.zap, 400n], 1);
    const zap = v4Params();
    const mint = {
      key: zap.key,
      tickLower: zap.tickLower,
      tickUpper: zap.tickUpper,
      amount0Max: 600n,
      amount1Max: 400n,
      minimumLiquidity: 1n,
      minimumSqrtPriceX96: zap.minimumSqrtPriceX96,
      maximumSqrtPriceX96: zap.maximumSqrtPriceX96,
      useNativeForWeth: false,
      deadline: deadline(),
      hookData: "0x"
    };
    await write("ZapMockV4StateView", contracts.v4StateView, "setSlot0", [
      poolId(mint.key),
      mint.maximumSqrtPriceX96 + 1n
    ]);
    await expect(write(
      "ScoplZapRouter",
      contracts.zap,
      "mintV4",
      [mint],
      1
    )).rejects.toThrow();
    expect(await balance(contracts.token0, addresses[1])).toBe(10_000n);
    expect(await balance(contracts.token1, addresses[1])).toBe(400n);
  });

  it("supports a one-sided V4 mint without requesting a zero Permit2 allowance", async () => {
    await write("ScoplZapRouter", contracts.zap, "zapV4", [v4Params({
      swapAmountIn: 0n,
      amountOutMinimum: 0n,
      tickLower: 60,
      tickUpper: 120
    })], 1);
    expect(await balance(contracts.token0, addresses[1])).toBe(9_250n);
    expect(await read<Address>(
      "ZapMockV4PositionManager",
      contracts.v4PositionManager,
      "ownerOf",
      [1n]
    )).toBe(addresses[1]);
  });

  it("supports a native-ETH V4 pool by unwrapping WETH atomically", async () => {
    await write("ScoplZapRouter", contracts.zap, "zapV4", [v4Params({
      key: {
        currency0: "0x0000000000000000000000000000000000000000",
        currency1: contracts.token1,
        fee: 3_000,
        tickSpacing: 60,
        hooks: "0x0000000000000000000000000000000000000000"
      },
      sourceToken: contracts.weth
    })], 1);
    expect(await balance(contracts.weth, addresses[1])).toBe(9_000n);
    expect(await balance(contracts.token1, addresses[1])).toBe(100n);
    expect(await publicClient.getBalance({ address: contracts.zap })).toBe(0n);
    expect(await publicClient.getBalance({
      address: contracts.v4PositionManager
    })).toBe(0n);
    expect(await read<Address>(
      "ZapMockV4PositionManager",
      contracts.v4PositionManager,
      "ownerOf",
      [1n]
    )).toBe(addresses[1]);
  });

  it("accepts native ETH directly for a V4 Zap without wrapping or approval", async () => {
    const zeroAddress =
      "0x0000000000000000000000000000000000000000" as Address;
    await write("ScoplZapRouter", contracts.zap, "zapV4", [v4Params({
      key: {
        currency0: zeroAddress,
        currency1: contracts.token1,
        fee: 3_000,
        tickSpacing: 60,
        hooks: zeroAddress
      },
      sourceToken: zeroAddress
    })], 1, 1_000n);
    expect(await balance(contracts.weth, addresses[1])).toBe(10_000n);
    expect(await balance(contracts.token1, addresses[1])).toBe(100n);
    expect(await publicClient.getBalance({ address: contracts.zap })).toBe(0n);
    expect(await read<Address>(
      "ZapMockV4PositionManager",
      contracts.v4PositionManager,
      "ownerOf",
      [1n]
    )).toBe(addresses[1]);
  });

  it("supports V4 output tokens whose Permit2 allowance is fixed at infinity", async () => {
    const zeroAddress =
      "0x0000000000000000000000000000000000000000" as Address;
    const fixedToken = await deploy("ZapMockFixedPermit2ERC20", [
      contracts.permit2
    ]);
    const key = {
      currency0: zeroAddress,
      currency1: fixedToken,
      fee: 3_000,
      tickSpacing: 60,
      hooks: zeroAddress
    };
    await write("ZapMockV4StateView", contracts.v4StateView, "setSlot0", [
      poolId(key),
      2n ** 96n
    ]);
    await write("ScoplZapRouter", contracts.zap, "zapV4", [v4Params({
      key,
      sourceToken: zeroAddress
    })], 1, 1_000n);
    expect(await read<bigint>(
      "ZapMockFixedPermit2ERC20",
      fixedToken,
      "allowance",
      [contracts.zap, contracts.permit2]
    )).toBe((1n << 256n) - 1n);
    expect(await read<bigint>(
      "ZapMockPermit2",
      contracts.permit2,
      "allowance",
      [contracts.zap, fixedToken, contracts.v4PositionManager]
    )).toBe(0n);
    expect(await read<Address>(
      "ZapMockV4PositionManager",
      contracts.v4PositionManager,
      "ownerOf",
      [1n]
    )).toBe(addresses[1]);
  });

  it("rejects a native V4 Zap whose transaction value does not match amountIn", async () => {
    const zeroAddress =
      "0x0000000000000000000000000000000000000000" as Address;
    await expect(write(
      "ScoplZapRouter",
      contracts.zap,
      "zapV4",
      [v4Params({
        key: {
          currency0: zeroAddress,
          currency1: contracts.token1,
          fee: 3_000,
          tickSpacing: 60,
          hooks: zeroAddress
        },
        sourceToken: zeroAddress
      })],
      1,
      999n
    )).rejects.toThrow();
    expect(await publicClient.getBalance({ address: contracts.zap })).toBe(0n);
  });

  it("receives native ETH from a V4 swap and refunds unused ETH", async () => {
    await write("ZapMockERC20", contracts.token1, "mint", [addresses[1], 1_000n]);
    await write("ZapMockERC20", contracts.token1, "approve", [contracts.zap, 1_000n], 1);
    await write("ScoplZapRouter", contracts.zap, "zapV4", [v4Params({
      key: {
        currency0: "0x0000000000000000000000000000000000000000",
        currency1: contracts.token1,
        fee: 3_000,
        tickSpacing: 60,
        hooks: "0x0000000000000000000000000000000000000000"
      },
      sourceToken: contracts.token1,
      zeroForOne: false,
      amount0Max: 400n,
      amount1Max: 600n
    })], 1);
    expect(await balance(contracts.token1, addresses[1])).toBe(150n);
    expect(await publicClient.getBalance({ address: contracts.zap })).toBe(0n);
    expect(await publicClient.getBalance({
      address: contracts.v4PositionManager
    })).toBe(0n);
    expect(await read<Address>(
      "ZapMockV4PositionManager",
      contracts.v4PositionManager,
      "ownerOf",
      [1n]
    )).toBe(addresses[1]);
  });

  it("rolls the full Zap back when swap slippage protection fails", async () => {
    const before = await balance(contracts.token0, addresses[1]);
    await expect(write(
      "ScoplZapRouter",
      contracts.zap,
      "zapV3",
      [v3Params({ amountOutMinimum: 401n })],
      1
    )).rejects.toThrow();
    expect(await balance(contracts.token0, addresses[1])).toBe(before);
  });

  it("never refunds token balances that predate the caller's Zap", async () => {
    await write("ZapMockERC20", contracts.token0, "mint", [contracts.zap, 100n]);
    await write("ScoplZapRouter", contracts.zap, "zapV3", [v3Params()], 1);
    expect(await balance(contracts.token0, contracts.zap)).toBe(100n);
  });

  it("lets only governance recover tokens accidentally sent between zaps", async () => {
    await write("ZapMockERC20", contracts.token0, "mint", [contracts.zap, 100n]);
    await expect(write(
      "ScoplZapRouter",
      contracts.zap,
      "recoverAsset",
      [contracts.token0, addresses[2], 100n],
      1
    )).rejects.toThrow();
    await write("ScoplZapRouter", contracts.zap, "recoverAsset", [
      contracts.token0, addresses[2], 100n
    ]);
    expect(await balance(contracts.token0, addresses[2])).toBe(100n);
  });
});
