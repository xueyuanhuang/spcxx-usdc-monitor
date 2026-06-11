const DEFAULT_RPC_URLS = [
  "https://bsc.publicnode.com",
  "https://bsc-rpc.publicnode.com",
  "https://bsc-dataseed1.binance.org",
  "https://bsc-dataseed.binance.org"
];

const CAMPAIGN_CONTRACT = "0xE79feA13F06c919FEda975e418be66c10c8caE32";
const USDC_CONTRACT = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const IMPLEMENTATION_CONTRACT = "0xd9a05f0729bf5727185ea7d30d3afb136240bd4d";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const BALANCE_OF_SELECTOR = "0x70a08231";
const PAUSED_SELECTOR = "0x5c975abb";
const START_BLOCK = Number(process.env.CAMPAIGN_START_BLOCK || 103507500);
const LOG_BLOCK_RANGE = Number(process.env.BACKFILL_LOG_BLOCK_RANGE || 1000);
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || "spcxx_usdc_metrics";
const DECIMALS = 18;

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const rpcUrls = parseRpcUrls(process.env.BSC_LOG_RPC_URLS || process.env.BSC_RPC_URLS);
let lastRpcError;

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

const latestBlock = Number(BigInt(await rpcCall("eth_blockNumber", [])));
const toBlock = Number(process.env.BACKFILL_TO_BLOCK || latestBlock);
const currentBalanceRaw = BigInt(
  await rpcCall("eth_call", [
    {
      to: USDC_CONTRACT,
      data: BALANCE_OF_SELECTOR + padAddress(CAMPAIGN_CONTRACT)
    },
    "latest"
  ])
);
const paused = BigInt(
  await rpcCall("eth_call", [
    {
      to: CAMPAIGN_CONTRACT,
      data: PAUSED_SELECTOR
    },
    "latest"
  ])
) !== 0n;

console.log(
  `Backfilling SPCXx history from block ${START_BLOCK} to ${toBlock} with ${LOG_BLOCK_RANGE}-block ranges`
);

const logs = await readTransferLogs(START_BLOCK, toBlock);
console.log(`Fetched ${logs.length} USDC transfer logs touching the campaign contract`);

const points = buildTrendPoints(logs, {
  startBlock: START_BLOCK,
  currentBlock: toBlock,
  currentBalanceRaw
});
const blockTimes = await readBlockTimestamps(points.map((point) => point.blockNumber));
const timedPoints = points
  .map((point) => ({
    ...point,
    timestampMs: blockTimes.get(point.blockNumber)
  }))
  .filter((point) => Number.isFinite(point.timestampMs))
  .sort((left, right) => left.timestampMs - right.timestampMs || left.blockNumber - right.blockNumber);

if (timedPoints.length < 2) {
  throw new Error("Not enough timestamped trend points to backfill");
}

const rows = buildMinuteRows(timedPoints);
console.log(
  `Prepared ${rows.length} minute samples from ${rows[0].sample_bucket} to ${rows.at(-1).sample_bucket}`
);

if (dryRun) {
  console.log(JSON.stringify({ first: rows[0], last: rows.at(-1) }, null, 2));
} else {
  await upsertSupabaseRows(rows);
  console.log(`Upserted ${rows.length} rows into Supabase table ${SUPABASE_TABLE}`);
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

async function readTransferLogs(fromBlock, toBlock) {
  const logs = [];

  for (let start = fromBlock; start <= toBlock; start += LOG_BLOCK_RANGE) {
    const end = Math.min(start + LOG_BLOCK_RANGE - 1, toBlock);
    const incoming = await readLogsForRange(start, end, [TRANSFER_TOPIC, null, `0x${padAddress(CAMPAIGN_CONTRACT)}`]);
    const outgoing = await readLogsForRange(start, end, [TRANSFER_TOPIC, `0x${padAddress(CAMPAIGN_CONTRACT)}`]);
    logs.push(...incoming, ...outgoing);

    if (logs.length && Math.floor((start - fromBlock) / LOG_BLOCK_RANGE) % 10 === 0) {
      console.log(`Scanned through block ${end}; logs=${logs.length}`);
    }
  }

  return logs.sort(compareLogs);
}

async function readLogsForRange(fromBlock, toBlock, topics) {
  try {
    return await rpcCall("eth_getLogs", [
      {
        address: USDC_CONTRACT,
        fromBlock: toHexBlock(fromBlock),
        toBlock: toHexBlock(toBlock),
        topics
      }
    ]);
  } catch (error) {
    if (fromBlock >= toBlock) {
      throw error;
    }

    const middle = Math.floor((fromBlock + toBlock) / 2);
    const left = await readLogsForRange(fromBlock, middle, topics);
    const right = await readLogsForRange(middle + 1, toBlock, topics);
    return [...left, ...right];
  }
}

function buildTrendPoints(logs, options) {
  const paddedCampaign = `0x${padAddress(CAMPAIGN_CONTRACT)}`.toLowerCase();
  const zeroTopic = `0x${"0".repeat(64)}`;
  const deltasByBlock = new Map([[options.startBlock, 0n]]);
  const incomingParticipantsByBlock = new Map();

  for (const log of logs) {
    const blockNumber = Number(BigInt(log.blockNumber));
    const from = String(log.topics?.[1] || "").toLowerCase();
    const to = String(log.topics?.[2] || "").toLowerCase();
    const value = BigInt(log.data || "0x0");
    const delta = to === paddedCampaign ? value : from === paddedCampaign ? -value : 0n;

    if (delta === 0n) {
      continue;
    }

    deltasByBlock.set(blockNumber, (deltasByBlock.get(blockNumber) || 0n) + delta);

    if (to === paddedCampaign && from !== zeroTopic && from !== paddedCampaign) {
      const participants = incomingParticipantsByBlock.get(blockNumber) || new Set();
      participants.add(from);
      incomingParticipantsByBlock.set(blockNumber, participants);
    }
  }

  const points = [];
  const participants = new Set();
  let runningBalance = 0n;
  const blockNumbers = [...new Set([...deltasByBlock.keys(), ...incomingParticipantsByBlock.keys()])].sort(
    (left, right) => left - right
  );

  for (const blockNumber of blockNumbers) {
    runningBalance += deltasByBlock.get(blockNumber) || 0n;

    for (const address of incomingParticipantsByBlock.get(blockNumber) || []) {
      participants.add(address);
    }

    points.push({
      blockNumber,
      balanceRaw: runningBalance,
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
  } else if (last.blockNumber === options.currentBlock) {
    last.balanceRaw = options.currentBalanceRaw;
  }

  return points;
}

async function readBlockTimestamps(blockNumbers) {
  const uniqueBlocks = [...new Set(blockNumbers)];
  const timestamps = new Map();
  const chunkSize = 100;

  for (let index = 0; index < uniqueBlocks.length; index += chunkSize) {
    const chunk = uniqueBlocks.slice(index, index + chunkSize);
    const calls = chunk.map((blockNumber, offset) => ({
      jsonrpc: "2.0",
      id: offset + 1,
      method: "eth_getBlockByNumber",
      params: [toHexBlock(blockNumber), false]
    }));
    const batch = await rpcBatch(calls, chunk.map((_, offset) => offset + 1));

    for (const entry of batch) {
      const blockNumber = chunk[entry.id - 1];
      const seconds = Number(BigInt(entry.result.timestamp));
      timestamps.set(blockNumber, seconds * 1000);
    }
  }

  return timestamps;
}

function buildMinuteRows(points) {
  const rows = [];
  const firstMinute = floorMinute(points[0].timestampMs);
  const lastMinute = floorMinute(points.at(-1).timestampMs);
  let pointIndex = 0;
  let current = points[0];

  for (let minute = firstMinute; minute <= lastMinute; minute += 60_000) {
    const minuteEnd = minute + 59_999;

    while (pointIndex + 1 < points.length && points[pointIndex + 1].timestampMs <= minuteEnd) {
      pointIndex += 1;
      current = points[pointIndex];
    }

    rows.push({
      sample_bucket: new Date(minute).toISOString(),
      checked_at: new Date(Math.max(current.timestampMs, minute)).toISOString(),
      chain: "BNB Smart Chain",
      block_number: current.blockNumber,
      campaign_contract: CAMPAIGN_CONTRACT,
      usdc_contract: USDC_CONTRACT,
      implementation: IMPLEMENTATION_CONTRACT,
      paused,
      staked_usdc: formatUnits(current.balanceRaw, DECIMALS),
      participant_count: current.participantCount,
      balance_raw: current.balanceRaw.toString(),
      rpc_url: "backfill"
    });
  }

  return rows;
}

async function upsertSupabaseRows(rows) {
  const url = `${trimSlash(process.env.SUPABASE_URL)}/rest/v1/${SUPABASE_TABLE}?on_conflict=sample_bucket`;
  const chunkSize = 500;

  for (let index = 0; index < rows.length; index += chunkSize) {
    const chunk = rows.slice(index, index + chunkSize);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "content-type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify(chunk)
    });

    if (!response.ok) {
      throw new Error(`Supabase upsert failed: ${response.status} ${await response.text()}`);
    }

    console.log(`Upserted rows ${index + 1}-${index + chunk.length}`);
  }
}

async function rpcCall(method, params) {
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method,
    params
  };

  for (const rpcUrl of rpcUrls) {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const json = await response.json();

      if (json.error) {
        throw new Error(json.error.message || "RPC error");
      }

      return json.result;
    } catch (error) {
      lastRpcError = error;
    }
  }

  throw new Error(`All RPC endpoints failed for ${method}: ${lastRpcError?.message || "unknown error"}`);
}

async function rpcBatch(calls, requiredIds) {
  let lastError;

  for (const rpcUrl of rpcUrls) {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(calls)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const json = await response.json();

      if (!Array.isArray(json)) {
        throw new Error("non-batch response");
      }

      const ids = new Set(json.map((entry) => entry.id));
      const missing = requiredIds.find((id) => !ids.has(id));

      if (missing) {
        throw new Error(`missing response id ${missing}`);
      }

      const failed = json.find((entry) => entry.error);

      if (failed) {
        throw new Error(failed.error.message || "RPC batch error");
      }

      return json;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`All RPC endpoints failed for batch: ${lastError?.message || "unknown error"}`);
}

function padAddress(address) {
  return address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
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

function floorMinute(value) {
  return Math.floor(value / 60_000) * 60_000;
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

function trimSlash(value) {
  return String(value).replace(/\/+$/, "");
}
