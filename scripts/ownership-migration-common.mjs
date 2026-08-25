import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  defineChain,
  getAddress,
  isAddress,
  keccak256,
  parseAbi
} from "viem";
import {
  robinhoodRpcTransport,
  robinhoodRpcUrls
} from "./robinhood-rpc.mjs";

export const CHAIN_ID = 4_663;
export const SAFE = getAddress("0x8240bce5CaC6241C7B5ad3D2Ac4941e5d1014517");
export const ZERO_ADDRESS = getAddress("0x0000000000000000000000000000000000000000");
export const WETH = getAddress("0x0bd7d308f8e1639fab988df18a8011f41eacad73");
export const PONS_V2_FACTORY = getAddress("0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e");
export const UNIVERSAL_ROUTER = getAddress("0x8876789976decbfcbbbe364623c63652db8c0904");
export const PERMIT2 = getAddress("0x000000000022d473030f116ddee9f6b43ac78ba3");
export const SAFE_SINGLETON = getAddress("0x29fcB43b46531BcA003ddC8FCB67FFE91900C762");
export const SAFE_FALLBACK_HANDLER = getAddress("0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99");

const GUARD_STORAGE_SLOT =
  "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";
const FALLBACK_HANDLER_STORAGE_SLOT =
  "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5";
const SENTINEL_MODULES = getAddress("0x0000000000000000000000000000000000000001");
const EMPTY_BYTES_HASH = keccak256("0x");
const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const PROXY_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const BEACON_SLOT =
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const FIXED_PRODUCTION = {
  ReferralRewards: getAddress("0x27f1944b9C2d104446CF25aEA01510A27870f609"),
  RevenueDistributor: getAddress("0x1cfB6dC47b7F2Ac83939Ba863AE41E7041414F13"),
  OrderPolicy: getAddress("0xfA7a06b158eCf40232A4e1c976160be592391646")
};

export const ownableAbi = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function transferOwnership(address nextOwner)",
  "function acceptOwnership()"
]);

const safeAbi = parseAbi([
  "function VERSION() view returns (string)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function getModulesPaginated(address start,uint256 pageSize) view returns (address[] array,address next)",
  "function getStorageAt(uint256 offset,uint256 length) view returns (bytes)"
]);

const rpcUrls = robinhoodRpcUrls();
export const chain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: rpcUrls } }
});
export const publicClient = createPublicClient({
  chain,
  transport: robinhoodRpcTransport()
});
export const walletTransport = () =>
  robinhoodRpcTransport({ timeout: 30_000 });

function configuredAddress(...names) {
  const value = names.map((name) => process.env[name]?.trim()).find(Boolean);
  if (!value || !isAddress(value)) {
    throw new Error(`${names[0]} is missing or invalid in .env`);
  }
  return getAddress(value);
}

function readManifest(filename) {
  const fullPath = path.join(process.cwd(), "deployments", filename);
  if (!fs.existsSync(fullPath)) {
    throw new Error(
      `Missing deployments/${filename}. The final Pons-aware BuybackVault must be deployed and recorded before ownership migration.`
    );
  }
  const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  if (Number(parsed.chainId) !== CHAIN_ID) {
    throw new Error(`${filename} has unexpected chainId ${parsed.chainId}`);
  }
  return parsed;
}

function sameAddress(actual, expected, label) {
  if (getAddress(actual) !== getAddress(expected)) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
}

function addressFromManifest(manifest, key, filename) {
  const value = manifest[key];
  if (!value || !isAddress(value)) {
    throw new Error(`${filename} is missing a valid ${key}`);
  }
  return getAddress(value);
}

export function resolveFinalProductionTargets() {
  const feeManifest = readManifest("robinhood-4663.json");
  const foundationManifest = readManifest("order-foundation-v2-4663.json");
  const v3Manifest = readManifest("limit-orders-v2-4663.json");
  const v4Manifest = readManifest("v4-limit-orders-v2-4663.json");
  const zapManifest = readManifest("zap-router-4663.json");
  const ponsManifest = readManifest("pons-buyback-4663.json");

  const targets = [
    {
      name: "FeeRouter",
      address: configuredAddress(
        "SCOPL_FEE_ROUTER_ADDRESS",
        "NEXT_PUBLIC_SCOPL_FEE_ROUTER_ADDRESS"
      )
    },
    {
      name: "ReferralRewards",
      address: configuredAddress(
        "SCOPL_REFERRAL_REWARDS_ADDRESS",
        "NEXT_PUBLIC_SCOPL_REFERRAL_REWARDS_ADDRESS"
      )
    },
    {
      name: "RevenueDistributor",
      address: configuredAddress("SCOPL_REVENUE_DISTRIBUTOR_ADDRESS")
    },
    {
      name: "OrderPolicy",
      address: configuredAddress(
        "SCOPL_ORDER_POLICY_ADDRESS",
        "NEXT_PUBLIC_SCOPL_ORDER_POLICY_ADDRESS"
      )
    },
    {
      name: "BuybackVault",
      address: configuredAddress("SCOPL_BUYBACK_VAULT_ADDRESS")
    },
    {
      name: "V3LimitOrderManager",
      address: configuredAddress(
        "SCOPL_V2_V3_LIMIT_ORDER_MANAGER_ADDRESS",
        "SCOPL_LIMIT_ORDER_MANAGER_ADDRESS",
        "NEXT_PUBLIC_SCOPL_V2_V3_LIMIT_ORDER_MANAGER_ADDRESS",
        "NEXT_PUBLIC_SCOPL_LIMIT_ORDER_MANAGER_ADDRESS"
      )
    },
    {
      name: "V4LimitOrderManager",
      address: configuredAddress(
        "SCOPL_V2_V4_LIMIT_ORDER_MANAGER_ADDRESS",
        "SCOPL_V4_LIMIT_ORDER_MANAGER_ADDRESS",
        "NEXT_PUBLIC_SCOPL_V2_V4_LIMIT_ORDER_MANAGER_ADDRESS",
        "NEXT_PUBLIC_SCOPL_V4_LIMIT_ORDER_MANAGER_ADDRESS"
      )
    },
    {
      name: "ZapRouter",
      address: configuredAddress("NEXT_PUBLIC_SCOPL_ZAP_ROUTER_ADDRESS")
    }
  ];
  const adapter = configuredAddress("SCOPL_BUYBACK_SWAP_ADAPTER_ADDRESS");

  sameAddress(
    targets[1].address,
    FIXED_PRODUCTION.ReferralRewards,
    "ReferralRewards production address"
  );
  sameAddress(
    targets[2].address,
    FIXED_PRODUCTION.RevenueDistributor,
    "RevenueDistributor production address"
  );
  sameAddress(
    targets[3].address,
    FIXED_PRODUCTION.OrderPolicy,
    "OrderPolicy production address"
  );
  sameAddress(
    targets[1].address,
    addressFromManifest(foundationManifest, "referralRewards", "order-foundation-v2-4663.json"),
    "ReferralRewards V2 manifest"
  );
  sameAddress(
    targets[2].address,
    addressFromManifest(foundationManifest, "revenueDistributor", "order-foundation-v2-4663.json"),
    "RevenueDistributor V2 manifest"
  );
  sameAddress(
    targets[3].address,
    addressFromManifest(foundationManifest, "orderPolicy", "order-foundation-v2-4663.json"),
    "OrderPolicy V2 manifest"
  );

  sameAddress(
    targets[0].address,
    addressFromManifest(feeManifest, "address", "robinhood-4663.json"),
    "FeeRouter .env/manifest"
  );
  sameAddress(
    targets[5].address,
    addressFromManifest(v3Manifest, "address", "limit-orders-v2-4663.json"),
    "V2 V3 manager .env/manifest"
  );
  sameAddress(
    targets[6].address,
    addressFromManifest(v4Manifest, "address", "v4-limit-orders-v2-4663.json"),
    "V2 V4 manager .env/manifest"
  );
  sameAddress(
    targets[7].address,
    addressFromManifest(zapManifest, "address", "zap-router-4663.json"),
    "ZapRouter .env/manifest"
  );
  sameAddress(
    targets[4].address,
    addressFromManifest(ponsManifest, "buybackVault", "pons-buyback-4663.json"),
    "BuybackVault .env/final manifest"
  );
  sameAddress(
    adapter,
    addressFromManifest(
      ponsManifest,
      "buybackSwapAdapter",
      "pons-buyback-4663.json"
    ),
    "SwapAdapter .env/final manifest"
  );
  sameAddress(
    targets[4].address,
    addressFromManifest(foundationManifest, "existingBuybackVault", "order-foundation-v2-4663.json"),
    "BuybackVault V2 foundation manifest"
  );

  return { targets, adapter, ponsManifest };
}

function bytesToAddress(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`Unexpected 32-byte address encoding: ${value}`);
  }
  return getAddress(`0x${value.slice(-40)}`);
}

export async function verifySafe() {
  const code = await publicClient.getCode({ address: SAFE });
  if (!code || code === "0x") throw new Error(`Safe ${SAFE} has no runtime code`);
  const [version, owners, threshold, nonce, modulePage, guardRaw, handlerRaw, slot0] =
    await Promise.all([
      publicClient.readContract({ address: SAFE, abi: safeAbi, functionName: "VERSION" }),
      publicClient.readContract({ address: SAFE, abi: safeAbi, functionName: "getOwners" }),
      publicClient.readContract({ address: SAFE, abi: safeAbi, functionName: "getThreshold" }),
      publicClient.readContract({ address: SAFE, abi: safeAbi, functionName: "nonce" }),
      publicClient.readContract({
        address: SAFE,
        abi: safeAbi,
        functionName: "getModulesPaginated",
        args: [SENTINEL_MODULES, 100n]
      }),
      publicClient.readContract({
        address: SAFE,
        abi: safeAbi,
        functionName: "getStorageAt",
        args: [BigInt(GUARD_STORAGE_SLOT), 1n]
      }),
      publicClient.readContract({
        address: SAFE,
        abi: safeAbi,
        functionName: "getStorageAt",
        args: [BigInt(FALLBACK_HANDLER_STORAGE_SLOT), 1n]
      }),
      publicClient.getStorageAt({
        address: SAFE,
        slot: `0x${"0".repeat(64)}`
      })
    ]);
  if (version !== "1.4.1") throw new Error(`Safe version is ${version}, expected 1.4.1`);
  if (!slot0) throw new Error("Safe singleton slot is unreadable");
  sameAddress(bytesToAddress(slot0), SAFE_SINGLETON, "Safe singleton");
  if (threshold < 2n || threshold > BigInt(owners.length)) {
    throw new Error(`Unsafe Safe threshold ${threshold}/${owners.length}`);
  }
  if (modulePage[0].length !== 0 || getAddress(modulePage[1]) !== SENTINEL_MODULES) {
    throw new Error("Safe has enabled modules; review them before ownership migration");
  }
  const guard = bytesToAddress(guardRaw);
  if (guard !== ZERO_ADDRESS) {
    throw new Error(`Safe has transaction guard ${guard}; review it before migration`);
  }
  const fallbackHandler = bytesToAddress(handlerRaw);
  sameAddress(fallbackHandler, SAFE_FALLBACK_HANDLER, "Safe fallback handler");
  return {
    address: SAFE,
    version,
    singleton: SAFE_SINGLETON,
    owners: owners.map((owner) => getAddress(owner)),
    threshold: threshold.toString(),
    nonce: nonce.toString(),
    modules: [],
    guard,
    fallbackHandler
  };
}

async function read(address, abi, functionName, args = []) {
  return publicClient.readContract({ address, abi, functionName, args });
}

const feeAbi = parseAbi([
  "function revenueDistributor() view returns (address)",
  "function feeToken() view returns (address)",
  "function paused() view returns (bool)"
]);
const rewardsAbi = parseAbi([
  "function revenueCreditors(address) view returns (bool)",
  "function referralBinders(address) view returns (bool)",
  "function referrerApprovalRequired() view returns (bool)"
]);
const policyAbi = parseAbi([
  "function referralRewards() view returns (address)",
  "function managers(address) view returns (bool)"
]);
const distributorAbi = parseAbi([
  "function guardian() view returns (address)",
  "function referralRewards() view returns (address)",
  "function buybackVault() view returns (address)",
  "function operationalTreasury() view returns (address)",
  "function paused() view returns (bool)",
  "function revenueSources(address) view returns (uint8 product,bool enabled)"
]);
const buybackAbi = parseAbi([
  "function guardian() view returns (address)",
  "function ponsV2Factory() view returns (address)",
  "function buybackToken() view returns (address)",
  "function buybackRecipient() view returns (address)",
  "function buybackConfigured() view returns (bool)",
  "function buybackConfigurationFinalized() view returns (bool)",
  "function paused() view returns (bool)",
  "function executors(address) view returns (bool)",
  "function allowedAdapters(address) view returns (bool)",
  "function adapterCodeHash(address) view returns (bytes32)"
]);
const adapterAbi = parseAbi([
  "function controller() view returns (address)",
  "function router() view returns (address)",
  "function permit2() view returns (address)",
  "function weth() view returns (address)"
]);
const managerAbi = parseAbi([
  "function revenueDistributor() view returns (address)",
  "function orderPolicy() view returns (address)",
  "function paused() view returns (bool)",
  "function executionPaused() view returns (bool)"
]);
const v4PolicyAbi = parseAbi([
  "function allowedHooks(address) view returns (bool)",
  "function allowedHookDataHash(address) view returns (bytes32)",
  "function allowedHookCodeHash(address) view returns (bytes32)"
]);

export async function verifyFinalProductionRelationships(resolved) {
  if (await publicClient.getChainId() !== CHAIN_ID) {
    throw new Error(`RPC is not Robinhood Chain ${CHAIN_ID}`);
  }
  const byName = Object.fromEntries(
    resolved.targets.map((target) => [target.name, target.address])
  );
  for (const target of [...resolved.targets, { name: "RouterSwapAdapter", address: resolved.adapter }]) {
    const code = await publicClient.getCode({ address: target.address });
    if (!code || code === "0x") throw new Error(`${target.name} has no runtime code`);
    for (const slot of [IMPLEMENTATION_SLOT, PROXY_ADMIN_SLOT, BEACON_SLOT]) {
      const value = await publicClient.getStorageAt({
        address: target.address,
        slot
      });
      if (value && BigInt(value) !== 0n) {
        throw new Error(`${target.name} has nonzero proxy control slot ${slot}`);
      }
    }
  }

  const [feeDistributor, feePaused, rewardsCreditor, approvalRequired,
    distributorGuardian, referralDestination, buybackDestination,
    operationalTreasury, distributorPaused, buybackGuardian,
    ponsFactory, buybackToken, buybackRecipient, buybackConfigured,
    buybackFinalized, buybackPaused, adapterAllowed, adapterHash,
    adapterController, adapterRouter, adapterPermit2, adapterWeth] =
    await Promise.all([
      read(byName.FeeRouter, feeAbi, "revenueDistributor"),
      read(byName.FeeRouter, feeAbi, "paused"),
      read(byName.ReferralRewards, rewardsAbi, "revenueCreditors", [byName.RevenueDistributor]),
      read(byName.ReferralRewards, rewardsAbi, "referrerApprovalRequired"),
      read(byName.RevenueDistributor, distributorAbi, "guardian"),
      read(byName.RevenueDistributor, distributorAbi, "referralRewards"),
      read(byName.RevenueDistributor, distributorAbi, "buybackVault"),
      read(byName.RevenueDistributor, distributorAbi, "operationalTreasury"),
      read(byName.RevenueDistributor, distributorAbi, "paused"),
      read(byName.BuybackVault, buybackAbi, "guardian"),
      read(byName.BuybackVault, buybackAbi, "ponsV2Factory"),
      read(byName.BuybackVault, buybackAbi, "buybackToken"),
      read(byName.BuybackVault, buybackAbi, "buybackRecipient"),
      read(byName.BuybackVault, buybackAbi, "buybackConfigured"),
      read(byName.BuybackVault, buybackAbi, "buybackConfigurationFinalized"),
      read(byName.BuybackVault, buybackAbi, "paused"),
      read(byName.BuybackVault, buybackAbi, "allowedAdapters", [resolved.adapter]),
      read(byName.BuybackVault, buybackAbi, "adapterCodeHash", [resolved.adapter]),
      read(resolved.adapter, adapterAbi, "controller"),
      read(resolved.adapter, adapterAbi, "router"),
      read(resolved.adapter, adapterAbi, "permit2"),
      read(resolved.adapter, adapterAbi, "weth")
    ]);

  const [policyRewards, policyBinder, v3PolicyAllowed, v4PolicyAllowed] =
    await Promise.all([
      read(byName.OrderPolicy, policyAbi, "referralRewards"),
      read(byName.ReferralRewards, rewardsAbi, "referralBinders", [byName.OrderPolicy]),
      read(byName.OrderPolicy, policyAbi, "managers", [byName.V3LimitOrderManager]),
      read(byName.OrderPolicy, policyAbi, "managers", [byName.V4LimitOrderManager])
    ]);

  sameAddress(feeDistributor, byName.RevenueDistributor, "FeeRouter distributor");
  if (feePaused) throw new Error("FeeRouter is paused");
  if (!rewardsCreditor) throw new Error("RevenueDistributor is not an authorized referral creditor");
  sameAddress(policyRewards, byName.ReferralRewards, "OrderPolicy referral module");
  if (!policyBinder) throw new Error("OrderPolicy is not an authorized referral binder");
  if (!v3PolicyAllowed || !v4PolicyAllowed) {
    throw new Error("A V2 manager is not authorized in OrderPolicy");
  }
  sameAddress(referralDestination, byName.ReferralRewards, "Referral destination");
  sameAddress(buybackDestination, byName.BuybackVault, "Buyback destination");
  if (distributorPaused) throw new Error("RevenueDistributor is paused");
  sameAddress(ponsFactory, PONS_V2_FACTORY, "BuybackVault Pons V2 Factory");
  sameAddress(buybackRecipient, byName.BuybackVault, "Buyback recipient");
  if (!buybackConfigured || !buybackFinalized || buybackToken === ZERO_ADDRESS) {
    throw new Error("Final Pons-aware BuybackVault is not configured and finalized");
  }
  if (buybackPaused) throw new Error("BuybackVault is paused");
  if (!adapterAllowed) throw new Error("Final RouterSwapAdapter is not allowed by BuybackVault");
  const adapterCode = await publicClient.getCode({ address: resolved.adapter });
  if (!adapterCode || adapterHash !== keccak256(adapterCode)) {
    throw new Error("BuybackVault adapter code hash does not match live adapter code");
  }
  sameAddress(adapterController, byName.BuybackVault, "RouterSwapAdapter controller");
  sameAddress(adapterRouter, UNIVERSAL_ROUTER, "RouterSwapAdapter router");
  sameAddress(adapterPermit2, PERMIT2, "RouterSwapAdapter Permit2");
  sameAddress(adapterWeth, WETH, "RouterSwapAdapter WETH");

  for (const [name, product] of [
    ["FeeRouter", 0],
    ["V3LimitOrderManager", 1],
    ["V4LimitOrderManager", 2]
  ]) {
    const source = await read(
      byName.RevenueDistributor,
      distributorAbi,
      "revenueSources",
      [byName[name]]
    );
    if (Number(source[0]) !== product || source[1] !== true) {
      throw new Error(`${name} is not the expected enabled revenue source`);
    }
  }
  for (const name of ["V3LimitOrderManager", "V4LimitOrderManager"]) {
    const [distributor, orderPolicy, paused, executionPaused] = await Promise.all([
      read(byName[name], managerAbi, "revenueDistributor"),
      read(byName[name], managerAbi, "orderPolicy"),
      read(byName[name], managerAbi, "paused"),
      read(byName[name], managerAbi, "executionPaused")
    ]);
    sameAddress(distributor, byName.RevenueDistributor, `${name} distributor`);
    sameAddress(orderPolicy, byName.OrderPolicy, `${name} order policy`);
    if (paused || executionPaused) throw new Error(`${name} is paused`);
  }

  const reviewedHooks = [
    ZERO_ADDRESS,
    getAddress("0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044"),
    getAddress("0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544")
  ];
  for (const hook of reviewedHooks) {
    const [allowed, dataHash, storedCodeHash, runtimeCode] = await Promise.all([
      read(byName.V4LimitOrderManager, v4PolicyAbi, "allowedHooks", [hook]),
      read(byName.V4LimitOrderManager, v4PolicyAbi, "allowedHookDataHash", [hook]),
      read(byName.V4LimitOrderManager, v4PolicyAbi, "allowedHookCodeHash", [hook]),
      hook === ZERO_ADDRESS ? Promise.resolve("0x") : publicClient.getCode({ address: hook })
    ]);
    const expectedCodeHash = hook === ZERO_ADDRESS ? `0x${"00".repeat(32)}` : keccak256(runtimeCode);
    if (!allowed || dataHash !== EMPTY_BYTES_HASH || storedCodeHash !== expectedCodeHash) {
      throw new Error(`Unexpected V4 hook policy for ${hook}`);
    }
  }

  const configuredKeeper = resolved.ponsManifest.keeper;
  if (!configuredKeeper || !isAddress(configuredKeeper)) {
    throw new Error("pons-buyback-4663.json is missing its keeper address");
  }
  const keeper = getAddress(configuredKeeper);
  if (!await read(byName.BuybackVault, buybackAbi, "executors", [keeper])) {
    throw new Error(`Buyback keeper ${keeper} is not an authorized executor`);
  }

  return {
    guardian: getAddress(distributorGuardian),
    buybackGuardian: getAddress(buybackGuardian),
    operationalTreasury: getAddress(operationalTreasury),
    referralApprovalRequired: approvalRequired,
    buybackToken: getAddress(buybackToken),
    buybackKeeper: keeper
  };
}

export async function verifyOwnershipPhase(targets, phase) {
  const expectedCurrentOwner = configuredAddress(
    "SCOPL_PROTOCOL_OWNER",
    "SCOPL_OWNER"
  );
  const states = [];
  for (const target of targets) {
    const [owner, pendingOwner] = await Promise.all([
      read(target.address, ownableAbi, "owner"),
      read(target.address, ownableAbi, "pendingOwner")
    ]);
    const state = {
      ...target,
      owner: getAddress(owner),
      pendingOwner: getAddress(pendingOwner)
    };
    if (phase === "before") {
      sameAddress(state.owner, expectedCurrentOwner, `${target.name} owner`);
      if (state.pendingOwner !== ZERO_ADDRESS) {
        throw new Error(`${target.name} already has pending owner ${state.pendingOwner}`);
      }
    } else if (phase === "transferable") {
      sameAddress(state.owner, expectedCurrentOwner, `${target.name} owner`);
      if (state.pendingOwner !== ZERO_ADDRESS && state.pendingOwner !== SAFE) {
        throw new Error(`${target.name} has unexpected pending owner ${state.pendingOwner}`);
      }
    } else if (phase === "pending") {
      sameAddress(state.owner, expectedCurrentOwner, `${target.name} owner`);
      sameAddress(state.pendingOwner, SAFE, `${target.name} pending owner`);
    } else if (phase === "accepted") {
      sameAddress(state.owner, SAFE, `${target.name} owner`);
      if (state.pendingOwner !== ZERO_ADDRESS) {
        throw new Error(`${target.name} pending owner was not cleared`);
      }
    } else {
      throw new Error(`Unsupported ownership phase ${phase}`);
    }
    states.push(state);
  }
  return { expectedCurrentOwner, states };
}

export async function simulateTransferOwnership(target, owner) {
  return publicClient.simulateContract({
    account: owner,
    address: target.address,
    abi: ownableAbi,
    functionName: "transferOwnership",
    args: [SAFE]
  });
}

export async function simulateAcceptOwnership(target) {
  return publicClient.simulateContract({
    account: SAFE,
    address: target.address,
    abi: ownableAbi,
    functionName: "acceptOwnership"
  });
}
