import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseEther
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { selectFreshRobinhoodRpcUrl } from "./robinhood-rpc.mjs";

const CHAIN_ID = 4_663;
const EXPLORER_URL = "https://robinhoodchain.blockscout.com";
const WETH = getAddress("0x0bd7d308f8e1639fab988df18a8011f41eacad73");
const WETH_CODE_HASH =
  "0x5706be52f64875fee65a2cec0d80e47a23d8793cbe85d214b48445e2d05f5353";
const CANONICAL_SCOPL = getAddress(
  "0xaA40e79E987517f7462bF79315B8A118799B04E3"
);
const CANONICAL_SCOPL_CODE_HASH =
  "0x2b03fa63ea8c3bd1486083114fa60e7d8bc4d1551642691c10cf94f7848ab5b1";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MINIMUM_BALANCES = [
  parseEther("50000"),
  parseEther("250000"),
  parseEther("1000000")
];
const BENEFICIARY_SHARES_BPS = [1_000, 2_500, 5_000, 7_500];
const dryRun = process.argv.includes("--dry-run");
const root = process.cwd();

function artifact(name) {
  const filename = path.join(root, "contracts", "artifacts", `${name}.json`);
  const compiled = JSON.parse(fs.readFileSync(filename, "utf8"));
  if (!Array.isArray(compiled.abi) || !compiled.evm?.bytecode?.object) {
    throw new Error(`${name} artifact is incomplete`);
  }
  return {
    abi: compiled.abi,
    bytecode: `0x${compiled.evm.bytecode.object}`
  };
}

function configuredAddress(name, fallback) {
  const value = process.env[name]?.trim() || fallback;
  if (!value || !isAddress(value)) throw new Error(`${name} is invalid`);
  return getAddress(value);
}

async function promptHidden(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "A TTY or SCOPL_DEPLOYER_PRIVATE_KEY is required for deployment"
    );
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
        } else if (character >= " ") {
          value += character;
        }
      }
    };
    process.stdout.write(question);
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

function writeManifest(filename, value) {
  fs.mkdirSync(path.join(root, "deployments"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "deployments", filename),
    `${JSON.stringify(value, null, 2)}\n`
  );
}

async function main() {
  const rpcUrl = await selectFreshRobinhoodRpcUrl();
  const chain = defineChain({
    id: CHAIN_ID,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: "Blockscout", url: EXPLORER_URL } }
  });
  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl, { timeout: 30_000, retryCount: 1 })
  });
  if (await publicClient.getChainId() !== CHAIN_ID) {
    throw new Error(`RPC is not Robinhood Chain ${CHAIN_ID}`);
  }

  const compiled = {
    rewards: artifact("ScoplReferralRewards"),
    distributor: artifact("ScoplRevenueDistributor"),
    policy: artifact("ScoplOrderPolicy")
  };
  const owner = configuredAddress(
    "SCOPL_ORDER_POLICY_OWNER",
    process.env.SCOPL_LIMIT_ORDER_OWNER?.trim() ||
      process.env.SCOPL_PROTOCOL_OWNER?.trim()
  );
  const guardian = configuredAddress("SCOPL_GUARDIAN", owner);
  const operationalTreasury = configuredAddress("SCOPL_OPERATIONAL_TREASURY");
  const existingBuybackVault = configuredAddress("SCOPL_BUYBACK_VAULT_ADDRESS");
  const tierSigner = configuredAddress("SCOPL_TIER_SIGNER_ADDRESS", ZERO_ADDRESS);
  const [wethCode, scoplCode, buybackCode, ownerBalance] = await Promise.all([
    publicClient.getCode({ address: WETH }),
    publicClient.getCode({ address: CANONICAL_SCOPL }),
    publicClient.getCode({ address: existingBuybackVault }),
    publicClient.getBalance({ address: owner })
  ]);
  if (!wethCode || keccak256(wethCode) !== WETH_CODE_HASH) {
    throw new Error("WETH runtime does not match the reviewed deployment");
  }
  if (!scoplCode || keccak256(scoplCode) !== CANONICAL_SCOPL_CODE_HASH) {
    throw new Error("Canonical SCOPL runtime does not match");
  }
  if (!buybackCode || buybackCode === "0x") {
    throw new Error("Configured existing buyback vault has no runtime code");
  }
  if (ownerBalance === 0n) throw new Error("Configured owner has no native gas balance");

  console.log(`RPC: ${rpcUrl}`);
  console.log(`Owner/deployer: ${owner}`);
  console.log(`Guardian: ${guardian}`);
  console.log(`Operational treasury: ${operationalTreasury}`);
  console.log(`Preserved buyback vault: ${existingBuybackVault}`);
  console.log(`Canonical SCOPL: ${CANONICAL_SCOPL}`);
  console.log(`Tier signer: ${tierSigner}`);
  console.log("Foundation deploys only new ReferralRewards, RevenueDistributor, and OrderPolicy.");
  console.log("Legacy referral liabilities and buyback-vault assets are not moved or modified.");
  if (dryRun) {
    console.log("SCOPL V2 order-foundation preflight passed. Nothing was broadcast.");
    return;
  }

  const suppliedKey = process.env.SCOPL_DEPLOYER_PRIVATE_KEY?.trim();
  const rawKey = suppliedKey || await promptHidden(
    "SCOPL V2 foundation deployer private key (input hidden): "
  );
  const key = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("Private key must contain exactly 32 bytes");
  }
  const account = privateKeyToAccount(key);
  if (getAddress(account.address) !== owner) {
    throw new Error(`Deployment wallet ${account.address} is not owner ${owner}`);
  }

  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(
      'Type "DEPLOY SCOPL V2 FOUNDATION" to broadcast five transactions: '
    );
    if (answer.trim() !== "DEPLOY SCOPL V2 FOUNDATION") {
      throw new Error("Deployment cancelled");
    }
  } finally {
    terminal.close();
  }

  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl, { timeout: 30_000, retryCount: 1 })
  });
  const journal = {
    status: "in_progress",
    chainId: CHAIN_ID,
    owner,
    guardian,
    operationalTreasury,
    existingBuybackVault,
    canonicalScoplToken: CANONICAL_SCOPL,
    tierSigner,
    transactions: [],
    startedAt: new Date().toISOString()
  };
  const journalName = "order-foundation-v2-4663.pending.json";
  writeManifest(journalName, journal);

  async function waitFor(hash, action, requireContract = false) {
    journal.transactions.push({ action, hash });
    writeManifest(journalName, journal);
    console.log(`${action}: ${EXPLORER_URL}/tx/${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 2,
      timeout: 180_000
    });
    if (receipt.status !== "success" || (requireContract && !receipt.contractAddress)) {
      throw new Error(`${action} failed`);
    }
    const transaction = journal.transactions.at(-1);
    transaction.blockNumber = receipt.blockNumber.toString();
    if (receipt.contractAddress) {
      transaction.contractAddress = getAddress(receipt.contractAddress);
    }
    writeManifest(journalName, journal);
    return receipt;
  }

  async function deploy(name, release, args) {
    const hash = await walletClient.deployContract({
      abi: release.abi,
      bytecode: release.bytecode,
      args
    });
    const receipt = await waitFor(hash, `deploy ${name}`, true);
    return getAddress(receipt.contractAddress);
  }

  const referralRewards = await deploy(
    "ScoplReferralRewards",
    compiled.rewards,
    [owner]
  );
  const revenueDistributor = await deploy(
    "ScoplRevenueDistributor",
    compiled.distributor,
    [
      owner,
      guardian,
      WETH,
      referralRewards,
      existingBuybackVault,
      operationalTreasury
    ]
  );
  const orderPolicy = await deploy("ScoplOrderPolicy", compiled.policy, [
    owner,
    CANONICAL_SCOPL,
    BigInt(CHAIN_ID),
    referralRewards,
    tierSigner,
    MINIMUM_BALANCES,
    BENEFICIARY_SHARES_BPS
  ]);

  const creditorHash = await walletClient.writeContract({
    address: referralRewards,
    abi: compiled.rewards.abi,
    functionName: "setRevenueCreditorAllowed",
    args: [revenueDistributor, true]
  });
  await waitFor(creditorHash, "authorize RevenueDistributor as reward creditor");
  const binderHash = await walletClient.writeContract({
    address: referralRewards,
    abi: compiled.rewards.abi,
    functionName: "setReferralBinderAllowed",
    args: [orderPolicy, true]
  });
  await waitFor(binderHash, "authorize OrderPolicy as referral binder");

  const [
    rewardsOwner,
    distributorOwner,
    distributorRewards,
    distributorBuyback,
    distributorOperational,
    creditorAllowed,
    binderAllowed,
    policyOwner,
    policyRewards,
    policyToken,
    policyChainId,
    policyTierSigner,
    tiers,
    rewardsCode,
    distributorCode,
    policyCode
  ] = await Promise.all([
    publicClient.readContract({ address: referralRewards, abi: compiled.rewards.abi, functionName: "owner" }),
    publicClient.readContract({ address: revenueDistributor, abi: compiled.distributor.abi, functionName: "owner" }),
    publicClient.readContract({ address: revenueDistributor, abi: compiled.distributor.abi, functionName: "referralRewards" }),
    publicClient.readContract({ address: revenueDistributor, abi: compiled.distributor.abi, functionName: "buybackVault" }),
    publicClient.readContract({ address: revenueDistributor, abi: compiled.distributor.abi, functionName: "operationalTreasury" }),
    publicClient.readContract({ address: referralRewards, abi: compiled.rewards.abi, functionName: "revenueCreditors", args: [revenueDistributor] }),
    publicClient.readContract({ address: referralRewards, abi: compiled.rewards.abi, functionName: "referralBinders", args: [orderPolicy] }),
    publicClient.readContract({ address: orderPolicy, abi: compiled.policy.abi, functionName: "owner" }),
    publicClient.readContract({ address: orderPolicy, abi: compiled.policy.abi, functionName: "referralRewards" }),
    publicClient.readContract({ address: orderPolicy, abi: compiled.policy.abi, functionName: "canonicalScoplToken" }),
    publicClient.readContract({ address: orderPolicy, abi: compiled.policy.abi, functionName: "canonicalScoplChainId" }),
    publicClient.readContract({ address: orderPolicy, abi: compiled.policy.abi, functionName: "tierSigner" }),
    publicClient.readContract({ address: orderPolicy, abi: compiled.policy.abi, functionName: "tierConfiguration" }),
    publicClient.getCode({ address: referralRewards }),
    publicClient.getCode({ address: revenueDistributor }),
    publicClient.getCode({ address: orderPolicy })
  ]);
  const tiersMatch = tiers[0].every((value, index) => value === MINIMUM_BALANCES[index]) &&
    tiers[1].every((value, index) => value === BENEFICIARY_SHARES_BPS[index]);
  if (
    getAddress(rewardsOwner) !== owner ||
    getAddress(distributorOwner) !== owner ||
    getAddress(distributorRewards) !== referralRewards ||
    getAddress(distributorBuyback) !== existingBuybackVault ||
    getAddress(distributorOperational) !== operationalTreasury ||
    creditorAllowed !== true ||
    binderAllowed !== true ||
    getAddress(policyOwner) !== owner ||
    getAddress(policyRewards) !== referralRewards ||
    getAddress(policyToken) !== CANONICAL_SCOPL ||
    policyChainId !== BigInt(CHAIN_ID) ||
    getAddress(policyTierSigner) !== tierSigner ||
    !tiersMatch ||
    !rewardsCode || !distributorCode || !policyCode
  ) {
    throw new Error("SCOPL V2 order-foundation verification failed");
  }

  const manifest = {
    ...journal,
    status: "complete",
    referralRewards,
    revenueDistributor,
    orderPolicy,
    minimumBalances: MINIMUM_BALANCES.map(String),
    beneficiarySharesBps: BENEFICIARY_SHARES_BPS,
    runtimeCodeHashes: {
      referralRewards: keccak256(rewardsCode),
      revenueDistributor: keccak256(distributorCode),
      orderPolicy: keccak256(policyCode)
    },
    completedAt: new Date().toISOString()
  };
  writeManifest("order-foundation-v2-4663.json", manifest);
  fs.unlinkSync(path.join(root, "deployments", journalName));
  console.log(`SCOPL_REFERRAL_REWARDS_ADDRESS=${referralRewards}`);
  console.log(`SCOPL_REVENUE_DISTRIBUTOR_ADDRESS=${revenueDistributor}`);
  console.log(`SCOPL_ORDER_POLICY_ADDRESS=${orderPolicy}`);
  console.log(`NEXT_PUBLIC_SCOPL_ORDER_POLICY_ADDRESS=${orderPolicy}`);
  console.log("Wrote deployments/order-foundation-v2-4663.json");
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
);
