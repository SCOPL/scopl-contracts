import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import solc from "solc";
import { describe, expect, it } from "vitest";

function compileZap() {
  const source = readFileSync(
    resolve(process.cwd(), "contracts/ScoplZapRouter.sol"),
    "utf8"
  );
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources: { "ScoplZapRouter.sol": { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      outputSelection: {
        "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] }
      }
    }
  }))) as {
    contracts?: Record<string, Record<string, {
      abi: Array<{
        type: string;
        name?: string;
        stateMutability?: string;
      }>;
      evm: { bytecode: { object: string }; deployedBytecode: { object: string } };
    }>>;
    errors?: Array<{ severity: string; formattedMessage: string }>;
  };
  expect((output.errors ?? []).filter((item) => item.severity === "error"))
    .toEqual([]);
  return output.contracts?.["ScoplZapRouter.sol"]?.ScoplZapRouter;
}

describe("ScoplZapRouter", () => {
  it("compiles below EVM code-size limits", () => {
    const contract = compileZap();
    expect(contract).toBeDefined();
    expect((contract?.evm.deployedBytecode.object.length ?? 0) / 2)
      .toBeLessThan(24_576);
    expect((contract?.evm.bytecode.object.length ?? 0) / 2)
      .toBeLessThan(49_152);
  });

  it("exposes typed v3 and v4 zap entrypoints without generic execution", () => {
    const contract = compileZap();
    const functions = new Set(contract?.abi
      .filter((entry) => entry.type === "function")
      .map((entry) => entry.name));
    expect(functions.has("zapV3")).toBe(true);
    expect(functions.has("zapV4")).toBe(true);
    expect(functions.has("mintV4")).toBe(true);
    expect(functions.has("previewV4Liquidity")).toBe(true);
    expect(functions.has("execute")).toBe(false);
    expect(functions.has("call")).toBe(false);
  });

  it("accepts transaction value only through the typed V4 entrypoints", () => {
    const contract = compileZap();
    const zapV3 = contract?.abi.find((entry) => entry.name === "zapV3");
    const zapV4 = contract?.abi.find((entry) => entry.name === "zapV4");
    const mintV4 = contract?.abi.find((entry) => entry.name === "mintV4");
    expect(zapV3?.stateMutability).toBe("nonpayable");
    expect(zapV4?.stateMutability).toBe("payable");
    expect(mintV4?.stateMutability).toBe("payable");
  });

  it("does not request Permit2 approval for an empty side of a v4 mint", () => {
    const source = readFileSync(
      resolve(process.cwd(), "contracts/ScoplZapRouter.sol"),
      "utf8"
    );
    expect(source).toContain(
      "if (amount0Max > 0 && key.currency0 != address(0))"
    );
    expect(source).toContain(
      "if (amount1Max > 0 && key.currency1 != address(0))"
    );
  });

  it("sweeps unused native V4 mint value back before refunding the caller", () => {
    const source = readFileSync(
      resolve(process.cwd(), "contracts/ScoplZapRouter.sol"),
      "utf8"
    );
    expect(source).toContain('if (nativePool) actions = hex"020d14"');
    expect(source).toContain(
      "actionParams[2] = abi.encode(address(0), address(this))"
    );
  });

  it("mints the execution-time maximum and enforces a separate minimum", () => {
    const source = readFileSync(
      resolve(process.cwd(), "contracts/ScoplZapRouter.sol"),
      "utf8"
    );
    expect(source).toContain("_maximumV4Liquidity(");
    expect(source).toContain(
      "revert MinimumLiquidityNotMet(liquidity, minimumLiquidity)"
    );
  });

  it("bounds the live V4 execution price before minting", () => {
    const source = readFileSync(
      resolve(process.cwd(), "contracts/ScoplZapRouter.sol"),
      "utf8"
    );
    expect(source).toContain("uint160 minimumSqrtPriceX96");
    expect(source).toContain("uint160 maximumSqrtPriceX96");
    expect(source).toContain("revert SqrtPriceOutOfBounds(");
  });
});
