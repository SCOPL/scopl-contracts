import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import solc from "solc";
import { describe, expect, it } from "vitest";

function compileManager() {
  const source = readFileSync(
    resolve(process.cwd(), "contracts/ScoplV4LimitOrderManager.sol"),
    "utf8"
  );
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources: { "ScoplV4LimitOrderManager.sol": { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      outputSelection: {
        "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] }
      }
    }
  }))) as {
    contracts?: Record<string, Record<string, {
      abi: Array<{ type: string; name?: string }>;
      evm: { bytecode: { object: string }; deployedBytecode: { object: string } };
    }>>;
    errors?: Array<{ severity: string; formattedMessage: string }>;
  };
  expect((output.errors ?? []).filter((item) => item.severity === "error"))
    .toEqual([]);
  return output.contracts?.["ScoplV4LimitOrderManager.sol"]
    ?.ScoplV4LimitOrderManager;
}

describe("ScoplV4LimitOrderManager", () => {
  it("compiles below EVM code-size limits", () => {
    const contract = compileManager();
    expect(contract).toBeDefined();
    expect((contract?.evm.deployedBytecode.object.length ?? 0) / 2)
      .toBeLessThan(24_576);
    expect((contract?.evm.bytecode.object.length ?? 0) / 2)
      .toBeLessThan(49_152);
  });

  it("exposes a v4 pool-key, hook-gated range-order API", () => {
    const contract = compileManager();
    const functions = new Set(contract?.abi
      .filter((entry) => entry.type === "function")
      .map((entry) => entry.name));
    expect([...functions]).toEqual(expect.arrayContaining([
      "createOrder",
      "executeOrder",
      "cancelOrder",
      "markOrderStale",
      "setHookAllowed",
      "setHookPolicy",
      "allowedHooks",
      "allowedHookDataHash",
      "allowedHookCodeHash",
      "orderPoolKeys",
      "getOrderHookData",
      "orderPolicy",
      "orderEconomics",
      "orderFeeGrowthSnapshots",
      "isExecutable",
      "isPositionManageable",
      "getOrderCountByOwner",
      "getOrdersByOwnerPage",
      "setPreferWrappedNative",
      "preferWrappedNative",
      "setExecutionPaused",
      "automaticPayouts"
    ]));
    expect(functions.has("transferNFT")).toBe(false);
    expect(functions.has("call")).toBe(false);
    expect(functions.has("feeBpsFor")).toBe(false);
    expect(functions.has("setFeeSchedule")).toBe(false);
    expect(functions.has("orderFeeModes")).toBe(false);
  });
});
