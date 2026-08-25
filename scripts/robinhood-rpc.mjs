import { fallback, http } from "viem";

export const ROBINHOOD_HTTP_RPC_URLS = Object.freeze([
  "https://rpc.mainnet.chain.robinhood.com",
  "https://robinhood-rpc.publicnode.com",
  "https://robinhood-chain.gateway.tenderly.co/",
  "https://robinhood.api.pocket.network",
  "https://lb.routeme.sh/rpc/evm/88",
  "https://robinhood.rpc.blxrbdn.com",
  "https://rpc.nodeflare.app/robinhood/public",
  "https://api.uniblock.dev/uni/v1/json-rpc?chainId=4663",
  "https://robinhood.drpc.org/"
]);

export function robinhoodRpcUrls(env = process.env) {
  const configured = [
    env.ROBINHOOD_RPC_URL?.trim(),
    ...(env.ROBINHOOD_RPC_FALLBACK_URLS ?? "")
      .split(",")
      .map((url) => url.trim())
  ].filter(Boolean);

  return [...new Set([...configured, ...ROBINHOOD_HTTP_RPC_URLS])];
}

export function robinhoodRpcTransport({ timeout = 20_000, rank = true } = {}) {
  return fallback(
    robinhoodRpcUrls().map((url) =>
      http(url, { timeout, retryCount: 0 })
    ),
    {
      rank,
      retryCount: 1,
      retryDelay: 250
    }
  );
}

export function preferredRobinhoodRpcUrl(env = process.env) {
  return robinhoodRpcUrls(env)[0];
}

export async function selectFreshRobinhoodRpcUrl(env = process.env) {
  const checkedAt = Date.now();
  const probes = await Promise.all(robinhoodRpcUrls(env).map(async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const startedAt = performance.now();
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([
          { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
          { jsonrpc: "2.0", id: 2, method: "eth_getBlockByNumber", params: ["latest", false] }
        ]),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (!Array.isArray(payload)) throw new Error("batch JSON-RPC is unsupported");
      const chainResult = payload.find((item) => item?.id === 1)?.result;
      const blockResult = payload.find((item) => item?.id === 2)?.result;
      if (Number.parseInt(chainResult, 16) !== 4_663) throw new Error("wrong chain");
      const blockNumber = Number.parseInt(blockResult?.number, 16);
      const blockTime = Number.parseInt(blockResult?.timestamp, 16) * 1_000;
      if (!Number.isSafeInteger(blockNumber)) throw new Error("invalid block number");
      const blockAge = checkedAt - blockTime;
      if (!Number.isFinite(blockTime) || blockAge > 120_000 || blockAge < -30_000) {
        throw new Error("stale latest block");
      }
      return { url, blockNumber, latency: performance.now() - startedAt };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }));
  const healthy = probes.filter(Boolean);
  const highestBlock = Math.max(...healthy.map((probe) => probe.blockNumber));
  const ranked = healthy
    .filter((probe) => highestBlock - probe.blockNumber <= 5)
    .sort((a, b) => a.latency - b.latency);
  if (!ranked[0]) throw new Error("No fresh Robinhood Chain RPC is available");
  return ranked[0].url;
}

export async function robinhoodRpcRequest(
  method,
  params = [],
  id = 1,
  { timeout = 10_000 } = {}
) {
  const failures = [];
  let emptyCodeResult;
  for (const url of robinhoodRpcUrls()) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (payload.error) throw new Error(payload.error.message);
      // Some third-party Robinhood endpoints intermittently return `0x` for
      // known deployed contracts while healthy providers return the bytecode.
      // Treat an empty code response as provisional and consult every fallback
      // before concluding that an address is undeployed.
      if (method === "eth_getCode" && payload.result === "0x") {
        emptyCodeResult = payload.result;
        failures.push(`${url}: empty runtime code`);
        continue;
      }
      return payload.result;
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  if (method === "eth_getCode" && emptyCodeResult !== undefined) {
    return emptyCodeResult;
  }
  throw new Error(`Every Robinhood RPC failed for ${method}: ${failures.join("; ")}`);
}
