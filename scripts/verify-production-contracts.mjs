import fs from "node:fs";
import path from "node:path";
import solc from "solc";
import {
  encodeAbiParameters,
  getAddress,
  isAddress,
  parseEther
} from "viem";

const EXPLORER_URL = "https://robinhoodchain.blockscout.com";
const PONS_V2_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
const root = process.cwd();
const V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const V3_POSITION_MANAGER = "0x73991a25c818bf1f1128deaab1492d45638de0d3";
const V3_SWAP_ROUTER = "0xcaf681a66d020601342297493863e78c959e5cb2";
const V4_POSITION_MANAGER = "0x58daec3116aae6d93017baaea7749052e8a04fa7";
const V4_STATE_VIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const V4_POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const UNIVERSAL_ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904";
const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";

function address(...names) {
  const value = names.map((name) => process.env[name]?.trim()).find(Boolean);
  if (!value || !isAddress(value)) {
    throw new Error(`${names[0]} is missing or invalid in .env`);
  }
  return getAddress(value);
}

function artifact(name) {
  const artifactPath = path.join(root, "contracts/artifacts", `${name}.json`);
  const inputPath = path.join(
    root,
    "contracts/artifacts",
    `${name}.standard-input.json`
  );
  const parsed = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const constructor = parsed.abi.find((entry) => entry.type === "constructor");
  if (!constructor || !Array.isArray(constructor.inputs)) {
    throw new Error(`${name} constructor ABI is missing`);
  }
  return {
    constructorInputs: constructor.inputs,
    standardInput: fs.readFileSync(inputPath, "utf8")
  };
}

async function explorerRequest(pathname, options) {
  const response = await fetch(`${EXPLORER_URL}${pathname}`, {
    ...options,
    headers: { accept: "application/json", ...options?.headers }
  });
  const body = await response.text();
  if (!response.ok) {
    const error = new Error(
      `Blockscout returned HTTP ${response.status}: ${body || response.statusText}`
    );
    error.status = response.status;
    throw error;
  }
  return body ? JSON.parse(body) : null;
}

async function status(addressValue) {
  return explorerRequest(`/api/v2/smart-contracts/${addressValue}`);
}

async function submit(contract) {
  const compiled = artifact(contract.name);
  const constructorArgs = encodeAbiParameters(
    compiled.constructorInputs,
    contract.args
  ).slice(2);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const form = new FormData();
    form.append("compiler_version", `v${solc.version().replace(/\.Emscripten\.clang$/, "")}`);
    form.append("contract_name", contract.name);
    form.append(
      "files[0]",
      new Blob([compiled.standardInput], { type: "application/json" }),
      `${contract.name}.standard-input.json`
    );
    form.append("autodetect_constructor_args", "false");
    form.append("constructor_args", constructorArgs);
    form.append("license_type", "mit");
    try {
      await explorerRequest(
        `/api/v2/smart-contracts/${contract.address}/verification/via/standard-input`,
        { method: "POST", body: form }
      );
      return;
    } catch (error) {
      if (Number(error?.status) < 500 || attempt === 3) throw error;
      console.warn(`${contract.name}: Blockscout submission retry ${attempt}/3`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }
}

async function poll(contract) {
  for (let attempt = 1; attempt <= 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    let result;
    try {
      result = await status(contract.address);
    } catch (error) {
      if (Number(error?.status) < 500) throw error;
      if (attempt % 5 === 0) {
        console.warn(`${contract.name}: Blockscout status temporarily unavailable`);
      }
      continue;
    }
    if (result?.is_verified || result?.is_fully_verified) return;
    if (attempt % 10 === 0) {
      console.log(`${contract.name}: verification pending (${attempt * 2}s)`);
    }
  }
  throw new Error(`${contract.name} verification was not indexed within 120 seconds`);
}

async function main() {
  const owner = address("SCOPL_PROTOCOL_OWNER", "SCOPL_OWNER");
  const limitOwner = address("SCOPL_LIMIT_ORDER_OWNER", "SCOPL_OWNER");
  const guardian = address("SCOPL_GUARDIAN", "SCOPL_PROTOCOL_OWNER", "SCOPL_OWNER");
  const rewards = address(
    "SCOPL_REFERRAL_REWARDS_ADDRESS",
    "NEXT_PUBLIC_SCOPL_REFERRAL_REWARDS_ADDRESS"
  );
  const buyback = address("SCOPL_BUYBACK_VAULT_ADDRESS");
  const distributor = address("SCOPL_REVENUE_DISTRIBUTOR_ADDRESS");
  const operational = address("SCOPL_OPERATIONAL_TREASURY");
  const minimumReserve = parseEther(
    process.env.SCOPL_MIN_GAS_RESERVE_ETH?.trim() || "0.00005"
  );
  const keeperReward = parseEther(
    process.env.SCOPL_BUYBACK_KEEPER_REWARD_ETH?.trim() || "0.00002"
  );
  const contracts = [
    {
      name: "ScoplReferralRewards",
      address: rewards,
      args: [owner]
    },
    {
      name: "ScoplBuybackVault",
      address: buyback,
      args: [owner, guardian, WETH, PONS_V2_FACTORY, keeperReward]
    },
    {
      name: "ScoplRevenueDistributor",
      address: distributor,
      args: [owner, guardian, WETH, rewards, buyback, operational]
    },
    {
      name: "ScoplRouterSwapAdapter",
      address: address("SCOPL_BUYBACK_SWAP_ADAPTER_ADDRESS"),
      args: [buyback, UNIVERSAL_ROUTER, PERMIT2, WETH]
    },
    {
      name: "ScoplLimitOrderManager",
      address: address(
        "SCOPL_LIMIT_ORDER_MANAGER_ADDRESS",
        "NEXT_PUBLIC_SCOPL_LIMIT_ORDER_MANAGER_ADDRESS"
      ),
      args: [
        limitOwner,
        distributor,
        V3_FACTORY,
        V3_POSITION_MANAGER,
        WETH,
        minimumReserve
      ]
    },
    {
      name: "ScoplV4LimitOrderManager",
      address: address(
        "SCOPL_V4_LIMIT_ORDER_MANAGER_ADDRESS",
        "NEXT_PUBLIC_SCOPL_V4_LIMIT_ORDER_MANAGER_ADDRESS"
      ),
      args: [
        limitOwner,
        distributor,
        V4_POSITION_MANAGER,
        V4_STATE_VIEW,
        V4_POOL_MANAGER,
        PERMIT2,
        WETH,
        minimumReserve
      ]
    },
    {
      name: "ScoplZapRouter",
      address: address("NEXT_PUBLIC_SCOPL_ZAP_ROUTER_ADDRESS"),
      args: [
        owner,
        V3_SWAP_ROUTER,
        V3_POSITION_MANAGER,
        V4_POSITION_MANAGER,
        V4_STATE_VIEW,
        UNIVERSAL_ROUTER,
        PERMIT2,
        WETH
      ]
    }
  ];

  for (const contract of contracts) {
    let current;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        current = await status(contract.address);
        break;
      } catch (error) {
        if (Number(error?.status) < 500 || attempt === 3) throw error;
        console.warn(`${contract.name}: Blockscout status retry ${attempt}/3`);
        await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
      }
    }
    if (current?.is_verified || current?.is_fully_verified) {
      console.log(`${contract.name}: already verified`);
      continue;
    }
    console.log(`${contract.name}: submitting ${contract.address}`);
    await submit(contract);
    await poll(contract);
    console.log(`${contract.name}: verified`);
  }
  console.log("All SCOPL production contracts are verified on Blockscout.");
}

main().catch((error) => {
  console.error(`Verification failed: ${error.message}`);
  process.exitCode = 1;
});
