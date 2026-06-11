const METRICS_URL = "https://spcxx-usdc-monitor.pages.dev/api/metrics?persist=1";

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
  const response = await fetch(METRICS_URL, {
    headers: { accept: "application/json" },
    cf: { cacheTtl: 0, cacheEverything: false }
  });

  const payload = await response.json();

  if (!response.ok || !payload.ok || payload.storage?.stored !== true) {
    return Response.json(
      {
        ok: false,
        status: response.status,
        storage: payload.storage,
        error: payload.error || payload.storage?.error || "Metric collection failed"
      },
      { status: 502 }
    );
  }

  return Response.json({
    ok: true,
    checkedAt: payload.checkedAt,
    blockNumber: payload.chain.blockNumber,
    stakedUsdc: payload.metrics.stakedUsdc,
    participantAddresses: payload.metrics.participantAddresses,
    source: payload.historyMeta?.source
  });
}
