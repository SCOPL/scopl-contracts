import fs from "node:fs";
import path from "node:path";
import solc from "solc";

const root = process.cwd();
const contractNames = [
  "ScoplFeeRouter",
  "ScoplZapRouter",
  "ScoplReferralRewards",
  "ScoplRevenueDistributor",
  "ScoplRevenueCollector",
  "ScoplBuybackVault",
  "ScoplRouterSwapAdapter",
  "ScoplOrderPolicy",
  "ScoplLimitOrderManager",
  "ScoplV4LimitOrderManager"
];
const sources = Object.fromEntries(contractNames.map((name) => [
  `${name}.sol`,
  { content: fs.readFileSync(path.join(root, "contracts", `${name}.sol`), "utf8") }
]));
const input = {
  language: "Solidity",
  sources,
  settings: {
    viaIR: true,
    optimizer: { enabled: true, runs: 200 },
    outputSelection: {
      "*": {
        "*": [
          "abi",
          "evm.bytecode.object",
          "evm.deployedBytecode.object"
        ]
      }
    }
  }
};
const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors ?? []).filter((item) =>
  item.severity === "error");
if (errors.length > 0) {
  for (const error of errors) console.error(error.formattedMessage);
  process.exit(1);
}
const artifactDir = path.join(root, "contracts", "artifacts");
fs.mkdirSync(artifactDir, { recursive: true });
for (const name of contractNames) {
  const contract = output.contracts[`${name}.sol`][name];
  fs.writeFileSync(
    path.join(artifactDir, `${name}.standard-input.json`),
    JSON.stringify({ ...input, sources: { [`${name}.sol`]: sources[`${name}.sol`] } }, null, 2)
  );
  fs.writeFileSync(
    path.join(artifactDir, `${name}.json`),
    JSON.stringify(contract, null, 2)
  );
  console.log(
    `Compiled ${name} ` +
    `(${contract.evm.bytecode.object.length / 2} init bytes, ` +
    `${contract.evm.deployedBytecode.object.length / 2} runtime bytes)`
  );
}
