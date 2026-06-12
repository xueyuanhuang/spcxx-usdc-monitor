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
const DEFAULT_SUPABASE_PARTICIPANTS_TABLE = "spcxx_usdc_participants";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const DEFAULT_LOG_RPC_URLS = [
  "https://bsc-mainnet.public.blastapi.io",
  "https://bsc.publicnode.com",
  "https://bsc-rpc.publicnode.com",
  "https://bsc-dataseed1.binance.org",
  "https://bsc-dataseed.binance.org"
];
const DEFAULT_CAMPAIGN_START_BLOCK = 103507500;
const DEFAULT_LOG_BLOCK_RANGE = 10;
const DEFAULT_LOG_RANGE_BATCH_SIZE = 40;
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
      participantsTable: env.SUPABASE_PARTICIPANTS_TABLE || DEFAULT_SUPABASE_PARTICIPANTS_TABLE,
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
  const participantCountResult = isSupabaseConfigured(env)
    ? await safeReadSupabaseParticipantCount(env)
    : { count: undefined, error: undefined };
  const useStoredHistory = storedHistoryResult.history.length > 0 && !options.reconstruct;

  if (useStoredHistory) {
    const historyParticipantCount = getKnownParticipantCount(storedHistoryResult.history);
    const participantTableReliable = isReliableParticipantTableCount(participantCountResult.count, historyParticipantCount);
    let knownParticipantCount = pickReliableParticipantCount(participantCountResult.count, historyParticipantCount);
    let responseHistory = participantTableReliable
      ? capHistoryParticipantCount(storedHistoryResult.history, knownParticipantCount)
      : storedHistoryResult.history;

    if (options.persist) {
      const incrementalParticipants = await safeReadIncrementalParticipants(env, {
        campaignContract,
        usdcContract,
        currentBlock: blockNumber,
        checkedAt,
        rpcUrls: logRpcUrls,
        storedHistory: storedHistoryResult.history
      });

      knownParticipantCount = pickReliableParticipantCount(
        incrementalParticipants.totalParticipantCount,
        knownParticipantCount
      );
      responseHistory = isReliableParticipantTableCount(incrementalParticipants.totalParticipantCount, historyParticipantCount)
        ? capHistoryParticipantCount(storedHistoryResult.history, knownParticipantCount)
        : responseHistory;
      metrics.historyMeta.incremental = incrementalParticipants.meta;

      if (incrementalParticipants.error) {
        metrics.historyMeta.incrementalError = incrementalParticipants.error;
      }
    }

    currentPoint.participantCount = knownParticipantCount;
    metrics.metrics.participantAddresses = knownParticipantCount;
    metrics.history = mergeCurrentPoint(responseHistory, currentPoint, metrics.historyMeta.pointLimit);
    metrics.historyMeta = {
      ...metrics.historyMeta,
      source: options.persist ? "supabase_samples_incremental" : "supabase_samples",
      returnedPoints: metrics.history.length,
      participantsSource: participantCountResult.count ? "supabase_participants" : "supabase_samples",
      participantsError: participantCountResult.error,
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

async function safeReadIncrementalParticipants(env, options) {
  try {
    const meta = await readIncrementalParticipants(env, options);
    return {
      newParticipantCount: meta.newParticipantCount,
      totalParticipantCount: meta.totalParticipantCount,
      meta,
      error: undefined
    };
  } catch (error) {
    return {
      newParticipantCount: 0,
      totalParticipantCount: undefined,
      meta: {
        source: "incremental_transfer_logs",
        fromBlock: options.storedHistory.at(-1)?.blockNumber,
        toBlock: options.currentBlock,
        logCount: 0,
        newParticipantCount: 0,
        totalParticipantCount: undefined
      },
      error: error instanceof Error ? error.message : "Incremental participant read failed"
    };
  }
}

async function readIncrementalParticipants(env, options) {
  const lastStoredBlock = Number(options.storedHistory.at(-1)?.blockNumber || 0);
  const fromBlock = Math.max(lastStoredBlock + 1, readPositiveInteger(env.CAMPAIGN_START_BLOCK, DEFAULT_CAMPAIGN_START_BLOCK));

  if (!lastStoredBlock || fromBlock > options.currentBlock) {
    return {
      source: "incremental_transfer_logs",
      fromBlock,
      toBlock: options.currentBlock,
      logCount: 0,
      newParticipantCount: 0,
      totalParticipantCount: await readSupabaseParticipantCount(env)
    };
  }

  const logs = await readTransferLogs(options.rpcUrls, {
    usdcContract: options.usdcContract,
    campaignContract: options.campaignContract,
    fromBlock,
    toBlock: options.currentBlock,
    rangeSize: Math.min(readPositiveInteger(env.LOG_BLOCK_RANGE, DEFAULT_LOG_BLOCK_RANGE), 1000),
    rangeBatchSize: readPositiveInteger(env.LOG_RANGE_BATCH_SIZE, DEFAULT_LOG_RANGE_BATCH_SIZE)
  });
  const paddedCampaign = `0x${padAddress(options.campaignContract)}`.toLowerCase();
  const zeroTopic = `0x${"0".repeat(64)}`;
  const participants = new Map();

  for (const log of logs) {
    const from = String(log.topics?.[1] || "").toLowerCase();
    const to = String(log.topics?.[2] || "").toLowerCase();

    if (to === paddedCampaign && from !== zeroTopic && from !== paddedCampaign) {
      const address = topicToAddress(from);
      const blockNumber = Number(BigInt(log.blockNumber));
      const existing = participants.get(address);

      participants.set(address, {
        address,
        first_seen_at: options.checkedAt,
        first_seen_block: existing ? Math.min(existing.first_seen_block, blockNumber) : blockNumber,
        last_seen_at: options.checkedAt,
        last_seen_block: existing ? Math.max(existing.last_seen_block, blockNumber) : blockNumber,
        transfer_count: (existing?.transfer_count || 0) + 1,
        total_in_raw: ((existing ? BigInt(existing.total_in_raw) : 0n) + BigInt(log.data || "0x0")).toString()
      });
    }
  }

  await upsertSupabaseParticipants(env, [...participants.values()]);
  const totalParticipantCount = await readSupabaseParticipantCount(env);

  return {
    source: "incremental_transfer_logs",
    fromBlock,
    toBlock: options.currentBlock,
    logCount: logs.length,
    newParticipantCount: participants.size,
    totalParticipantCount
  };
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
  const limit = readPositiveInteger(env.HISTORY_LIMIT, 288);
  const pageSize = 1000;
  const rows = [];

  for (let offset = 0; offset < limit; offset += pageSize) {
    const params = new URLSearchParams({
      select: "checked_at,block_number,staked_usdc,balance_raw,participant_count",
      order: "checked_at.desc",
      limit: String(Math.min(pageSize, limit - offset)),
      offset: String(offset)
    });
    const url = `${trimSlash(env.SUPABASE_URL)}/rest/v1/${table}?${params}`;

    const response = await fetch(url, {
      headers: supabaseHeaders(env)
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Supabase history read failed: ${response.status} ${detail}`);
    }

    const pageRows = await response.json();
    rows.push(...pageRows);

    if (pageRows.length < pageSize) {
      break;
    }
  }

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

async function readSupabaseParticipantCount(env) {
  const table = env.SUPABASE_PARTICIPANTS_TABLE || DEFAULT_SUPABASE_PARTICIPANTS_TABLE;
  const params = new URLSearchParams({
    select: "address"
  });
  const url = `${trimSlash(env.SUPABASE_URL)}/rest/v1/${table}?${params}`;
  const response = await fetch(url, {
    method: "HEAD",
    headers: supabaseHeaders(env, {
      Prefer: "count=exact",
      Range: "0-0"
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Supabase participant count read failed: ${response.status} ${detail}`);
  }

  return readContentRangeCount(response.headers.get("content-range"));
}

async function safeReadSupabaseParticipantCount(env) {
  try {
    return {
      count: await readSupabaseParticipantCount(env),
      error: undefined
    };
  } catch (error) {
    return {
      count: undefined,
      error: error instanceof Error ? error.message : "Supabase participant count read failed"
    };
  }
}

async function upsertSupabaseParticipants(env, rows) {
  if (!rows.length) {
    return;
  }

  const table = env.SUPABASE_PARTICIPANTS_TABLE || DEFAULT_SUPABASE_PARTICIPANTS_TABLE;
  const url = `${trimSlash(env.SUPABASE_URL)}/rest/v1/${table}?on_conflict=address`;
  const chunkSize = 500;

  for (let index = 0; index < rows.length; index += chunkSize) {
    const chunk = rows.slice(index, index + chunkSize);
    const response = await fetch(url, {
      method: "POST",
      headers: supabaseHeaders(env, {
        Prefer: "resolution=ignore-duplicates,return=minimal"
      }),
      body: JSON.stringify(chunk)
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Supabase participant upsert failed: ${response.status} ${detail}`);
    }
  }
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

function pickReliableParticipantCount(participantTableCount, fallbackCount) {
  const tableCount = Number(participantTableCount || 0);
  const fallback = Number(fallbackCount || 0);

  if (isReliableParticipantTableCount(tableCount, fallback)) {
    return tableCount;
  }

  return fallback;
}

function isReliableParticipantTableCount(participantTableCount, fallbackCount) {
  const tableCount = Number(participantTableCount || 0);
  const fallback = Number(fallbackCount || 0);

  return tableCount > 0 && (!fallback || tableCount >= fallback * 0.5);
}

function capHistoryParticipantCount(history, participantCount) {
  const cap = Number(participantCount || 0);

  if (!cap) {
    return history;
  }

  return history.map((point) => ({
    ...point,
    participantCount: Math.min(Number(point.participantCount || 0), cap)
  }));
}

function readContentRangeCount(value) {
  const match = String(value || "").match(/\/(\d+)$/);

  if (!match) {
    throw new Error("Supabase count response did not include content-range");
  }

  return Number(match[1]);
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

function supabaseHeaders(env, extra = {}) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "content-type": "application/json",
    ...extra
  };
}

function topicToAddress(topic) {
  const clean = String(topic).toLowerCase().replace(/^0x/, "");

  if (clean.length < 40) {
    throw new Error(`Invalid address topic: ${topic}`);
  }

  return `0x${clean.slice(-40)}`;
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
