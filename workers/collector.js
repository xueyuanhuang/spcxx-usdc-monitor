const METRICS_URL = "https://spcxx-usdc-monitor.pages.dev/api/metrics?persist=1";
const TOKEN_URL = "https://spcxx-usdc-monitor.pages.dev/api/token?persist=1";

export default {
  async scheduled(_event, _env, ctx) {
    ctx.waitUntil(collectMetric());
  },

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname !== "/collect") {
      return Response.json({ ok: true, service: "spcxx-usdc-monitor-collector" });
    }

    return collectMetric();
  }
};

async function collectMetric() {
  const [metricsResult, tokenResult] = await Promise.all([
    collectJson(METRICS_URL),
    collectJson(TOKEN_URL)
  ]);

  if (!metricsResult.ok || !tokenResult.ok) {
    return Response.json(
      {
        ok: false,
        usdc: metricsResult,
        token: tokenResult,
        error: metricsResult.error || tokenResult.error || "Metric collection failed"
      },
      { status: 502 }
    );
  }

  const payload = metricsResult.payload;
  const tokenPayload = tokenResult.payload;

  return Response.json({
    ok: true,
    checkedAt: payload.checkedAt,
    blockNumber: payload.chain.blockNumber,
    stakedUsdc: payload.metrics.stakedUsdc,
    participantAddresses: payload.metrics.participantAddresses,
    tokenSupply: tokenPayload.metrics.totalSupply,
    tokenHolders: tokenPayload.metrics.holderCount,
    distributedSupply: tokenPayload.metrics.distributedSupply,
    source: payload.historyMeta?.source,
    tokenSource: tokenPayload.historyMeta?.source
  });
}

async function collectJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    cf: { cacheTtl: 0, cacheEverything: false }
  });
  const payload = await response.json();

  if (!response.ok || !payload.ok || payload.storage?.stored !== true) {
    return {
      ok: false,
      status: response.status,
      storage: payload.storage,
      payload,
      error: payload.error || payload.storage?.error || `Collection failed for ${url}`
    };
  }

  return {
    ok: true,
    status: response.status,
    storage: payload.storage,
    payload
  };
}
