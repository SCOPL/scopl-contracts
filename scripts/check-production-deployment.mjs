import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  defineChain,
  getAddress,
  isAddress,
  keccak256,
  parseAbi,
  parseUnits
} from "viem";
import {
  robinhoodRpcTransport,
  robinhoodRpcUrls
} from "./robinhood-rpc.mjs";

const CHAIN_ID = 4_663;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_HASH = `0x${"00".repeat(32)}`;
const V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const V3_POSITION_MANAGER = "0x73991a25c818bf1f1128deaab1492d45638de0d3";
const V3_SWAP_ROUTER = "0xcaf681a66d020601342297493863e78c959e5cb2";
const V4_POSITION_MANAGER = "0x58daec3116aae6d93017baaea7749052e8a04fa7";
const V4_STATE_VIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const V4_POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const UNIVERSAL_ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904";
const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const PONS_V2_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";

const rpcUrls = robinhoodRpcUrls();
const chain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: rpcUrls } }
});
const client = createPublicClient({
  chain,
  transport: robinhoodRpcTransport({ rank: false })
});

function requireJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), relativePath), "utf8"));
}

function configuredAddress(fallback, ...names) {
  const value = names.map((name) => process.env[name]?.trim()).find(Boolean) || fallback;
  if (!value || !isAddress(value)) {
    throw new Error(`${names[0]} is missing or invalid`);
  }
  return getAddress(value);
}

function artifact(name) {
  const filename = path.join(process.cwd(), "contracts", "artifacts", `${name}.json`);
  const parsed = JSON.parse(fs.readFileSync(filename, "utf8"));
  if (!Array.isArray(parsed.abi)) throw new Error(`Missing ${name} ABI`);
  return parsed.abi;
}

function sameAddress(actual, expected, label) {
  if (getAddress(String(actual)) !== getAddress(expected)) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
}

function sameValue(actual, expected, label) {
  if (String(actual) !== String(expected)) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
}

async function read(address, abi, functionName, args = []) {
  return client.readContract({ address, abi, functionName, args });
}

async function main() {
  sameValue(await client.getChainId(), CHAIN_ID, "chain ID");
  const deployments = {
    foundation: requireJson("deployments/order-foundation-v2-4663.json"),
    managers: requireJson("deployments/order-managers-v2-4663.json"),
    v3: requireJson("deployments/limit-orders-v2-4663.json"),
    v4: requireJson("deployments/v4-limit-orders-v2-4663.json"),
    feeRouter: requireJson("deployments/robinhood-4663.json"),
    buyback: requireJson("deployments/pons-buyback-4663.json"),
    zap: requireJson("deployments/zap-router-4663.json")
  };
  for (const [label, deployment] of Object.entries(deployments)) {
    sameValue(deployment.chainId, CHAIN_ID, `${label} manifest chain ID`);
  }
  sameValue(deployments.foundation.status, "complete", "foundation manifest status");

  const addresses = {
    feeRouter: configuredAddress(
      deployments.feeRouter.address,
      "SCOPL_FEE_ROUTER_ADDRESS", "NEXT_PUBLIC_SCOPL_FEE_ROUTER_ADDRESS"
    ),
    rewards: configuredAddress(
      deployments.foundation.referralRewards,
      "SCOPL_REFERRAL_REWARDS_ADDRESS",
      "NEXT_PUBLIC_SCOPL_REFERRAL_REWARDS_ADDRESS"
    ),
    distributor: configuredAddress(
      deployments.foundation.revenueDistributor,
      "SCOPL_REVENUE_DISTRIBUTOR_ADDRESS"
    ),
    policy: configuredAddress(
      deployments.foundation.orderPolicy,
      "SCOPL_ORDER_POLICY_ADDRESS",
      "NEXT_PUBLIC_SCOPL_ORDER_POLICY_ADDRESS"
    ),
    buyback: configuredAddress(
      deployments.foundation.existingBuybackVault,
      "SCOPL_BUYBACK_VAULT_ADDRESS"
    ),
    buybackSwapAdapter: configuredAddress(
      deployments.buyback.buybackSwapAdapter,
      "SCOPL_BUYBACK_SWAP_ADAPTER_ADDRESS"
    ),
    v3Manager: configuredAddress(
      deployments.v3.address,
      "SCOPL_V2_V3_LIMIT_ORDER_MANAGER_ADDRESS",
      "SCOPL_LIMIT_ORDER_MANAGER_ADDRESS",
      "NEXT_PUBLIC_SCOPL_V2_V3_LIMIT_ORDER_MANAGER_ADDRESS",
      "NEXT_PUBLIC_SCOPL_LIMIT_ORDER_MANAGER_ADDRESS"
    ),
    v4Manager: configuredAddress(
      deployments.v4.address,
      "SCOPL_V2_V4_LIMIT_ORDER_MANAGER_ADDRESS",
      "SCOPL_V4_LIMIT_ORDER_MANAGER_ADDRESS",
      "NEXT_PUBLIC_SCOPL_V2_V4_LIMIT_ORDER_MANAGER_ADDRESS",
      "NEXT_PUBLIC_SCOPL_V4_LIMIT_ORDER_MANAGER_ADDRESS"
    ),
    zap: configuredAddress(
      deployments.zap.address,
      "SCOPL_ZAP_ROUTER_ADDRESS",
      "NEXT_PUBLIC_SCOPL_ZAP_ROUTER_ADDRESS"
    )
  };
  const owner = configuredAddress(
    deployments.foundation.owner,
    "SCOPL_PROTOCOL_OWNER",
    "SCOPL_OWNER"
  );
  const operational = configuredAddress(
    deployments.foundation.operationalTreasury,
    "SCOPL_OPERATIONAL_TREASURY"
  );

  const runtimeCode = {};
  for (const [label, address] of Object.entries(addresses)) {
    const code = await client.getCode({ address });
    if (!code || code === "0x") throw new Error(`${label} has no bytecode`);
    runtimeCode[label] = code;
  }
  for (const [label, expectedHash] of [
    ["feeRouter", deployments.feeRouter.release.deployedRuntimeHash],
    ["rewards", deployments.foundation.runtimeCodeHashes.referralRewards],
    ["distributor", deployments.foundation.runtimeCodeHashes.revenueDistributor],
    ["policy", deployments.foundation.runtimeCodeHashes.orderPolicy],
    ["v3Manager", deployments.v3.runtimeCodeHash],
    ["v4Manager", deployments.v4.runtimeCodeHash]
  ]) {
    sameValue(keccak256(runtimeCode[label]), expectedHash, `${label} runtime hash`);
  }

  const feeAbi = artifact("ScoplFeeRouter");
  const rewardsAbi = artifact("ScoplReferralRewards");
  const distributorAbi = artifact("ScoplRevenueDistributor");
  const policyAbi = artifact("ScoplOrderPolicy");
  const buybackAbi = artifact("ScoplBuybackVault");
  const swapAdapterAbi = artifact("ScoplRouterSwapAdapter");
  const v3Abi = artifact("ScoplLimitOrderManager");
  const v4Abi = artifact("ScoplV4LimitOrderManager");
  const zapAbi = artifact("ScoplZapRouter");
  const expectedLpBase = Number(
    process.env.SCOPL_LP_BASE_FEE_BPS || deployments.feeRouter.baseFeeBps
  );
  const configuredFeeToken = configuredAddress(
    deployments.foundation.canonicalScoplToken,
    "SCOPL_TOKEN_ADDRESS"
  );

  const [feeVersion, feeMaximum, feeBase, feePaused, feeOwner,
    feeDistributor, feeToken] = await Promise.all([
    read(addresses.feeRouter, feeAbi, "VERSION"),
    read(addresses.feeRouter, feeAbi, "MAX_FEE_BPS"),
    read(addresses.feeRouter, feeAbi, "baseFeeBps"),
    read(addresses.feeRouter, feeAbi, "paused"),
    read(addresses.feeRouter, feeAbi, "owner"),
    read(addresses.feeRouter, feeAbi, "revenueDistributor"),
    read(addresses.feeRouter, feeAbi, "feeToken")
  ]);
  sameValue(feeVersion, "3.0.0", "Fee Router version");
  sameValue(feeMaximum, 500, "Fee Router ceiling");
  sameValue(feeBase, expectedLpBase, "Fee Router base fee");
  sameValue(feePaused, false, "Fee Router pause state");
  sameAddress(feeOwner, owner, "Fee Router owner");
  sameAddress(
    feeDistributor,
    addresses.distributor,
    "Fee Router V2 distributor"
  );

  const [rewardsOwner, share, creditor, policyBinder] = await Promise.all([
    read(addresses.rewards, rewardsAbi, "owner"),
    read(addresses.rewards, rewardsAbi, "referralShareBps"),
    read(addresses.rewards, rewardsAbi, "revenueCreditors", [addresses.distributor]),
    read(addresses.rewards, rewardsAbi, "referralBinders", [addresses.policy])
  ]);
  sameAddress(rewardsOwner, owner, "Referral Rewards owner");
  sameValue(share, 3000, "Referral share");
  sameValue(creditor, true, "Distributor referral-credit permission");
  sameValue(policyBinder, true, "Order Policy referral-binder permission");

  const [distributorOwner, referralDestination, buybackDestination,
    operationalDestination, distributorPaused, distributorWeth,
    referralShare, buybackShare, operationalShare] = await Promise.all([
    read(addresses.distributor, distributorAbi, "owner"),
    read(addresses.distributor, distributorAbi, "referralRewards"),
    read(addresses.distributor, distributorAbi, "buybackVault"),
    read(addresses.distributor, distributorAbi, "operationalTreasury"),
    read(addresses.distributor, distributorAbi, "paused"),
    read(addresses.distributor, distributorAbi, "weth"),
    read(addresses.distributor, distributorAbi, "REFERRAL_SHARE_BPS"),
    read(addresses.distributor, distributorAbi, "BUYBACK_SHARE_BPS"),
    read(addresses.distributor, distributorAbi, "OPERATIONAL_SHARE_BPS")
  ]);
  sameAddress(distributorOwner, owner, "Distributor owner");
  sameAddress(referralDestination, addresses.rewards, "Referral destination");
  sameAddress(buybackDestination, addresses.buyback, "Buyback destination");
  sameAddress(operationalDestination, operational, "Operational destination");
  sameAddress(distributorWeth, WETH, "Distributor WETH");
  sameValue(distributorPaused, false, "Distributor pause state");
  sameValue(referralShare, 3000, "Distributor referral share");
  sameValue(buybackShare, 5000, "Distributor buyback share");
  sameValue(operationalShare, 2000, "Distributor operational share");

  for (const [address, product, label] of [
    [addresses.v3Manager, 1, "V3 orders"],
    [addresses.v4Manager, 2, "V4 orders"]
  ]) {
    const [storedProduct, enabled] = await read(
      addresses.distributor, distributorAbi, "revenueSources", [address]
    );
    sameValue(storedProduct, product, `${label} product`);
    sameValue(enabled, true, `${label} source permission`);
  }
  const [sharedFeeProduct, sharedFeeEnabled] = await read(
    addresses.distributor,
    distributorAbi,
    "revenueSources",
    [addresses.feeRouter]
  );
  sameValue(sharedFeeProduct, 0, "Fee Router revenue product");
  sameValue(
    sharedFeeEnabled,
    true,
    "Fee Router V2 revenue permission"
  );

  const [policyOwner, policyToken, policyChainId, policyRewards, policySigner,
    tierConfiguration] = await Promise.all([
    read(addresses.policy, policyAbi, "owner"),
    read(addresses.policy, policyAbi, "canonicalScoplToken"),
    read(addresses.policy, policyAbi, "canonicalScoplChainId"),
    read(addresses.policy, policyAbi, "referralRewards"),
    read(addresses.policy, policyAbi, "tierSigner"),
    read(addresses.policy, policyAbi, "tierConfiguration")
  ]);
  sameAddress(policyOwner, owner, "Order Policy owner");
  sameAddress(policyToken, configuredFeeToken, "Order Policy canonical SCOPL");
  sameValue(policyChainId, CHAIN_ID, "Order Policy canonical chain ID");
  sameAddress(policyRewards, addresses.rewards, "Order Policy Referral Rewards");
  sameAddress(
    policySigner,
    configuredAddress(
      deployments.foundation.tierSigner,
      "SCOPL_TIER_SIGNER_ADDRESS"
    ),
    "Order Policy tier signer"
  );
  for (const [index, expected] of deployments.foundation.minimumBalances.entries()) {
    sameValue(tierConfiguration[0][index], expected, `tier threshold ${index}`);
  }
  for (const [index, expected] of deployments.foundation.beneficiarySharesBps.entries()) {
    sameValue(tierConfiguration[1][index], expected, `tier beneficiary share ${index}`);
  }
  for (const [manager, label] of [
    [addresses.v3Manager, "V3"],
    [addresses.v4Manager, "V4"]
  ]) {
    sameValue(
      await read(addresses.policy, policyAbi, "managers", [manager]),
      true,
      `${label} Order Policy permission`
    );
  }

  const [buybackOwner, buybackConfigured, buybackFinalized, buybackRecipient,
    adapterAllowed, adapterHash, buybackWeth, buybackPonsFactory,
    keeperRewardWei] = await Promise.all([
    read(addresses.buyback, buybackAbi, "owner"),
    read(addresses.buyback, buybackAbi, "buybackConfigured"),
    read(addresses.buyback, buybackAbi, "buybackConfigurationFinalized"),
    read(addresses.buyback, buybackAbi, "buybackRecipient"),
    read(addresses.buyback, buybackAbi, "allowedAdapters", [addresses.buybackSwapAdapter]),
    read(addresses.buyback, buybackAbi, "adapterCodeHash", [addresses.buybackSwapAdapter]),
    read(addresses.buyback, buybackAbi, "weth"),
    read(addresses.buyback, buybackAbi, "ponsV2Factory"),
    read(addresses.buyback, buybackAbi, "keeperRewardWei")
  ]);
  sameAddress(buybackOwner, owner, "Buyback vault owner");
  sameAddress(buybackWeth, WETH, "Buyback vault WETH");
  sameAddress(
    buybackPonsFactory,
    PONS_V2_FACTORY,
    "Buyback vault Pons V2 Factory"
  );
  if (keeperRewardWei <= 0n || keeperRewardWei > 1_000_000_000_000_000n) {
    throw new Error("Buyback keeper reward is outside its safe contract bounds");
  }
  sameValue(adapterAllowed, true, "Buyback swap adapter permission");
  sameValue(
    adapterHash,
    keccak256(await client.getCode({ address: addresses.buybackSwapAdapter })),
    "Buyback swap adapter code hash"
  );
  sameAddress(
    await read(addresses.buybackSwapAdapter, swapAdapterAbi, "controller"),
    addresses.buyback,
    "Buyback swap adapter controller"
  );
  sameAddress(
    await read(addresses.buybackSwapAdapter, swapAdapterAbi, "router"),
    UNIVERSAL_ROUTER,
    "Buyback swap adapter router"
  );
  sameAddress(
    await read(addresses.buybackSwapAdapter, swapAdapterAbi, "permit2"),
    PERMIT2,
    "Buyback swap adapter Permit2"
  );
  sameAddress(
    await read(addresses.buybackSwapAdapter, swapAdapterAbi, "weth"),
    WETH,
    "Buyback swap adapter WETH"
  );

  if (configuredFeeToken) {
    const buybackKeeper = configuredAddress(
      deployments.buyback.keeper,
      "SCOPL_BUYBACK_KEEPER_ADDRESS"
    );
    const ponsLaunch = await read(
      PONS_V2_FACTORY,
      parseAbi([
        "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))"
      ]),
      "getLaunchedToken",
      [getAddress(configuredFeeToken)]
    );
    sameValue(ponsLaunch.exists, true, "SCOPL Pons V2 launch existence");
    sameAddress(ponsLaunch.token, configuredFeeToken, "SCOPL Pons V2 launch token");
    const ponsCurveCode = await client.getCode({ address: ponsLaunch.curve });
    if (!ponsCurveCode || ponsCurveCode === "0x") {
      throw new Error("SCOPL Pons V2 curve has no bytecode");
    }
    sameAddress(feeToken, configuredFeeToken, "Fee Router discount token");
    const tokenDecimals = await read(
      getAddress(configuredFeeToken),
      parseAbi(["function decimals() view returns (uint8)"]),
      "decimals"
    );
    const expectedFreeClaimMinimum = parseUnits(
      process.env.SCOPL_LP_FREE_CLAIM_MINIMUM_BALANCE?.trim() || "1000",
      Number(tokenDecimals)
    );
    const claimTiers = await Promise.all([0n, 1n, 2n].map((tier) =>
      read(addresses.feeRouter, feeAbi, "discountTiers", [tier])
    ));
    sameValue(
      claimTiers[0][0],
      expectedFreeClaimMinimum,
      "Fee Router free-claim minimum"
    );
    sameValue(claimTiers[0][1], 0, "Fee Router holder claim fee");
    for (const tier of [1, 2]) {
      sameValue(claimTiers[tier][0], 0, `Fee Router disabled tier ${tier}`);
      sameValue(claimTiers[tier][1], 0, `Fee Router disabled fee ${tier}`);
    }
    sameAddress(
      await read(addresses.buyback, buybackAbi, "buybackToken"),
      configuredFeeToken,
      "Buyback reserve token"
    );
    sameValue(buybackConfigured, true, "Buyback configuration");
    sameValue(buybackFinalized, true, "Buyback finalization");
    sameAddress(buybackRecipient, addresses.buyback, "Buyback reserve recipient");
    sameValue(
      await read(addresses.buyback, buybackAbi, "executors", [buybackKeeper]),
      true,
      "Buyback keeper permission"
    );
  } else {
    sameAddress(feeToken, ZERO_ADDRESS, "Fee Router pre-token state");
    sameValue(buybackConfigured, false, "Buyback pre-token configuration");
    sameValue(buybackFinalized, false, "Buyback pre-token finalization");
    console.warn("SCOPL is not configured; the Buyback Vault is accumulating fee tokens.");
  }

  for (const [manager, abi, deployment, label] of [
    [addresses.v3Manager, v3Abi, deployments.v3, "V3"],
    [addresses.v4Manager, v4Abi, deployments.v4, "V4"]
  ]) {
    const [managerOwner, managerDistributor, managerPolicy, contractVersion,
      minimumProtocolShare, maximumBeneficiaryShare, minimumReserve, paused,
      executionPaused, automaticPayouts] = await Promise.all([
      read(manager, abi, "owner"),
      read(manager, abi, "revenueDistributor"),
      read(manager, abi, "orderPolicy"),
      read(manager, abi, "SCOPL_CONTRACT_VERSION"),
      read(manager, abi, "MIN_PROTOCOL_SHARE_BPS"),
      read(manager, abi, "MAX_BENEFICIARY_SHARE_BPS"),
      read(manager, abi, "minGasReserveWei"),
      read(manager, abi, "paused"),
      read(manager, abi, "executionPaused"),
      read(manager, abi, "automaticPayouts")
    ]);
    sameAddress(managerOwner, owner, `${label} manager owner`);
    sameAddress(managerDistributor, addresses.distributor, `${label} distributor`);
    sameAddress(managerPolicy, addresses.policy, `${label} Order Policy`);
    sameValue(contractVersion, 2, `${label} contract version`);
    sameValue(minimumProtocolShare, 2500, `${label} minimum protocol share`);
    sameValue(maximumBeneficiaryShare, 7500, `${label} maximum beneficiary share`);
    sameValue(minimumReserve, deployment.minGasReserveWei, `${label} minimum gas reserve`);
    sameValue(paused, false, `${label} creation pause`);
    sameValue(executionPaused, false, `${label} execution pause`);
    sameValue(automaticPayouts, true, `${label} automatic ETH payouts`);
  }

  sameAddress(await read(addresses.v3Manager, v3Abi, "factory"), V3_FACTORY, "V3 factory");
  sameAddress(
    await read(addresses.v3Manager, v3Abi, "positionManager"),
    V3_POSITION_MANAGER,
    "V3 PositionManager"
  );
  sameAddress(
    await read(addresses.v4Manager, v4Abi, "positionManager"),
    V4_POSITION_MANAGER,
    "V4 PositionManager"
  );
  sameAddress(await read(addresses.v4Manager, v4Abi, "stateView"), V4_STATE_VIEW, "V4 StateView");
  sameAddress(await read(addresses.v4Manager, v4Abi, "poolManager"), V4_POOL_MANAGER, "V4 PoolManager");
  sameAddress(await read(addresses.v4Manager, v4Abi, "permit2"), PERMIT2, "V4 Permit2");
  sameAddress(await read(addresses.v4Manager, v4Abi, "weth"), WETH, "V4 WETH");
  sameValue(
    await read(addresses.v4Manager, v4Abi, "allowedHooks", [ZERO_ADDRESS]),
    true,
    "hookless V4 policy"
  );
  sameValue(
    await read(addresses.v4Manager, v4Abi, "allowedHookDataHash", [ZERO_ADDRESS]),
    keccak256("0x"),
    "hookless calldata policy"
  );
  sameValue(
    await read(addresses.v4Manager, v4Abi, "allowedHookCodeHash", [ZERO_ADDRESS]),
    ZERO_HASH,
    "hookless code policy"
  );
  for (const hook of deployments.v4.defaultAllowedHooks.slice(1)) {
    const expectedDataHash = deployments.v4.allowedHookDataHash[hook];
    const expectedCodeHash = deployments.v4.allowedHookCodeHash[hook];
    sameValue(
      await read(addresses.v4Manager, v4Abi, "allowedHooks", [hook]),
      true,
      `${hook} hook permission`
    );
    sameValue(
      await read(addresses.v4Manager, v4Abi, "allowedHookDataHash", [hook]),
      expectedDataHash,
      `${hook} hook data hash`
    );
    sameValue(
      await read(addresses.v4Manager, v4Abi, "allowedHookCodeHash", [hook]),
      expectedCodeHash,
      `${hook} stored hook code hash`
    );
    const hookCode = await client.getCode({ address: getAddress(hook) });
    if (!hookCode || hookCode === "0x") throw new Error(`${hook} has no bytecode`);
    sameValue(keccak256(hookCode), expectedCodeHash, `${hook} live hook code hash`);
  }

  for (const [functionName, expected, label] of [
    ["owner", owner, "Zap owner"],
    ["v3SwapRouter", V3_SWAP_ROUTER, "Zap V3 SwapRouter"],
    ["v3PositionManager", V3_POSITION_MANAGER, "Zap V3 PositionManager"],
    ["v4PositionManager", V4_POSITION_MANAGER, "Zap V4 PositionManager"],
    ["v4StateView", V4_STATE_VIEW, "Zap V4 StateView"],
    ["universalRouter", UNIVERSAL_ROUTER, "Zap UniversalRouter"],
    ["permit2", PERMIT2, "Zap Permit2"],
    ["weth", WETH, "Zap WETH"]
  ]) {
    sameAddress(await read(addresses.zap, zapAbi, functionName), expected, label);
  }

  console.log("Robinhood V2 production deployment verification passed.");
  console.log({
    ...addresses,
    feeRouterDistributor: addresses.distributor,
    allV2RevenueUsesOneDistributor: true
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
