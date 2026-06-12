const DEFAULT_RPC_URLS = [
  "https://bsc-mainnet.public.blastapi.io",
  "https://1rpc.io/bnb",
  "https://bsc.publicnode.com",
  "https://bsc-rpc.publicnode.com"
];

const CAMPAIGN_CONTRACT = "0xE79feA13F06c919FEda975e418be66c10c8caE32";
const USDC_CONTRACT = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const IMPLEMENTATION_CONTRACT = "0xd9a05f0729bf5727185ea7d30d3afb136240bd4d";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const BALANCE_OF_SELECTOR = "0x70a08231";
const PAUSED_SELECTOR = "0x5c975abb";
const START_BLOCK = Number(process.env.CAMPAIGN_START_BLOCK || 103507500);
const LOG_BLOCK_RANGE = Number(process.env.REBUILD_LOG_BLOCK_RANGE || 10);
const RANGE_BATCH_SIZE = Number(process.env.REBUILD_RANGE_BATCH_SIZE || 50);
const BATCH_DELAY_MS = Number(process.env.REBUILD_BATCH_DELAY_MS || 0);
const MAX_RPC_ATTEMPTS = Number(process.env.REBUILD_MAX_RPC_ATTEMPTS || 8);
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || "spcxx_usdc_metrics";
const PARTICIPANTS_TABLE = process.env.SUPABASE_PARTICIPANTS_TABLE || "spcxx_usdc_participants";
const DECIMALS = 18;

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const rpcUrls = parseRpcUrls(process.env.BSC_ARCHIVE_RPC_URLS || process.env.BSC_LOG_RPC_URLS);
let rpcCursor = 0;

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

await assertSupabaseParticipantsTable();

const latestBlock = Number(BigInt(await rpcCall("eth_blockNumber", [])));
const toBlock = Number(process.env.REBUILD_TO_BLOCK || process.env.BACKFILL_TO_BLOCK || latestBlock);
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
  `Rebuilding participants from block ${START_BLOCK} to ${toBlock} with ${LOG_BLOCK_RANGE}-block ranges`
);

const logs = await readTransferLogs(START_BLOCK, toBlock);
console.log(`Fetched ${logs.length} USDC transfer logs touching the campaign contract`);

const { points, participants } = buildTrendPointsAndParticipants(logs, {
  startBlock: START_BLOCK,
  currentBlock: toBlock,
  currentBalanceRaw
});
const timedPoints = points
  .filter((point) => Number.isFinite(point.timestampMs))
  .sort((left, right) => left.timestampMs - right.timestampMs || left.blockNumber - right.blockNumber);

if (timedPoints.length < 2) {
  throw new Error("Not enough timestamped trend points to rebuild metrics");
}

const rows = buildMinuteRows(timedPoints);
const participantRows = [...participants.values()].map((participant) => ({
  ...participant,
  total_in_usdc: formatUnits(BigInt(participant.total_in_raw), DECIMALS)
}));

console.log(
  `Prepared ${participantRows.length} participant addresses and ${rows.length} minute samples from ${rows[0].sample_bucket} to ${rows.at(-1).sample_bucket}`
);
console.log(
  JSON.stringify(
    {
      first: rows[0],
      last: rows.at(-1),
      participantCount: participantRows.length
    },
    null,
    2
  )
);

if (dryRun) {
  console.log("Dry run complete; Supabase was not modified");
} else {
  await upsertSupabaseParticipants(participantRows);
  await upsertSupabaseRows(rows);
  console.log(`Rebuilt ${participantRows.length} participants and ${rows.length} metric rows in Supabase`);
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
  const ranges = [];

  for (let start = fromBlock; start <= toBlock; start += LOG_BLOCK_RANGE) {
    ranges.push({
      fromBlock: start,
      toBlock: Math.min(start + LOG_BLOCK_RANGE - 1, toBlock)
    });
  }

  for (let index = 0; index < ranges.length; index += RANGE_BATCH_SIZE) {
    const chunk = ranges.slice(index, index + RANGE_BATCH_SIZE);
    let requestId = 1;
    const calls = [];

    for (const range of chunk) {
      const common = {
        address: USDC_CONTRACT,
        fromBlock: toHexBlock(range.fromBlock),
        toBlock: toHexBlock(range.toBlock)
      };
      calls.push(
        buildLogCall(requestId++, common, [TRANSFER_TOPIC, null, `0x${padAddress(CAMPAIGN_CONTRACT)}`]),
        buildLogCall(requestId++, common, [TRANSFER_TOPIC, `0x${padAddress(CAMPAIGN_CONTRACT)}`])
      );
    }

    const batch = await rpcBatch(calls);

    for (const entry of batch) {
      logs.push(...(entry.result || []));
    }

    if (index === 0 || index + RANGE_BATCH_SIZE >= ranges.length || index % (RANGE_BATCH_SIZE * 20) === 0) {
      console.log(`Scanned ${Math.min(index + RANGE_BATCH_SIZE, ranges.length)}/${ranges.length} ranges; logs=${logs.length}`);
    }

    if (BATCH_DELAY_MS > 0) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  return logs.sort(compareLogs);
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

function buildTrendPointsAndParticipants(logs, options) {
  const paddedCampaign = `0x${padAddress(CAMPAIGN_CONTRACT)}`.toLowerCase();
  const zeroTopic = `0x${"0".repeat(64)}`;
  const deltasByBlock = new Map([[options.startBlock, 0n]]);
  const incomingParticipantsByBlock = new Map();
  const timestampByBlock = new Map();
  const participants = new Map();

  for (const log of logs) {
    const blockNumber = Number(BigInt(log.blockNumber));
    const blockTimestamp = decodeBlockTimestamp(log.blockTimestamp);
    const fromTopic = String(log.topics?.[1] || "").toLowerCase();
    const toTopic = String(log.topics?.[2] || "").toLowerCase();
    const value = BigInt(log.data || "0x0");
    const delta = toTopic === paddedCampaign ? value : fromTopic === paddedCampaign ? -value : 0n;

    if (blockTimestamp) {
      timestampByBlock.set(blockNumber, Date.parse(blockTimestamp));
    }

    if (delta !== 0n) {
      deltasByBlock.set(blockNumber, (deltasByBlock.get(blockNumber) || 0n) + delta);
    }

    if (toTopic === paddedCampaign && fromTopic !== zeroTopic && fromTopic !== paddedCampaign) {
      const address = topicToAddress(fromTopic);
      const addresses = incomingParticipantsByBlock.get(blockNumber) || new Set();
      const existing = participants.get(address);

      addresses.add(address);
      incomingParticipantsByBlock.set(blockNumber, addresses);
      participants.set(address, {
        address,
        first_seen_at: existing?.first_seen_at || blockTimestamp,
        first_seen_block: existing ? Math.min(existing.first_seen_block, blockNumber) : blockNumber,
        last_seen_at: blockTimestamp || existing?.last_seen_at || null,
        last_seen_block: existing ? Math.max(existing.last_seen_block, blockNumber) : blockNumber,
        transfer_count: (existing?.transfer_count || 0) + 1,
        total_in_raw: ((existing ? BigInt(existing.total_in_raw) : 0n) + value).toString(),
        updated_at: new Date().toISOString()
      });
    }
  }

  const points = [];
  const seenParticipants = new Set();
  let runningBalance = 0n;
  const blockNumbers = [...new Set([...deltasByBlock.keys(), ...incomingParticipantsByBlock.keys()])].sort(
    (left, right) => left - right
  );

  for (const blockNumber of blockNumbers) {
    runningBalance += deltasByBlock.get(blockNumber) || 0n;

    for (const address of incomingParticipantsByBlock.get(blockNumber) || []) {
      seenParticipants.add(address);
    }

    points.push({
      blockNumber,
      balanceRaw: runningBalance,
      participantCount: seenParticipants.size,
      timestampMs: timestampByBlock.get(blockNumber)
    });
  }

  const last = points.at(-1);

  if (!last || last.blockNumber < options.currentBlock) {
    points.push({
      blockNumber: options.currentBlock,
      balanceRaw: options.currentBalanceRaw,
      participantCount: last?.participantCount || 0,
      timestampMs: timestampByBlock.get(options.currentBlock) || last?.timestampMs
    });
  } else if (last.blockNumber === options.currentBlock) {
    last.balanceRaw = options.currentBalanceRaw;
  }

  return { points, participants };
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
      rpc_url: "rebuild"
    });
  }

  return rows;
}

async function assertSupabaseParticipantsTable() {
  const response = await fetch(`${trimSlash(process.env.SUPABASE_URL)}/rest/v1/${PARTICIPANTS_TABLE}?select=address&limit=1`, {
    headers: supabaseHeaders()
  });

  if (!response.ok) {
    throw new Error(
      `Supabase participants table is not ready: ${response.status} ${await response.text()}. Run supabase/schema.sql first.`
    );
  }
}

async function upsertSupabaseParticipants(rows) {
  const url = `${trimSlash(process.env.SUPABASE_URL)}/rest/v1/${PARTICIPANTS_TABLE}?on_conflict=address`;
  const chunkSize = 500;

  for (let index = 0; index < rows.length; index += chunkSize) {
    const chunk = rows.slice(index, index + chunkSize);
    const response = await fetch(url, {
      method: "POST",
      headers: supabaseHeaders({
        Prefer: "resolution=merge-duplicates,return=minimal"
      }),
      body: JSON.stringify(chunk)
    });

    if (!response.ok) {
      throw new Error(`Supabase participant upsert failed: ${response.status} ${await response.text()}`);
    }

    console.log(`Upserted participant rows ${index + 1}-${index + chunk.length}`);
  }
}

async function upsertSupabaseRows(rows) {
  const url = `${trimSlash(process.env.SUPABASE_URL)}/rest/v1/${SUPABASE_TABLE}?on_conflict=sample_bucket`;
  const chunkSize = 500;

  for (let index = 0; index < rows.length; index += chunkSize) {
    const chunk = rows.slice(index, index + chunkSize);
    const response = await fetch(url, {
      method: "POST",
      headers: supabaseHeaders({
        Prefer: "resolution=merge-duplicates,return=minimal"
      }),
      body: JSON.stringify(chunk)
    });

    if (!response.ok) {
      throw new Error(`Supabase metric upsert failed: ${response.status} ${await response.text()}`);
    }

    console.log(`Upserted metric rows ${index + 1}-${index + chunk.length}`);
  }
}

async function rpcCall(method, params) {
  return rpcBatch([
    {
      jsonrpc: "2.0",
      id: 1,
      method,
      params
    }
  ]).then((batch) => batch[0].result);
}

async function rpcBatch(calls, attempt = 1) {
  let lastError;

  for (let offset = 0; offset < rpcUrls.length; offset += 1) {
    const rpcUrl = rpcUrls[(rpcCursor + offset) % rpcUrls.length];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(calls),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const json = await response.json();
      const batch = Array.isArray(json) ? json : [json];
      const failed = batch.find((entry) => entry.error);

      if (failed) {
        throw new Error(failed.error.message || "RPC batch error");
      }

      rpcCursor = (rpcCursor + offset + 1) % rpcUrls.length;
      return batch;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
    }
  }

  if (attempt < MAX_RPC_ATTEMPTS) {
    const retryDelay = Math.min(30_000, 1000 * 2 ** (attempt - 1));
    console.log(`RPC batch failed (${lastError?.message || "unknown error"}); retrying in ${retryDelay}ms`);
    await sleep(retryDelay);
    return rpcBatch(calls, attempt + 1);
  }

  throw new Error(`All RPC endpoints failed for batch: ${lastError?.message || "unknown error"}`);
}

function padAddress(address) {
  return address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function topicToAddress(topic) {
  return `0x${String(topic).toLowerCase().replace(/^0x/, "").slice(-40)}`;
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

function decodeBlockTimestamp(value) {
  if (!value) {
    return null;
  }

  return new Date(Number(BigInt(value)) * 1000).toISOString();
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

function supabaseHeaders(extra = {}) {
  return {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    "content-type": "application/json",
    ...extra
  };
}

function trimSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
