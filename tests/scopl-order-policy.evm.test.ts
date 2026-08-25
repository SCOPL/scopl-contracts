// @vitest-environment node

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import solc from "solc";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Abi,
  type Address,
  type Hex
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

interface Artifact { abi: Abi; bytecode: Hex }
interface ResolvedPolicy {
  source: number;
  integrationId: Hex;
  beneficiary: Address;
  beneficiaryShareBps: number;
  integratorFeeRecipient: Address;
  integratorShareBps: number;
  protocolShareBps: number;
  referrer: Address;
}
type IntegrationConfig = readonly [Address, Address, number];
const MNEMONIC = "test test test test test test test test test test test junk";
const chain = defineChain({
  id: 1_341,
  name: "SCOPL order policy tests",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1"] } }
});
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const ZERO_HASH: Hex = `0x${"00".repeat(32)}`;
const REGISTRATION_KEY: Hex = `0x${"42".repeat(32)}`;
const SCOPL_UNIT = 10n ** 18n;
const thresholds = [
  50_000n * SCOPL_UNIT,
  250_000n * SCOPL_UNIT,
  1_000_000n * SCOPL_UNIT
] as const;
const shares = [1_000, 2_500, 5_000, 7_500] as const;

function compile(): Record<string, Artifact> {
  const files = [
    "ScoplOrderPolicy.sol",
    "ScoplReferralRewards.sol",
    "test/ScoplLimitOrderManagerMocks.sol",
    "test/ScoplOrderPolicyMocks.sol"
  ];
  const sources = Object.fromEntries(files.map((file) => [file, {
    content: readFileSync(resolve(process.cwd(), "contracts", file), "utf8")
  }]));
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } }
    }
  }))) as {
    contracts?: Record<string, Record<string, { abi: Abi; evm: { bytecode: { object: string } } }>>;
    errors?: Array<{ severity: string; formattedMessage: string }>;
  };
  expect((output.errors ?? []).filter((item) => item.severity === "error")
    .map((item) => item.formattedMessage)).toEqual([]);
  const result: Record<string, Artifact> = {};
  for (const group of Object.values(output.contracts ?? {})) {
    for (const [name, contract] of Object.entries(group)) {
      result[name] = { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` };
    }
  }
  return result;
}

const artifacts = compile();

describe.sequential("ScoplOrderPolicy EVM behavior", () => {
  let anvil: ChildProcess;
  let rpcUrl: string;
  let publicClient: ReturnType<typeof createPublicClient>;
  let wallets: Array<ReturnType<typeof createWalletClient>>;
  let addresses: Address[];
  let token: Address;
  let referrals: Address;
  let caller: Address;
  let canonicalPolicy: Address;
  let remotePolicy: Address;
  let integrationId: Hex;
  let snapshot: string;

  async function rpc(method: string, params: unknown[] = []) {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    const body = await response.json() as { result?: unknown; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result;
  }

  async function deploy(name: string, args: readonly unknown[] = []) {
    const hash = await wallets[0].deployContract({
      abi: artifacts[name].abi,
      bytecode: artifacts[name].bytecode,
      args
    } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error(`${name} deployment failed`);
    return receipt.contractAddress;
  }

  async function write(
    name: string,
    address: Address,
    functionName: string,
    args: readonly unknown[] = [],
    accountIndex = 0
  ) {
    const hash = await wallets[accountIndex].writeContract({
      address,
      abi: artifacts[name].abi,
      functionName,
      args
    } as never);
    return publicClient.waitForTransactionReceipt({ hash });
  }

  async function read<T>(name: string, address: Address, functionName: string, args: readonly unknown[] = []) {
    return publicClient.readContract({
      address,
      abi: artifacts[name].abi,
      functionName,
      args
    }) as Promise<T>;
  }

  function emptyAttestation(user = ZERO) {
    return { user, destinationChainId: 0n, beneficiaryShareBps: 0, expiry: 0 };
  }

  async function resolvePolicy(
    policy: Address,
    user: Address,
    integrationId: Hex = ZERO_HASH,
    optionalReferrer: Address = ZERO,
    attestation = emptyAttestation(),
    signature: Hex = "0x"
  ) {
    await write("ScoplOrderPolicyCaller", caller, "resolve", [
      policy, user, integrationId, optionalReferrer, attestation, signature
    ]);
    return read<ResolvedPolicy>(
      "ScoplOrderPolicyCaller",
      caller,
      "resolve",
      [policy, user, integrationId, optionalReferrer, attestation, signature]
    );
  }

  beforeAll(async () => {
    const port = 27_000 + process.pid % 1_000;
    rpcUrl = `http://127.0.0.1:${port}`;
    anvil = spawn(process.execPath, [
      resolve(process.cwd(), "node_modules/@foundry-rs/anvil/bin.mjs"),
      "--port", String(port), "--chain-id", String(chain.id),
      "--mnemonic", MNEMONIC, "--silent"
    ], { stdio: "ignore", windowsHide: true });
    for (let attempt = 0; attempt < 50; attempt++) {
      try { await rpc("eth_chainId"); break; } catch {
        await new Promise((done) => setTimeout(done, 100));
      }
    }
    const transport = http(rpcUrl);
    publicClient = createPublicClient({ chain, transport });
    wallets = Array.from({ length: 6 }, (_, index) => createWalletClient({
      account: mnemonicToAccount(MNEMONIC, { addressIndex: index }), chain, transport
    }));
    addresses = wallets.map((wallet) => wallet.account!.address);
    token = await deploy("LimitOrderMockERC20", ["SCOPL", "SCOPL", 18]);
    referrals = await deploy("ScoplReferralRewards", [addresses[0]]);
    caller = await deploy("ScoplOrderPolicyCaller");
    canonicalPolicy = await deploy("ScoplOrderPolicy", [
      addresses[0], token, BigInt(chain.id), referrals, addresses[2], thresholds, shares
    ]);
    remotePolicy = await deploy("ScoplOrderPolicy", [
      addresses[0], addresses[5], 4_663n, referrals, addresses[2], thresholds, shares
    ]);
    for (const policy of [canonicalPolicy, remotePolicy]) {
      await write("ScoplOrderPolicy", policy, "setManager", [caller, true]);
      await write("ScoplReferralRewards", referrals, "setReferralBinderAllowed", [policy, true]);
    }
    await write("ScoplOrderPolicy", canonicalPolicy, "registerIntegration", [
      REGISTRATION_KEY, addresses[4], 2_500
    ], 3);
    integrationId = await read<Hex>(
      "ScoplOrderPolicy", canonicalPolicy, "integrationIdFor", [addresses[3], REGISTRATION_KEY]
    );
    snapshot = await rpc("evm_snapshot") as string;
  }, 60_000);

  beforeEach(async () => {
    await rpc("evm_revert", [snapshot]);
    snapshot = await rpc("evm_snapshot") as string;
  });

  afterAll(() => anvil?.kill("SIGTERM"));

  it.each([
    [0n, 1_000],
    [50_000n * SCOPL_UNIT - 1n, 1_000],
    [50_000n * SCOPL_UNIT, 2_500],
    [250_000n * SCOPL_UNIT - 1n, 2_500],
    [250_000n * SCOPL_UNIT, 5_000],
    [1_000_000n * SCOPL_UNIT - 1n, 5_000],
    [1_000_000n * SCOPL_UNIT, 7_500],
    [1_000_001n * SCOPL_UNIT, 7_500]
  ])("maps balance %s to beneficiary share %s", async (balance, expected) => {
    expect(await read<number>(
      "ScoplOrderPolicy", canonicalPolicy, "beneficiaryShareForBalance", [balance]
    )).toBe(expected);
  });

  it("uses the canonical balance and binds a direct referrer atomically", async () => {
    await write("LimitOrderMockERC20", token, "mint", [addresses[1], 250_000n * SCOPL_UNIT]);
    await resolvePolicy(canonicalPolicy, addresses[1], ZERO_HASH, addresses[3]);
    expect(await read<Address>(
      "ScoplReferralRewards", referrals, "referrerOf", [addresses[1]]
    )).toBe(addresses[3]);
    const resolved = await read<ResolvedPolicy>(
      "ScoplOrderPolicyCaller", caller, "resolve",
      [canonicalPolicy, addresses[1], ZERO_HASH, addresses[4], emptyAttestation(), "0x"]
    );
    expect(resolved).toEqual({
      source: 0,
      integrationId: ZERO_HASH,
      beneficiary: addresses[1],
      beneficiaryShareBps: 5_000,
      integratorFeeRecipient: ZERO,
      integratorShareBps: 0,
      protocolShareBps: 5_000,
      referrer: addresses[3]
    });
    const replacement = await resolvePolicy(
      canonicalPolicy, addresses[1], ZERO_HASH, addresses[4]
    );
    expect(replacement.referrer).toBe(addresses[3]);
  });

  it("ignores invalid optional referral data without blocking an order", async () => {
    await write("ScoplReferralRewards", referrals, "setReferrerApprovalRequired", [true]);
    const resolved = await read<ResolvedPolicy>(
      "ScoplOrderPolicyCaller", caller, "resolve",
      [canonicalPolicy, addresses[1], ZERO_HASH, addresses[3], emptyAttestation(), "0x"]
    );
    expect(resolved.referrer).toBe(ZERO);
  });

  it("ignores a self-referral without blocking an order", async () => {
    const resolved = await resolvePolicy(
      canonicalPolicy, addresses[1], ZERO_HASH, addresses[1]
    );
    expect(resolved.referrer).toBe(ZERO);
  });

  it("uses the registered integration split and bypasses tier/referral input", async () => {
    await write("LimitOrderMockERC20", token, "mint", [addresses[1], 2_000_000n * SCOPL_UNIT]);
    await write("LimitOrderMockERC20", token, "mint", [addresses[4], 2_000_000n * SCOPL_UNIT]);
    await resolvePolicy(canonicalPolicy, addresses[1], ZERO_HASH, addresses[3]);
    expect(await read<Address>(
      "ScoplReferralRewards", referrals, "referrerOf", [addresses[1]]
    )).toBe(addresses[3]);
    const resolved = await read<ResolvedPolicy>(
      "ScoplOrderPolicyCaller", caller, "resolve",
      [canonicalPolicy, addresses[1], integrationId, addresses[3], {
        user: addresses[5], destinationChainId: 999n, beneficiaryShareBps: 123, expiry: 1
      }, "0x1234"]
    );
    expect(resolved).toEqual({
      source: 1,
      integrationId,
      beneficiary: addresses[1],
      beneficiaryShareBps: 2_500,
      integratorFeeRecipient: addresses[4],
      integratorShareBps: 5_000,
      protocolShareBps: 2_500,
      referrer: ZERO
    });
    await expect(resolvePolicy(canonicalPolicy, addresses[1], `0x${"99".repeat(32)}`))
      .rejects.toThrow();
  });

  it("lets independent developers register non-colliding integrations without approval", async () => {
    const keyA = `0x${"11".repeat(32)}`;
    const keyB = `0x${"22".repeat(32)}`;
    await write("ScoplOrderPolicy", canonicalPolicy, "registerIntegration", [
      keyA, addresses[4], 0
    ], 1);
    await write("ScoplOrderPolicy", canonicalPolicy, "registerIntegration", [
      keyB, addresses[5], 7_500
    ], 2);
    const idA = await read<Hex>(
      "ScoplOrderPolicy", canonicalPolicy, "integrationIdFor", [addresses[1], keyA]
    );
    const idB = await read<Hex>(
      "ScoplOrderPolicy", canonicalPolicy, "integrationIdFor", [addresses[2], keyB]
    );
    expect(idA).not.toBe(idB);
    expect(await read<IntegrationConfig>(
      "ScoplOrderPolicy", canonicalPolicy, "integrations", [idA]
    )).toEqual([addresses[1], addresses[4], 0]);
    expect(await read<IntegrationConfig>(
      "ScoplOrderPolicy", canonicalPolicy, "integrations", [idB]
    )).toEqual([addresses[2], addresses[5], 7_500]);
    await expect(write("ScoplOrderPolicy", canonicalPolicy, "registerIntegration", [
      `0x${"33".repeat(32)}`, addresses[4], 7_501
    ], 1)).rejects.toThrow();
  });

  it("uses the same deterministic logical ID across chain-local registries", async () => {
    await write("ScoplOrderPolicy", remotePolicy, "registerIntegration", [
      REGISTRATION_KEY, addresses[4], 2_500
    ], 3);
    expect(await read<Hex>(
      "ScoplOrderPolicy", remotePolicy, "integrationIdFor", [addresses[3], REGISTRATION_KEY]
    )).toBe(integrationId);
  });

  it("restricts updates to the integration owner and supports two-step ownership transfer", async () => {
    await expect(write("ScoplOrderPolicy", canonicalPolicy, "updateIntegration", [
      integrationId, addresses[5], 5_000
    ], 1)).rejects.toThrow();
    await write("ScoplOrderPolicy", canonicalPolicy, "updateIntegration", [
      integrationId, addresses[5], 5_000
    ], 3);
    expect(await read<IntegrationConfig>(
      "ScoplOrderPolicy", canonicalPolicy, "integrations", [integrationId]
    )).toEqual([addresses[3], addresses[5], 5_000]);
    await write("ScoplOrderPolicy", canonicalPolicy, "transferIntegrationOwnership", [
      integrationId, addresses[2]
    ], 3);
    await expect(write("ScoplOrderPolicy", canonicalPolicy, "acceptIntegrationOwnership", [
      integrationId
    ], 1)).rejects.toThrow();
    await write("ScoplOrderPolicy", canonicalPolicy, "acceptIntegrationOwnership", [
      integrationId
    ], 2);
    await write("ScoplOrderPolicy", canonicalPolicy, "updateIntegration", [
      integrationId, addresses[4], 7_500
    ], 2);
    await expect(write("ScoplOrderPolicy", canonicalPolicy, "updateIntegration", [
      integrationId, addresses[4], 0
    ], 3)).rejects.toThrow();
  });

  it("fails open to the lowest remote tier only when no attestation is supplied", async () => {
    const missing = await read<ResolvedPolicy>(
      "ScoplOrderPolicyCaller", caller, "resolve",
      [remotePolicy, addresses[1], ZERO_HASH, ZERO, emptyAttestation(), "0x"]
    );
    expect(missing.beneficiaryShareBps).toBe(1_000);
    await write("ScoplOrderPolicy", remotePolicy, "setTierSigner", [ZERO]);
    await expect(resolvePolicy(
      remotePolicy, addresses[1], ZERO_HASH, ZERO,
      { user: addresses[1], destinationChainId: BigInt(chain.id), beneficiaryShareBps: 2_500, expiry: 4_000_000_000 },
      `0x${"11".repeat(65)}`
    )).rejects.toThrow();
  });

  it("accepts only an unexpired EIP-712 attestation for this user and destination", async () => {
    const expiry = 4_000_000_000;
    const attestation = {
      user: addresses[1], destinationChainId: BigInt(chain.id),
      beneficiaryShareBps: 5_000, expiry
    };
    const account = mnemonicToAccount(MNEMONIC, { addressIndex: 2 });
    const signature = await account.signTypedData({
      domain: {
        name: "SCOPL Order Policy", version: "2", chainId: chain.id,
        verifyingContract: remotePolicy
      },
      types: {
        TierAttestation: [
          { name: "user", type: "address" },
          { name: "destinationChainId", type: "uint256" },
          { name: "beneficiaryShareBps", type: "uint16" },
          { name: "expiry", type: "uint48" }
        ]
      },
      primaryType: "TierAttestation",
      message: attestation
    });
    const resolved = await read<ResolvedPolicy>(
      "ScoplOrderPolicyCaller", caller, "resolve",
      [remotePolicy, addresses[1], ZERO_HASH, ZERO, attestation, signature]
    );
    expect(resolved.beneficiaryShareBps).toBe(5_000);
    const reused = await read<ResolvedPolicy>(
      "ScoplOrderPolicyCaller", caller, "resolve",
      [remotePolicy, addresses[1], ZERO_HASH, ZERO, attestation, signature]
    );
    expect(reused.beneficiaryShareBps).toBe(5_000);
    await expect(resolvePolicy(
      remotePolicy, addresses[3], ZERO_HASH, ZERO, attestation, signature
    )).rejects.toThrow();
    await expect(resolvePolicy(
      remotePolicy, addresses[1], ZERO_HASH, ZERO,
      { ...attestation, destinationChainId: 4_663n }, signature
    )).rejects.toThrow();

    const wrongSigner = mnemonicToAccount(MNEMONIC, { addressIndex: 3 });
    const wrongSignature = await wrongSigner.signTypedData({
      domain: {
        name: "SCOPL Order Policy", version: "2", chainId: chain.id,
        verifyingContract: remotePolicy
      },
      types: {
        TierAttestation: [
          { name: "user", type: "address" },
          { name: "destinationChainId", type: "uint256" },
          { name: "beneficiaryShareBps", type: "uint16" },
          { name: "expiry", type: "uint48" }
        ]
      },
      primaryType: "TierAttestation",
      message: attestation
    });
    await expect(resolvePolicy(
      remotePolicy, addresses[1], ZERO_HASH, ZERO, attestation, wrongSignature
    )).rejects.toThrow();

    for (const invalid of [
      { ...attestation, beneficiaryShareBps: 4_000 },
      { ...attestation, beneficiaryShareBps: 7_501 },
      { ...attestation, expiry: 1 }
    ]) {
      const invalidSignature = await account.signTypedData({
        domain: {
          name: "SCOPL Order Policy", version: "2", chainId: chain.id,
          verifyingContract: remotePolicy
        },
        types: {
          TierAttestation: [
            { name: "user", type: "address" },
            { name: "destinationChainId", type: "uint256" },
            { name: "beneficiaryShareBps", type: "uint16" },
            { name: "expiry", type: "uint48" }
          ]
        },
        primaryType: "TierAttestation",
        message: invalid
      });
      await expect(resolvePolicy(
        remotePolicy, addresses[1], ZERO_HASH, ZERO, invalid, invalidSignature
      )).rejects.toThrow();
    }
  });

  it("hardcodes the final tiers and rejects any other deployment schedule", async () => {
    expect(await read<readonly [readonly bigint[], readonly number[]]>(
      "ScoplOrderPolicy", canonicalPolicy, "tierConfiguration"
    )).toEqual([thresholds, shares]);
    expect(artifacts.ScoplOrderPolicy.abi.some((entry) =>
      entry.type === "function" && "name" in entry && entry.name === "setTierConfiguration"
    )).toBe(false);
    await expect(deploy("ScoplOrderPolicy", [
      addresses[0], token, BigInt(chain.id), referrals, addresses[2],
      thresholds, [1_000, 2_500, 5_000, 7_499]
    ])).rejects.toThrow();
  });
});
