const state = {
  samples: []
};

const elements = {
  status: document.querySelector("#status"),
  stakedUsdc: document.querySelector("#staked-usdc"),
  stakedUsd: document.querySelector("#staked-usd"),
  campaignLink: document.querySelector("#campaign-link"),
  usdcLink: document.querySelector("#usdc-link"),
  blockNumber: document.querySelector("#block-number"),
  checkedAt: document.querySelector("#checked-at"),
  implementation: document.querySelector("#implementation"),
  paused: document.querySelector("#paused"),
  refreshButton: document.querySelector("#refresh-button"),
  canvas: document.querySelector("#history-chart"),
  sampleCount: document.querySelector("#sample-count")
};

elements.refreshButton.addEventListener("click", () => refreshMetrics({ manual: true }));

await refreshMetrics();
setInterval(refreshMetrics, 30_000);

async function refreshMetrics(options = {}) {
  setStatus("Loading", "");
  elements.refreshButton.disabled = true;

  try {
    const response = await fetch("/api/metrics", {
      headers: { accept: "application/json" },
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }

    const data = await response.json();

    if (!data.ok) {
      throw new Error(data.error || "Metrics API failed");
    }

    renderMetrics(data);
    setStatus("Live", "live");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Failed", "error");
  } finally {
    elements.refreshButton.disabled = false;

    if (options.manual) {
      elements.refreshButton.blur();
    }
  }
}

function renderMetrics(data) {
  const staked = Number(data.metrics.stakedUsdc);

  elements.stakedUsdc.textContent = `${formatCompact(staked)} USDC`;
  elements.stakedUsd.textContent = `Approximate USD value: $${formatNumber(staked)}`;
  elements.blockNumber.textContent = formatInteger(data.chain.blockNumber);
  elements.checkedAt.textContent = formatDate(data.checkedAt);
  elements.implementation.textContent = data.campaign.implementation;
  elements.paused.textContent = data.campaign.paused ? "Yes" : "No";

  setAddressLink(elements.campaignLink, data.campaign.contract, "address");
  setAddressLink(elements.usdcLink, data.asset.contract, "token");

  state.samples.push({
    value: staked,
    time: new Date(data.checkedAt)
  });

  if (state.samples.length > 80) {
    state.samples.shift();
  }

  elements.sampleCount.textContent = `${state.samples.length} sample${state.samples.length === 1 ? "" : "s"}`;
  drawChart();
}

function setAddressLink(element, address, path) {
  element.textContent = shortAddress(address);
  element.href = `https://bscscan.com/${path}/${address}`;
}

function setStatus(text, modifier) {
  elements.status.className = `status ${modifier}`.trim();
  elements.status.querySelector("span:last-child").textContent = text;
}

function drawChart() {
  const canvas = elements.canvas;
  const ctx = canvas.getContext("2d");
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;

  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const padding = { top: 24, right: 18, bottom: 34, left: 72 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const values = state.samples.map((sample) => sample.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, Math.max(max * 0.002, 1));
  const lower = min - span * 0.15;
  const upper = max + span * 0.15;

  drawGrid(ctx, width, height, padding, chartWidth, chartHeight, lower, upper);

  if (state.samples.length < 2) {
    drawEmpty(ctx, width, height);
    return;
  }

  ctx.beginPath();
  state.samples.forEach((sample, index) => {
    const x = padding.left + (index / (state.samples.length - 1)) * chartWidth;
    const y = padding.top + (1 - (sample.value - lower) / (upper - lower)) * chartHeight;

    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });

  ctx.lineWidth = 3;
  ctx.strokeStyle = "#46d4a3";
  ctx.stroke();

  const latest = state.samples[state.samples.length - 1];
  const latestX = padding.left + chartWidth;
  const latestY = padding.top + (1 - (latest.value - lower) / (upper - lower)) * chartHeight;
  ctx.fillStyle = "#f0b90b";
  ctx.beginPath();
  ctx.arc(latestX, latestY, 5, 0, Math.PI * 2);
  ctx.fill();
}

function drawGrid(ctx, width, height, padding, chartWidth, chartHeight, lower, upper) {
  ctx.strokeStyle = "rgba(154, 168, 181, 0.16)";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#9aa8b5";
  ctx.font = "12px Inter, system-ui, sans-serif";

  for (let step = 0; step <= 4; step += 1) {
    const y = padding.top + (step / 4) * chartHeight;
    const value = upper - (step / 4) * (upper - lower);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
    ctx.fillText(formatCompact(value), 12, y + 4);
  }

  ctx.strokeStyle = "rgba(154, 168, 181, 0.28)";
  ctx.strokeRect(padding.left, padding.top, chartWidth, chartHeight);
  ctx.fillText("USDC", 12, 18);
  ctx.fillText("now", width - padding.right - 24, height - 12);
}

function drawEmpty(ctx, width, height) {
  ctx.fillStyle = "#9aa8b5";
  ctx.font = "14px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("Waiting for another sample", width / 2, height / 2);
  ctx.textAlign = "left";
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2
  }).format(value);
}

function formatInteger(value) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0
  }).format(value);
}

function formatCompact(value) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2
  }).format(value);
}

function formatDate(value) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    month: "short",
    day: "2-digit"
  }).format(new Date(value));
}

function shortAddress(address) {
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}
