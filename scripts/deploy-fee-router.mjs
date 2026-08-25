import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
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
const CONTRACT_NAME = "ScoplFeeRouter";
const dependencies = {
  v3PositionManager: {
    label: "v3 position manager",
    address: "0x73991a25c818bf1f1128deaab1492d45638de0d3",
    codeHash:
      "0x0a493d1af3d0f25fed8efa205244ebee14114267a08647fc38c515c7cd6ead4f"
  },
  v4PositionManager: {
    label: "v4 position manager",
    address: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
    codeHash:
      "0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2"
  },
  v4PoolManager: {
    label: "v4 pool manager",
    address: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    codeHash:
      "0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626"
  },
  weth: {
    label: "WETH",
    address: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
    codeHash:
      "0x5706be52f64875fee65a2cec0d80e47a23d8793cbe85d214b48445e2d05f5353"
  }
};
const root = process.cwd();
const artifactPath = path.join(
  root,
  "contracts",
  "artifacts",
  `${CONTRACT_NAME}.json`
);
const sourcePath = path.join(root, "contracts", `${CONTRACT_NAME}.sol`);
const dryRun = process.argv.includes("--dry-run");
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function configuredAddress(name, fallback) {
  const value = process.env[name]?.trim() || fallback;
  if (!isAddress(value)) {
    throw new Error(`${name} is not a valid EVM address`);
  }
  return getAddress(value);
}

function gitMetadata() {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return { commit, dirty: status.length > 0 };
  } catch {
    return { commit: null, dirty: null };
  }
}

async function promptHidden(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "A TTY is required for the private-key prompt. " +
      "Run this command in an interactive terminal."
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
          continue;
        }
        if (character >= " ") value += character;
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
  if (process.env.SCOPL_DEPLOY_CONFIRM === "DEPLOY") return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Interactive confirmation is required. Set " +
      "SCOPL_DEPLOY_CONFIRM=DEPLOY only in a controlled CI environment."
    );
  }
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    const answer = await terminal.question(
      'Type "DEPLOY" to broadcast this transaction: '
    );
    if (answer.trim() !== "DEPLOY") throw new Error("Deployment cancelled");
  } finally {
    terminal.close();
  }
}

async function verifyDependencies() {
  const actualChainId = await publicClient.getChainId();
  if (actualChainId !== CHAIN_ID) {
    throw new Error(
      `Wrong chain: expected ${CHAIN_ID}, received ${actualChainId}`
    );
  }

  for (const dependency of Object.values(dependencies)) {
    const code = await publicClient.getCode({
      address: getAddress(dependency.address)
    });
    if (!code) {
      throw new Error(`${dependency.label} has no runtime code`);
    }
    const actualHash = keccak256(code);
    if (actualHash !== dependency.codeHash) {
      throw new Error(
        `${dependency.label} code hash mismatch: ${actualHash}`
      );
    }
    console.log(
      `Verified ${dependency.label} at ${getAddress(dependency.address)}`
    );
  }
}

function loadReleaseArtifact() {
  if (!fs.existsSync(artifactPath)) {
    throw new Error(
      `Missing ${artifactPath}. Run npm run compile first.`
    );
  }
  const source = fs.readFileSync(sourcePath, "utf8");
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const bytecodeObject = artifact.evm?.bytecode?.object;
  const runtimeObject = artifact.evm?.deployedBytecode?.object;
  if (
    !Array.isArray(artifact.abi) ||
    typeof bytecodeObject !== "string" ||
    bytecodeObject.length === 0 ||
    typeof runtimeObject !== "string" ||
    runtimeObject.length === 0
  ) {
    throw new Error("The compiled contract artifact is incomplete");
  }
  const bytecode = `0x${bytecodeObject}`;
  const runtimeTemplate = `0x${runtimeObject}`;
  return {
    abi: artifact.abi,
    bytecode,
    sourceSha256: sha256(source),
    initCodeHash: keccak256(bytecode),
    runtimeTemplateHash: keccak256(runtimeTemplate),
    initCodeBytes: bytecodeObject.length / 2,
    runtimeBytes: runtimeObject.length / 2,
    compilerVersion: artifact.metadata
      ? JSON.parse(artifact.metadata).compiler?.version ?? null
      : null
  };
}

async function main() {
  console.log(`Checking Robinhood Chain ${CHAIN_ID} via ${RPC_URLS.length} RPCs`);
  await verifyDependencies();
  const release = loadReleaseArtifact();
  const git = gitMetadata();
  console.log(
    `Release source SHA-256: ${release.sourceSha256}\n` +
    `Init code hash: ${release.initCodeHash}\n` +
    `Runtime template hash: ${release.runtimeTemplateHash}\n` +
    `Contract size: ${release.runtimeBytes} runtime bytes`
  );

  if (dryRun) {
    console.log("Deployment preflight passed. No transaction was broadcast.");
    return;
  }

  const suppliedKey = process.env.SCOPL_DEPLOYER_PRIVATE_KEY?.trim();
  const rawKey = suppliedKey ||
    await promptHidden("Deployer private key (input hidden): ");
  const privateKey = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("Private key must contain exactly 32 bytes");
  }
  const account = privateKeyToAccount(privateKey);
  const owner = configuredAddress("SCOPL_OWNER", account.address);
  const revenueDistributor = configuredAddress(
    "SCOPL_REVENUE_DISTRIBUTOR_ADDRESS"
  );
  if (!await publicClient.getCode({ address: revenueDistributor })) {
    throw new Error("Configured revenue distributor has no runtime code");
  }
  const balance = await publicClient.getBalance({ address: account.address });
  if (balance === 0n) {
    throw new Error(
      `Deployer ${account.address} has no ETH for Robinhood Chain gas`
    );
  }

  console.log("\nDeployment summary");
  console.log(`  Deployer: ${account.address}`);
  console.log(`  Balance:  ${formatEther(balance)} ETH`);
  console.log(`  Owner:    ${owner}`);
  console.log(`  Revenue distributor: ${revenueDistributor}`);
  console.log("  Initial state: ACTIVE");
  if (git.dirty) {
    console.warn(
      "  WARNING: the Git worktree is dirty; the manifest will record it."
    );
  }
  await confirmDeployment();

  const walletClient = createWalletClient({
    account,
    chain,
    transport: robinhoodRpcTransport({ timeout: 30_000 })
  });
  const constructorArgs = [
    owner,
    revenueDistributor,
    getAddress(dependencies.v3PositionManager.address),
    getAddress(dependencies.v4PositionManager.address),
    getAddress(dependencies.weth.address)
  ];
  const transactionHash = await walletClient.deployContract({
    abi: release.abi,
    bytecode: release.bytecode,
    args: constructorArgs
  });
  console.log(`Broadcast ${EXPLORER_URL}/tx/${transactionHash}`);
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: transactionHash,
    confirmations: 2,
    timeout: 180_000
  });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`Deployment transaction ${transactionHash} failed`);
  }
  const contractAddress = getAddress(receipt.contractAddress);

  const [
    deployedOwner,
    deployedRevenueDistributor,
    deployedV3,
    deployedV4,
    deployedV4PoolManager,
    deployedWeth,
    maximumFeeBps,
    baseFeeBps,
    isPaused
  ] = await Promise.all([
    publicClient.readContract({
      address: contractAddress,
      abi: release.abi,
      functionName: "owner"
    }),
    publicClient.readContract({
      address: contractAddress,
      abi: release.abi,
      functionName: "revenueDistributor"
    }),
    publicClient.readContract({
      address: contractAddress,
      abi: release.abi,
      functionName: "v3PositionManager"
    }),
    publicClient.readContract({
      address: contractAddress,
      abi: release.abi,
      functionName: "v4PositionManager"
    }),
    publicClient.readContract({
      address: contractAddress,
      abi: release.abi,
      functionName: "v4PoolManager"
    }),
    publicClient.readContract({
      address: contractAddress,
      abi: release.abi,
      functionName: "weth"
    }),
    publicClient.readContract({
      address: contractAddress,
      abi: release.abi,
      functionName: "MAX_FEE_BPS"
    }),
    publicClient.readContract({
      address: contractAddress,
      abi: release.abi,
      functionName: "baseFeeBps"
    }),
    publicClient.readContract({
      address: contractAddress,
      abi: release.abi,
      functionName: "paused"
    })
  ]);
  const expectedState = [
    [deployedOwner, owner, "owner"],
    [
      deployedRevenueDistributor,
      revenueDistributor,
      "revenue distributor"
    ],
    [deployedV3, constructorArgs[2], "v3 position manager"],
    [deployedV4, constructorArgs[3], "v4 position manager"],
    [
      deployedV4PoolManager,
      getAddress(dependencies.v4PoolManager.address),
      "v4 pool manager"
    ],
    [deployedWeth, constructorArgs[4], "WETH"]
  ];
  for (const [actual, expected, label] of expectedState) {
    if (getAddress(String(actual)) !== expected) {
      throw new Error(`Post-deploy ${label} verification failed`);
    }
  }
  if (Number(maximumFeeBps) !== 500 || Number(baseFeeBps) !== 500) {
    throw new Error("Post-deploy fee ceiling verification failed");
  }
  if (isPaused !== false) {
    throw new Error("Post-deploy active-state verification failed");
  }
  const deployedCode = await publicClient.getCode({
    address: contractAddress
  });
  if (!deployedCode) throw new Error("Deployed contract has no runtime code");

  const manifestDir = path.join(root, "deployments");
  const manifestPath = path.join(manifestDir, `robinhood-${CHAIN_ID}.json`);
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({
    contract: CONTRACT_NAME,
    chainId: CHAIN_ID,
    address: contractAddress,
    transactionHash,
    blockNumber: receipt.blockNumber.toString(),
    deployedAt: new Date().toISOString(),
    deployer: account.address,
    owner,
    revenueDistributor,
    paused: false,
    maximumFeeBps: 500,
    baseFeeBps: 500,
    constructorArgs,
    dependencies: Object.fromEntries(
      Object.entries(dependencies).map(([name, dependency]) => [
        name,
        {
          address: getAddress(dependency.address),
          codeHash: dependency.codeHash
        }
      ])
    ),
    release: {
      sourceSha256: release.sourceSha256,
      initCodeHash: release.initCodeHash,
      runtimeTemplateHash: release.runtimeTemplateHash,
      deployedRuntimeHash: keccak256(deployedCode),
      initCodeBytes: release.initCodeBytes,
      runtimeBytes: release.runtimeBytes,
      compilerVersion: release.compilerVersion,
      optimizer: { enabled: true, runs: 200, viaIR: true },
      gitCommit: git.commit,
      gitDirty: git.dirty
    }
  }, null, 2) + "\n");

  console.log("\nDeployment verified");
  console.log(`  Contract: ${EXPLORER_URL}/address/${contractAddress}`);
  console.log(`  Manifest: ${manifestPath}`);
  console.log(
    `  Application: NEXT_PUBLIC_SCOPL_FEE_ROUTER_ADDRESS=${contractAddress}`
  );
  console.log(
    "The router is active. Verify the source and constructor arguments " +
    "and run a low-value claim immediately."
  );
}

main().catch((error) => {
  console.error(`Deployment failed: ${error.message}`);
  process.exitCode = 1;
});
