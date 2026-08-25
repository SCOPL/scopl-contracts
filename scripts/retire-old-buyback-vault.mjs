import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  parseAbi
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  robinhoodRpcTransport,
  robinhoodRpcUrls
} from "./robinhood-rpc.mjs";

const CHAIN_ID = 4_663;
const dryRun = process.argv.includes("--dry-run");
const manifestPath = path.join(
  process.cwd(),
  "deployments",
  "pons-buyback-4663.json"
);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const oldVault = getAddress(manifest.oldBuybackVault);
const newVault = getAddress(manifest.buybackVault);
const distributor = getAddress(manifest.distributor);
const expectedOwner = getAddress(manifest.owner);
const rpcUrls = robinhoodRpcUrls();
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
const vaultAbi = parseAbi([
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
  "function pause()"
]);
const distributorAbi = parseAbi([
  "function buybackVault() view returns (address)"
]);

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
          reject(new Error("Retirement cancelled"));
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
  if (await publicClient.getChainId() !== CHAIN_ID) {
    throw new Error(`RPC is not Robinhood Chain ${CHAIN_ID}`);
  }
  const [owner, paused, currentDestination, oldCode, newCode] =
    await Promise.all([
      publicClient.readContract({
        address: oldVault,
        abi: vaultAbi,
        functionName: "owner"
      }),
      publicClient.readContract({
        address: oldVault,
        abi: vaultAbi,
        functionName: "paused"
      }),
      publicClient.readContract({
        address: distributor,
        abi: distributorAbi,
        functionName: "buybackVault"
      }),
      publicClient.getCode({ address: oldVault }),
      publicClient.getCode({ address: newVault })
    ]);
  if (!oldCode || oldCode === "0x" || !newCode || newCode === "0x") {
    throw new Error("Old or new BuybackVault has no deployed bytecode");
  }
  if (getAddress(owner) !== expectedOwner) {
    throw new Error(`Old BuybackVault owner is ${owner}, expected ${expectedOwner}`);
  }
  if (getAddress(currentDestination) !== newVault) {
    throw new Error(
      `Distributor targets ${currentDestination}, not replacement ${newVault}`
    );
  }
  console.log({
    distributor,
    currentBuybackDestination: getAddress(currentDestination),
    oldBuybackVault: oldVault,
    newBuybackVault: newVault,
    owner: getAddress(owner),
    oldVaultPaused: paused,
    assetRecovery: "disabled; existing balances remain in the old vault"
  });
  if (paused) {
    console.log("Old BuybackVault is already paused. Nothing was broadcast.");
    return;
  }
  await publicClient.simulateContract({
    account: expectedOwner,
    address: oldVault,
    abi: vaultAbi,
    functionName: "pause"
  });
  if (dryRun) {
    console.log("Old BuybackVault retirement preflight passed. Nothing was broadcast.");
    return;
  }

  const supplied = process.env.SCOPL_DEPLOYER_PRIVATE_KEY?.trim();
  const raw = supplied || await promptHidden("Protocol owner private key (input hidden): ");
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("Private key must contain exactly 32 bytes");
  }
  const account = privateKeyToAccount(key);
  if (account.address !== expectedOwner) {
    throw new Error(`Wallet ${account.address} is not owner ${expectedOwner}`);
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(
      'Type "RETIRE OLD BUYBACK VAULT" to pause the old vault without moving assets: '
    );
    if (answer.trim() !== "RETIRE OLD BUYBACK VAULT") {
      throw new Error("Retirement cancelled");
    }
  } finally {
    terminal.close();
  }
  const walletClient = createWalletClient({
    account,
    chain,
    transport: robinhoodRpcTransport({ timeout: 30_000 })
  });
  const simulation = await publicClient.simulateContract({
    account,
    address: oldVault,
    abi: vaultAbi,
    functionName: "pause"
  });
  const hash = await walletClient.writeContract(simulation.request);
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: 2,
    timeout: 180_000
  });
  if (receipt.status !== "success") throw new Error("Old vault pause failed");
  const nowPaused = await publicClient.readContract({
    address: oldVault,
    abi: vaultAbi,
    functionName: "paused"
  });
  if (!nowPaused) throw new Error("Old vault is not paused after confirmation");
  console.log(`Old BuybackVault paused: ${hash}`);
  console.log("No asset was recovered or transferred.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
