import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import solc from "solc";
import { describe, expect, it } from "vitest";

function compileManager() {
  const source = readFileSync(
    resolve(process.cwd(), "contracts/ScoplLimitOrderManager.sol"),
    "utf8"
  );
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources: { "ScoplLimitOrderManager.sol": { content: source } },
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
  return output.contracts?.["ScoplLimitOrderManager.sol"]
    ?.ScoplLimitOrderManager;
}

describe("ScoplLimitOrderManager", () => {
  it("compiles below EVM code-size limits", () => {
    const contract = compileManager();
    expect(contract).toBeDefined();
    expect((contract?.evm.deployedBytecode.object.length ?? 0) / 2)
      .toBeLessThan(24_576);
    expect((contract?.evm.bytecode.object.length ?? 0) / 2)
      .toBeLessThan(49_152);
  });

  it("exposes immutable per-order economics without legacy fee modes", () => {
    const contract = compileManager();
    const functions = new Set(contract?.abi
      .filter((entry) => entry.type === "function")
      .map((entry) => entry.name));
    expect([...functions]).toEqual(expect.arrayContaining([
      "createOrder",
      "executeOrder",
      "cancelOrder",
      "markOrderStale",
      "increaseGasReserve",
      "createOrderFromNative",
      "automaticPayouts",
      "activeOrderCount",
      "orderPolicy",
      "orderEconomics",
      "orderFeeGrowthSnapshots",
      "isExecutable",
      "isPositionManageable",
      "getOrdersByOwner",
      "getOrderCountByOwner",
      "getOrdersByOwnerPage",
      "setPreferWrappedNative",
      "preferWrappedNative",
      "setExecutionPaused"
    ]));
    expect(functions.has("transferNFT")).toBe(false);
    expect(functions.has("execute")).toBe(false);
    expect(functions.has("call")).toBe(false);
    expect(functions.has("feeBpsFor")).toBe(false);
    expect(functions.has("setFeeSchedule")).toBe(false);
    expect(functions.has("orderFeeModes")).toBe(false);
  });
});
