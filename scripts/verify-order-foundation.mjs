import fs from "node:fs";
import path from "node:path";
import solc from "solc";
import {
  createPublicClient,
  defineChain,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256
} from "viem";
import { selectFreshRobinhoodRpcUrl } from "./robinhood-rpc.mjs";

const CHAIN_ID = 4_663;
const EXPLORER_URL = "https://robinhoodchain.blockscout.com";
const WETH = getAddress("0x0bd7d308f8e1639fab988df18a8011f41eacad73");
const root = process.cwd();
const checkOnly = process.argv.includes("--check-only");
const verifyV3Only = process.argv.includes("--v3");
const verifyManagers = process.argv.includes("--managers") || verifyV3Only;
const foundationManifestPath = path.join(
  root,
  "deployments",
  "order-foundation-v2-4663.json"
);

function requireJson(filename) {
  if (!fs.existsSync(filename)) throw new Error(`Required file is missing: ${filename}`);
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

function compiledContract(name) {
  const artifactPath = path.join(root, "contracts", "artifacts", `${name}.json`);
  const inputPath = path.join(
    root,
    "contracts",
    "artifacts",
    `${name}.standard-input.json`
  );
  const artifact = requireJson(artifactPath);
  const constructor = artifact.abi?.find((entry) => entry.type === "constructor");
  if (!constructor || !Array.isArray(constructor.inputs)) {
    throw new Error(`${name} constructor ABI is missing`);
  }
  const bytecode = artifact.evm?.bytecode?.object;
  if (!bytecode || !fs.existsSync(inputPath)) {
    throw new Error(`${name} verification artifacts are incomplete`);
  }
  return {
    constructorInputs: constructor.inputs,
    bytecode: `0x${bytecode}`,
    standardInput: fs.readFileSync(inputPath, "utf8")
  };
}

async function explorerRequest(pathname, options) {
  const response = await fetch(`${EXPLORER_URL}${pathname}`, {
    ...options,
    signal: options?.signal ?? AbortSignal.timeout(30_000),
    headers: { accept: "application/json", ...options?.headers }
  });
  const body = await response.text();
  if (!response.ok) {
    const error = new Error(
      `Blockscout returned HTTP ${response.status}: ${body || response.statusText}`
    );
    error.status = response.status;
    throw error;
  }
  return body ? JSON.parse(body) : null;
}

async function verificationStatus(address) {
  return explorerRequest(`/api/v2/smart-contracts/${address}`);
}

async function verificationStatusWithRetry(contract) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await verificationStatus(contract.address);
    } catch (error) {
      if (Number(error?.status) === 404) return null;
      if (Number(error?.status) < 500) throw error;
      lastError = error;
      if (attempt === 5) break;
      console.warn(`${contract.name}: Blockscout status retry ${attempt}/5`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }
  try {
    const addressInfo = await explorerRequest(`/api/v2/addresses/${contract.address}`);
    if (addressInfo?.is_verified) return addressInfo;
    return null;
  } catch {
    throw lastError;
  }
}

async function submit(contract) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const form = new FormData();
    form.append(
      "compiler_version",
      `v${solc.version().replace(/\.Emscripten\.clang$/, "")}`
    );
    form.append("contract_name", contract.name);
    form.append(
      "files[0]",
      new Blob([contract.standardInput], { type: "application/json" }),
      `${contract.name}.standard-input.json`
    );
    form.append("autodetect_constructor_args", "false");
    form.append("constructor_args", contract.constructorArgs.slice(2));
    form.append("license_type", "mit");
    try {
      await explorerRequest(
        `/api/v2/smart-contracts/${contract.address}/verification/via/standard-input`,
        { method: "POST", body: form }
      );
      return;
    } catch (error) {
      if (Number(error?.status) < 500 || attempt === 3) throw error;
      console.warn(`${contract.name}: submission retry ${attempt}/3`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }
}

async function submitLegacyBlockscout(contract) {
  let submission;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const form = new FormData();
    form.append("module", "contract");
    form.append("action", "verifysourcecode");
    form.append("codeformat", "solidity-standard-json-input");
    form.append("contractaddress", contract.address);
    form.append("contractname", `${contract.name}.sol:${contract.name}`);
    form.append(
      "compilerversion",
      `v${solc.version().replace(/\.Emscripten\.clang$/, "")}`
    );
    form.append("sourceCode", contract.standardInput);
    form.append("constructorArguments", contract.constructorArgs.slice(2));
    form.append("autodetectConstructorArguments", "false");
    try {
      submission = await explorerRequest("/api", {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(60_000)
      });
      break;
    } catch (error) {
      if (Number(error?.status) < 500 || attempt === 5) throw error;
      console.warn(`${contract.name}: legacy submission retry ${attempt}/5`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 3_000));
    }
  }
  const result = String(submission?.result ?? "");
  if (submission?.status !== "1") {
    if (/already verified/i.test(result)) return;
    throw new Error(`${contract.name}: legacy Blockscout submission failed: ${result}`);
  }
  console.log(`${contract.name}: legacy Blockscout job ${result}`);
  for (let attempt = 1; attempt <= 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const query = new URLSearchParams({
      module: "contract",
      action: "checkverifystatus",
      guid: result
    });
    const status = await explorerRequest(`/api?${query}`);
    const statusResult = String(status?.result ?? "");
    if (/pass\s*-\s*verified/i.test(statusResult)) return;
    if (!/pending in queue/i.test(statusResult)) {
      throw new Error(
        `${contract.name}: legacy Blockscout verification failed: ${statusResult}`
      );
    }
    if (attempt % 10 === 0) {
      console.log(`${contract.name}: legacy verification pending (${attempt * 2}s)`);
    }
  }
  throw new Error(`${contract.name}: legacy Blockscout verification timed out`);
}

async function poll(contract) {
  for (let attempt = 1; attempt <= 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    let result;
    try {
      result = await verificationStatus(contract.address);
    } catch (error) {
      if (Number(error?.status) === 404) continue;
      if (Number(error?.status) < 500) throw error;
      continue;
    }
    if (result?.is_verified || result?.is_fully_verified) return result;
    if (attempt % 10 === 0) {
      console.log(`${contract.name}: verification pending (${attempt * 2}s)`);
    }
  }
  throw new Error(`${contract.name} verification was not indexed within 120 seconds`);
}

function dependencyAddress(manifest, name) {
  const dependency = manifest.dependencies?.find((entry) => entry.name === name);
  if (!dependency?.address) {
    throw new Error(`${manifest.contract}: ${name} dependency is missing`);
  }
  return getAddress(dependency.address);
}

function foundationDefinitions() {
  const manifest = requireJson(foundationManifestPath);
  if (manifest.status !== "complete" || manifest.chainId !== CHAIN_ID) {
    throw new Error("Order-foundation manifest is not a completed Robinhood deployment");
  }
  const transactionsByAction = new Map(
    manifest.transactions.map((transaction) => [transaction.action, transaction])
  );
  return [
    {
      name: "ScoplReferralRewards",
      address: getAddress(manifest.referralRewards),
      transaction: transactionsByAction.get("deploy ScoplReferralRewards"),
      args: [getAddress(manifest.owner)],
      expectedRuntimeHash: manifest.runtimeCodeHashes.referralRewards
    },
    {
      name: "ScoplRevenueDistributor",
      address: getAddress(manifest.revenueDistributor),
      transaction: transactionsByAction.get("deploy ScoplRevenueDistributor"),
      args: [
        getAddress(manifest.owner),
        getAddress(manifest.guardian),
        WETH,
        getAddress(manifest.referralRewards),
        getAddress(manifest.existingBuybackVault),
        getAddress(manifest.operationalTreasury)
      ],
      expectedRuntimeHash: manifest.runtimeCodeHashes.revenueDistributor
    },
    {
      name: "ScoplOrderPolicy",
      address: getAddress(manifest.orderPolicy),
      transaction: transactionsByAction.get("deploy ScoplOrderPolicy"),
      args: [
        getAddress(manifest.owner),
        getAddress(manifest.canonicalScoplToken),
        BigInt(manifest.chainId),
        getAddress(manifest.referralRewards),
        getAddress(manifest.tierSigner),
        manifest.minimumBalances.map(BigInt),
        manifest.beneficiarySharesBps
      ],
      expectedRuntimeHash: manifest.runtimeCodeHashes.orderPolicy
    }
  ];
}

function managerDefinitions() {
  const v3 = requireJson(path.join(
    root,
    "deployments",
    "limit-orders-v2-4663.json"
  ));
  const manifests = [v3];
  let v4;
  if (!verifyV3Only) {
    v4 = requireJson(path.join(
      root,
      "deployments",
      "v4-limit-orders-v2-4663.json"
    ));
    manifests.push(v4);
  }
  for (const manifest of manifests) {
    if (manifest.chainId !== CHAIN_ID || manifest.contractVersion !== 2) {
      throw new Error(`${manifest.contract}: manifest is not a Robinhood V2 deployment`);
    }
    if (!manifest.transactionHash || !manifest.runtimeCodeHash) {
      throw new Error(`${manifest.contract}: deployment proof is incomplete`);
    }
  }
  const definitions = [
    {
      name: "ScoplLimitOrderManager",
      address: getAddress(v3.address),
      transaction: { hash: v3.transactionHash },
      args: [
        getAddress(v3.owner),
        getAddress(v3.revenueDistributor),
        getAddress(v3.orderPolicy),
        dependencyAddress(v3, "v3 factory"),
        dependencyAddress(v3, "v3 position manager"),
        dependencyAddress(v3, "WETH"),
        BigInt(v3.minGasReserveWei)
      ],
      expectedRuntimeHash: v3.runtimeCodeHash
    }
  ];
  if (v4) definitions.push({
      name: "ScoplV4LimitOrderManager",
      address: getAddress(v4.address),
      transaction: { hash: v4.transactionHash },
      args: [
        getAddress(v4.owner),
        getAddress(v4.revenueDistributor),
        getAddress(v4.orderPolicy),
        dependencyAddress(v4, "v4 position manager"),
        dependencyAddress(v4, "v4 state view"),
        dependencyAddress(v4, "v4 pool manager"),
        dependencyAddress(v4, "Permit2"),
        dependencyAddress(v4, "WETH"),
        BigInt(v4.minGasReserveWei)
      ],
      expectedRuntimeHash: v4.runtimeCodeHash
    });
  return definitions;
}

async function main() {
  const contractDefinitions = verifyManagers
    ? managerDefinitions()
    : foundationDefinitions();
  const rpcUrl = await selectFreshRobinhoodRpcUrl();
  const chain = defineChain({
    id: CHAIN_ID,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } }
  });
  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl, { timeout: 30_000, retryCount: 1 })
  });
  console.log(`RPC: ${rpcUrl}`);

  for (const definition of contractDefinitions) {
    if (!definition.transaction?.hash) {
      throw new Error(`${definition.name} deployment transaction is missing`);
    }
    const compiled = compiledContract(definition.name);
    const constructorArgs = encodeAbiParameters(
      compiled.constructorInputs,
      definition.args
    );
    const expectedCreationInput = `${compiled.bytecode}${constructorArgs.slice(2)}`;
    const [transaction, runtime] = await Promise.all([
      publicClient.getTransaction({ hash: definition.transaction.hash }),
      publicClient.getCode({ address: definition.address })
    ]);
    if (transaction.to !== null) {
      throw new Error(`${definition.name} transaction is not contract creation`);
    }
    if (transaction.input.toLowerCase() !== expectedCreationInput.toLowerCase()) {
      throw new Error(`${definition.name} creation bytecode or constructor args differ`);
    }
    if (!runtime || runtime === "0x" || keccak256(runtime) !== definition.expectedRuntimeHash) {
      throw new Error(`${definition.name} live runtime hash differs from the deployment manifest`);
    }
    definition.constructorArgs = constructorArgs;
    definition.standardInput = compiled.standardInput;
    console.log(`${definition.name}: exact creation input and runtime hash confirmed`);
  }

  for (const contract of contractDefinitions) {
    const current = await verificationStatusWithRetry(contract);
    if (current?.is_verified || current?.is_fully_verified) {
      console.log(`${contract.name}: already verified`);
      continue;
    }
    if (checkOnly) {
      throw new Error(`${contract.name}: Blockscout source verification is missing`);
    }
    console.log(`${contract.name}: submitting ${contract.address}`);
    try {
      await submit(contract);
    } catch (error) {
      const status = Number(error?.status);
      const missingAddress = status === 404 &&
        error.message.includes("Address is not a smart-contract");
      if (!missingAddress && !(status >= 500)) throw error;
      console.warn(`${contract.name}: v2 verification unavailable; trying legacy Blockscout API`);
      try {
        await submitLegacyBlockscout(contract);
        console.log(
          `${contract.name}: verified through legacy Blockscout API — ` +
          `${EXPLORER_URL}/address/${contract.address}?tab=contract`
        );
        continue;
      } catch (legacyError) {
        throw new Error(
          `${contract.name}: both Blockscout verification APIs are blocked; ` +
          legacyError.message
        );
      }
    }
    const verified = await poll(contract);
    console.log(
      `${contract.name}: verified as ${verified?.name ?? contract.name} — ` +
      `${EXPLORER_URL}/address/${contract.address}?tab=contract`
    );
  }
  console.log(
    verifyManagers
      ? verifyV3Only
        ? "The SCOPL V2 V3 order manager is verified on Blockscout."
        : "Both SCOPL V2 order managers are verified on Blockscout."
      : "All SCOPL V2 order-foundation contracts are verified on Blockscout."
  );
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`Verification failed: ${error.message}`);
    process.exit(1);
  }
);
