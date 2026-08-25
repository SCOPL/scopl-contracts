import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  isAddress
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { selectFreshRobinhoodRpcUrl } from "./robinhood-rpc.mjs";

const CHAIN_ID = 4_663;
const EXPLORER_URL = "https://robinhoodchain.blockscout.com";
const dryRun = process.argv.includes("--dry-run");
const root = process.cwd();

function abi(name) {
  const filename = path.join(root, "contracts", "artifacts", `${name}.json`);
  const artifact = JSON.parse(fs.readFileSync(filename, "utf8"));
  if (!Array.isArray(artifact.abi)) throw new Error(`Missing ${name} ABI`);
  return artifact.abi;
}

function configuredAddress(name, fallback) {
  const value = process.env[name]?.trim() || fallback;
  if (!value || !isAddress(value)) throw new Error(`${name} is invalid`);
  return getAddress(value);
}

async function promptHidden(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "A TTY or SCOPL_DEPLOYER_PRIVATE_KEY is required for configuration"
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
          reject(new Error("Configuration cancelled"));
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

  const policy = configuredAddress("SCOPL_ORDER_POLICY_ADDRESS");
  const distributor = configuredAddress("SCOPL_REVENUE_DISTRIBUTOR_ADDRESS");
  const managers = [
    {
      name: "V3 manager",
      address: configuredAddress(
        "SCOPL_V2_V3_LIMIT_ORDER_MANAGER_ADDRESS",
        process.env.NEXT_PUBLIC_SCOPL_V2_V3_LIMIT_ORDER_MANAGER_ADDRESS?.trim()
      ),
      product: 1,
      abi: abi("ScoplLimitOrderManager")
    },
    {
      name: "V4 manager",
      address: configuredAddress(
        "SCOPL_V2_V4_LIMIT_ORDER_MANAGER_ADDRESS",
        process.env.NEXT_PUBLIC_SCOPL_V2_V4_LIMIT_ORDER_MANAGER_ADDRESS?.trim()
      ),
      product: 2,
      abi: abi("ScoplV4LimitOrderManager")
    }
  ];
  const policyAbi = abi("ScoplOrderPolicy");
  const distributorAbi = abi("ScoplRevenueDistributor");
  const codes = await Promise.all(
    [policy, distributor, ...managers.map((manager) => manager.address)].map(
      (address) => publicClient.getCode({ address })
    )
  );
  if (codes.some((code) => !code || code === "0x")) {
    throw new Error("Policy, distributor, and both managers must contain runtime code");
  }

  const [policyOwner, distributorOwner, ...managerWiring] = await Promise.all([
    publicClient.readContract({ address: policy, abi: policyAbi, functionName: "owner" }),
    publicClient.readContract({ address: distributor, abi: distributorAbi, functionName: "owner" }),
    ...managers.flatMap((manager) => [
      publicClient.readContract({ address: manager.address, abi: manager.abi, functionName: "orderPolicy" }),
      publicClient.readContract({ address: manager.address, abi: manager.abi, functionName: "revenueDistributor" })
    ])
  ]);
  const owner = getAddress(policyOwner);
  if (getAddress(distributorOwner) !== owner) {
    throw new Error("Policy and distributor owners differ");
  }
  for (let index = 0; index < managers.length; index++) {
    if (
      getAddress(managerWiring[index * 2]) !== policy ||
      getAddress(managerWiring[index * 2 + 1]) !== distributor
    ) {
      throw new Error(`${managers[index].name} constructor wiring does not match`);
    }
  }

  async function readState(manager) {
    const [policyAllowed, revenueSource] = await Promise.all([
      publicClient.readContract({
        address: policy,
        abi: policyAbi,
        functionName: "managers",
        args: [manager.address]
      }),
      publicClient.readContract({
        address: distributor,
        abi: distributorAbi,
        functionName: "revenueSources",
        args: [manager.address]
      })
    ]);
    return {
      policyAllowed,
      revenueProduct: Number(revenueSource[0]),
      revenueEnabled: revenueSource[1]
    };
  }
  const initialStates = await Promise.all(managers.map(readState));
  const actions = [];
  for (let index = 0; index < managers.length; index++) {
    const manager = managers[index];
    const state = initialStates[index];
    if (!state.policyAllowed) {
      await publicClient.simulateContract({
        account: owner,
        address: policy,
        abi: policyAbi,
        functionName: "setManager",
        args: [manager.address, true]
      });
      actions.push({ kind: "policy", manager });
    }
    if (!state.revenueEnabled || state.revenueProduct !== manager.product) {
      await publicClient.simulateContract({
        account: owner,
        address: distributor,
        abi: distributorAbi,
        functionName: "setRevenueSource",
        args: [manager.address, manager.product, true]
      });
      actions.push({ kind: "revenue", manager });
    }
  }

  console.log(`RPC: ${rpcUrl}`);
  console.log(`Owner: ${owner}`);
  console.log(`OrderPolicy: ${policy}`);
  console.log(`RevenueDistributor: ${distributor}`);
  for (let index = 0; index < managers.length; index++) {
    console.log(`${managers[index].name}: ${managers[index].address}`, initialStates[index]);
  }
  console.log(`Required authorization transactions: ${actions.length}`);
  if (dryRun) {
    console.log("Order-manager activation preflight passed. Nothing was broadcast.");
    return;
  }
  if (actions.length === 0) {
    console.log("Both managers are already fully authorized.");
    return;
  }

  const suppliedKey = process.env.SCOPL_DEPLOYER_PRIVATE_KEY?.trim();
  const rawKey = suppliedKey || await promptHidden(
    "Policy/distributor owner private key (input hidden): "
  );
  const key = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("Private key must contain exactly 32 bytes");
  }
  const account = privateKeyToAccount(key);
  if (getAddress(account.address) !== owner) {
    throw new Error(`Configuration wallet ${account.address} is not owner ${owner}`);
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(
      `Type "ACTIVATE SCOPL V2 MANAGERS" to broadcast ${actions.length} transaction(s): `
    );
    if (answer.trim() !== "ACTIVATE SCOPL V2 MANAGERS") {
      throw new Error("Configuration cancelled");
    }
  } finally {
    terminal.close();
  }

  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl, { timeout: 30_000, retryCount: 1 })
  });
  const transactions = [];
  for (const action of actions) {
    const isPolicy = action.kind === "policy";
    const hash = await walletClient.writeContract({
      address: isPolicy ? policy : distributor,
      abi: isPolicy ? policyAbi : distributorAbi,
      functionName: isPolicy ? "setManager" : "setRevenueSource",
      args: isPolicy
        ? [action.manager.address, true]
        : [action.manager.address, action.manager.product, true]
    });
    const label = isPolicy
      ? `allow ${action.manager.name} in policy`
      : `allow ${action.manager.name} as revenue source`;
    console.log(`${label}: ${EXPLORER_URL}/tx/${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 2,
      timeout: 180_000
    });
    if (receipt.status !== "success") throw new Error(`${label} failed`);
    transactions.push({
      action: label,
      hash,
      blockNumber: receipt.blockNumber.toString()
    });
  }

  const finalStates = await Promise.all(managers.map(readState));
  for (let index = 0; index < managers.length; index++) {
    const state = finalStates[index];
    if (
      !state.policyAllowed ||
      !state.revenueEnabled ||
      state.revenueProduct !== managers[index].product
    ) {
      throw new Error(`${managers[index].name} authorization verification failed`);
    }
  }
  const manifest = {
    chainId: CHAIN_ID,
    owner,
    orderPolicy: policy,
    revenueDistributor: distributor,
    managers: managers.map((manager, index) => ({
      name: manager.name,
      address: manager.address,
      product: manager.product,
      ...finalStates[index]
    })),
    transactions,
    activatedAt: new Date().toISOString()
  };
  fs.mkdirSync(path.join(root, "deployments"), { recursive: true });
  const manifestPath = path.join(root, "deployments", "order-managers-v2-4663.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Both managers are active. Wrote ${manifestPath}`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
);
