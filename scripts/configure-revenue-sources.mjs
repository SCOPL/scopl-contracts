import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  isAddress
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  robinhoodRpcTransport,
  robinhoodRpcUrls
} from "./robinhood-rpc.mjs";

const CHAIN_ID = 4_663;
const dryRun = process.argv.includes("--dry-run");
const rpcUrls = robinhoodRpcUrls();
const chain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: rpcUrls } }
});
const publicClient = createPublicClient({
  chain,
  transport: robinhoodRpcTransport({ rank: false })
});

function manifest(filename) {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), "deployments", filename), "utf8"));
}

function address(fallback, ...names) {
  const value = names.map((name) => process.env[name]?.trim()).find(Boolean) || fallback;
  if (!value || !isAddress(value)) throw new Error(`${names[0]} is missing or invalid`);
  return getAddress(value);
}

function abi(name) {
  const filename = path.join(process.cwd(), "contracts/artifacts", `${name}.json`);
  const artifact = JSON.parse(fs.readFileSync(filename, "utf8"));
  if (!Array.isArray(artifact.abi)) throw new Error(`Missing ${name} ABI`);
  return artifact.abi;
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

async function main() {
  if (await publicClient.getChainId() !== CHAIN_ID) {
    throw new Error(`RPC is not Robinhood Chain ${CHAIN_ID}`);
  }

  const foundation = manifest("order-foundation-v2-4663.json");
  const feeDeployment = manifest("robinhood-4663.json");
  const v3Deployment = manifest("limit-orders-v2-4663.json");
  const v4Deployment = manifest("v4-limit-orders-v2-4663.json");
  const distributor = address(
    foundation.revenueDistributor,
    "SCOPL_REVENUE_DISTRIBUTOR_ADDRESS"
  );
  const feeRouter = address(
    feeDeployment.address,
    "SCOPL_FEE_ROUTER_ADDRESS",
    "NEXT_PUBLIC_SCOPL_FEE_ROUTER_ADDRESS"
  );
  const sources = [
    { name: "FeeRouter", address: feeRouter, product: 0 },
    {
      name: "V2 V3 LimitOrderManager",
      address: address(
        v3Deployment.address,
        "SCOPL_V2_V3_LIMIT_ORDER_MANAGER_ADDRESS",
        "SCOPL_LIMIT_ORDER_MANAGER_ADDRESS",
        "NEXT_PUBLIC_SCOPL_V2_V3_LIMIT_ORDER_MANAGER_ADDRESS",
        "NEXT_PUBLIC_SCOPL_LIMIT_ORDER_MANAGER_ADDRESS"
      ),
      product: 1
    },
    {
      name: "V2 V4 LimitOrderManager",
      address: address(
        v4Deployment.address,
        "SCOPL_V2_V4_LIMIT_ORDER_MANAGER_ADDRESS",
        "SCOPL_V4_LIMIT_ORDER_MANAGER_ADDRESS",
        "NEXT_PUBLIC_SCOPL_V2_V4_LIMIT_ORDER_MANAGER_ADDRESS",
        "NEXT_PUBLIC_SCOPL_V4_LIMIT_ORDER_MANAGER_ADDRESS"
      ),
      product: 2
    }
  ];
  const feeAbi = abi("ScoplFeeRouter");
  const distributorAbi = abi("ScoplRevenueDistributor");

  const contracts = [distributor, ...sources.map((source) => source.address)];
  const codes = await Promise.all(contracts.map((current) =>
    publicClient.getCode({ address: current })
  ));
  if (codes.some((current) => !current || current === "0x")) {
    throw new Error("The V2 distributor and every V2 revenue source must contain code");
  }

  const [feeOwner, distributorOwner, currentFeeDistributor, ...sourceStates] =
    await Promise.all([
      publicClient.readContract({
        address: feeRouter,
        abi: feeAbi,
        functionName: "owner"
      }),
      publicClient.readContract({
        address: distributor,
        abi: distributorAbi,
        functionName: "owner"
      }),
      publicClient.readContract({
        address: feeRouter,
        abi: feeAbi,
        functionName: "revenueDistributor"
      }),
      ...sources.map((source) => publicClient.readContract({
        address: distributor,
        abi: distributorAbi,
        functionName: "revenueSources",
        args: [source.address]
      }))
    ]);

  const actions = [];
  const feeRouterNeedsSwitch = getAddress(currentFeeDistributor) !== distributor;
  for (const [index, source] of sources.entries()) {
    const [storedProduct, enabled] = sourceStates[index];
    if (Number(storedProduct) === source.product && enabled === true) continue;
    actions.push({
      name: `authorize ${source.name} as V2 revenue product ${source.product}`,
      owner: getAddress(distributorOwner),
      address: distributor,
      abi: distributorAbi,
      functionName: "setRevenueSource",
      args: [source.address, source.product, true]
    });
  }
  if (feeRouterNeedsSwitch) {
    actions.push({
      name: "point FeeRouter to the V2 RevenueDistributor",
      owner: getAddress(feeOwner),
      address: feeRouter,
      abi: feeAbi,
      functionName: "setRevenueDistributor",
      args: [distributor]
    });
  }

  for (const action of actions) {
    await publicClient.simulateContract({
      account: action.owner,
      address: action.address,
      abi: action.abi,
      functionName: action.functionName,
      args: action.args
    });
  }

  console.log(JSON.stringify({
    chainId: CHAIN_ID,
    feeRouter,
    currentFeeDistributor: getAddress(currentFeeDistributor),
    v2RevenueDistributor: distributor,
    feeRouterOwner: getAddress(feeOwner),
    distributorOwner: getAddress(distributorOwner),
    sources: sources.map((source, index) => ({
      ...source,
      currentProduct: Number(sourceStates[index][0]),
      currentlyEnabled: sourceStates[index][1]
    })),
    requiredActions: actions.map(({ name, address: target, owner }) => ({ name, target, owner }))
  }, null, 2));

  if (actions.length === 0) {
    console.log("SCOPL V2 revenue routing is already fully active. Nothing was broadcast.");
    return;
  }
  if (dryRun) {
    console.log(`V2 revenue activation preflight passed for ${actions.length} transaction(s). Nothing was broadcast.`);
    return;
  }

  const requiredOwners = new Set(actions.map((action) => action.owner));
  if (requiredOwners.size !== 1) {
    throw new Error("FeeRouter and RevenueDistributor currently require different owner wallets");
  }
  const expectedOwner = [...requiredOwners][0];
  const raw = process.env.SCOPL_DEPLOYER_PRIVATE_KEY?.trim() ||
    await promptHidden("V2 revenue owner private key (input hidden): ");
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("Private key must contain exactly 32 bytes");
  }
  const account = privateKeyToAccount(key);
  if (account.address !== expectedOwner) {
    throw new Error(`Wallet ${account.address} is not required owner ${expectedOwner}`);
  }

  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(
      `Type "ACTIVATE SCOPL V2 REVENUE" to broadcast ${actions.length} transaction(s): `
    );
    if (answer.trim() !== "ACTIVATE SCOPL V2 REVENUE") {
      throw new Error("Configuration cancelled");
    }
  } finally {
    terminal.close();
  }

  const walletClient = createWalletClient({
    account,
    chain,
    transport: robinhoodRpcTransport({ timeout: 30_000, rank: false })
  });
  const transactions = [];
  for (const action of actions) {
    const hash = await walletClient.writeContract({
      address: action.address,
      abi: action.abi,
      functionName: action.functionName,
      args: action.args
    });
    console.log(`${action.name}: https://robinhoodchain.blockscout.com/tx/${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 2,
      timeout: 180_000
    });
    if (receipt.status !== "success") throw new Error(`${action.name} failed`);
    transactions.push({
      action: action.name,
      hash,
      blockNumber: receipt.blockNumber.toString()
    });
  }

  const [finalFeeDistributor, ...finalSourceStates] = await Promise.all([
    publicClient.readContract({
      address: feeRouter,
      abi: feeAbi,
      functionName: "revenueDistributor"
    }),
    ...sources.map((source) => publicClient.readContract({
      address: distributor,
      abi: distributorAbi,
      functionName: "revenueSources",
      args: [source.address]
    }))
  ]);
  if (getAddress(finalFeeDistributor) !== distributor) {
    throw new Error("FeeRouter did not retain the V2 RevenueDistributor");
  }
  for (const [index, source] of sources.entries()) {
    const [product, enabled] = finalSourceStates[index];
    if (Number(product) !== source.product || enabled !== true) {
      throw new Error(`${source.name} did not retain its V2 revenue permission`);
    }
  }

  const output = path.join(process.cwd(), "deployments", "revenue-routing-v2-4663.json");
  fs.writeFileSync(output, `${JSON.stringify({
    chainId: CHAIN_ID,
    feeRouter,
    revenueDistributor: distributor,
    sources: sources.map(({ name, address: source, product }) => ({ name, address: source, product })),
    transactions,
    activatedAt: new Date().toISOString()
  }, null, 2)}\n`);
  console.log(`SCOPL V2 revenue routing is active. Wrote ${output}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
