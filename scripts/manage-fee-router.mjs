import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  isAddress,
  keccak256,
  parseAbi
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  robinhoodRpcTransport,
  robinhoodRpcUrls
} from "./robinhood-rpc.mjs";

const CHAIN_ID = 4_663;
const RPC_URLS = robinhoodRpcUrls();
const EXPLORER_URL = "https://robinhoodchain.blockscout.com";
const DEFAULT_ROUTER =
  "0x97BaF7c3d906C285ecC54eb0AeB275CD485a87F2";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const action = process.argv[2] ?? "status";
const allowedActions = new Set(["status", "pause", "unpause"]);
const routerAbi = parseAbi([
  "function owner() view returns (address)",
  "function revenueDistributor() view returns (address)",
  "function paused() view returns (bool)",
  "function MAX_FEE_BPS() view returns (uint16)",
  "function baseFeeBps() view returns (uint16)",
  "function feeToken() view returns (address)",
  "function pause()",
  "function unpause()"
]);

if (!allowedActions.has(action)) {
  throw new Error("Usage: node scripts/manage-fee-router.mjs status|pause|unpause");
}

const root = process.cwd();
const manifestPath = path.join(
  root,
  "deployments",
  `robinhood-${CHAIN_ID}.json`
);
const manifest = fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  : null;
const configuredRouter =
  process.env.NEXT_PUBLIC_SCOPL_FEE_ROUTER_ADDRESS?.trim() ||
  manifest?.address ||
  DEFAULT_ROUTER;
if (!isAddress(configuredRouter)) {
  throw new Error("The configured SCOPL Fee Router address is invalid");
}
const router = getAddress(configuredRouter);
const chain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: RPC_URLS } },
  blockExplorers: {
    default: { name: "Blockscout", url: EXPLORER_URL }
  }
});
const publicClient = createPublicClient({
  chain,
  transport: robinhoodRpcTransport()
});

async function promptHidden(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Run this command in an interactive terminal for the hidden key prompt."
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
          process.stdout.write("\n");
          reject(new Error("Action cancelled"));
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

async function confirmAction(phrase) {
  if (process.env.SCOPL_ADMIN_CONFIRM === phrase) return;
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    const answer = await terminal.question(
      `Type "${phrase}" to broadcast this transaction: `
    );
    if (answer.trim() !== phrase) throw new Error("Action cancelled");
  } finally {
    terminal.close();
  }
}

async function readStatus() {
  const [
    owner,
    revenueDistributor,
    paused,
    maximumFeeBps,
    baseFeeBps,
    feeToken
  ] = await Promise.all([
    publicClient.readContract({
      address: router,
      abi: routerAbi,
      functionName: "owner"
    }),
    publicClient.readContract({
      address: router,
      abi: routerAbi,
      functionName: "revenueDistributor"
    }),
    publicClient.readContract({
      address: router,
      abi: routerAbi,
      functionName: "paused"
    }),
    publicClient.readContract({
      address: router,
      abi: routerAbi,
      functionName: "MAX_FEE_BPS"
    }),
    publicClient.readContract({
      address: router,
      abi: routerAbi,
      functionName: "baseFeeBps"
    }),
    publicClient.readContract({
      address: router,
      abi: routerAbi,
      functionName: "feeToken"
    })
  ]);
  return {
    owner: getAddress(owner),
    revenueDistributor: getAddress(revenueDistributor),
    paused,
    maximumFeeBps: Number(maximumFeeBps),
    baseFeeBps: Number(baseFeeBps),
    feeToken: getAddress(feeToken)
  };
}

async function main() {
  const actualChainId = await publicClient.getChainId();
  if (actualChainId !== CHAIN_ID) {
    throw new Error(
      `Wrong chain: expected ${CHAIN_ID}, received ${actualChainId}`
    );
  }
  const code = await publicClient.getCode({ address: router });
  if (!code) throw new Error(`${router} has no deployed runtime code`);
  const runtimeHash = keccak256(code);
  if (
    manifest?.release?.deployedRuntimeHash &&
    runtimeHash !== manifest.release.deployedRuntimeHash
  ) {
    throw new Error(
      `Runtime hash mismatch: expected ` +
      `${manifest.release.deployedRuntimeHash}, received ${runtimeHash}`
    );
  }

  const status = await readStatus();
  console.log(`SCOPL Fee Router: ${router}`);
  console.log(`Explorer: ${EXPLORER_URL}/address/${router}`);
  console.log(`Runtime hash: ${runtimeHash}`);
  console.log(`Owner: ${status.owner}`);
  console.log(`Revenue distributor: ${status.revenueDistributor}`);
  console.log(`State: ${status.paused ? "PAUSED" : "ACTIVE"}`);
  console.log(
    `Base fee: ${(status.baseFeeBps / 100).toFixed(2)}% ` +
    `(maximum ${(status.maximumFeeBps / 100).toFixed(2)}%)`
  );
  console.log(
    status.feeToken === getAddress(ZERO_ADDRESS)
      ? "SCOPL discounts: not configured; every user pays the base fee"
      : `SCOPL discount token: ${status.feeToken}`
  );

  if (action === "status") return;
  const targetPausedState = action === "pause";
  if (status.paused === targetPausedState) {
    console.log(
      `No transaction needed: the router is already ` +
      `${targetPausedState ? "paused" : "active"}.`
    );
    return;
  }

  const suppliedKey = process.env.SCOPL_DEPLOYER_PRIVATE_KEY?.trim();
  const rawKey = suppliedKey ||
    await promptHidden("Owner private key (input hidden): ");
  const privateKey = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("Private key must contain exactly 32 bytes");
  }
  const account = privateKeyToAccount(privateKey);
  if (account.address.toLowerCase() !== status.owner.toLowerCase()) {
    throw new Error(
      `Signer ${account.address} is not contract owner ${status.owner}`
    );
  }
  const phrase = action.toUpperCase();
  await confirmAction(phrase);

  const walletClient = createWalletClient({
    account,
    chain,
    transport: robinhoodRpcTransport({ timeout: 30_000 })
  });
  const simulation = await publicClient.simulateContract({
    account,
    address: router,
    abi: routerAbi,
    functionName: action
  });
  const transactionHash = await walletClient.writeContract(simulation.request);
  console.log(`Broadcast ${EXPLORER_URL}/tx/${transactionHash}`);
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: transactionHash,
    confirmations: 2,
    timeout: 180_000
  });
  if (receipt.status !== "success") {
    throw new Error(`Transaction ${transactionHash} failed`);
  }
  const finalPausedState = await publicClient.readContract({
    address: router,
    abi: routerAbi,
    functionName: "paused"
  });
  if (finalPausedState !== targetPausedState) {
    throw new Error("Post-transaction pause-state verification failed");
  }
  console.log(
    `Verified: router is now ${finalPausedState ? "PAUSED" : "ACTIVE"}.`
  );
}

main().catch((error) => {
  console.error(`Fee Router action failed: ${error.message}`);
  process.exitCode = 1;
});
