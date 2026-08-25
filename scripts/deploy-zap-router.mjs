import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  isAddress,
  keccak256
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  robinhoodRpcTransport,
  robinhoodRpcUrls
} from "./robinhood-rpc.mjs";

const CHAIN_ID = 4_663;
const RPC_URLS = robinhoodRpcUrls();
const EXPLORER_URL = "https://robinhoodchain.blockscout.com";
const V3_SWAP_ROUTER = "0xcaf681a66d020601342297493863e78c959e5cb2";
const V3_POSITION_MANAGER = "0x73991a25c818bf1f1128deaab1492d45638de0d3";
const V4_POSITION_MANAGER = "0x58daec3116aae6d93017baaea7749052e8a04fa7";
const V4_STATE_VIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const UNIVERSAL_ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904";
const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const dependencies = [
  {
    name: "v3 swap router",
    address: V3_SWAP_ROUTER,
    codeHash: "0x6f36c378e272c6324c48f045182bcb54bd8ad654cf9ebd42e8893d52c4cb25dc"
  },
  {
    name: "v3 position manager",
    address: V3_POSITION_MANAGER,
    codeHash: "0x0a493d1af3d0f25fed8efa205244ebee14114267a08647fc38c515c7cd6ead4f"
  },
  {
    name: "v4 position manager",
    address: V4_POSITION_MANAGER,
    codeHash: "0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2"
  },
  {
    name: "v4 state view",
    address: V4_STATE_VIEW,
    codeHash: "0x7d9c591e0956fd89d98feb4ffcfe8bf1f7a62bd485edd979fa21d104b49878a6"
  },
  {
    name: "universal router",
    address: UNIVERSAL_ROUTER,
    codeHash: "0x2ce6aaaf9f4151f5e1cbf774668772f17f532ae11b15e9284fd0a072a8b0fbde"
  },
  {
    name: "Permit2",
    address: PERMIT2,
    codeHash: "0x5208783f52488f7d3493e5e38311ab707c1d75457fe472a19b0b4d57d66a7fca"
  },
  {
    name: "WETH",
    address: WETH,
    codeHash: "0x5706be52f64875fee65a2cec0d80e47a23d8793cbe85d214b48445e2d05f5353"
  }
];
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

function artifact() {
  const filename = path.join(root, "contracts/artifacts/ScoplZapRouter.json");
  const compiled = JSON.parse(fs.readFileSync(filename, "utf8"));
  if (!Array.isArray(compiled.abi) || !compiled.evm?.bytecode?.object) {
    throw new Error("ZapRouter artifact is incomplete");
  }
  return {
    abi: compiled.abi,
    bytecode: `0x${compiled.evm.bytecode.object}`
  };
}

async function promptHidden(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("A TTY is required for the private-key prompt.");
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

async function verifyDependencies() {
  if (await publicClient.getChainId() !== CHAIN_ID) {
    throw new Error(`RPC is not Robinhood Chain ${CHAIN_ID}`);
  }
  for (const dependency of dependencies) {
    const code = await publicClient.getCode({ address: dependency.address });
    if (!code || keccak256(code) !== dependency.codeHash) {
      throw new Error(`${dependency.name} runtime code does not match`);
    }
  }
}

async function main() {
  const compiled = artifact();
  await verifyDependencies();
  const ownerValue = process.env.SCOPL_PROTOCOL_OWNER?.trim() ||
    process.env.SCOPL_OWNER?.trim();
  if (!ownerValue || !isAddress(ownerValue)) {
    throw new Error("SCOPL_PROTOCOL_OWNER is required");
  }
  const owner = getAddress(ownerValue);
  console.log("Verified every immutable Zap dependency on Robinhood Chain.");
  if (dryRun) {
    console.log("Zap deployment preflight passed. Nothing was broadcast.");
    return;
  }

  const suppliedKey = process.env.SCOPL_DEPLOYER_PRIVATE_KEY?.trim();
  const rawKey = suppliedKey || await promptHidden(
    "Zap deployer private key (input hidden): "
  );
  const key = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("Private key must contain exactly 32 bytes");
  }
  const account = privateKeyToAccount(key);
  if (account.address !== owner) {
    throw new Error(`Deployment wallet ${account.address} is not owner ${owner}`);
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question('Type "DEPLOY ZAP" to broadcast: ');
    if (answer.trim() !== "DEPLOY ZAP") throw new Error("Deployment cancelled");
  } finally {
    terminal.close();
  }

  const walletClient = createWalletClient({
    account,
    chain,
    transport: robinhoodRpcTransport({ timeout: 30_000 })
  });
  const constructorArguments = [
    owner,
    V3_SWAP_ROUTER,
    V3_POSITION_MANAGER,
    V4_POSITION_MANAGER,
    V4_STATE_VIEW,
    UNIVERSAL_ROUTER,
    PERMIT2,
    WETH
  ];
  const hash = await walletClient.deployContract({
    abi: compiled.abi,
    bytecode: compiled.bytecode,
    args: constructorArguments
  });
  console.log(`Deploying ${EXPLORER_URL}/tx/${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: 2,
    timeout: 180_000
  });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error("ZapRouter deployment failed");
  }
  const address = getAddress(receipt.contractAddress);
  const immutableFunctions = [
    "owner",
    "v3SwapRouter",
    "v3PositionManager",
    "v4PositionManager",
    "v4StateView",
    "universalRouter",
    "permit2",
    "weth"
  ];
  const storedDependencies = await Promise.all(immutableFunctions.map(
    (functionName) => publicClient.readContract({
      address,
      abi: compiled.abi,
      functionName
    })
  ));
  for (let index = 0; index < constructorArguments.length; index++) {
    if (getAddress(storedDependencies[index]) !== getAddress(constructorArguments[index])) {
      throw new Error(`Immutable ${immutableFunctions[index]} verification failed`);
    }
  }
  const manifest = {
    contract: "ScoplZapRouter",
    chainId: CHAIN_ID,
    address,
    transactionHash: hash,
    blockNumber: receipt.blockNumber.toString(),
    deployer: account.address,
    owner,
    dependencies,
    deployedAt: new Date().toISOString()
  };
  fs.mkdirSync(path.join(root, "deployments"), { recursive: true });
  const manifestPath = path.join(root, "deployments/zap-router-4663.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`ZapRouter deployed at ${address}`);
  console.log(`Set NEXT_PUBLIC_SCOPL_ZAP_ROUTER_ADDRESS=${address}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
