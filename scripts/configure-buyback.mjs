import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  isAddress,
  parseAbi
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  robinhoodRpcTransport,
  robinhoodRpcUrls
} from "./robinhood-rpc.mjs";

const CHAIN_ID = 4_663;
const rpcUrls = robinhoodRpcUrls();
const dryRun = process.argv.includes("--dry-run");
const PONS_V2_FACTORY = getAddress(
  "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e"
);
const ponsFactoryAbi = parseAbi([
  "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))"
]);
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

function address(name) {
  const value = process.env[name]?.trim();
  if (!value || !isAddress(value)) throw new Error(`${name} is required`);
  return getAddress(value);
}

function loadAbi() {
  const artifact = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), "contracts/artifacts/ScoplBuybackVault.json"),
    "utf8"
  ));
  if (!Array.isArray(artifact.abi)) throw new Error("Missing Buyback Vault ABI");
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
  const vault = address("SCOPL_BUYBACK_VAULT_ADDRESS");
  const token = address("SCOPL_TOKEN_ADDRESS");
  const keeper = address("SCOPL_BUYBACK_KEEPER_ADDRESS");
  const abi = loadAbi();
  for (const [label, configured] of Object.entries({ vault, token })) {
    const code = await publicClient.getCode({ address: configured });
    if (!code || code === "0x") throw new Error(`${label} has no runtime code`);
  }
  const [owner, finalized, currentExecutor, storedPonsFactory, ponsLaunch] =
    await Promise.all([
    publicClient.readContract({ address: vault, abi, functionName: "owner" }),
    publicClient.readContract({
      address: vault,
      abi,
      functionName: "buybackConfigurationFinalized"
    }),
    publicClient.readContract({
      address: vault,
      abi,
      functionName: "executors",
      args: [keeper]
    }),
    publicClient.readContract({
      address: vault,
      abi,
      functionName: "ponsV2Factory"
    }),
    publicClient.readContract({
      address: PONS_V2_FACTORY,
      abi: ponsFactoryAbi,
      functionName: "getLaunchedToken",
      args: [token]
    })
  ]);
  if (getAddress(String(storedPonsFactory)) !== PONS_V2_FACTORY) {
    throw new Error("Buyback Vault does not pin the verified Pons V2 Factory");
  }
  if (
    !ponsLaunch.exists || getAddress(ponsLaunch.token) !== token ||
    ponsLaunch.curve === "0x0000000000000000000000000000000000000000"
  ) {
    throw new Error("SCOPL_TOKEN_ADDRESS is not a Pons V2 launch from the pinned Factory");
  }
  if (finalized) {
    const storedToken = await publicClient.readContract({
      address: vault,
      abi,
      functionName: "buybackToken"
    });
    if (getAddress(String(storedToken)) !== token) {
      throw new Error("Finalized buyback token does not match SCOPL_TOKEN_ADDRESS");
    }
    if (!currentExecutor) {
      throw new Error("Buyback is finalized but the configured keeper is not authorized");
    }
    console.log("Buyback token and keeper are already configured.");
    return;
  }

  const accountAddress = getAddress(String(owner));
  const calls = [
    { functionName: "configureBuyback", args: [token] },
    { functionName: "setExecutor", args: [keeper, true] },
    { functionName: "finalizeBuybackConfiguration", args: [] }
  ];
  for (const call of calls.slice(0, 2)) {
    await publicClient.simulateContract({
      account: accountAddress,
      address: vault,
      abi,
      functionName: call.functionName,
      args: call.args
    });
  }
  console.log({ vault, token, keeper });
  if (dryRun) {
    console.log("Buyback configuration preflight passed. Nothing was broadcast.");
    return;
  }

  const raw = process.env.SCOPL_DEPLOYER_PRIVATE_KEY?.trim() ||
    await promptHidden("Buyback owner private key (input hidden): ");
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("Private key must contain exactly 32 bytes");
  }
  const account = privateKeyToAccount(key);
  if (account.address !== accountAddress) throw new Error("Wallet is not Buyback Vault owner");
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(
      'This permanently locks bought SCOPL in the vault. Type "FINALIZE BUYBACK RESERVE" to continue: '
    );
    if (answer.trim() !== "FINALIZE BUYBACK RESERVE") {
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
  for (const call of calls) {
    const simulation = await publicClient.simulateContract({
      account,
      address: vault,
      abi,
      functionName: call.functionName,
      args: call.args
    });
    const hash = await walletClient.writeContract(simulation.request);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 2,
      timeout: 180_000
    });
    if (receipt.status !== "success") throw new Error(`${call.functionName} failed`);
  }
  console.log("Buyback token finalized and keeper authorized.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
