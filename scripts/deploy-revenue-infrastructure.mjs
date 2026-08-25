import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  isAddress,
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
const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const UNIVERSAL_ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904";
const PONS_V2_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
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

function artifact(name) {
  const filename = path.join(root, "contracts", "artifacts", `${name}.json`);
  const compiled = JSON.parse(fs.readFileSync(filename, "utf8"));
  const object = compiled.evm?.bytecode?.object;
  if (!Array.isArray(compiled.abi) || !object) {
    throw new Error(`${name} artifact is incomplete`);
  }
  return { abi: compiled.abi, bytecode: `0x${object}` };
}

function configuredAddress(name, fallback) {
  const value = process.env[name]?.trim() || fallback;
  if (!value || !isAddress(value)) throw new Error(`${name} is invalid`);
  return getAddress(value);
}

async function promptHidden(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("A TTY is required for the private-key prompt");
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

async function confirmDeployment() {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(
      'Type "DEPLOY REVENUE INFRASTRUCTURE" to broadcast the revenue deployment transactions: '
    );
    if (answer.trim() !== "DEPLOY REVENUE INFRASTRUCTURE") {
      throw new Error("Deployment cancelled");
    }
  } finally {
    terminal.close();
  }
}

async function main() {
  if (await publicClient.getChainId() !== CHAIN_ID) {
    throw new Error(`RPC is not Robinhood Chain ${CHAIN_ID}`);
  }
  const compiled = {
    rewards: artifact("ScoplReferralRewards"),
    buyback: artifact("ScoplBuybackVault"),
    swapAdapter: artifact("ScoplRouterSwapAdapter"),
    distributor: artifact("ScoplRevenueDistributor")
  };
  const owner = configuredAddress(
    "SCOPL_PROTOCOL_OWNER",
    process.env.SCOPL_OWNER?.trim()
  );
  const guardian = configuredAddress("SCOPL_GUARDIAN", owner);
  const operationalTreasury = configuredAddress(
    "SCOPL_OPERATIONAL_TREASURY"
  );
  const keeperReward = parseEther(
    process.env.SCOPL_BUYBACK_KEEPER_REWARD_ETH?.trim() || "0.00002"
  );
  if (keeperReward === 0n || keeperReward > parseEther("0.001")) {
    throw new Error("SCOPL_BUYBACK_KEEPER_REWARD_ETH must be above 0 and at most 0.001");
  }
  for (const [name, address] of Object.entries({
    PERMIT2,
    WETH,
    UNIVERSAL_ROUTER,
    PONS_V2_FACTORY
  })) {
    const code = await publicClient.getCode({ address });
    if (!code || code === "0x") throw new Error(`${name} has no runtime code`);
  }
  console.log({
    owner,
    guardian,
    operationalTreasury,
    buybackKeeperRewardWei: keeperReward.toString()
  });
  if (dryRun) {
    console.log("Revenue infrastructure preflight passed. Nothing was broadcast.");
    return;
  }

  const supplied = process.env.SCOPL_DEPLOYER_PRIVATE_KEY?.trim();
  const raw = supplied || await promptHidden("Deployer private key (input hidden): ");
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("Private key must contain exactly 32 bytes");
  }
  const account = privateKeyToAccount(key);
  if (account.address !== owner) {
    throw new Error(`Deployment wallet ${account.address} is not owner ${owner}`);
  }
  if (await publicClient.getBalance({ address: account.address }) === 0n) {
    throw new Error("Deployer has no native token for gas");
  }
  await confirmDeployment();
  const walletClient = createWalletClient({
    account,
    chain,
    transport: robinhoodRpcTransport({ timeout: 30_000 })
  });
  const transactions = [];
  async function deploy(name, release, args) {
    const hash = await walletClient.deployContract({
      abi: release.abi,
      bytecode: release.bytecode,
      args
    });
    const transaction = { action: `deploy ${name}`, hash };
    transactions.push(transaction);
    console.log(`${name}: ${EXPLORER_URL}/tx/${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 2,
      timeout: 180_000
    });
    if (receipt.status !== "success" || !receipt.contractAddress) {
      throw new Error(`${name} deployment failed`);
    }
    transaction.blockNumber = receipt.blockNumber.toString();
    transaction.contractAddress = getAddress(receipt.contractAddress);
    return getAddress(receipt.contractAddress);
  }

  const rewards = await deploy("ScoplReferralRewards", compiled.rewards, [owner]);
  const buybackVault = await deploy("ScoplBuybackVault", compiled.buyback, [
    owner,
    guardian,
    WETH,
    PONS_V2_FACTORY,
    keeperReward
  ]);
  const distributor = await deploy(
    "ScoplRevenueDistributor",
    compiled.distributor,
    [
      owner,
      guardian,
      WETH,
      rewards,
      buybackVault,
      operationalTreasury
    ]
  );
  const buybackSwapAdapter = await deploy(
    "ScoplRouterSwapAdapter",
    compiled.swapAdapter,
    [buybackVault, UNIVERSAL_ROUTER, PERMIT2, WETH]
  );
  const authorizeHash = await walletClient.writeContract({
    address: rewards,
    abi: compiled.rewards.abi,
    functionName: "setRevenueCreditorAllowed",
    args: [distributor, true]
  });
  transactions.push({ action: "authorize distributor", hash: authorizeHash });
  const authorizeReceipt = await publicClient.waitForTransactionReceipt({
    hash: authorizeHash,
    confirmations: 2,
    timeout: 180_000
  });
  if (authorizeReceipt.status !== "success") {
    throw new Error("Distributor authorization failed");
  }
  const authorizeBuybackSwapHash = await walletClient.writeContract({
    address: buybackVault,
    abi: compiled.buyback.abi,
    functionName: "setAdapter",
    args: [buybackSwapAdapter, true]
  });
  transactions.push({ action: "authorize buyback swap adapter", hash: authorizeBuybackSwapHash });
  const authorizeBuybackSwapReceipt = await publicClient.waitForTransactionReceipt({
    hash: authorizeBuybackSwapHash,
    confirmations: 2,
    timeout: 180_000
  });
  if (authorizeBuybackSwapReceipt.status !== "success") {
    throw new Error("Buyback swap adapter authorization failed");
  }
  const [storedWeth, storedRewards, storedBuyback, storedOperational,
    allowed, buybackSwapAllowed, buybackWeth, buybackPonsFactory, adapterWeth,
    storedKeeperReward] =
    await Promise.all([
      publicClient.readContract({
        address: distributor,
        abi: compiled.distributor.abi,
        functionName: "weth"
      }),
      publicClient.readContract({
        address: distributor,
        abi: compiled.distributor.abi,
        functionName: "referralRewards"
      }),
      publicClient.readContract({
        address: distributor,
        abi: compiled.distributor.abi,
        functionName: "buybackVault"
      }),
      publicClient.readContract({
        address: distributor,
        abi: compiled.distributor.abi,
        functionName: "operationalTreasury"
      }),
      publicClient.readContract({
        address: rewards,
        abi: compiled.rewards.abi,
        functionName: "revenueCreditors",
        args: [distributor]
      }),
      publicClient.readContract({
        address: buybackVault,
        abi: compiled.buyback.abi,
        functionName: "allowedAdapters",
        args: [buybackSwapAdapter]
      }),
      publicClient.readContract({
        address: buybackVault,
        abi: compiled.buyback.abi,
        functionName: "weth"
      }),
      publicClient.readContract({
        address: buybackVault,
        abi: compiled.buyback.abi,
        functionName: "ponsV2Factory"
      }),
      publicClient.readContract({
        address: buybackSwapAdapter,
        abi: compiled.swapAdapter.abi,
        functionName: "weth"
      }),
      publicClient.readContract({
        address: buybackVault,
        abi: compiled.buyback.abi,
        functionName: "keeperRewardWei"
      })
    ]);
  if (
    getAddress(storedWeth) !== getAddress(WETH) ||
    getAddress(storedRewards) !== rewards ||
    getAddress(storedBuyback) !== buybackVault ||
    getAddress(storedOperational) !== operationalTreasury ||
    allowed !== true || buybackSwapAllowed !== true ||
    getAddress(buybackWeth) !== getAddress(WETH) ||
    getAddress(buybackPonsFactory) !== getAddress(PONS_V2_FACTORY) ||
    getAddress(adapterWeth) !== getAddress(WETH) ||
    storedKeeperReward !== keeperReward
  ) throw new Error("Revenue infrastructure verification failed");

  const manifest = {
    chainId: CHAIN_ID,
    owner,
    guardian,
    operationalTreasury,
    referralRewards: rewards,
    buybackVault,
    buybackSwapAdapter,
    ponsV2Factory: getAddress(PONS_V2_FACTORY),
    buybackKeeperRewardWei: keeperReward.toString(),
    revenueDistributor: distributor,
    sharesBps: { referral: 3000, buyback: 5000, operational: 2000 },
    transactions,
    deployedAt: new Date().toISOString()
  };
  fs.mkdirSync(path.join(root, "deployments"), { recursive: true });
  const manifestPath = path.join(root, "deployments/revenue-infrastructure-4663.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`SCOPL_REFERRAL_REWARDS_ADDRESS=${rewards}`);
  console.log(`SCOPL_BUYBACK_VAULT_ADDRESS=${buybackVault}`);
  console.log(`SCOPL_BUYBACK_SWAP_ADAPTER_ADDRESS=${buybackSwapAdapter}`);
  console.log(`SCOPL_REVENUE_DISTRIBUTOR_ADDRESS=${distributor}`);
  console.log(`Wrote ${manifestPath}`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
);
