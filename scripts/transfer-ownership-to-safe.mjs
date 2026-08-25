import { createInterface } from "node:readline/promises";
import { createWalletClient, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  SAFE,
  ZERO_ADDRESS,
  chain,
  ownableAbi,
  publicClient,
  resolveFinalProductionTargets,
  simulateTransferOwnership,
  verifyFinalProductionRelationships,
  verifyOwnershipPhase,
  verifySafe,
  walletTransport
} from "./ownership-migration-common.mjs";

const broadcast = process.argv.includes("--broadcast");

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
          reject(new Error("Ownership transfer cancelled"));
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

async function currentState(target) {
  const [owner, pendingOwner] = await Promise.all([
    publicClient.readContract({
      address: target.address,
      abi: ownableAbi,
      functionName: "owner"
    }),
    publicClient.readContract({
      address: target.address,
      abi: ownableAbi,
      functionName: "pendingOwner"
    })
  ]);
  return { owner: getAddress(owner), pendingOwner: getAddress(pendingOwner) };
}

async function main() {
  const resolved = resolveFinalProductionTargets();
  await Promise.all([
    verifySafe(),
    verifyFinalProductionRelationships(resolved)
  ]);
  const { expectedCurrentOwner, states } = await verifyOwnershipPhase(
    resolved.targets,
    "transferable"
  );
  for (const state of states) {
    if (state.pendingOwner === ZERO_ADDRESS) {
      await simulateTransferOwnership(state, expectedCurrentOwner);
    }
  }
  console.log({
    safe: SAFE,
    currentOwner: expectedCurrentOwner,
    transactions: states.map((state) => ({
      contract: state.name,
      to: state.address,
      action: state.pendingOwner === SAFE ? "already pending; skip" : "transferOwnership(address)",
      nextOwner: SAFE
    }))
  });
  if (!broadcast) {
    console.log("Phase-one ownership-transfer preflight passed. Nothing was broadcast.");
    return;
  }

  const supplied = process.env.SCOPL_DEPLOYER_PRIVATE_KEY?.trim();
  const raw = supplied || await promptHidden("Current protocol owner private key (input hidden): ");
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("Private key must contain exactly 32 bytes");
  }
  const account = privateKeyToAccount(key);
  if (account.address !== expectedCurrentOwner) {
    throw new Error(`Wallet ${account.address} is not owner ${expectedCurrentOwner}`);
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(
      `Type "TRANSFER SCOPL OWNERSHIP TO SAFE" to broadcast ${resolved.targets.length} transactions: `
    );
    if (answer.trim() !== "TRANSFER SCOPL OWNERSHIP TO SAFE") {
      throw new Error("Ownership transfer cancelled");
    }
  } finally {
    terminal.close();
  }

  const wallet = createWalletClient({
    account,
    chain,
    transport: walletTransport()
  });
  for (const target of resolved.targets) {
    const before = await currentState(target);
    if (before.owner !== expectedCurrentOwner) {
      throw new Error(`${target.name} owner changed to ${before.owner}`);
    }
    if (before.pendingOwner === SAFE) {
      console.log(`${target.name}: Safe is already pending owner; skipping.`);
      continue;
    }
    if (before.pendingOwner !== ZERO_ADDRESS) {
      throw new Error(`${target.name} has unexpected pending owner ${before.pendingOwner}`);
    }
    const simulation = await simulateTransferOwnership(target, account);
    const hash = await wallet.writeContract(simulation.request);
    console.log(`${target.name}: https://robinhoodchain.blockscout.com/tx/${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 2,
      timeout: 180_000
    });
    if (receipt.status !== "success") throw new Error(`${target.name} transfer failed`);
    const after = await currentState(target);
    if (after.owner !== expectedCurrentOwner || after.pendingOwner !== SAFE) {
      throw new Error(`${target.name} post-transfer verification failed`);
    }
  }
  await verifyOwnershipPhase(resolved.targets, "pending");
  console.log(`All ${resolved.targets.length} contracts now have the Safe as pending owner. The Safe has not accepted yet.`);
}

main().catch((error) => {
  console.error(`OWNERSHIP TRANSFER FAILED: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
