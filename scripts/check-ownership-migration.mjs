import {
  resolveFinalProductionTargets,
  verifyFinalProductionRelationships,
  verifyOwnershipPhase,
  verifySafe
} from "./ownership-migration-common.mjs";

const phaseArg = process.argv.find((arg) => arg.startsWith("--phase="));
const phase = phaseArg?.slice("--phase=".length) || "before";

async function main() {
  const resolved = resolveFinalProductionTargets();
  const [safe, roles] = await Promise.all([
    verifySafe(),
    verifyFinalProductionRelationships(resolved)
  ]);
  const ownership = await verifyOwnershipPhase(resolved.targets, phase);
  console.log(JSON.stringify({
    chainId: 4663,
    phase,
    safe,
    contracts: ownership.states,
    immutableAdapter: {
      address: resolved.adapter,
      controller: resolved.targets.find((target) => target.name === "BuybackVault").address
    },
    otherRoles: roles
  }, null, 2));
  console.log(`Ownership migration ${phase} verification passed. Nothing was broadcast.`);
}

main().catch((error) => {
  console.error(`OWNERSHIP MIGRATION CHECK FAILED: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
