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
  parseEther
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  robinhoodRpcTransport,
  robinhoodRpcUrls
} from "./robinhood-rpc.mjs";

const CHAIN_ID = 4_663;
const RPC_URLS = robinhoodRpcUrls();
const EXPLORER = "https://robinhoodchain.blockscout.com";
const WETH = getAddress("0x0bd7d308f8e1639fab988df18a8011f41eacad73");
const UNIVERSAL_ROUTER = getAddress("0x8876789976decbfcbbbe364623c63652db8c0904");
const PERMIT2 = getAddress("0x000000000022d473030f116ddee9f6b43ac78ba3");
const PONS_V2_FACTORY = getAddress("0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e");
const dryRun = process.argv.includes("--dry-run");
const chain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: RPC_URLS } }
});
const publicClient = createPublicClient({
  chain,
  transport: robinhoodRpcTransport()
});
const ponsFactoryAbi = parseAbi([
  "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))"
]);

function configuredAddress(...names) {
  const value = names.map((name) => process.env[name]?.trim()).find(Boolean);
  if (!value || !isAddress(value)) throw new Error(`${names[0]} is missing or invalid`);
  return getAddress(value);
}

function artifact(name) {
  const parsed = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), "contracts", "artifacts", `${name}.json`),
    "utf8"
  ));
  const object = parsed.evm?.bytecode?.object;
  if (!Array.isArray(parsed.abi) || !object) {
    throw new Error(`${name} artifact is incomplete; run npm run compile`);
  }
  return { abi: parsed.abi, bytecode: `0x${object}` };
}

async function hidden(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("A TTY is required");
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
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") value += character;
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
  if (await publicClient.getChainId() !== CHAIN_ID) throw new Error("Wrong RPC chain");
  const owner = configuredAddress("SCOPL_PROTOCOL_OWNER", "SCOPL_OWNER");
  const guardian = configuredAddress("SCOPL_GUARDIAN", "SCOPL_PROTOCOL_OWNER", "SCOPL_OWNER");
  const distributor = configuredAddress("SCOPL_REVENUE_DISTRIBUTOR_ADDRESS");
  const scopl = configuredAddress("SCOPL_TOKEN_ADDRESS");
  const keeper = configuredAddress("SCOPL_BUYBACK_KEEPER_ADDRESS");
  const keeperReward = parseEther(
    process.env.SCOPL_BUYBACK_KEEPER_REWARD_ETH?.trim() || "0.00002"
  );
  if (keeperReward === 0n || keeperReward > parseEther("0.001")) {
    throw new Error("Keeper reward must be above 0 and at most 0.001 ETH");
  }
  const vaultArtifact = artifact("ScoplBuybackVault");
  const adapterArtifact = artifact("ScoplRouterSwapAdapter");
  const distributorArtifact = artifact("ScoplRevenueDistributor");
  for (const [name, address] of Object.entries({
    WETH, UNIVERSAL_ROUTER, PERMIT2, PONS_V2_FACTORY, distributor, scopl
  })) {
    const code = await publicClient.getCode({ address });
    if (!code || code === "0x") throw new Error(`${name} has no runtime code`);
  }
  const [distributorOwner, referralRewards, oldBuybackVault,
    operationalTreasury, ponsLaunch] = await Promise.all([
    publicClient.readContract({
      address: distributor,
      abi: distributorArtifact.abi,
      functionName: "owner"
    }),
    publicClient.readContract({
      address: distributor,
      abi: distributorArtifact.abi,
      functionName: "referralRewards"
    }),
    publicClient.readContract({
      address: distributor,
      abi: distributorArtifact.abi,
      functionName: "buybackVault"
    }),
    publicClient.readContract({
      address: distributor,
      abi: distributorArtifact.abi,
      functionName: "operationalTreasury"
    }),
    publicClient.readContract({
      address: PONS_V2_FACTORY,
      abi: ponsFactoryAbi,
      functionName: "getLaunchedToken",
      args: [scopl]
    })
  ]);
  if (getAddress(distributorOwner) !== owner) throw new Error("Owner does not control Distributor");
  if (!ponsLaunch.exists || getAddress(ponsLaunch.token) !== scopl) {
    throw new Error("SCOPL is not registered by the pinned Pons V2 Factory");
  }
  const curveCode = await publicClient.getCode({ address: ponsLaunch.curve });
  if (!curveCode || curveCode === "0x") throw new Error("Pons SCOPL curve has no bytecode");

  console.log({
    owner,
    guardian,
    distributor,
    oldBuybackVault,
    referralRewards,
    operationalTreasury,
    scopl,
    ponsV2Factory: PONS_V2_FACTORY,
    ponsPhase: Number(ponsLaunch.phase),
    ponsCurve: ponsLaunch.curve,
    ponsPairToken: ponsLaunch.pairToken,
    keeper,
    keeperRewardWei: keeperReward.toString()
  });
  if (dryRun) {
    console.log("Pons-aware buyback replacement preflight passed. Nothing was broadcast.");
    return;
  }

  const supplied = process.env.SCOPL_DEPLOYER_PRIVATE_KEY?.trim();
  const raw = supplied || await hidden("Protocol owner private key (input hidden): ");
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("Invalid private key");
  const account = privateKeyToAccount(key);
  if (account.address !== owner) throw new Error(`Wallet ${account.address} is not owner ${owner}`);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(
      'Type "DEPLOY PONS BUYBACK" to deploy and switch the Distributor destination: '
    );
    if (answer.trim() !== "DEPLOY PONS BUYBACK") throw new Error("Deployment cancelled");
  } finally {
    terminal.close();
  }
  const wallet = createWalletClient({
    account,
    chain,
    transport: robinhoodRpcTransport({ timeout: 30_000 })
  });
  const transactions = [];
  async function deploy(name, release, args) {
    const hash = await wallet.deployContract({ ...release, args });
    console.log(`${name}: ${EXPLORER}/tx/${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash, confirmations: 2, timeout: 180_000
    });
    if (receipt.status !== "success" || !receipt.contractAddress) {
      throw new Error(`${name} deployment failed`);
    }
    const address = getAddress(receipt.contractAddress);
    transactions.push({ action: `deploy ${name}`, hash, address });
    return address;
  }
  async function send(address, abi, functionName, args) {
    const simulation = await publicClient.simulateContract({
      account, address, abi, functionName, args
    });
    const hash = await wallet.writeContract(simulation.request);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash, confirmations: 2, timeout: 180_000
    });
    if (receipt.status !== "success") throw new Error(`${functionName} failed`);
    transactions.push({ action: functionName, hash });
  }

  const vault = await deploy("ScoplBuybackVault", vaultArtifact, [
    owner, guardian, WETH, PONS_V2_FACTORY, keeperReward
  ]);
  const adapter = await deploy("ScoplRouterSwapAdapter", adapterArtifact, [
    vault, UNIVERSAL_ROUTER, PERMIT2, WETH
  ]);
  await send(vault, vaultArtifact.abi, "setAdapter", [adapter, true]);
  await send(vault, vaultArtifact.abi, "configureBuyback", [scopl]);
  await send(vault, vaultArtifact.abi, "setExecutor", [keeper, true]);
  await send(vault, vaultArtifact.abi, "finalizeBuybackConfiguration", []);
  await send(distributor, distributorArtifact.abi, "setDestinations", [
    referralRewards, vault, operationalTreasury
  ]);

  const [storedDestination, storedToken, storedFactory, executorAllowed] =
    await Promise.all([
      publicClient.readContract({ address: distributor, abi: distributorArtifact.abi, functionName: "buybackVault" }),
      publicClient.readContract({ address: vault, abi: vaultArtifact.abi, functionName: "buybackToken" }),
      publicClient.readContract({ address: vault, abi: vaultArtifact.abi, functionName: "ponsV2Factory" }),
      publicClient.readContract({ address: vault, abi: vaultArtifact.abi, functionName: "executors", args: [keeper] })
    ]);
  if (
    getAddress(storedDestination) !== vault || getAddress(storedToken) !== scopl ||
    getAddress(storedFactory) !== PONS_V2_FACTORY || !executorAllowed
  ) throw new Error("Pons buyback replacement verification failed");

  const manifest = {
    chainId: CHAIN_ID,
    owner,
    guardian,
    distributor,
    oldBuybackVault: getAddress(oldBuybackVault),
    buybackVault: vault,
    buybackSwapAdapter: adapter,
    ponsV2Factory: PONS_V2_FACTORY,
    scopl,
    keeper,
    keeperRewardWei: keeperReward.toString(),
    transactions,
    deployedAt: new Date().toISOString()
  };
  fs.mkdirSync(path.join(process.cwd(), "deployments"), { recursive: true });
  const filename = path.join(process.cwd(), "deployments", "pons-buyback-4663.json");
  fs.writeFileSync(filename, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log({
    SCOPL_BUYBACK_VAULT_ADDRESS: vault,
    SCOPL_BUYBACK_SWAP_ADAPTER_ADDRESS: adapter,
    manifest: filename
  });
  console.log(
    `Revenue now targets the new vault. Pause ${oldBuybackVault} and recover each accumulated asset into ${vault} before retiring it.`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
