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
  parseAbi,
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
const FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const POSITION_MANAGER = "0x73991a25c818bf1f1128deaab1492d45638de0d3";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const positionManagerDependencyAbi = parseAbi([
  "function factory() view returns (address)",
  "function WETH9() view returns (address)"
]);
const dependencies = [
  {
    name: "v3 factory",
    address: FACTORY,
    codeHash: "0xec72b1abd1f2faee020cfea9c646bd8994f9fb389054f6e574f103a895091739"
  },
  {
    name: "v3 position manager",
    address: POSITION_MANAGER,
    codeHash: "0x0a493d1af3d0f25fed8efa205244ebee14114267a08647fc38c515c7cd6ead4f"
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
  const filename = path.join(
    root,
    "contracts/artifacts/ScoplLimitOrderManager.json"
  );
  const compiled = JSON.parse(fs.readFileSync(filename, "utf8"));
  if (!Array.isArray(compiled.abi) || !compiled.evm?.bytecode?.object) {
    throw new Error("LimitOrderManager artifact is incomplete");
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
  const [positionFactory, positionWeth] = await Promise.all([
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: positionManagerDependencyAbi,
      functionName: "factory"
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: positionManagerDependencyAbi,
      functionName: "WETH9"
    })
  ]);
  if (
    getAddress(positionFactory) !== getAddress(FACTORY) ||
    getAddress(positionWeth) !== getAddress(WETH)
  ) {
    throw new Error("V3 PositionManager dependency relationship mismatch");
  }
}

async function main() {
  const compiled = artifact();
  await verifyDependencies();
  const minimum = parseEther(
    process.env.SCOPL_MIN_GAS_RESERVE_ETH?.trim() || "0.00005"
  );
  const revenueDistributor = configuredAddress("SCOPL_REVENUE_DISTRIBUTOR_ADDRESS");
  const orderPolicy = configuredAddress("SCOPL_ORDER_POLICY_ADDRESS");
  for (const [name, address] of [["revenue distributor", revenueDistributor], ["order policy", orderPolicy]]) {
    if (!await publicClient.getCode({ address })) {
      throw new Error(`Configured ${name} has no runtime code`);
    }
  }
  console.log("Verified Robinhood V3 factory, position manager, and WETH.");
  console.log(`Initial reserve minimum: ${minimum} wei`);
  console.log("Verified SCOPL V2 order policy and revenue distributor.");
  if (dryRun) {
    console.log("Limit-order deployment preflight passed. Nothing was broadcast.");
    return;
  }

  const suppliedKey = process.env.SCOPL_DEPLOYER_PRIVATE_KEY?.trim();
  const rawKey = suppliedKey || await promptHidden(
    "Limit-order deployer private key (input hidden): "
  );
  const key = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("Private key must contain exactly 32 bytes");
  }
  const account = privateKeyToAccount(key);
  const owner = configuredAddress("SCOPL_LIMIT_ORDER_OWNER", account.address);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(
      'Type "DEPLOY LIMIT ORDERS" to broadcast: '
    );
    if (answer.trim() !== "DEPLOY LIMIT ORDERS") {
      throw new Error("Deployment cancelled");
    }
  } finally {
    terminal.close();
  }

  const walletClient = createWalletClient({
    account,
    chain,
    transport: robinhoodRpcTransport({ timeout: 30_000 })
  });
  const hash = await walletClient.deployContract({
    abi: compiled.abi,
    bytecode: compiled.bytecode,
    args: [owner, revenueDistributor, orderPolicy, FACTORY, POSITION_MANAGER, WETH, minimum]
  });
  console.log(`Deploying ${EXPLORER_URL}/tx/${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: 2,
    timeout: 180_000
  });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error("LimitOrderManager deployment failed");
  }
  const address = getAddress(receipt.contractAddress);
  const [storedOwner, storedDistributor, storedPolicy, contractVersion, automaticPayouts] = await Promise.all([
    publicClient.readContract({ address, abi: compiled.abi, functionName: "owner" }),
    publicClient.readContract({ address, abi: compiled.abi, functionName: "revenueDistributor" }),
    publicClient.readContract({ address, abi: compiled.abi, functionName: "orderPolicy" }),
    publicClient.readContract({ address, abi: compiled.abi, functionName: "SCOPL_CONTRACT_VERSION" }),
    publicClient.readContract({ address, abi: compiled.abi, functionName: "automaticPayouts" })
  ]);
  if (storedOwner !== owner || storedDistributor !== revenueDistributor ||
    storedPolicy !== orderPolicy || contractVersion !== 2 || automaticPayouts !== true) {
    throw new Error("Post-deployment state verification failed");
  }
  const runtimeCode = await publicClient.getCode({ address });
  if (!runtimeCode || runtimeCode === "0x") {
    throw new Error("Deployed manager runtime code is unavailable");
  }
  const manifest = {
    contract: "ScoplLimitOrderManager",
    chainId: CHAIN_ID,
    address,
    transactionHash: hash,
    blockNumber: receipt.blockNumber.toString(),
    owner,
    revenueDistributor,
    orderPolicy,
    contractVersion: 2,
    automaticPayouts,
    runtimeCodeHash: keccak256(runtimeCode),
    minGasReserveWei: minimum.toString(),
    dependencies,
    deployedAt: new Date().toISOString()
  };
  fs.mkdirSync(path.join(root, "deployments"), { recursive: true });
  const manifestPath = path.join(root, "deployments/limit-orders-v2-4663.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`LimitOrderManager deployed at ${address}`);
  console.log(`Set NEXT_PUBLIC_SCOPL_V2_V3_LIMIT_ORDER_MANAGER_ADDRESS=${address}`);
  console.log(`Set SCOPL_V2_V3_LIMIT_ORDER_MANAGER_ADDRESS=${address} for the keeper.`);
  console.log(`Set SCOPL_V2_V3_KEEPER_START_BLOCK=${receipt.blockNumber} for the keeper.`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
);
