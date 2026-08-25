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
const distributorAbi = parseAbi([
  "function owner() view returns (address)",
  "function revenueSources(address) view returns (uint8 product,bool enabled)",
  "function setRevenueSource(address source,uint8 product,bool enabled)"
]);
const managerAbi = parseAbi([
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
  "function setPaused(bool nextPaused)"
]);
const retiredManagers = [
  {
    version: "V4 August 13 replacement",
    address: getAddress("0x891472F2Fd2fB60c9Cf10DeE515d35070F8ef16d"),
    product: 2
  },
  {
    version: "V3 previous",
    address: getAddress("0xEce07C4719BD506927bB1372124b6dD2278b78bC"),
    product: 1
  },
  {
    version: "V3 original",
    address: getAddress("0x7eAC87dA43C6CcBF54fc9bAD1113a38FFFBbDF41"),
    product: 1
  },
  {
    version: "V4 previous",
    address: getAddress("0x7A47c9Ab0935497Ba1e660f34bf7C4A7bDd8f74c"),
    product: 2
  },
  {
    version: "V4 original",
    address: getAddress("0x149492D98db5eCa77d232990607914aDc3894242"),
    product: 2
  }
];

function configuredAddress(name) {
  const value = process.env[name]?.trim();
  if (!value || !isAddress(value)) throw new Error(`${name} is required`);
  return getAddress(value);
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

async function stateFor(manager, distributor) {
  const [code, managerOwner, paused, source] = await Promise.all([
    publicClient.getCode({ address: manager.address }),
    publicClient.readContract({
      address: manager.address,
      abi: managerAbi,
      functionName: "owner"
    }),
    publicClient.readContract({
      address: manager.address,
      abi: managerAbi,
      functionName: "paused"
    }),
    publicClient.readContract({
      address: distributor,
      abi: distributorAbi,
      functionName: "revenueSources",
      args: [manager.address]
    })
  ]);
  if (!code || code === "0x") throw new Error(`${manager.version} has no bytecode`);
  return {
    ...manager,
    owner: getAddress(managerOwner),
    paused,
    sourceProduct: Number(source[0]),
    sourceEnabled: source[1]
  };
}

async function main() {
  if (await publicClient.getChainId() !== CHAIN_ID) {
    throw new Error(`RPC is not Robinhood Chain ${CHAIN_ID}`);
  }
  const distributor = configuredAddress("SCOPL_REVENUE_DISTRIBUTOR_ADDRESS");
  const activeManagers = new Set([
    configuredAddress("SCOPL_LIMIT_ORDER_MANAGER_ADDRESS"),
    configuredAddress("SCOPL_V4_LIMIT_ORDER_MANAGER_ADDRESS")
  ].map((address) => address.toLowerCase()));
  for (const manager of retiredManagers) {
    if (activeManagers.has(manager.address.toLowerCase())) {
      throw new Error(`${manager.version} is still configured as an active manager`);
    }
  }
  const [ownerValue, ...states] = await Promise.all([
    publicClient.readContract({
      address: distributor,
      abi: distributorAbi,
      functionName: "owner"
    }),
    ...retiredManagers.map((manager) => stateFor(manager, distributor))
  ]);
  const owner = getAddress(ownerValue);
  for (const state of states) {
    if (state.owner !== owner) {
      throw new Error(`${state.version} owner ${state.owner} differs from ${owner}`);
    }
    if (state.sourceEnabled && state.sourceProduct !== state.product) {
      throw new Error(`${state.version} has unexpected revenue product ${state.sourceProduct}`);
    }
    if (!state.paused) {
      await publicClient.simulateContract({
        account: owner,
        address: state.address,
        abi: managerAbi,
        functionName: "setPaused",
        args: [true]
      });
    }
    if (state.sourceEnabled) {
      await publicClient.simulateContract({
        account: owner,
        address: distributor,
        abi: distributorAbi,
        functionName: "setRevenueSource",
        args: [state.address, state.product, false]
      });
    }
  }
  console.log({ distributor, owner, retiredManagers: states });
  const actionCount = states.reduce(
    (count, state) => count + Number(!state.paused) + Number(state.sourceEnabled),
    0
  );
  if (dryRun) {
    console.log(`Retirement preflight passed. ${actionCount} transaction(s) required; nothing was broadcast.`);
    return;
  }
  if (actionCount === 0) {
    console.log("Every historical limit-order manager is already paused and deauthorized.");
    return;
  }
  const raw = process.env.SCOPL_DEPLOYER_PRIVATE_KEY?.trim() ||
    await promptHidden("Revenue owner private key (input hidden): ");
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("Private key must contain exactly 32 bytes");
  }
  const account = privateKeyToAccount(key);
  if (account.address !== owner) throw new Error(`Wallet ${account.address} is not owner ${owner}`);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(
      `Type "RETIRE OLD MANAGERS" to broadcast ${actionCount} transaction(s): `
    );
    if (answer.trim() !== "RETIRE OLD MANAGERS") throw new Error("Retirement cancelled");
  } finally {
    terminal.close();
  }
  const walletClient = createWalletClient({
    account,
    chain,
    transport: robinhoodRpcTransport({ timeout: 30_000 })
  });
  async function send(address, abi, functionName, args = []) {
    const simulation = await publicClient.simulateContract({
      account,
      address,
      abi,
      functionName,
      args
    });
    const hash = await walletClient.writeContract(simulation.request);
    console.log(`${functionName}: https://robinhoodchain.blockscout.com/tx/${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 2,
      timeout: 180_000
    });
    if (receipt.status !== "success") throw new Error(`${functionName} failed`);
  }
  for (const state of states) {
    if (!state.paused) await send(state.address, managerAbi, "setPaused", [true]);
    if (state.sourceEnabled) {
      await send(distributor, distributorAbi, "setRevenueSource", [
        state.address,
        state.product,
        false
      ]);
    }
  }
  const finalStates = await Promise.all(
    retiredManagers.map((manager) => stateFor(manager, distributor))
  );
  if (finalStates.some((state) => !state.paused || state.sourceEnabled)) {
    throw new Error("Historical manager retirement verification failed");
  }
  console.log("Every historical limit-order manager is paused and deauthorized.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
