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

function compileRewards() {
  const source = readFileSync(
    resolve(process.cwd(), "contracts/ScoplReferralRewards.sol"),
    "utf8"
  );
  const result = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources: {
      "ScoplReferralRewards.sol": { content: source }
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
  return result.contracts?.["ScoplReferralRewards.sol"]
    ?.ScoplReferralRewards;
}

describe("ScoplReferralRewards", () => {
  it("compiles below EVM code-size limits", () => {
    const contract = compileRewards();
    expect(contract).toBeDefined();
    expect((contract?.evm.deployedBytecode.object.length ?? 0) / 2)
      .toBeLessThan(24_576);
    expect((contract?.evm.bytecode.object.length ?? 0) / 2)
      .toBeLessThan(49_152);
  });

  it("exposes attribution, source accounting, and user claims", () => {
    const contract = compileRewards();
    const functions = new Set(
      contract?.abi
        .filter((entry) => entry.type === "function")
        .map((entry) => entry.name)
    );
    expect([...functions]).toEqual(expect.arrayContaining([
      "bindReferrer",
      "referrerOf",
      "referredCount",
      "creditReward",
      "revenueCreditors",
      "setRevenueCreditorAllowed",
      "claimable",
      "claim",
      "claimAll",
      "getRewardTokens",
      "getRewardTokenCount",
      "getRewardTokensPage",
      "setReferrerApprovalRequired",
      "setReferrerApprovals"
    ]));
    expect(functions.has("previewClaimReward")).toBe(false);
    expect(functions.has("creditLimitOrderReward")).toBe(false);
  });
});
