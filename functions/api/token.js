const DEFAULT_RPC_URLS = [
  "https://bsc-dataseed1.binance.org",
  "https://bsc-dataseed.binance.org",
  "https://bsc.publicnode.com"
];

const DEFAULT_TOKEN_CONTRACT = "0x68fa48b1c2fe52b3d776e1953e0e782b5044ce28";
const DEFAULT_BACKED_DEPLOYER = "0x5F7A4c11bde4f218f0025Ef444c369d838ffa2aD";
const DEFAULT_TOKEN_DEPLOY_BLOCK = 101702130;
const DEFAULT_TOKEN_TABLE = "spcxx_token_metrics";
const DEFAULT_TOKEN_HISTORY_LIMIT = 2000;
const DEFAULT_XSTOCKS_WALLETS = [
  "0x5F7A4c11bde4f218f0025Ef444c369d838ffa2aD",
  "0xdfb7c32e55c43e28e2e1febbfcda1e945f52f3b3",
  "0xdaab44b861f2768a57d49d7344eaf2fed0b1317b",
  "0xbe0f93a8a46f756d9f16d90342c93b872793f90a",
  "0x0a934bc9c64309c9654451f23d8331c2dad34c2a"
];

const NAME_SELECTOR = "0x06fdde03";
const SYMBOL_SELECTOR = "0x95d89b41";
const DECIMALS_SELECTOR = "0x313ce567";
const TOTAL_SUPPLY_SELECTOR = "0x18160ddd";
const BALANCE_OF_SELECTOR = "0x70a08231";
const OWNER_SELECTOR = "0x8da5cb5b";
const MINTER_SELECTOR = "0x07546172";
const BURNER_SELECTOR = "0x27810b6e";
const PAUSER_SELECTOR = "0x9fd0506d";
const IS_PAUSED_SELECTOR = "0xb187bd26";
const EIP_1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const persist = url.searchParams.get("persist") === "1";

  try {
    const token = await readTokenMonitor(context.env, { persist });

    return json(token, 200, {
      "Cache-Control": "no-store"
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown token monitor error",
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

async function readTokenMonitor(env, options = {}) {
  const rpcUrls = parseRpcUrls(env.BSC_RPC_URLS);
  const tokenContract = env.SPCXX_TOKEN_CONTRACT || DEFAULT_TOKEN_CONTRACT;
  const backedDeployer = env.SPCXX_BACKED_DEPLOYER || DEFAULT_BACKED_DEPLOYER;
  const checkedAt = new Date().toISOString();
  const latestStored = isSupabaseConfigured(env) ? await safeReadLatestTokenMetric(env) : { row: undefined };

  const metadataBatch = await rpcBatch(rpcUrls, [
    ethCall(1, tokenContract, NAME_SELECTOR),
    ethCall(2, tokenContract, SYMBOL_SELECTOR),
    ethCall(3, tokenContract, DECIMALS_SELECTOR),
    ethCall(4, tokenContract, TOTAL_SUPPLY_SELECTOR),
    ethCall(5, tokenContract, OWNER_SELECTOR),
    ethCall(6, tokenContract, MINTER_SELECTOR),
    ethCall(7, tokenContract, BURNER_SELECTOR),
    ethCall(8, tokenContract, PAUSER_SELECTOR),
    ethCall(9, tokenContract, IS_PAUSED_SELECTOR),
    {
      jsonrpc: "2.0",
      id: 10,
      method: "eth_blockNumber",
      params: []
    },
    {
      jsonrpc: "2.0",
      id: 11,
      method: "eth_getStorageAt",
      params: [tokenContract, EIP_1967_IMPL_SLOT, "latest"]
    }
  ]);

  const decimals = Number(BigInt(getRpcResult(metadataBatch, 3)));
  const totalSupplyRaw = BigInt(getRpcResult(metadataBatch, 4));
  const permissions = {
    owner: decodeAddressResult(getRpcResult(metadataBatch, 5)),
    minter: decodeAddressResult(getRpcResult(metadataBatch, 6)),
    burner: decodeAddressResult(getRpcResult(metadataBatch, 7)),
    pauser: decodeAddressResult(getRpcResult(metadataBatch, 8)),
    paused: BigInt(getRpcResult(metadataBatch, 9)) !== 0n
  };
  const blockNumber = Number(BigInt(getRpcResult(metadataBatch, 10)));
  const implementationRaw = getRpcResult(metadataBatch, 11);
  const officialWallets = uniqueAddresses([
    ...DEFAULT_XSTOCKS_WALLETS,
    ...parseAddressList(env.SPCXX_OFFICIAL_WALLETS),
    backedDeployer,
    permissions.owner,
    permissions.minter,
    permissions.burner,
    permissions.pauser
  ]);

  const balanceBatch = await rpcBatch(
    rpcUrls,
    officialWallets.map((wallet, index) => ethCall(index + 1, tokenContract, BALANCE_OF_SELECTOR + padAddress(wallet)))
  );
  const officialBalances = officialWallets.map((address, index) => ({
    address,
    balanceRaw: BigInt(getRpcResult(balanceBatch, index + 1))
  }));
  const officialBalanceRaw = officialBalances.reduce((sum, item) => sum + item.balanceRaw, 0n);
  const backedBalanceRaw = officialBalances.find((item) => sameAddress(item.address, backedDeployer))?.balanceRaw || 0n;
  const distributedRaw = totalSupplyRaw > officialBalanceRaw ? totalSupplyRaw - officialBalanceRaw : 0n;
  const shouldFetchHolders = options.persist || !latestStored.row;
  const holderSnapshot = shouldFetchHolders
    ? await safeReadHolderSnapshot(tokenContract, totalSupplyRaw, decimals)
    : {
        holderCount: latestStored.row?.holder_count,
        topHolders: latestStored.row?.top_holders || [],
        source: "supabase_latest",
        error: undefined
      };
  const holderCount = Number(holderSnapshot.holderCount || latestStored.row?.holder_count || 0);
  const topHolders = normalizeTopHolders(holderSnapshot.topHolders || latestStored.row?.top_holders || []);
  const currentPoint = {
    checkedAt,
    blockNumber,
    totalSupply: formatUnits(totalSupplyRaw, decimals),
    totalSupplyRaw: totalSupplyRaw.toString(),
    holderCount,
    backedBalance: formatUnits(backedBalanceRaw, decimals),
    backedBalanceRaw: backedBalanceRaw.toString(),
    officialBalance: formatUnits(officialBalanceRaw, decimals),
    officialBalanceRaw: officialBalanceRaw.toString(),
    distributedSupply: formatUnits(distributedRaw, decimals),
    distributedSupplyRaw: distributedRaw.toString()
  };
  const response = {
    ok: true,
    checkedAt,
    chain: {
      name: env.BSC_CHAIN_NAME || "BNB Smart Chain",
      blockNumber,
      rpcUrl: metadataBatch.rpcUrl
    },
    token: {
      contract: tokenContract,
      name: decodeAbiString(getRpcResult(metadataBatch, 1)) || "SpaceX xStock",
      symbol: decodeAbiString(getRpcResult(metadataBatch, 2)) || "SPCXx",
      decimals,
      deployBlock: readPositiveInteger(env.SPCXX_TOKEN_DEPLOY_BLOCK, DEFAULT_TOKEN_DEPLOY_BLOCK),
      implementation: "0x" + implementationRaw.slice(-40)
    },
    permissions,
    metrics: {
      totalSupply: currentPoint.totalSupply,
      totalSupplyRaw: currentPoint.totalSupplyRaw,
      holderCount,
      backedBalance: currentPoint.backedBalance,
      backedBalanceRaw: currentPoint.backedBalanceRaw,
      officialBalance: currentPoint.officialBalance,
      officialBalanceRaw: currentPoint.officialBalanceRaw,
      distributedSupply: currentPoint.distributedSupply,
      distributedSupplyRaw: currentPoint.distributedSupplyRaw,
      backedDeployer,
      officialWallets: officialBalances.map((item) => ({
        address: item.address,
        balance: formatUnits(item.balanceRaw, decimals),
        balanceRaw: item.balanceRaw.toString()
      })),
      topHolders
    },
    holdersMeta: {
      source: holderSnapshot.source,
      error: holderSnapshot.error
    },
    storage: {
      enabled: isSupabaseConfigured(env),
      table: env.SUPABASE_TOKEN_TABLE || DEFAULT_TOKEN_TABLE,
      stored: false
    },
    history: [],
    historyMeta: {
      source: "current_token_state",
      returnedPoints: 1
    }
  };

  if (isSupabaseConfigured(env) && options.persist) {
    try {
      response.storage.stored = await storeSupabaseTokenMetric(env, response);
    } catch (error) {
      response.storage.error = error instanceof Error ? error.message : "Supabase token storage failed";
    }
  }

  if (isSupabaseConfigured(env)) {
    const historyResult = await safeReadTokenHistory(env);
    response.history = mergeCurrentPoint(historyResult.history, currentPoint, readPositiveInteger(env.TOKEN_HISTORY_POINT_LIMIT, DEFAULT_TOKEN_HISTORY_LIMIT));
    response.historyMeta = {
      source: historyResult.history.length ? "supabase_token_samples" : "current_token_state",
      returnedPoints: response.history.length,
      error: historyResult.error
    };
  } else {
    response.history = [currentPoint];
  }

  return response;
}

async function safeReadHolderSnapshot(tokenContract, totalSupplyRaw, decimals) {
  try {
    return await readBscScanHolderSnapshot(tokenContract, totalSupplyRaw, decimals);
  } catch (error) {
    return {
      holderCount: undefined,
      topHolders: [],
      source: "bscscan_holders",
      error: error instanceof Error ? error.message : "Holder snapshot failed"
    };
  }
}

async function readBscScanHolderSnapshot(tokenContract, totalSupplyRaw, decimals) {
  const tokenUrl = `https://bscscan.com/token/${tokenContract}`;
  const holderUrl = `https://bscscan.com/token/generic-tokenholders2?m=normal&a=${tokenContract}&s=${totalSupplyRaw.toString()}&p=1`;
  const headers = {
    "user-agent": "Mozilla/5.0",
    "accept": "text/html,application/xhtml+xml"
  };
  const [tokenResponse, holderResponse] = await Promise.all([
    fetch(tokenUrl, { headers }),
    fetch(holderUrl, {
      headers: {
        ...headers,
        "x-requested-with": "XMLHttpRequest"
      }
    })
  ]);

  if (!tokenResponse.ok) {
    throw new Error(`BscScan token page returned HTTP ${tokenResponse.status}`);
  }

  if (!holderResponse.ok) {
    throw new Error(`BscScan holder page returned HTTP ${holderResponse.status}`);
  }

  const tokenHtml = await tokenResponse.text();
  const holderHtml = await holderResponse.text();
  const holderCount = parseHolderCount(tokenHtml);
  const topHolders = parseTopHolders(holderHtml, tokenContract, decimals);

  return {
    holderCount: holderCount || topHolders.length,
    topHolders,
    source: "bscscan_holders",
    error: undefined
  };
}

function parseHolderCount(html) {
  const text = stripHtml(html);
  const match = text.match(/Holders\s+([\d,]+)/i);

  if (!match) {
    return undefined;
  }

  return Number(match[1].replace(/,/g, ""));
}

function parseTopHolders(html, tokenContract, decimals) {
  const rows = String(html).match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const holders = [];

  for (const row of rows) {
    const addresses = [...new Set(row.match(/0x[a-fA-F0-9]{40}/g) || [])];
    const holderAddress = addresses.find((address) => !sameAddress(address, tokenContract));

    if (!holderAddress) {
      continue;
    }

    const text = stripHtml(row);
    const numbers = text.match(/[\d,]+(?:\.\d+)?/g) || [];

    if (numbers.length < 3) {
      continue;
    }

    const rank = Number(numbers[0].replace(/,/g, ""));
    const balance = numbers[1].replace(/,/g, "");
    const share = `${numbers[2]}%`;
    const label = text
      .replace(/^\d+\s+/, "")
      .replace(new RegExp(`${numbers[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+${numbers[2].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}%.*$`), "")
      .trim();
    const balanceRaw = parseDecimalUnits(balance, decimals).toString();

    holders.push({
      rank,
      address: normalizeAddress(holderAddress),
      label: label || shortAddress(holderAddress),
      balance,
      balanceRaw,
      share
    });
  }

  return holders;
}

function stripHtml(value) {
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function storeSupabaseTokenMetric(env, response) {
  const table = env.SUPABASE_TOKEN_TABLE || DEFAULT_TOKEN_TABLE;
  const url = `${trimSlash(env.SUPABASE_URL)}/rest/v1/${table}?on_conflict=sample_bucket`;
  const checkedAt = new Date(response.checkedAt);
  const sampleBucket = new Date(Math.floor(checkedAt.getTime() / 60000) * 60000).toISOString();
  const body = {
    sample_bucket: sampleBucket,
    checked_at: response.checkedAt,
    chain: response.chain.name,
    block_number: response.chain.blockNumber,
    token_contract: response.token.contract,
    token_name: response.token.name,
    token_symbol: response.token.symbol,
    decimals: response.token.decimals,
    implementation: response.token.implementation,
    owner_address: response.permissions.owner,
    minter_address: response.permissions.minter,
    burner_address: response.permissions.burner,
    pauser_address: response.permissions.pauser,
    paused: response.permissions.paused,
    total_supply: response.metrics.totalSupply,
    total_supply_raw: response.metrics.totalSupplyRaw,
    holder_count: response.metrics.holderCount,
    backed_deployer: response.metrics.backedDeployer,
    backed_balance: response.metrics.backedBalance,
    backed_balance_raw: response.metrics.backedBalanceRaw,
    official_balance: response.metrics.officialBalance,
    official_balance_raw: response.metrics.officialBalanceRaw,
    distributed_supply: response.metrics.distributedSupply,
    distributed_supply_raw: response.metrics.distributedSupplyRaw,
    top_holders: response.metrics.topHolders,
    rpc_url: response.chain.rpcUrl,
    holder_source: response.holdersMeta.source
  };
  const result = await fetch(url, {
    method: "POST",
    headers: supabaseHeaders(env, {
      Prefer: "resolution=merge-duplicates,return=minimal"
    }),
    body: JSON.stringify(body)
  });

  if (!result.ok) {
    const detail = await result.text();
    throw new Error(`Supabase token insert failed: ${result.status} ${detail}`);
  }

  return true;
}

async function safeReadLatestTokenMetric(env) {
  try {
    return { row: await readLatestTokenMetric(env), error: undefined };
  } catch (error) {
    return {
      row: undefined,
      error: error instanceof Error ? error.message : "Supabase latest token metric read failed"
    };
  }
}

async function readLatestTokenMetric(env) {
  const table = env.SUPABASE_TOKEN_TABLE || DEFAULT_TOKEN_TABLE;
  const params = new URLSearchParams({
    select: "holder_count,top_holders",
    order: "checked_at.desc",
    limit: "1"
  });
  const response = await fetch(`${trimSlash(env.SUPABASE_URL)}/rest/v1/${table}?${params}`, {
    headers: supabaseHeaders(env)
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Supabase latest token metric read failed: ${response.status} ${detail}`);
  }

  const rows = await response.json();
  return rows[0];
}

async function safeReadTokenHistory(env) {
  try {
    return { history: await readTokenHistory(env), error: undefined };
  } catch (error) {
    return {
      history: [],
      error: error instanceof Error ? error.message : "Supabase token history read failed"
    };
  }
}

async function readTokenHistory(env) {
  const table = env.SUPABASE_TOKEN_TABLE || DEFAULT_TOKEN_TABLE;
  const limit = readPositiveInteger(env.TOKEN_HISTORY_LIMIT, DEFAULT_TOKEN_HISTORY_LIMIT);
  const pageSize = 1000;
  const rows = [];

  for (let offset = 0; offset < limit; offset += pageSize) {
    const params = new URLSearchParams({
      select: "checked_at,block_number,total_supply,total_supply_raw,holder_count,backed_balance,backed_balance_raw,official_balance,official_balance_raw,distributed_supply,distributed_supply_raw",
      order: "checked_at.desc",
      limit: String(Math.min(pageSize, limit - offset)),
      offset: String(offset)
    });
    const response = await fetch(`${trimSlash(env.SUPABASE_URL)}/rest/v1/${table}?${params}`, {
      headers: supabaseHeaders(env)
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Supabase token history read failed: ${response.status} ${detail}`);
    }

    const pageRows = await response.json();
    rows.push(...pageRows);

    if (pageRows.length < pageSize) {
      break;
    }
  }

  return rows
    .map((row) => ({
      checkedAt: row.checked_at,
      blockNumber: row.block_number,
      totalSupply: String(row.total_supply),
      totalSupplyRaw: row.total_supply_raw,
      holderCount: row.holder_count || 0,
      backedBalance: String(row.backed_balance),
      backedBalanceRaw: row.backed_balance_raw,
      officialBalance: String(row.official_balance),
      officialBalanceRaw: row.official_balance_raw,
      distributedSupply: String(row.distributed_supply),
      distributedSupplyRaw: row.distributed_supply_raw
    }))
    .reverse();
}

function mergeCurrentPoint(history, currentPoint, limit) {
  const next = history.filter((point) => Number(point.blockNumber) < Number(currentPoint.blockNumber));
  next.push(currentPoint);
  return sampleHistoryPoints(next, limit);
}

function sampleHistoryPoints(points, limit) {
  if (points.length <= limit) {
    return points;
  }

  const result = [points[0]];
  const middleLimit = Math.max(limit - 2, 1);
  const middleCount = points.length - 2;

  for (let bucket = 0; bucket < middleLimit; bucket += 1) {
    const end = 1 + Math.floor(((bucket + 1) * middleCount) / middleLimit);
    const point = points[Math.max(1, end)];
    const last = result.at(-1);

    if (point && point.checkedAt !== last.checkedAt) {
      result.push(point);
    }
  }

  const tail = points.at(-1);

  if (tail && result.at(-1)?.checkedAt !== tail.checkedAt) {
    result.push(tail);
  }

  return result.slice(0, limit);
}

function parseRpcUrls(value, defaults = DEFAULT_RPC_URLS) {
  if (!value) {
    return defaults;
  }

  const urls = value
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);

  return urls.length ? urls : defaults;
}

function parseAddressList(value) {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);
}

function uniqueAddresses(addresses) {
  const seen = new Set();
  const result = [];

  for (const address of addresses) {
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      continue;
    }

    const key = address.toLowerCase();

    if (!seen.has(key)) {
      seen.add(key);
      result.push(normalizeAddress(address));
    }
  }

  return result;
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
  return normalizeAddress(address).replace(/^0x/, "").padStart(64, "0");
}

function decodeAddressResult(hex) {
  if (!hex || hex === "0x") {
    return "";
  }

  return normalizeAddress(`0x${hex.slice(-40)}`);
}

function normalizeAddress(address) {
  const clean = String(address).toLowerCase().replace(/^0x/, "");

  if (!/^[0-9a-f]{40}$/.test(clean)) {
    throw new Error(`Invalid address: ${address}`);
  }

  return `0x${clean}`;
}

function sameAddress(left, right) {
  return String(left).toLowerCase() === String(right).toLowerCase();
}

function shortAddress(address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
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

function parseDecimalUnits(value, decimals) {
  const [whole, fraction = ""] = String(value).replace(/,/g, "").split(".");
  const fractionText = fraction.slice(0, decimals).padEnd(decimals, "0");
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fractionText || "0");
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

function normalizeTopHolders(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return [];
}

function readPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isSupabaseConfigured(env) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

function supabaseHeaders(env, extra = {}) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "content-type": "application/json",
    ...extra
  };
}

function trimSlash(value) {
  return String(value).replace(/\/+$/, "");
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
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "content-type,authorization"
  };
}
