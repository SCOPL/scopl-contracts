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
  maxUint256,
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
const AI = getAddress("0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18");
const NVDA = getAddress("0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC");
const AI_HOLDER = getAddress("0xE85458669e58C9440C0045a034eDf6D3110609C5");
const NVDA_HOLDER = getAddress("0x9f736F87E6293AC1Bd9142E257dbfAC8b7AcF1ae");
const DOPPLER_HOOK = getAddress("0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544");
const POOL_ID = "0xcbdfea90430a30ee4469c9902e120a77e7c7e4711d5643671c1d1957f2f1ce27";
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
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const RESERVE = parseEther("0.00005");

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
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function transfer(address recipient,uint256 amount) returns (bool)"
]);
const permit2Abi = parseAbi([
  "function allowance(address owner,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)"
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
  const port = 30_000 + process.pid % 1_000;
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
    const key = {
      currency0: AI,
      currency1: NVDA,
      fee: 0x800000,
      tickSpacing: 8,
      hooks: DOPPLER_HOOK
    };
    const derivedPoolId = keccak256(encodeAbiParameters(
      parseAbiParameters(
        "(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)"
      ),
      [key]
    ));
    if (derivedPoolId !== POOL_ID) throw new Error("Long.xyz pool key mismatch");
    const [slot0, aiDecimals, nvdaDecimals] = await Promise.all([
      publicClient.readContract({
        address: STATE_VIEW,
        abi: stateViewAbi,
        functionName: "getSlot0",
        args: [POOL_ID]
      }),
      publicClient.readContract({ address: AI, abi: erc20Abi, functionName: "decimals" }),
      publicClient.readContract({ address: NVDA, abi: erc20Abi, functionName: "decimals" })
    ]);
    if (slot0[0] === 0n || slot0[3] === 0) {
      throw new Error("Long.xyz sample pool is not initialized with a nonzero LP fee");
    }
    const aiAmount = parseUnits("1000", aiDecimals);
    const nvdaAmount = parseUnits("0.01", nvdaDecimals);

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
    const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
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
      args: [DOPPLER_HOOK, true, keccak256("0x")]
    });
    await write({
      address: POSITION_MANAGER,
      abi: positionManagerAbi,
      functionName: "setApprovalForAll",
      args: [manager, true]
    });

    const fundToken = async (token, holder, amount) => {
      await rpc("anvil_setBalance", [holder, "0xde0b6b3a7640000"]);
      await rpc("anvil_impersonateAccount", [holder]);
      try {
        const balance = await publicClient.readContract({
          address: token,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [holder]
        });
        if (balance < amount) throw new Error(`Holder balance is too low for ${token}`);
        const transferHash = await unlockedWallet.writeContract({
          account: holder,
          address: token,
          abi: erc20Abi,
          functionName: "transfer",
          args: [account.address, amount]
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash: transferHash });
        if (receipt.status !== "success") throw new Error(`Holder transfer failed for ${token}`);
      } finally {
        await rpc("anvil_stopImpersonatingAccount", [holder]);
      }
    };
    await fundToken(AI, AI_HOLDER, aiAmount);
    await fundToken(NVDA, NVDA_HOLDER, nvdaAmount);

    const currentTick = Number(slot0[1]);
    const alignedBelow = Math.floor(currentTick / key.tickSpacing) * key.tickSpacing;
    const deadline = BigInt(Math.floor(Date.now() / 1_000) + 3_600);

    await write({
      address: AI,
      abi: erc20Abi,
      functionName: "approve",
      args: [manager, aiAmount]
    });
    const sellAiLower = alignedBelow + key.tickSpacing;
    const sellAiUpper = sellAiLower + key.tickSpacing;
    const sellAiLiquidity = liquidityAtRange(
      currentTick,
      sellAiLower,
      sellAiUpper,
      aiAmount,
      0n
    );
    await write({
      address: manager,
      abi: compiled.abi,
      functionName: "createOrder",
      args: [{
        key,
        tokenIn: AI,
        tokenOut: NVDA,
        tickLower: sellAiLower,
        tickUpper: sellAiUpper,
        amountIn: aiAmount,
        amountInMinimum: aiAmount * 9_950n / 10_000n,
        liquidity: sellAiLiquidity,
        gasReserve: RESERVE,
        deadline,
        hookData: "0x",
        integrationId: ZERO_BYTES32,
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
      args: [1n]
    })) throw new Error("Long.xyz AI sell order is not manageable");
    const aiPermit2Erc20Allowance = await publicClient.readContract({
      address: AI,
      abi: erc20Abi,
      functionName: "allowance",
      args: [manager, PERMIT2]
    });
    const aiPositionManagerAllowance = await publicClient.readContract({
      address: PERMIT2,
      abi: permit2Abi,
      functionName: "allowance",
      args: [manager, AI, POSITION_MANAGER]
    });
    if (aiPermit2Erc20Allowance !== maxUint256 || aiPositionManagerAllowance[0] !== 0n) {
      throw new Error("Long.xyz fixed-infinite Permit2 allowance handling is unsafe");
    }
    await write({
      address: manager,
      abi: compiled.abi,
      functionName: "cancelOrder",
      args: [1n]
    });

    await write({
      address: NVDA,
      abi: erc20Abi,
      functionName: "approve",
      args: [manager, nvdaAmount]
    });
    const buyAiUpper = alignedBelow;
    const buyAiLower = buyAiUpper - key.tickSpacing;
    const buyAiLiquidity = liquidityAtRange(
      currentTick,
      buyAiLower,
      buyAiUpper,
      0n,
      nvdaAmount
    );
    await write({
      address: manager,
      abi: compiled.abi,
      functionName: "createOrder",
      args: [{
        key,
        tokenIn: NVDA,
        tokenOut: AI,
        tickLower: buyAiLower,
        tickUpper: buyAiUpper,
        amountIn: nvdaAmount,
        amountInMinimum: nvdaAmount * 9_950n / 10_000n,
        liquidity: buyAiLiquidity,
        gasReserve: RESERVE,
        deadline,
        hookData: "0x",
        integrationId: ZERO_BYTES32,
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
    })) throw new Error("Long.xyz AI buy order is not manageable");
    await write({
      address: manager,
      abi: compiled.abi,
      functionName: "cancelOrder",
      args: [2n]
    });

    console.log(`Validated Long.xyz pool ${POOL_ID} on an isolated Robinhood Chain fork.`);
    console.log(`Live LP fee: ${Number(slot0[3]) / 10_000}% (nonzero).`);
    console.log("AI -> NVDA limit order: created, manageable, allowance-safe, and cancelled.");
    console.log("NVDA -> AI limit order: created, manageable, and cancelled.");
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
