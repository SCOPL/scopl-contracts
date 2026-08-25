import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
  parseAbi,
  parseAbiParameters,
  parseEther
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  robinhoodRpcTransport,
  robinhoodRpcUrls
} from "./robinhood-rpc.mjs";

const CHAIN_ID = 4_663;
const RPC_URLS = robinhoodRpcUrls();
const EXPLORER_URL = "https://robinhoodchain.blockscout.com";
const V4_POSITION_MANAGER = "0x58daec3116aae6d93017baaea7749052e8a04fa7";
const V4_STATE_VIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const V4_POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const PONS_V2_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
const PONS_V2_MEME_HOOK = "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044";
const PONS_V2_SAMPLE_TOKEN = "0x9cA1cC0c90d97B4F36c5E2232d4fbD705a73c65d";
const PONS_V2_FACTORY_CODE_HASH =
  "0x89a27da6f703e0a7cdd4f233e7cb57604ff75b164530962d3ff7cf8483a67d84";
const PONS_V2_MEME_HOOK_CODE_HASH =
  "0xc21b1e6c1b45403e81a581f22ed6d9c747997af1cfdac1b1dc9f4b1d346a10db";
const LONG_SAMPLE_TOKEN = "0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18";
const LONG_SAMPLE_NUMERAIRE = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const LONG_SAMPLE_POOL_ID =
  "0xcbdfea90430a30ee4469c9902e120a77e7c7e4711d5643671c1d1957f2f1ce27";
const LONG_DOPPLER_HOOK = "0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544";
const LONG_REHYPE_HOOK = "0x6f02324d20CC679d0E585290CAa6b16baCbC0F77";
const LONG_TOKEN_IMPLEMENTATION = "0x3Be8B97Fd0e713B5aBE0649Fa830223B6B4BC599";
const LONG_DOPPLER_HOOK_CODE_HASH =
  "0xc41a91106002f15bf70ae266824317f3f3ac638ac72ca5253bae395fa47ee631";
const LONG_REHYPE_HOOK_CODE_HASH =
  "0x5d33a1d867ba0d17cc7af077786b1356848c72f8e0bf960ef88aa15f7a6962d1";
const LONG_TOKEN_IMPLEMENTATION_CODE_HASH =
  "0x67a382a66d2b14a7032698e11c9ae4432435d2c803429d5c660692289ad10e12";
const positionManagerDependencyAbi = parseAbi([
  "function poolManager() view returns (address)",
  "function permit2() view returns (address)"
]);
const stateViewDependencyAbi = parseAbi([
  "function poolManager() view returns (address)",
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)"
]);
const ponsFactoryAbi = parseAbi([
  "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))",
  "function memeHook() view returns (address)"
]);
const ponsMemeHookAbi = parseAbi([
  "function launches(bytes32 poolId) view returns (bool registered,bool memecoinIsCurrency0,address memecoin,address quoteToken,address creator,address buybackCreatorRecipient,address protocolFeeRecipient,uint16 creatorTaxBps,uint16 protocolFeeShareBps,uint16 buybackBurnBps,uint16 hookFeeBps,uint16 maxInternalPriceImpactBps,bool buybackEnabled)",
  "function getHookPermissions() view returns ((bool beforeInitialize,bool afterInitialize,bool beforeAddLiquidity,bool afterAddLiquidity,bool beforeRemoveLiquidity,bool afterRemoveLiquidity,bool beforeSwap,bool afterSwap,bool beforeDonate,bool afterDonate,bool beforeSwapReturnDelta,bool afterSwapReturnDelta,bool afterAddLiquidityReturnDelta,bool afterRemoveLiquidityReturnDelta))"
]);
const dopplerHookAbi = parseAbi([
  "function getHookPermissions() view returns ((bool beforeInitialize,bool afterInitialize,bool beforeAddLiquidity,bool afterAddLiquidity,bool beforeRemoveLiquidity,bool afterRemoveLiquidity,bool beforeSwap,bool afterSwap,bool beforeDonate,bool afterDonate,bool beforeSwapReturnDelta,bool afterSwapReturnDelta,bool afterAddLiquidityReturnDelta,bool afterRemoveLiquidityReturnDelta))",
  "function isDopplerHookEnabled(address dopplerHook) view returns (uint256 flags)"
]);
const rehypeHookAbi = parseAbi([
  "function INITIALIZER() view returns (address)",
  "function getPoolInfo(bytes32 poolId) view returns (address asset,address numeraire,address buybackDst)",
  "function getFeeSchedule(bytes32 poolId) view returns (uint32 startingTime,uint24 startFee,uint24 endFee,uint24 lastFee,uint32 durationSeconds)"
]);
const dependencies = [
  ["v4 position manager", V4_POSITION_MANAGER, "0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2"],
  ["v4 state view", V4_STATE_VIEW, "0x7d9c591e0956fd89d98feb4ffcfe8bf1f7a62bd485edd979fa21d104b49878a6"],
  ["v4 pool manager", V4_POOL_MANAGER, "0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626"],
  ["Permit2", PERMIT2, "0x5208783f52488f7d3493e5e38311ab707c1d75457fe472a19b0b4d57d66a7fca"],
  ["WETH", WETH, "0x5706be52f64875fee65a2cec0d80e47a23d8793cbe85d214b48445e2d05f5353"]
].map(([name, address, codeHash]) => ({ name, address, codeHash }));
const dryRun = process.argv.includes("--dry-run");
const root = process.cwd();
const chain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: RPC_URLS } },
  blockExplorers: { default: { name: "Blockscout", url: EXPLORER_URL } }
});
const publicClient = createPublicClient({
  chain,
  transport: robinhoodRpcTransport()
});

function artifact() {
  const filename = path.join(
    root,
    "contracts/artifacts/ScoplV4LimitOrderManager.json"
  );
  const compiled = JSON.parse(fs.readFileSync(filename, "utf8"));
  if (!Array.isArray(compiled.abi) || !compiled.evm?.bytecode?.object) {
    throw new Error("V4 LimitOrderManager artifact is incomplete");
  }
  return { abi: compiled.abi, bytecode: `0x${compiled.evm.bytecode.object}` };
}

function configuredAddress(name, fallback) {
  const value = process.env[name]?.trim() || fallback;
  if (!value || !isAddress(value)) throw new Error(`${name} is invalid`);
  return getAddress(value);
}

async function promptHidden(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("A TTY is required for the private-key prompt.");
  }
  return new Promise((resolve, reject) => {
    let value = "";
    const stdin = process.stdin;
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Deployment cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else if (character >= " ") value += character;
      }
    };
    process.stdout.write(question);
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function verifyDependencies() {
  if (await publicClient.getChainId() !== CHAIN_ID) {
    throw new Error(`RPC is not Robinhood Chain ${CHAIN_ID}`);
  }
  for (const dependency of dependencies) {
    const code = await publicClient.getCode({ address: dependency.address });
    if (!code || keccak256(code) !== dependency.codeHash) {
      throw new Error(`${dependency.name} runtime code does not match`);
    }
  }
  const [positionPoolManager, positionPermit2, stateViewPoolManager] =
    await Promise.all([
      publicClient.readContract({
        address: V4_POSITION_MANAGER,
        abi: positionManagerDependencyAbi,
        functionName: "poolManager"
      }),
      publicClient.readContract({
        address: V4_POSITION_MANAGER,
        abi: positionManagerDependencyAbi,
        functionName: "permit2"
      }),
      publicClient.readContract({
        address: V4_STATE_VIEW,
        abi: stateViewDependencyAbi,
        functionName: "poolManager"
      })
    ]);
  if (
    getAddress(positionPoolManager) !== getAddress(V4_POOL_MANAGER) ||
    getAddress(positionPermit2) !== getAddress(PERMIT2) ||
    getAddress(stateViewPoolManager) !== getAddress(V4_POOL_MANAGER)
  ) {
    throw new Error("V4 dependency relationship mismatch");
  }
}

async function verifyPonsV2LimitOrderSupport() {
  const factory = getAddress(PONS_V2_FACTORY);
  const expectedHook = getAddress(PONS_V2_MEME_HOOK);
  const sampleToken = getAddress(PONS_V2_SAMPLE_TOKEN);
  const [factoryCode, hookCode, factoryHook, launch, permissions] =
    await Promise.all([
      publicClient.getCode({ address: factory }),
      publicClient.getCode({ address: expectedHook }),
      publicClient.readContract({
        address: factory,
        abi: ponsFactoryAbi,
        functionName: "memeHook"
      }),
      publicClient.readContract({
        address: factory,
        abi: ponsFactoryAbi,
        functionName: "getLaunchedToken",
        args: [sampleToken]
      }),
      publicClient.readContract({
        address: expectedHook,
        abi: ponsMemeHookAbi,
        functionName: "getHookPermissions"
      })
    ]);
  if (
    !factoryCode || keccak256(factoryCode) !== PONS_V2_FACTORY_CODE_HASH ||
    !hookCode || keccak256(hookCode) !== PONS_V2_MEME_HOOK_CODE_HASH ||
    getAddress(factoryHook) !== expectedHook
  ) {
    throw new Error("Pons V2 Factory or meme hook runtime does not match the reviewed deployment");
  }
  if (
    !launch.exists || getAddress(launch.token) !== sampleToken ||
    Number(launch.phase) !== 2 || Number(launch.tickSpacing) <= 0
  ) {
    throw new Error("Pons V2 compatibility sample is not a graduated pool");
  }
  const pairToken = getAddress(launch.pairToken);
  const currency0 = BigInt(sampleToken) < BigInt(pairToken)
    ? sampleToken
    : pairToken;
  const currency1 = currency0 === sampleToken ? pairToken : sampleToken;
  const key = {
    currency0,
    currency1,
    fee: Number(launch.poolFee),
    tickSpacing: Number(launch.tickSpacing),
    hooks: expectedHook
  };
  const poolId = keccak256(encodeAbiParameters(
    parseAbiParameters(
      "(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)"
    ),
    [key]
  ));
  const [registration, slot0] = await Promise.all([
    publicClient.readContract({
      address: expectedHook,
      abi: ponsMemeHookAbi,
      functionName: "launches",
      args: [poolId]
    }),
    publicClient.readContract({
      address: V4_STATE_VIEW,
      abi: stateViewDependencyAbi,
      functionName: "getSlot0",
      args: [poolId]
    })
  ]);
  if (
    registration[0] !== true ||
    getAddress(registration[2]) !== sampleToken ||
    getAddress(registration[3]) !== pairToken ||
    slot0[0] === 0n
  ) {
    throw new Error("Pons V2 compatibility sample pool is not registered and initialized as expected");
  }
  if (
    permissions.beforeInitialize !== true ||
    permissions.afterInitialize !== false ||
    permissions.beforeAddLiquidity !== false ||
    permissions.afterAddLiquidity !== false ||
    permissions.beforeRemoveLiquidity !== false ||
    permissions.afterRemoveLiquidity !== false ||
    permissions.beforeSwap !== false ||
    permissions.afterSwap !== true ||
    permissions.beforeDonate !== false ||
    permissions.afterDonate !== false ||
    permissions.beforeSwapReturnDelta !== false ||
    permissions.afterSwapReturnDelta !== true ||
    permissions.afterAddLiquidityReturnDelta !== false ||
    permissions.afterRemoveLiquidityReturnDelta !== false
  ) {
    throw new Error("Pons V2 meme hook permissions differ from the reviewed liquidity-safe policy");
  }
  return { factory, hook: expectedHook, sampleToken, poolId, key };
}

async function verifyLongLimitOrderSupport() {
  const sampleToken = getAddress(LONG_SAMPLE_TOKEN);
  const numeraire = getAddress(LONG_SAMPLE_NUMERAIRE);
  const hook = getAddress(LONG_DOPPLER_HOOK);
  const rehypeHook = getAddress(LONG_REHYPE_HOOK);
  const tokenImplementation = getAddress(LONG_TOKEN_IMPLEMENTATION);
  const key = {
    currency0: sampleToken,
    currency1: numeraire,
    fee: 0x800000,
    tickSpacing: 8,
    hooks: hook
  };
  const poolId = keccak256(encodeAbiParameters(
    parseAbiParameters(
      "(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)"
    ),
    [key]
  ));
  if (poolId !== LONG_SAMPLE_POOL_ID) {
    throw new Error("Long.xyz compatibility sample pool key does not match the reviewed pool ID");
  }
  const [
    sampleTokenCode,
    tokenImplementationCode,
    hookCode,
    rehypeHookCode,
    permissions,
    rehypeFlags,
    rehypeInitializer,
    poolInfo,
    feeSchedule,
    slot0
  ] = await Promise.all([
    publicClient.getCode({ address: sampleToken }),
    publicClient.getCode({ address: tokenImplementation }),
    publicClient.getCode({ address: hook }),
    publicClient.getCode({ address: rehypeHook }),
    publicClient.readContract({
      address: hook,
      abi: dopplerHookAbi,
      functionName: "getHookPermissions"
    }),
    publicClient.readContract({
      address: hook,
      abi: dopplerHookAbi,
      functionName: "isDopplerHookEnabled",
      args: [rehypeHook]
    }),
    publicClient.readContract({
      address: rehypeHook,
      abi: rehypeHookAbi,
      functionName: "INITIALIZER"
    }),
    publicClient.readContract({
      address: rehypeHook,
      abi: rehypeHookAbi,
      functionName: "getPoolInfo",
      args: [poolId]
    }),
    publicClient.readContract({
      address: rehypeHook,
      abi: rehypeHookAbi,
      functionName: "getFeeSchedule",
      args: [poolId]
    }),
    publicClient.readContract({
      address: V4_STATE_VIEW,
      abi: stateViewDependencyAbi,
      functionName: "getSlot0",
      args: [poolId]
    })
  ]);
  const expectedCloneRuntime = (
    `0x3d3d3d3d363d3d37363d73${tokenImplementation.slice(2).toLowerCase()}` +
    "5af43d3d93803e602a57fd5bf3"
  );
  if (
    sampleTokenCode?.toLowerCase() !== expectedCloneRuntime ||
    !tokenImplementationCode ||
    keccak256(tokenImplementationCode) !== LONG_TOKEN_IMPLEMENTATION_CODE_HASH
  ) {
    throw new Error("Long.xyz sample token is not the reviewed Doppler ERC20 implementation clone");
  }
  if (
    !hookCode || keccak256(hookCode) !== LONG_DOPPLER_HOOK_CODE_HASH ||
    !rehypeHookCode || keccak256(rehypeHookCode) !== LONG_REHYPE_HOOK_CODE_HASH ||
    getAddress(rehypeInitializer) !== hook || rehypeFlags !== 3n
  ) {
    throw new Error("Long.xyz Doppler or Rehype hook runtime/state differs from the reviewed deployment");
  }
  if (
    permissions.beforeInitialize !== true ||
    permissions.afterInitialize !== false ||
    permissions.beforeAddLiquidity !== false ||
    permissions.afterAddLiquidity !== true ||
    permissions.beforeRemoveLiquidity !== false ||
    permissions.afterRemoveLiquidity !== true ||
    permissions.beforeSwap !== false ||
    permissions.afterSwap !== true ||
    permissions.beforeDonate !== false ||
    permissions.afterDonate !== false ||
    permissions.beforeSwapReturnDelta !== false ||
    permissions.afterSwapReturnDelta !== true ||
    permissions.afterAddLiquidityReturnDelta !== false ||
    permissions.afterRemoveLiquidityReturnDelta !== false
  ) {
    throw new Error("Long.xyz Doppler hook permissions differ from the reviewed liquidity-safe policy");
  }
  if (
    getAddress(poolInfo[0]) !== sampleToken ||
    getAddress(poolInfo[1]) !== numeraire ||
    slot0[0] === 0n || slot0[3] === 0 ||
    feeSchedule[1] === 0 || feeSchedule[2] === 0
  ) {
    throw new Error("Long.xyz compatibility sample is not the expected initialized nonzero-fee pool");
  }
  return {
    hook,
    rehypeHook,
    sampleToken,
    sampleNumeraire: numeraire,
    poolId,
    key,
    liveLpFee: Number(slot0[3])
  };
}

async function main() {
  const compiled = artifact();
  await verifyDependencies();
  const pons = await verifyPonsV2LimitOrderSupport();
  const long = await verifyLongLimitOrderSupport();
  const minimum = parseEther(
    process.env.SCOPL_MIN_GAS_RESERVE_ETH?.trim() || "0.00005"
  );
  const revenueDistributor = configuredAddress("SCOPL_REVENUE_DISTRIBUTOR_ADDRESS");
  const orderPolicy = configuredAddress("SCOPL_ORDER_POLICY_ADDRESS");
  for (const [name, address] of [["revenue distributor", revenueDistributor], ["order policy", orderPolicy]]) {
    if (!await publicClient.getCode({ address })) {
      throw new Error(`Configured ${name} has no runtime code`);
    }
  }
  console.log("Verified V4 PositionManager, StateView, PoolManager, Permit2, and WETH.");
  console.log(
    `Verified Pons V2 Factory, meme hook, and graduated sample pool ${pons.poolId}.`
  );
  console.log(
    `Verified Long.xyz Doppler/Rehype hooks and nonzero-fee sample pool ${long.poolId}.`
  );
  console.log(`Initial reserve minimum: ${minimum} wei`);
  console.log("Verified SCOPL V2 order policy and revenue distributor.");
  console.log("Hookless pools and the reviewed Pons V2 and Long.xyz hooks will be enabled.");
  if (dryRun) {
    console.log("V4 limit-order deployment preflight passed. Nothing was broadcast.");
    return;
  }

  const suppliedKey = process.env.SCOPL_DEPLOYER_PRIVATE_KEY?.trim();
  const rawKey = suppliedKey || await promptHidden(
    "V4 limit-order deployer private key (input hidden): "
  );
  const key = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("Private key must contain exactly 32 bytes");
  }
  const account = privateKeyToAccount(key);
  const owner = configuredAddress("SCOPL_LIMIT_ORDER_OWNER", account.address);
  if (getAddress(account.address) !== owner) {
    throw new Error(
      "SCOPL_LIMIT_ORDER_OWNER must match the deployer so the reviewed hook policies can be enabled"
    );
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(
      'Type "DEPLOY V4 LIMIT ORDERS" to broadcast the deployment and reviewed hook-policy transactions: '
    );
    if (answer.trim() !== "DEPLOY V4 LIMIT ORDERS") {
      throw new Error("Deployment cancelled");
    }
  } finally {
    terminal.close();
  }

  const walletClient = createWalletClient({
    account,
    chain,
    transport: robinhoodRpcTransport({ timeout: 30_000 })
  });
  const hash = await walletClient.deployContract({
    abi: compiled.abi,
    bytecode: compiled.bytecode,
    args: [
      owner,
      revenueDistributor,
      orderPolicy,
      V4_POSITION_MANAGER,
      V4_STATE_VIEW,
      V4_POOL_MANAGER,
      PERMIT2,
      WETH,
      minimum
    ]
  });
  console.log(`Deploying ${EXPLORER_URL}/tx/${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: 2,
    timeout: 180_000
  });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error("V4 LimitOrderManager deployment failed");
  }
  const address = getAddress(receipt.contractAddress);
  const ponsHookPolicyHash = keccak256("0x");
  const ponsPolicyHash = await walletClient.writeContract({
    address,
    abi: compiled.abi,
    functionName: "setHookPolicy",
    args: [pons.hook, true, ponsHookPolicyHash]
  });
  console.log(`Enabling reviewed Pons V2 hook ${EXPLORER_URL}/tx/${ponsPolicyHash}`);
  const ponsPolicyReceipt = await publicClient.waitForTransactionReceipt({
    hash: ponsPolicyHash,
    confirmations: 2,
    timeout: 180_000
  });
  if (ponsPolicyReceipt.status !== "success") {
    throw new Error("Pons V2 hook policy configuration failed");
  }
  const longHookPolicyHash = keccak256("0x");
  const longPolicyHash = await walletClient.writeContract({
    address,
    abi: compiled.abi,
    functionName: "setHookPolicy",
    args: [long.hook, true, longHookPolicyHash]
  });
  console.log(`Enabling reviewed Long.xyz hook ${EXPLORER_URL}/tx/${longPolicyHash}`);
  const longPolicyReceipt = await publicClient.waitForTransactionReceipt({
    hash: longPolicyHash,
    confirmations: 2,
    timeout: 180_000
  });
  if (longPolicyReceipt.status !== "success") {
    throw new Error("Long.xyz hook policy configuration failed");
  }
  const [
    storedOwner,
    storedDistributor,
    storedPolicy,
    contractVersion,
    zeroHook,
    zeroHookDataHash,
    executionPaused,
    automaticPayouts,
    ponsHookAllowed,
    ponsHookDataHash,
    ponsHookCodeHash,
    longHookAllowed,
    longHookDataHash,
    longHookCodeHash
  ] =
    await Promise.all([
      publicClient.readContract({ address, abi: compiled.abi, functionName: "owner" }),
      publicClient.readContract({ address, abi: compiled.abi, functionName: "revenueDistributor" }),
      publicClient.readContract({ address, abi: compiled.abi, functionName: "orderPolicy" }),
      publicClient.readContract({ address, abi: compiled.abi, functionName: "SCOPL_CONTRACT_VERSION" }),
      publicClient.readContract({
        address,
        abi: compiled.abi,
        functionName: "allowedHooks",
        args: ["0x0000000000000000000000000000000000000000"]
      }),
      publicClient.readContract({
        address,
        abi: compiled.abi,
        functionName: "allowedHookDataHash",
        args: ["0x0000000000000000000000000000000000000000"]
      }),
      publicClient.readContract({
        address,
        abi: compiled.abi,
        functionName: "executionPaused"
      }),
      publicClient.readContract({
        address,
        abi: compiled.abi,
        functionName: "automaticPayouts"
      }),
      publicClient.readContract({
        address,
        abi: compiled.abi,
        functionName: "allowedHooks",
        args: [pons.hook]
      }),
      publicClient.readContract({
        address,
        abi: compiled.abi,
        functionName: "allowedHookDataHash",
        args: [pons.hook]
      }),
      publicClient.readContract({
        address,
        abi: compiled.abi,
        functionName: "allowedHookCodeHash",
        args: [pons.hook]
      }),
      publicClient.readContract({
        address,
        abi: compiled.abi,
        functionName: "allowedHooks",
        args: [long.hook]
      }),
      publicClient.readContract({
        address,
        abi: compiled.abi,
        functionName: "allowedHookDataHash",
        args: [long.hook]
      }),
      publicClient.readContract({
        address,
        abi: compiled.abi,
        functionName: "allowedHookCodeHash",
        args: [long.hook]
      })
    ]);
  if (
    storedOwner !== owner || storedDistributor !== revenueDistributor ||
    storedPolicy !== orderPolicy || contractVersion !== 2 || zeroHook !== true ||
    zeroHookDataHash !== keccak256("0x") || executionPaused !== false ||
    automaticPayouts !== true || ponsHookAllowed !== true ||
    ponsHookDataHash !== ponsHookPolicyHash ||
    ponsHookCodeHash !== PONS_V2_MEME_HOOK_CODE_HASH ||
    longHookAllowed !== true || longHookDataHash !== longHookPolicyHash ||
    longHookCodeHash !== LONG_DOPPLER_HOOK_CODE_HASH
  ) throw new Error("Post-deployment state verification failed");
  const runtimeCode = await publicClient.getCode({ address });
  if (!runtimeCode || runtimeCode === "0x") {
    throw new Error("Deployed manager runtime code is unavailable");
  }

  const manifest = {
    contract: "ScoplV4LimitOrderManager",
    chainId: CHAIN_ID,
    address,
    transactionHash: hash,
    hookPolicyTransactionHashes: {
      ponsV2: ponsPolicyHash,
      long: longPolicyHash
    },
    blockNumber: receipt.blockNumber.toString(),
    owner,
    revenueDistributor,
    orderPolicy,
    contractVersion: 2,
    automaticPayouts,
    runtimeCodeHash: keccak256(runtimeCode),
    minGasReserveWei: minimum.toString(),
    defaultAllowedHooks: [
      "0x0000000000000000000000000000000000000000",
      pons.hook,
      long.hook
    ],
    allowedHookDataHash: {
      [pons.hook]: ponsHookPolicyHash,
      [long.hook]: longHookPolicyHash
    },
    allowedHookCodeHash: {
      [pons.hook]: ponsHookCodeHash,
      [long.hook]: longHookCodeHash
    },
    ponsV2: {
      factory: pons.factory,
      reviewedHook: pons.hook,
      compatibilitySampleToken: pons.sampleToken,
      compatibilitySamplePoolId: pons.poolId
    },
    long: {
      reviewedHook: long.hook,
      reviewedRehypeHook: long.rehypeHook,
      compatibilitySampleToken: long.sampleToken,
      compatibilitySampleNumeraire: long.sampleNumeraire,
      compatibilitySamplePoolId: long.poolId,
      liveLpFee: long.liveLpFee
    },
    dependencies,
    deployedAt: new Date().toISOString()
  };
  fs.mkdirSync(path.join(root, "deployments"), { recursive: true });
  const manifestPath = path.join(root, "deployments/v4-limit-orders-v2-4663.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`V4 LimitOrderManager deployed at ${address}`);
  console.log(`Set NEXT_PUBLIC_SCOPL_V2_V4_LIMIT_ORDER_MANAGER_ADDRESS=${address}`);
  console.log(`Set SCOPL_V2_V4_LIMIT_ORDER_MANAGER_ADDRESS=${address} for the keeper.`);
  console.log(`Set SCOPL_V2_V4_KEEPER_START_BLOCK=${receipt.blockNumber} for the keeper.`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
);
