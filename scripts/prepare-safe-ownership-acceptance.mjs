import fs from "node:fs";
import path from "node:path";
import {
  SAFE,
  resolveFinalProductionTargets,
  simulateAcceptOwnership,
  verifyFinalProductionRelationships,
  verifyOwnershipPhase,
  verifySafe
} from "./ownership-migration-common.mjs";

const writeFile = process.argv.includes("--write");

async function main() {
  const resolved = resolveFinalProductionTargets();
  await Promise.all([
    verifySafe(),
    verifyFinalProductionRelationships(resolved)
  ]);
  await verifyOwnershipPhase(resolved.targets, "pending");
  for (const target of resolved.targets) {
    await simulateAcceptOwnership(target);
  }

  const batch = {
    version: "1.0",
    chainId: "4663",
    createdAt: Date.now(),
    meta: {
      name: "SCOPL Ownable2Step acceptance",
      description: `Safe accepts ownership of the ${resolved.targets.length} SCOPL V2 Robinhood Chain production contracts.`,
      txBuilderVersion: "2.0.1",
      createdFromSafeAddress: SAFE,
      createdFromOwnerAddress: "",
      checksum: ""
    },
    transactions: resolved.targets.map((target) => ({
      to: target.address,
      value: "0",
      contractMethod: {
        inputs: [],
        name: "acceptOwnership",
        payable: false
      },
      contractInputsValues: {}
    }))
  };
  if (writeFile) {
    const output = path.join(
      process.cwd(),
      "deployments",
      "scopl-ownership-acceptance-safe-batch-4663.json"
    );
    fs.writeFileSync(output, `${JSON.stringify(batch, null, 2)}\n`);
    console.log(`Wrote ${output}`);
  } else {
    console.log(JSON.stringify(batch, null, 2));
  }
  console.log("Safe acceptance batch preflight passed. Nothing was broadcast.");
}

main().catch((error) => {
  console.error(`SAFE ACCEPTANCE PREPARATION FAILED: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
