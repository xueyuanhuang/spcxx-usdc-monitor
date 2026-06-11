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
const DEFAULT_SUPABASE_TABLE = "spcxx_usdc_metrics";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const DEFAULT_LOG_RPC_URLS = [
  "https://bsc.publicnode.com",
  "https://bsc-rpc.publicnode.com",
  "https://bsc-dataseed1.binance.org",
  "https://bsc-dataseed.binance.org"
];
const DEFAULT_CAMPAIGN_START_BLOCK = 103507500;
const DEFAULT_LOG_BLOCK_RANGE = 10000;
const DEFAULT_LOG_RANGE_BATCH_SIZE = 6;
const DEFAULT_HISTORY_POINT_LIMIT = 220;
const DEFAULT_TREND_CACHE_SECONDS = 60;
const DEFAULT_TREND_REFRESH_BLOCKS = 240;

let transferTrendCache;

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const persist = url.searchParams.get("persist") === "1";
  const reconstruct = url.searchParams.get("reconstruct") === "1";

  try {
    const metrics = await readMetrics(context.env, {
      persist,
      reconstruct
    });
    const response = json(metrics, 200, {
      "Cache-Control": "no-store"
    });
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

async function readMetrics(env, options = {}) {
  const campaignContract = env.CAMPAIGN_CONTRACT || CAMPAIGN_CONTRACT;
  const usdcContract = env.USDC_CONTRACT || USDC_CONTRACT;
  const rpcUrls = parseRpcUrls(env.BSC_RPC_URLS);
  const logRpcUrls = parseRpcUrls(env.BSC_LOG_RPC_URLS || env.BSC_RPC_URLS, DEFAULT_LOG_RPC_URLS);
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

  const checkedAt = new Date().toISOString();
  const metrics = {
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
      stakedUsdApprox: balance,
      participantAddresses: 0
    },
    storage: {
      enabled: isSupabaseConfigured(env),
      table: env.SUPABASE_TABLE || DEFAULT_SUPABASE_TABLE,
      stored: false
    },
    history: [],
    historyMeta: {
      source: "supabase_samples",
      fromBlock: readPositiveInteger(env.CAMPAIGN_START_BLOCK, DEFAULT_CAMPAIGN_START_BLOCK),
      toBlock: blockNumber,
      pointLimit: readPositiveInteger(env.HISTORY_POINT_LIMIT, DEFAULT_HISTORY_POINT_LIMIT)
    },
    checkedAt
  };
  const currentPoint = {
    checkedAt,
    blockNumber,
    stakedUsdc: balance,
    balanceRaw: balanceRaw.toString(),
    participantCount: 0
  };
  const storedHistoryResult = isSupabaseConfigured(env)
    ? await safeReadSupabaseHistory(env)
    : { history: [], error: undefined };
  const useStoredHistory =
    storedHistoryResult.history.length > 0 && !options.reconstruct && !options.persist;

  if (useStoredHistory) {
    const knownParticipantCount = getKnownParticipantCount(storedHistoryResult.history);
    currentPoint.participantCount = knownParticipantCount;
    metrics.metrics.participantAddresses = knownParticipantCount;
    metrics.history = mergeCurrentPoint(storedHistoryResult.history, currentPoint, metrics.historyMeta.pointLimit);
    metrics.historyMeta = {
      ...metrics.historyMeta,
      source: "supabase_samples",
      returnedPoints: metrics.history.length,
      supabaseError: storedHistoryResult.error
    };
  } else {
    await readTransferHistoryIntoMetrics(metrics, env, {
      campaignContract,
      usdcContract,
      decimals,
      currentBlock: blockNumber,
      currentBalanceRaw: balanceRaw,
      checkedAt,
      rpcUrls: logRpcUrls,
      currentPoint,
      storedHistory: storedHistoryResult.history,
      storedHistoryError: storedHistoryResult.error
    });
  }

  if (isSupabaseConfigured(env)) {
    const shouldPersist = options.persist || env.PERSIST_ON_READ === "true";
    try {
      metrics.storage.stored = shouldPersist ? await storeSupabaseMetric(env, metrics) : false;
    } catch (error) {
      metrics.storage.error = error instanceof Error ? error.message : "Supabase storage failed";
    }
  }

  return metrics;
}

async function readTransferHistoryIntoMetrics(metrics, env, options) {
  try {
    const trend = await readTransferTrend(env, {
      campaignContract: options.campaignContract,
      usdcContract: options.usdcContract,
      decimals: options.decimals,
      currentBlock: options.currentBlock,
      currentBalanceRaw: options.currentBalanceRaw,
      checkedAt: options.checkedAt,
      rpcUrls: options.rpcUrls
    });
    metrics.history = trend.history;
    metrics.metrics.participantAddresses = trend.meta.participantCount;
    metrics.historyMeta = {
      ...metrics.historyMeta,
      ...trend.meta
    };
  } catch (error) {
    const fallbackPoint = options.currentPoint;
    let fallbackHistory = [options.currentPoint];
    let fallbackSource = "current_balance_fallback";

    if (options.storedHistory.length > 0) {
      const knownParticipantCount = getKnownParticipantCount(options.storedHistory);
      fallbackPoint.participantCount = knownParticipantCount;
      fallbackHistory = mergeCurrentPoint(options.storedHistory, fallbackPoint, metrics.historyMeta.pointLimit);
      metrics.metrics.participantAddresses = knownParticipantCount;
      fallbackSource = "supabase_samples_fallback";
    }

    metrics.history = fallbackHistory;
    metrics.historyMeta = {
      ...metrics.historyMeta,
      source: fallbackSource,
      returnedPoints: metrics.history.length,
      error: error instanceof Error ? error.message : "Unknown transfer log error",
      fallbackError: options.storedHistoryError
    };
  }
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

async function readTransferTrend(env, options) {
  const startBlock = readPositiveInteger(env.CAMPAIGN_START_BLOCK, DEFAULT_CAMPAIGN_START_BLOCK);
  const rangeSize = readPositiveInteger(env.LOG_BLOCK_RANGE, DEFAULT_LOG_BLOCK_RANGE);
  const rangeBatchSize = readPositiveInteger(env.LOG_RANGE_BATCH_SIZE, DEFAULT_LOG_RANGE_BATCH_SIZE);
  const pointLimit = readPositiveInteger(env.HISTORY_POINT_LIMIT, DEFAULT_HISTORY_POINT_LIMIT);
  const cacheSeconds = readPositiveInteger(env.TREND_CACHE_SECONDS, DEFAULT_TREND_CACHE_SECONDS);
  const refreshBlocks = readPositiveInteger(env.TREND_REFRESH_BLOCKS, DEFAULT_TREND_REFRESH_BLOCKS);
  const cacheKey = [
    options.campaignContract.toLowerCase(),
    options.usdcContract.toLowerCase(),
    startBlock,
    rangeSize,
    pointLimit
  ].join(":");

  if (
    transferTrendCache?.key === cacheKey &&
    Date.now() - transferTrendCache.cachedAt <= cacheSeconds * 1000 &&
    transferTrendCache.toBlock >= options.currentBlock - refreshBlocks
  ) {
    return {
      history: reconcileLatestPoint(
        transferTrendCache.history,
        options.currentBlock,
        options.currentBalanceRaw,
        options.decimals,
        options.checkedAt,
        pointLimit
      ),
      meta: {
        ...transferTrendCache.meta,
        cached: true,
        toBlock: options.currentBlock
      }
    };
  }

  const logs = await readTransferLogs(options.rpcUrls, {
    usdcContract: options.usdcContract,
    campaignContract: options.campaignContract,
    fromBlock: startBlock,
    toBlock: options.currentBlock,
    rangeSize,
    rangeBatchSize
  });
  const rawPoints = buildTrendPointsFromLogs(logs, {
    campaignContract: options.campaignContract,
    startBlock,
    currentBlock: options.currentBlock,
    currentBalanceRaw: options.currentBalanceRaw
  });
  const sampledPoints = sampleTrendPoints(rawPoints, pointLimit);
  const blockTimes = await readBlockTimestamps(
    options.rpcUrls,
    sampledPoints.map((point) => point.blockNumber)
  );
  const history = sampledPoints.map((point) => {
    const checkedAt = blockTimes.get(point.blockNumber) || options.checkedAt;
    return {
      checkedAt,
      blockNumber: point.blockNumber,
      stakedUsdc: formatUnits(point.balanceRaw, options.decimals),
      balanceRaw: point.balanceRaw.toString(),
      participantCount: point.participantCount
    };
  });
  const reconstructedRaw = rawPoints.at(-1)?.balanceRaw ?? 0n;
  const meta = {
    source: "bsc_usdc_transfer_logs",
    fromBlock: startBlock,
    toBlock: options.currentBlock,
    rawPoints: rawPoints.length,
    returnedPoints: history.length,
    pointLimit,
    logCount: logs.length,
    participantCount: rawPoints.at(-1)?.participantCount || 0,
    reconciled: reconstructedRaw !== options.currentBalanceRaw,
    reconciliationDeltaRaw: (options.currentBalanceRaw - reconstructedRaw).toString(),
    cached: false
  };

  transferTrendCache = {
    key: cacheKey,
    cachedAt: Date.now(),
    toBlock: options.currentBlock,
    history,
    meta
  };

  return { history, meta };
}

async function readTransferLogs(rpcUrls, options) {
  const paddedCampaign = `0x${padAddress(options.campaignContract)}`;
  const logs = [];
  const ranges = [];

  for (let fromBlock = options.fromBlock; fromBlock <= options.toBlock; fromBlock += options.rangeSize) {
    const toBlock = Math.min(fromBlock + options.rangeSize - 1, options.toBlock);
    ranges.push({ fromBlock, toBlock });
  }

  for (let index = 0; index < ranges.length; index += options.rangeBatchSize) {
    const chunk = ranges.slice(index, index + options.rangeBatchSize);
    let requestId = 1;
    const calls = [];
    const ids = [];

    for (const range of chunk) {
      const common = {
        address: options.usdcContract,
        fromBlock: toHexBlock(range.fromBlock),
        toBlock: toHexBlock(range.toBlock)
      };
      const incomingId = requestId;
      const outgoingId = requestId + 1;
      requestId += 2;
      ids.push(incomingId, outgoingId);
      calls.push(
        buildLogCall(incomingId, common, [TRANSFER_TOPIC, null, paddedCampaign]),
        buildLogCall(outgoingId, common, [TRANSFER_TOPIC, paddedCampaign])
      );
    }

    const batch = await rpcBatchWithRequiredIds(rpcUrls, calls, ids);

    for (const id of ids) {
      logs.push(...getRpcLogResult(batch, id));
    }
  }

  return logs.sort(compareLogs);
}

async function rpcBatchWithRequiredIds(rpcUrls, calls, requiredIds) {
  let lastError;

  for (const rpcUrl of rpcUrls) {
    try {
      const batch = await rpcBatch([rpcUrl], calls);
      const returnedIds = new Set(batch.map((entry) => entry.id));
      const missingId = requiredIds.find((id) => !returnedIds.has(id));

      if (missingId) {
        throw new Error(`RPC ${rpcUrl} omitted response id ${missingId}`);
      }

      const failed = batch.find((entry) => requiredIds.includes(entry.id) && entry.error);

      if (failed) {
        throw new Error(`RPC ${rpcUrl} log request ${failed.id} failed: ${failed.error.message || "unknown error"}`);
      }

      return batch;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`All BSC log RPC endpoints failed: ${lastError?.message || "unknown error"}`);
}

function buildLogCall(id, common, topics) {
  return {
    jsonrpc: "2.0",
    id,
    method: "eth_getLogs",
    params: [
      {
        ...common,
        topics
      }
    ]
  };
}

function buildTrendPointsFromLogs(logs, options) {
  const paddedCampaign = `0x${padAddress(options.campaignContract)}`.toLowerCase();
  const zeroTopic = `0x${"0".repeat(64)}`;
  const deltasByBlock = new Map([[options.startBlock, 0n]]);
  const incomingParticipantsByBlock = new Map();

  for (const log of logs) {
    const blockNumber = Number(BigInt(log.blockNumber));
    const to = String(log.topics?.[2] || "").toLowerCase();
    const from = String(log.topics?.[1] || "").toLowerCase();
    const value = BigInt(log.data || "0x0");
    const delta = to === paddedCampaign ? value : from === paddedCampaign ? -value : 0n;

    if (delta === 0n) {
      continue;
    }

    deltasByBlock.set(blockNumber, (deltasByBlock.get(blockNumber) || 0n) + delta);

    if (to === paddedCampaign && from !== zeroTopic && from !== paddedCampaign) {
      const addresses = incomingParticipantsByBlock.get(blockNumber) || new Set();
      addresses.add(from);
      incomingParticipantsByBlock.set(blockNumber, addresses);
    }
  }

  const points = [];
  let running = 0n;
  const participants = new Set();

  const blockNumbers = new Set([...deltasByBlock.keys(), ...incomingParticipantsByBlock.keys()]);

  for (const blockNumber of [...blockNumbers].sort((a, b) => a - b)) {
    running += deltasByBlock.get(blockNumber) || 0n;

    for (const address of incomingParticipantsByBlock.get(blockNumber) || []) {
      participants.add(address);
    }

    points.push({
      blockNumber,
      balanceRaw: running,
      participantCount: participants.size
    });
  }

  const last = points.at(-1);

  if (!last || last.blockNumber < options.currentBlock) {
    points.push({
      blockNumber: options.currentBlock,
      balanceRaw: options.currentBalanceRaw,
      participantCount: last?.participantCount || 0
    });
  } else if (last.blockNumber === options.currentBlock && last.balanceRaw !== options.currentBalanceRaw) {
    last.balanceRaw = options.currentBalanceRaw;
  }

  return points;
}

function sampleTrendPoints(points, limit) {
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

    if (point && point.blockNumber !== last.blockNumber) {
      result.push(point);
    }
  }

  const tail = points.at(-1);

  if (tail && result.at(-1)?.blockNumber !== tail.blockNumber) {
    result.push(tail);
  }

  return result.slice(0, limit);
}

async function readBlockTimestamps(rpcUrls, blockNumbers) {
  const uniqueBlocks = [...new Set(blockNumbers)];
  const timestamps = new Map();
  const chunkSize = 240;

  for (let index = 0; index < uniqueBlocks.length; index += chunkSize) {
    const chunk = uniqueBlocks.slice(index, index + chunkSize);
    const batch = await rpcBatch(
      rpcUrls,
      chunk.map((blockNumber, offset) => ({
        jsonrpc: "2.0",
        id: offset + 1,
        method: "eth_getBlockByNumber",
        params: [toHexBlock(blockNumber), false]
      }))
    );

    for (const entry of batch) {
      if (entry.error) {
        throw new Error(`Block timestamp lookup failed: ${entry.error.message || "unknown error"}`);
      }

      if (!entry.result?.timestamp) {
        throw new Error("Block timestamp lookup returned an invalid block");
      }

      const blockNumber = chunk[entry.id - 1];
      const seconds = Number(BigInt(entry.result.timestamp));
      timestamps.set(blockNumber, new Date(seconds * 1000).toISOString());
    }
  }

  return timestamps;
}

function reconcileLatestPoint(history, currentBlock, currentBalanceRaw, decimals, checkedAt, pointLimit) {
  const next = [...history];
  const currentPoint = {
    checkedAt,
    blockNumber: currentBlock,
    stakedUsdc: formatUnits(currentBalanceRaw, decimals),
    balanceRaw: currentBalanceRaw.toString(),
    participantCount: next.at(-1)?.participantCount || 0
  };

  if (!next.length || next.at(-1).blockNumber < currentBlock) {
    next.push(currentPoint);
  } else if (next.at(-1).blockNumber === currentBlock) {
    next[next.length - 1] = currentPoint;
  }

  while (next.length > pointLimit && next.length > 2) {
    next.splice(1, 1);
  }

  return next;
}

function getRpcLogResult(batch, id) {
  const item = batch.find((entry) => entry.id === id);

  if (!item) {
    throw new Error(`Missing RPC log response for request ${id}`);
  }

  if (item.error) {
    throw new Error(`RPC log request ${id} failed: ${item.error.message || "unknown error"}`);
  }

  if (!Array.isArray(item.result)) {
    throw new Error(`RPC log request ${id} returned an invalid result`);
  }

  return item.result;
}

function compareLogs(left, right) {
  return (
    Number(BigInt(left.blockNumber)) - Number(BigInt(right.blockNumber)) ||
    Number(BigInt(left.transactionIndex || "0x0")) - Number(BigInt(right.transactionIndex || "0x0")) ||
    Number(BigInt(left.logIndex || "0x0")) - Number(BigInt(right.logIndex || "0x0"))
  );
}

function toHexBlock(value) {
  return `0x${Number(value).toString(16)}`;
}

function readPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

function isSupabaseConfigured(env) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

async function storeSupabaseMetric(env, metrics) {
  const table = env.SUPABASE_TABLE || DEFAULT_SUPABASE_TABLE;
  const url = `${trimSlash(env.SUPABASE_URL)}/rest/v1/${table}?on_conflict=sample_bucket`;
  const checkedAt = new Date(metrics.checkedAt);
  const sampleBucket = new Date(Math.floor(checkedAt.getTime() / 60000) * 60000).toISOString();

  const body = {
    sample_bucket: sampleBucket,
    checked_at: metrics.checkedAt,
    chain: metrics.chain.name,
    block_number: metrics.chain.blockNumber,
    campaign_contract: metrics.campaign.contract,
    usdc_contract: metrics.asset.contract,
    implementation: metrics.campaign.implementation,
    paused: metrics.campaign.paused,
    staked_usdc: metrics.metrics.stakedUsdc,
    participant_count: metrics.metrics.participantAddresses,
    balance_raw: metrics.metrics.balanceRaw,
    rpc_url: metrics.chain.rpcUrl
  };

  const response = await fetch(url, {
    method: "POST",
    headers: supabaseHeaders(env, {
      Prefer: "resolution=merge-duplicates,return=minimal"
    }),
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Supabase insert failed: ${response.status} ${detail}`);
  }

  return true;
}

async function readSupabaseHistory(env) {
  const table = env.SUPABASE_TABLE || DEFAULT_SUPABASE_TABLE;
  const params = new URLSearchParams({
    select: "checked_at,block_number,staked_usdc,balance_raw,participant_count",
    order: "checked_at.desc",
    limit: env.HISTORY_LIMIT || "288"
  });
  const url = `${trimSlash(env.SUPABASE_URL)}/rest/v1/${table}?${params}`;

  const response = await fetch(url, {
    headers: supabaseHeaders(env)
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Supabase history read failed: ${response.status} ${detail}`);
  }

  const rows = await response.json();
  let runningParticipantCount = 0;

  return rows
    .map((row) => ({
      checkedAt: row.checked_at,
      blockNumber: row.block_number,
      stakedUsdc: String(row.staked_usdc),
      balanceRaw: row.balance_raw,
      participantCount: row.participant_count || 0
    }))
    .reverse()
    .map((row) => {
      runningParticipantCount = Math.max(runningParticipantCount, Number(row.participantCount || 0));

      return {
        ...row,
        participantCount: runningParticipantCount
      };
    });
}

async function safeReadSupabaseHistory(env) {
  try {
    return {
      history: await readSupabaseHistory(env),
      error: undefined
    };
  } catch (error) {
    return {
      history: [],
      error: error instanceof Error ? error.message : "Supabase history read failed"
    };
  }
}

function getKnownParticipantCount(history) {
  return history.reduce((max, point) => Math.max(max, Number(point.participantCount || 0)), 0);
}

function mergeCurrentPoint(history, currentPoint, limit) {
  const participantCount = Math.max(getKnownParticipantCount(history), Number(currentPoint.participantCount || 0));
  const next = history
    .filter((point) => Number(point.blockNumber) < Number(currentPoint.blockNumber))
    .map((point) => ({
      ...point,
      participantCount: Math.max(Number(point.participantCount || 0), 0)
    }));

  next.push({
    ...currentPoint,
    participantCount
  });

  while (next.length > limit && next.length > 2) {
    next.shift();
  }

  return next;
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
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "content-type"
  };
}
