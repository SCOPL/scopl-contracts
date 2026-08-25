import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import solc from "solc";
import { describe, expect, it } from "vitest";

interface SolcResult {
  contracts?: Record<string, Record<string, {
    abi: Array<{ type: string; name?: string }>;
    evm: {
      bytecode: { object: string };
      deployedBytecode: { object: string };
    };
  }>>;
  errors?: Array<{ severity: string; formattedMessage: string }>;
}

function compileRouter() {
  const source = readFileSync(
    resolve(process.cwd(), "contracts/ScoplFeeRouter.sol"),
    "utf8"
  );
  const result = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources: {
      "ScoplFeeRouter.sol": { content: source }
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
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
  }))) as SolcResult;
  const failures = (result.errors ?? [])
    .filter((error) => error.severity === "error");
  expect(failures.map((error) => error.formattedMessage)).toEqual([]);
  return result.contracts?.["ScoplFeeRouter.sol"]?.ScoplFeeRouter;
}

describe("ScoplFeeRouter", () => {
  it("compiles below EVM runtime and initcode size limits", () => {
    const contract = compileRouter();
    expect(contract).toBeDefined();
    expect((contract?.evm.deployedBytecode.object.length ?? 0) / 2)
      .toBeLessThan(24_576);
    expect((contract?.evm.bytecode.object.length ?? 0) / 2)
      .toBeLessThan(49_152);
  });

  it("exposes v3/v4 claim, remove, and discount controls", () => {
    const contract = compileRouter();
    const functions = new Set(
      contract?.abi
        .filter((entry) => entry.type === "function")
        .map((entry) => entry.name)
    );
    expect([...functions]).toEqual(expect.arrayContaining([
      "claimV3",
      "claimV4",
      "claimAll",
      "removeV3",
      "removeV4",
      "VERSION",
      "MAX_BATCH_POSITIONS",
      "feeBpsFor",
      "previewFee",
      "setFeeConfiguration",
      "setDiscountTier",
      "setFeeSchedule",
      "setRevenueDistributor",
      "pause",
      "unpause",
      "recoverAsset"
    ]));
    expect(functions.has("activateV3")).toBe(false);
    expect(functions.has("activateV4")).toBe(false);
    expect(functions.has("managedV3")).toBe(false);
    expect(functions.has("managedV4")).toBe(false);
  });
});
