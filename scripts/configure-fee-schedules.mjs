import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  isAddress,
  parseAbi,
  parseUnits
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  robinhoodRpcTransport,
  robinhoodRpcUrls
} from "./robinhood-rpc.mjs";

const CHAIN_ID = 4_663;
const rpcUrls = robinhoodRpcUrls();
const dryRun = process.argv.includes("--dry-run");
const disableTiers = process.argv.includes("--disable") ||
  process.env.SCOPL_DISABLE_FEE_TIERS?.trim() === "true";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const chain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: rpcUrls } }
});
const publicClient = createPublicClient({
  chain,
  transport: robinhoodRpcTransport()
});
const tokenAbi = parseAbi(["function decimals() view returns (uint8)"]);

function artifact(name) {
  const filename = path.join(
    process.cwd(), "contracts", "artifacts", `${name}.json`
  );
  const parsed = JSON.parse(fs.readFileSync(filename, "utf8"));
  if (!Array.isArray(parsed.abi)) throw new Error(`Missing ${name} ABI`);
  return parsed.abi;
}

function addressFrom(...names) {
  const value = names.map((name) => process.env[name]?.trim()).find(Boolean);
  if (!value || !isAddress(value)) throw new Error(`${names[0]} is required`);
  return getAddress(value);
}

function integer(name, fallback, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${name} must be an integer from 0 to ${maximum}`);
  }
  return value;
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
  const feeRouter = addressFrom(
    "SCOPL_FEE_ROUTER_ADDRESS", "NEXT_PUBLIC_SCOPL_FEE_ROUTER_ADDRESS"
  );
  const token = disableTiers ? ZERO_ADDRESS : addressFrom("SCOPL_TOKEN_ADDRESS");
  const feeAbi = artifact("ScoplFeeRouter");
  const [feeCode, tokenCode] = await Promise.all([
    publicClient.getCode({ address: feeRouter }),
    disableTiers ? Promise.resolve("0x01") : publicClient.getCode({ address: token })
  ]);
  if ([feeCode, tokenCode].some((code) => !code || code === "0x")) {
    throw new Error("Every configured contract must contain bytecode");
  }
  const decimals = disableTiers ? 18 : await publicClient.readContract({
    address: token,
    abi: tokenAbi,
    functionName: "decimals"
  });
  const lpFreeMinimum = (
    process.env.SCOPL_LP_FREE_CLAIM_MINIMUM_BALANCE?.trim() || "1000"
  );
  if (!/^\d+(?:\.\d+)?$/.test(lpFreeMinimum) || Number(lpFreeMinimum) <= 0) {
    throw new Error("SCOPL_LP_FREE_CLAIM_MINIMUM_BALANCE must be positive");
  }
  const lpMinimumBalances = disableTiers
    ? [0n, 0n, 0n]
    : [parseUnits(lpFreeMinimum, Number(decimals)), 0n, 0n];
  const lpBase = integer("SCOPL_LP_BASE_FEE_BPS", "500", 500);
  const lpTiers = [0, 0, 0];
  const contracts = [
    {
      name: "Fee Router",
      address: feeRouter,
      abi: feeAbi,
      base: lpBase,
      minimumBalances: lpMinimumBalances,
      tiers: lpTiers
    }
  ];
  const owners = await Promise.all(contracts.map((contract) =>
    publicClient.readContract({
      address: contract.address,
      abi: contract.abi,
      functionName: "owner"
    })
  ));
  console.log({
    mode: disableTiers ? "tiers-disabled" : "tiers-enabled",
    token,
    decimals,
    lp: {
      baseFeeBps: lpBase,
      freeClaimMinimum: lpFreeMinimum,
      minimumBalances: lpMinimumBalances,
      tierFeeBps: lpTiers
    },
    owners
  });
  for (const [index, contract] of contracts.entries()) {
    await publicClient.simulateContract({
      account: getAddress(String(owners[index])),
      address: contract.address,
      abi: contract.abi,
      functionName: "setFeeSchedule",
      args: [token, contract.base, contract.minimumBalances, contract.tiers]
    });
  }
  if (dryRun) {
    console.log("Fee schedule preflight passed. Nothing was broadcast.");
    return;
  }

  const supplied = process.env.SCOPL_DEPLOYER_PRIVATE_KEY?.trim();
  const raw = supplied || await promptHidden("Admin private key (input hidden): ");
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("Private key must contain exactly 32 bytes");
  }
  const account = privateKeyToAccount(key);
  for (const [index, owner] of owners.entries()) {
    if (getAddress(String(owner)) !== account.address) {
      throw new Error(`${contracts[index].name} is owned by ${owner}`);
    }
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(
      'Type "CONFIGURE LP FEE SCHEDULE" to broadcast one transaction: '
    );
    if (answer.trim() !== "CONFIGURE LP FEE SCHEDULE") {
      throw new Error("Configuration cancelled");
    }
  } finally {
    terminal.close();
  }
  const walletClient = createWalletClient({
    account,
    chain,
    transport: robinhoodRpcTransport({ timeout: 30_000 })
  });
  for (const contract of contracts) {
    const simulation = await publicClient.simulateContract({
      account,
      address: contract.address,
      abi: contract.abi,
      functionName: "setFeeSchedule",
      args: [token, contract.base, contract.minimumBalances, contract.tiers]
    });
    const hash = await walletClient.writeContract(simulation.request);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 2,
      timeout: 180_000
    });
    if (receipt.status !== "success") throw new Error(`${contract.name} update failed`);
    const [storedToken, storedBase, ...storedTiers] = await Promise.all([
      publicClient.readContract({
        address: contract.address,
        abi: contract.abi,
        functionName: "feeToken"
      }),
      publicClient.readContract({
        address: contract.address,
        abi: contract.abi,
        functionName: "baseFeeBps"
      }),
      ...[0, 1, 2].map((tier) => publicClient.readContract({
        address: contract.address,
        abi: contract.abi,
        functionName: "discountTiers",
        args: [tier]
      }))
    ]);
    if (getAddress(String(storedToken)) !== token || Number(storedBase) !== contract.base) {
      throw new Error(`${contract.name} post-configuration verification failed`);
    }
    for (const [tier, stored] of storedTiers.entries()) {
      if (
        String(stored[0]) !== String(contract.minimumBalances[tier]) ||
        Number(stored[1]) !== contract.tiers[tier]
      ) {
        throw new Error(`${contract.name} tier ${tier} verification failed`);
      }
    }
    console.log(`${contract.name} configured: ${hash}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
