import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseAbiParameters,
  parseEther,
  parseUnits
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { maximumLiquidityAtRange } from "./liquidity-math.mjs";
import { selectFreshRobinhoodRpcUrl } from "./robinhood-rpc.mjs";

const MNEMONIC = "test test test test test test test test test test test junk";
const CHAIN_ID = 4_663;
const FORK_URL = await selectFreshRobinhoodRpcUrl();
const FACTORY = getAddress("0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e");
const SAMPLE_TOKEN = getAddress("0x9cA1cC0c90d97B4F36c5E2232d4fbD705a73c65d");
const SAMPLE_HOLDER = getAddress("0x548129a58bC230549DF7F9e33f27E77F6779ff0f");
const POSITION_MANAGER = getAddress("0x58daec3116aae6d93017baaea7749052e8a04fa7");
const STATE_VIEW = getAddress("0xf3334192d15450cdd385c8b70e03f9a6bd9e673b");
const POOL_MANAGER = getAddress("0x8366a39cc670b4001a1121b8f6a443a643e40951");
const PERMIT2 = getAddress("0x000000000022d473030f116ddee9f6b43ac78ba3");
const WETH = getAddress("0x0bd7d308f8e1639fab988df18a8011f41EAcAD73");
const DISTRIBUTOR = getAddress(
  process.env.SCOPL_REVENUE_DISTRIBUTOR_ADDRESS ??
  "0x1cfB6dC47b7F2Ac83939Ba863AE41E7041414F13"
);
const ORDER_POLICY = getAddress(
  process.env.SCOPL_ORDER_POLICY_ADDRESS ??
  "0xfA7a06b158eCf40232A4e1c976160be592391646"
);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const RESERVE = parseEther("0.00005");
const BUY_AMOUNT = parseEther("0.001");
const SELL_AMOUNT = parseUnits("10000", 18);

const factoryAbi = parseAbi([
  "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))",
  "function memeHook() view returns (address)"
]);
const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)"
]);
const positionManagerAbi = parseAbi([
  "function setApprovalForAll(address operator,bool approved)"
]);
const orderPolicyAbi = parseAbi([
  "function owner() view returns (address)",
  "function setManager(address manager,bool allowed)"
]);
const erc20Abi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function transfer(address recipient,uint256 amount) returns (bool)"
]);

function artifact() {
  const filename = path.join(
    process.cwd(),
    "contracts/artifacts/ScoplV4LimitOrderManager.json"
  );
  const parsed = JSON.parse(fs.readFileSync(filename, "utf8"));
  return { abi: parsed.abi, bytecode: `0x${parsed.evm.bytecode.object}` };
}

function liquidityAtRange(currentTick, tickLower, tickUpper, amount0, amount1) {
  return maximumLiquidityAtRange(
    currentTick,
    tickLower,
    tickUpper,
    amount0,
    amount1
  );
}

async function main() {
  const port = 29_000 + process.pid % 1_000;
  const rpcUrl = `http://127.0.0.1:${port}`;
  const executable = path.resolve(
    process.cwd(),
    "node_modules/@foundry-rs/anvil/bin.mjs"
  );
  const anvil = spawn(process.execPath, [
    executable,
    "--port", String(port),
    "--chain-id", String(CHAIN_ID),
    "--fork-url", FORK_URL,
    "--mnemonic", MNEMONIC,
    "--silent"
  ], { stdio: "ignore", windowsHide: true });
  const rpc = async (method, params = []) => {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    const body = await response.json();
    if (body.error) throw new Error(body.error.message);
    return body.result;
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await rpc("eth_chainId");
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!ready) throw new Error("The Robinhood Chain fork did not start");

    const chain = defineChain({
      id: CHAIN_ID,
      name: "Robinhood Chain fork",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } }
    });
    const transport = http(rpcUrl, { timeout: 30_000 });
    const publicClient = createPublicClient({ chain, transport });
    const account = mnemonicToAccount(MNEMONIC);
    const walletClient = createWalletClient({ account, chain, transport });
    const unlockedWallet = createWalletClient({ chain, transport });
    const compiled = artifact();

    const [launch, hook] = await Promise.all([
      publicClient.readContract({
        address: FACTORY,
        abi: factoryAbi,
        functionName: "getLaunchedToken",
        args: [SAMPLE_TOKEN]
      }),
      publicClient.readContract({
        address: FACTORY,
        abi: factoryAbi,
        functionName: "memeHook"
      })
    ]);
    if (!launch.exists || Number(launch.phase) !== 2) {
      throw new Error("The Pons V2 sample token is not graduated");
    }
    const pairToken = getAddress(launch.pairToken);
    const currency0 = BigInt(SAMPLE_TOKEN) < BigInt(pairToken)
      ? SAMPLE_TOKEN
      : pairToken;
    const currency1 = currency0 === SAMPLE_TOKEN ? pairToken : SAMPLE_TOKEN;
    const key = {
      currency0,
      currency1,
      fee: Number(launch.poolFee),
      tickSpacing: Number(launch.tickSpacing),
      hooks: getAddress(hook)
    };
    const poolId = keccak256(encodeAbiParameters(
      parseAbiParameters(
        "(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)"
      ),
      [key]
    ));
    const slot0 = await publicClient.readContract({
      address: STATE_VIEW,
      abi: stateViewAbi,
      functionName: "getSlot0",
      args: [poolId]
    });
    if (slot0[0] === 0n) throw new Error("The Pons V2 sample pool is not initialized");

    const deployHash = await walletClient.deployContract({
      abi: compiled.abi,
      bytecode: compiled.bytecode,
      args: [
        account.address,
        DISTRIBUTOR,
        ORDER_POLICY,
        POSITION_MANAGER,
        STATE_VIEW,
        POOL_MANAGER,
        PERMIT2,
        WETH,
        RESERVE
      ]
    });
    const deployReceipt = await publicClient.waitForTransactionReceipt({
      hash: deployHash
    });
    if (!deployReceipt.contractAddress) throw new Error("Fork manager deployment failed");
    const manager = getAddress(deployReceipt.contractAddress);
    const write = async (request) => {
      const hash = await walletClient.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Fork transaction reverted");
      return receipt;
    };
    const policyOwner = await publicClient.readContract({
      address: ORDER_POLICY,
      abi: orderPolicyAbi,
      functionName: "owner"
    });
    await rpc("anvil_setBalance", [policyOwner, "0xde0b6b3a7640000"]);
    await rpc("anvil_impersonateAccount", [policyOwner]);
    try {
      const authorizeHash = await unlockedWallet.writeContract({
        account: policyOwner,
        address: ORDER_POLICY,
        abi: orderPolicyAbi,
        functionName: "setManager",
        args: [manager, true]
      });
      await publicClient.waitForTransactionReceipt({ hash: authorizeHash });
    } finally {
      await rpc("anvil_stopImpersonatingAccount", [policyOwner]);
    }

    await write({
      address: manager,
      abi: compiled.abi,
      functionName: "setHookPolicy",
      args: [key.hooks, true, keccak256("0x")]
    });
    await write({
      address: POSITION_MANAGER,
      abi: positionManagerAbi,
      functionName: "setApprovalForAll",
      args: [manager, true]
    });

    const currentTick = Number(slot0[1]);
    const spacing = key.tickSpacing;
    const alignedBelow = Math.floor(currentTick / spacing) * spacing;
    const buyTickLower = alignedBelow + spacing;
    const buyTickUpper = buyTickLower + spacing;
    const buyLiquidity = liquidityAtRange(
      currentTick,
      buyTickLower,
      buyTickUpper,
      BUY_AMOUNT,
      0n
    );
    await write({
      address: manager,
      abi: compiled.abi,
      functionName: "createOrder",
      args: [{
        key,
        tokenIn: ZERO_ADDRESS,
        tokenOut: SAMPLE_TOKEN,
        tickLower: buyTickLower,
        tickUpper: buyTickUpper,
        amountIn: BUY_AMOUNT,
        amountInMinimum: BUY_AMOUNT * 9_950n / 10_000n,
        liquidity: buyLiquidity,
        gasReserve: RESERVE,
        deadline: BigInt(Math.floor(Date.now() / 1_000) + 3_600),
        hookData: "0x",
        integrationId: `0x${"00".repeat(32)}`,
        optionalReferrer: ZERO_ADDRESS,
        tierAttestation: {
          user: ZERO_ADDRESS,
          destinationChainId: 0n,
          beneficiaryShareBps: 0,
          expiry: 0
        },
        tierSignature: "0x"
      }],
      value: BUY_AMOUNT + RESERVE
    });
    if (!await publicClient.readContract({
      address: manager,
      abi: compiled.abi,
      functionName: "isPositionManageable",
      args: [1n]
    })) throw new Error("Pons V2 native buy order is not manageable");
    await write({
      address: manager,
      abi: compiled.abi,
      functionName: "cancelOrder",
      args: [1n]
    });

    await rpc("anvil_setBalance", [SAMPLE_HOLDER, "0xde0b6b3a7640000"]);
    await rpc("anvil_impersonateAccount", [SAMPLE_HOLDER]);
    try {
      const holderBalance = await publicClient.readContract({
        address: SAMPLE_TOKEN,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [SAMPLE_HOLDER]
      });
      if (holderBalance < SELL_AMOUNT) throw new Error("Sample holder balance is too low");
      const transferHash = await unlockedWallet.writeContract({
        account: SAMPLE_HOLDER,
        address: SAMPLE_TOKEN,
        abi: erc20Abi,
        functionName: "transfer",
        args: [account.address, SELL_AMOUNT]
      });
      await publicClient.waitForTransactionReceipt({ hash: transferHash });
    } finally {
      await rpc("anvil_stopImpersonatingAccount", [SAMPLE_HOLDER]);
    }
    await write({
      address: SAMPLE_TOKEN,
      abi: erc20Abi,
      functionName: "approve",
      args: [manager, SELL_AMOUNT]
    });
    const sellTickUpper = alignedBelow;
    const sellTickLower = sellTickUpper - spacing;
    const sellLiquidity = liquidityAtRange(
      currentTick,
      sellTickLower,
      sellTickUpper,
      0n,
      SELL_AMOUNT
    );
    await write({
      address: manager,
      abi: compiled.abi,
      functionName: "createOrder",
      args: [{
        key,
        tokenIn: SAMPLE_TOKEN,
        tokenOut: ZERO_ADDRESS,
        tickLower: sellTickLower,
        tickUpper: sellTickUpper,
        amountIn: SELL_AMOUNT,
        amountInMinimum: SELL_AMOUNT * 9_950n / 10_000n,
        liquidity: sellLiquidity,
        gasReserve: RESERVE,
        deadline: BigInt(Math.floor(Date.now() / 1_000) + 3_600),
        hookData: "0x",
        integrationId: `0x${"00".repeat(32)}`,
        optionalReferrer: ZERO_ADDRESS,
        tierAttestation: {
          user: ZERO_ADDRESS,
          destinationChainId: 0n,
          beneficiaryShareBps: 0,
          expiry: 0
        },
        tierSignature: "0x"
      }],
      value: RESERVE
    });
    if (!await publicClient.readContract({
      address: manager,
      abi: compiled.abi,
      functionName: "isPositionManageable",
      args: [2n]
    })) throw new Error("Pons V2 token sell order is not manageable");
    const managerPermit2Allowance = await publicClient.readContract({
      address: SAMPLE_TOKEN,
      abi: erc20Abi,
      functionName: "allowance",
      args: [manager, PERMIT2]
    });
    if (managerPermit2Allowance !== 0n) {
      throw new Error("Pons V2 token Permit2 allowance was not revoked");
    }
    await write({
      address: manager,
      abi: compiled.abi,
      functionName: "cancelOrder",
      args: [2n]
    });

    console.log(`Validated Pons V2 pool ${poolId} on an isolated Robinhood Chain fork.`);
    console.log("Native ETH buy order: created, manageable, and cancelled.");
    console.log("Pons V2 token sell order: created, manageable, allowance-revoked, and cancelled.");
    console.log("No production transaction was broadcast.");
  } finally {
    anvil.kill("SIGTERM");
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
);
