import fs from "node:fs";
import path from "node:path";
import { getAddress } from "viem";

const CHAIN_ID = 4_663;
const EXPLORER_URL = "https://robinhoodchain.blockscout.com";

function manifest(filename) {
  const parsed = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "deployments", filename), "utf8")
  );
  if (parsed.chainId !== CHAIN_ID) {
    throw new Error(`${filename}: expected chain ID ${CHAIN_ID}`);
  }
  return parsed;
}

async function status(address) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(
        `${EXPLORER_URL}/api/v2/smart-contracts/${address}`,
        {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(20_000)
        }
      );
      const body = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${body || response.statusText}`);
      }
      return JSON.parse(body);
    } catch (error) {
      lastError = error;
      if (attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
      }
    }
  }
  throw lastError;
}

async function main() {
  const foundation = manifest("order-foundation-v2-4663.json");
  const v3 = manifest("limit-orders-v2-4663.json");
  const v4 = manifest("v4-limit-orders-v2-4663.json");
  const feeRouter = manifest("robinhood-4663.json");
  const zap = manifest("zap-router-4663.json");
  const buyback = manifest("pons-buyback-4663.json");
  const contracts = [
    ["ScoplFeeRouter", feeRouter.address],
    ["ScoplZapRouter", zap.address],
    ["ScoplReferralRewards", foundation.referralRewards],
    ["ScoplRevenueDistributor", foundation.revenueDistributor],
    ["ScoplBuybackVault", buyback.buybackVault],
    ["ScoplRouterSwapAdapter", buyback.buybackSwapAdapter],
    ["ScoplOrderPolicy", foundation.orderPolicy],
    ["ScoplLimitOrderManager", v3.address],
    ["ScoplV4LimitOrderManager", v4.address]
  ];

  for (const [expectedName, rawAddress] of contracts) {
    const address = getAddress(rawAddress);
    const result = await status(address);
    if (!result?.is_verified && !result?.is_fully_verified) {
      throw new Error(`${expectedName} is not source verified at ${address}`);
    }
    if (result.name && result.name !== expectedName) {
      throw new Error(
        `${address}: expected ${expectedName}, Blockscout reports ${result.name}`
      );
    }
    if (!String(result.compiler_version ?? "").includes("0.8.26")) {
      throw new Error(
        `${expectedName}: unexpected compiler ${result.compiler_version ?? "unknown"}`
      );
    }
    console.log(`${expectedName}: source verified at ${address}`);
  }

  console.log("All nine Robinhood SCOPL contracts are source verified.");
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`Blockscout check failed: ${error.message}`);
    process.exit(1);
  }
);
