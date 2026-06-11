const DEFAULT_RPC_URLS = [
  "https://bsc-dataseed1.binance.org",
  "https://bsc-dataseed.binance.org",
  "https://bsc.publicnode.com"
];

const CAMPAIGN_CONTRACT = "0xE79feA13F06c919FEda975e418be66c10c8caE32";
const USDC_CONTRACT = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const BALANCE_OF_SELECTOR = "0x70a08231";
const DECIMALS_SELECTOR = "0x313ce567";
const SYMBOL_SELECTOR = "0x95d89b41";
const NAME_SELECTOR = "0x06fdde03";
const PAUSED_SELECTOR = "0x5c975abb";
const EIP_1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

export async function onRequestGet(context) {
  const cache = caches.default;
  const cacheKey = new Request(new URL(context.request.url).origin + "/api/metrics");
  const cached = await cache.match(cacheKey);

  if (cached) {
    return withCors(cached);
  }

  try {
    const metrics = await readMetrics(context.env);
    const response = json(metrics, 200, {
      "Cache-Control": "public, max-age=10, s-maxage=10"
    });
    context.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
        checkedAt: new Date().toISOString()
      },
      502,
      { "Cache-Control": "no-store" }
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

async function readMetrics(env) {
  const campaignContract = env.CAMPAIGN_CONTRACT || CAMPAIGN_CONTRACT;
  const usdcContract = env.USDC_CONTRACT || USDC_CONTRACT;
  const rpcUrls = parseRpcUrls(env.BSC_RPC_URLS);
  const accountData = padAddress(campaignContract);

  const balanceCall = ethCall(1, usdcContract, BALANCE_OF_SELECTOR + accountData);
  const decimalsCall = ethCall(2, usdcContract, DECIMALS_SELECTOR);
  const symbolCall = ethCall(3, usdcContract, SYMBOL_SELECTOR);
  const nameCall = ethCall(4, usdcContract, NAME_SELECTOR);
  const pausedCall = ethCall(5, campaignContract, PAUSED_SELECTOR);
  const implementationCall = {
    jsonrpc: "2.0",
    id: 6,
    method: "eth_getStorageAt",
    params: [campaignContract, EIP_1967_IMPL_SLOT, "latest"]
  };
  const blockCall = {
    jsonrpc: "2.0",
    id: 7,
    method: "eth_blockNumber",
    params: []
  };

  const result = await rpcBatch(rpcUrls, [
    balanceCall,
    decimalsCall,
    symbolCall,
    nameCall,
    pausedCall,
    implementationCall,
    blockCall
  ]);

  const balanceRaw = BigInt(getRpcResult(result, 1));
  const decimals = Number(BigInt(getRpcResult(result, 2)));
  const symbol = decodeAbiString(getRpcResult(result, 3)) || "USDC";
  const name = decodeAbiString(getRpcResult(result, 4)) || "USD Coin";
  const paused = BigInt(getRpcResult(result, 5)) !== 0n;
  const implementationRaw = getRpcResult(result, 6);
  const blockNumber = Number(BigInt(getRpcResult(result, 7)));
  const balance = formatUnits(balanceRaw, decimals);

  return {
    ok: true,
    chain: {
      name: env.BSC_CHAIN_NAME || "BNB Smart Chain",
      blockNumber,
      rpcUrl: result.rpcUrl
    },
    campaign: {
      contract: campaignContract,
      implementation: "0x" + implementationRaw.slice(-40),
      paused
    },
    asset: {
      contract: usdcContract,
      name,
      symbol,
      decimals
    },
    metrics: {
      balanceRaw: balanceRaw.toString(),
      stakedUsdc: balance,
      stakedUsdApprox: balance
    },
    checkedAt: new Date().toISOString()
  };
}

function parseRpcUrls(value) {
  if (!value) {
    return DEFAULT_RPC_URLS;
  }

  const urls = value
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);

  return urls.length ? urls : DEFAULT_RPC_URLS;
}

function ethCall(id, to, data) {
  return {
    jsonrpc: "2.0",
    id,
    method: "eth_call",
    params: [{ to, data }, "latest"]
  };
}

async function rpcBatch(rpcUrls, calls) {
  let lastError;

  for (const rpcUrl of rpcUrls) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 9000);

      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(calls),
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`RPC ${rpcUrl} returned HTTP ${response.status}`);
      }

      const payload = await response.json();

      if (!Array.isArray(payload)) {
        throw new Error(`RPC ${rpcUrl} returned a non-batch response`);
      }

      return Object.assign(payload, { rpcUrl });
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`All BSC RPC endpoints failed: ${lastError?.message || "unknown error"}`);
}

function getRpcResult(batch, id) {
  const item = batch.find((entry) => entry.id === id);

  if (!item) {
    throw new Error(`Missing RPC response for request ${id}`);
  }

  if (item.error) {
    throw new Error(`RPC request ${id} failed: ${item.error.message || "unknown error"}`);
  }

  if (typeof item.result !== "string") {
    throw new Error(`RPC request ${id} returned an invalid result`);
  }

  return item.result;
}

function padAddress(address) {
  const clean = address.toLowerCase().replace(/^0x/, "");

  if (!/^[0-9a-f]{40}$/.test(clean)) {
    throw new Error(`Invalid address: ${address}`);
  }

  return clean.padStart(64, "0");
}

function decodeAbiString(hex) {
  if (!hex || hex === "0x") {
    return "";
  }

  const clean = hex.slice(2);
  const length = Number.parseInt(clean.slice(64, 128), 16);

  if (!Number.isFinite(length) || length <= 0) {
    return "";
  }

  const body = clean.slice(128, 128 + length * 2);
  const bytes = body.match(/.{1,2}/g)?.map((part) => Number.parseInt(part, 16)) || [];
  return new TextDecoder().decode(new Uint8Array(bytes)).replace(/\0+$/, "");
}

function formatUnits(value, decimals) {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = abs % base;
  const fractionText = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${fractionText ? `.${fractionText}` : ""}`;
}

function json(data, status = 200, headers = {}) {
  return withCors(
    new Response(JSON.stringify(data, null, 2), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...headers
      }
    })
  );
}

function withCors(response) {
  const next = new Response(response.body, response);

  for (const [key, value] of Object.entries(corsHeaders())) {
    next.headers.set(key, value);
  }

  return next;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "content-type"
  };
}
