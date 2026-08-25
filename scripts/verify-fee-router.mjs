import fs from "node:fs";
import path from "node:path";
import solc from "solc";
import {
  encodeAbiParameters,
  getAddress,
  parseAbiParameters
} from "viem";

const CHAIN_ID = 4_663;
const EXPLORER_URL = "https://robinhoodchain.blockscout.com";
const root = process.cwd();
const manifestPath = path.join(
  root,
  "deployments",
  `robinhood-${CHAIN_ID}.json`
);
const standardInputPath = path.join(
  root,
  "contracts",
  "artifacts",
  "ScoplFeeRouter.standard-input.json"
);

function requireFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Required file is missing: ${filePath}`);
  }
  return fs.readFileSync(filePath, "utf8");
}

async function explorerRequest(pathname, options) {
  const response = await fetch(`${EXPLORER_URL}${pathname}`, {
    ...options,
    headers: {
      accept: "application/json",
      ...options?.headers
    }
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

async function submitV2Verification(input) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const form = new FormData();
    form.append("compiler_version", input.compilerVersion);
    form.append("contract_name", "ScoplFeeRouter");
    form.append(
      "files[0]",
      new Blob([input.standardInput], { type: "application/json" }),
      "ScoplFeeRouter.standard-input.json"
    );
    form.append("autodetect_constructor_args", "false");
    form.append("constructor_args", input.constructorArgs);
    form.append("license_type", "mit");
    try {
      await explorerRequest(
        `/api/v2/smart-contracts/${input.address}/verification/via/standard-input`,
        { method: "POST", body: form }
      );
      return;
    } catch (error) {
      if (Number(error?.status) < 500 || attempt === 3) throw error;
      console.warn(`Blockscout submission retry ${attempt}/3`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }
}

async function pollV2Verification(address) {
  for (let attempt = 1; attempt <= 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const result = await verificationStatus(address);
    if (result?.is_verified || result?.is_fully_verified) return result;
    if (attempt % 5 === 0) {
      console.log(`Verification pending (${attempt * 2}s)`);
    }
  }
  throw new Error(
    "Blockscout did not report successful verification within 120 seconds"
  );
}

async function main() {
  const manifest = JSON.parse(requireFile(manifestPath));
  const standardInput = requireFile(standardInputPath);
  const address = getAddress(manifest.address);
  const current = await verificationStatus(address);
  if (current?.is_verified || current?.is_fully_verified) {
    console.log(`Already verified: ${EXPLORER_URL}/address/${address}?tab=contract`);
    return;
  }

  const compilerVersion =
    `v${solc.version().replace(/\.Emscripten\.clang$/, "")}`;
  const constructorArgs = encodeAbiParameters(
    parseAbiParameters("address,address,address,address,address"),
    manifest.constructorArgs
  ).slice(2);
  console.log(`Submitting ${address} with ${compilerVersion}`);
  await submitV2Verification({
    address,
    compilerVersion,
    constructorArgs,
    standardInput
  });
  console.log("Verification request accepted");
  const status = await pollV2Verification(address);
  if (!status?.is_verified && !status?.is_fully_verified) {
    throw new Error(
      "Verification passed, but Blockscout has not indexed the verified metadata"
    );
  }
  console.log(
    `Verified ${status.name ?? "ScoplFeeRouter"}: ` +
    `${EXPLORER_URL}/address/${address}?tab=contract`
  );
  console.log(
    `Compiler ${status.compiler_version ?? compilerVersion}, ` +
    `optimization ${status.optimization_enabled ? "enabled" : "disabled"}`
  );
}

main().catch((error) => {
  console.error(`Verification failed: ${error.message}`);
  process.exitCode = 1;
});
