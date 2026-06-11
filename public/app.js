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

const groupDialog = document.querySelector("#group-dialog");
const openGroupButton = document.querySelector("#open-group");
const closeGroupButton = document.querySelector("#close-group");

openGroupButton.addEventListener("click", () => {
  if (typeof groupDialog.showModal === "function") {
    groupDialog.showModal();
  } else {
    groupDialog.setAttribute("open", "");
  }
});

closeGroupButton.addEventListener("click", closeGroupDialog);
groupDialog.addEventListener("click", (event) => {
  if (event.target === groupDialog) {
    closeGroupDialog();
  }
});

await refreshMetrics();
setInterval(refreshMetrics, 30_000);

async function refreshMetrics(options = {}) {
  setStatus("读取中", "");
  elements.refreshButton.disabled = true;

  try {
    const response = await fetch("/api/metrics", {
      headers: { accept: "application/json" },
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`接口返回 ${response.status}`);
    }

    const data = await response.json();

    if (!data.ok) {
      throw new Error(data.error || "数据读取失败");
    }

    renderMetrics(data);
    setStatus("实时", "live");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "失败", "error");
  } finally {
    elements.refreshButton.disabled = false;

    if (options.manual) {
      elements.refreshButton.blur();
    }
  }
}

function renderMetrics(data) {
  const staked = Number(data.metrics.stakedUsdc);

  elements.stakedUsdc.textContent = `${formatAbbreviated(staked)} USDC`;
  elements.stakedUsd.textContent = `约合美元：$${formatAbbreviated(staked)}`;
  elements.blockNumber.textContent = formatInteger(data.chain.blockNumber);
  elements.checkedAt.textContent = formatDate(data.checkedAt);
  elements.implementation.textContent = data.campaign.implementation;
  elements.paused.textContent = data.campaign.paused ? "是" : "否";

  setAddressLink(elements.campaignLink, data.campaign.contract, "address");
  setAddressLink(elements.usdcLink, data.asset.contract, "token");

  if (Array.isArray(data.history) && data.history.length > 0) {
    state.samples = data.history.map((sample) => ({
      value: Number(sample.stakedUsdc),
      time: new Date(sample.checkedAt),
      blockNumber: sample.blockNumber
    }));
  } else {
    state.samples.push({
      value: staked,
      time: new Date(data.checkedAt),
      blockNumber: data.chain.blockNumber
    });

    if (state.samples.length > 80) {
      state.samples.shift();
    }
  }

  const sourceLabel =
    data.historyMeta?.source === "bsc_usdc_transfer_logs" ? "从活动开始至今" : "当前余额";
  elements.sampleCount.textContent = `${sourceLabel} · ${state.samples.length} 个趋势点`;
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

  const padding = { top: 24, right: 18, bottom: 42, left: 72 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const values = state.samples.map((sample) => sample.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, Math.max(max * 0.002, 1));
  const lower = min - span * 0.15;
  const upper = max + span * 0.15;
  const timeline = getTimeline(state.samples);

  drawGrid(ctx, width, height, padding, chartWidth, chartHeight, lower, upper, timeline);

  if (state.samples.length < 2) {
    drawEmpty(ctx, width, height);
    return;
  }

  ctx.beginPath();
  state.samples.forEach((sample, index) => {
    const x = getSampleX(sample, index, state.samples.length, timeline, padding, chartWidth);
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
  const latestX = getSampleX(latest, state.samples.length - 1, state.samples.length, timeline, padding, chartWidth);
  const latestY = padding.top + (1 - (latest.value - lower) / (upper - lower)) * chartHeight;
  ctx.fillStyle = "#f0b90b";
  ctx.beginPath();
  ctx.arc(latestX, latestY, 5, 0, Math.PI * 2);
  ctx.fill();
}

function drawGrid(ctx, width, height, padding, chartWidth, chartHeight, lower, upper, timeline) {
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
    ctx.fillText(formatAbbreviated(value), 12, y + 4);
  }

  if (timeline) {
    const tickCount = width < 560 ? 3 : width < 860 ? 4 : 5;

    for (let step = 0; step < tickCount; step += 1) {
      const ratio = tickCount === 1 ? 0 : step / (tickCount - 1);
      const x = padding.left + ratio * chartWidth;
      const tickTime = timeline.start + ratio * (timeline.end - timeline.start);

      ctx.beginPath();
      ctx.moveTo(x, padding.top);
      ctx.lineTo(x, padding.top + chartHeight);
      ctx.stroke();

      ctx.textAlign = step === 0 ? "left" : step === tickCount - 1 ? "right" : "center";
      ctx.fillText(formatAxisDate(tickTime), x, height - 12);
    }

    ctx.textAlign = "left";
  }

  ctx.strokeStyle = "rgba(154, 168, 181, 0.28)";
  ctx.strokeRect(padding.left, padding.top, chartWidth, chartHeight);
  ctx.fillText("USDC", 12, 18);
}

function drawEmpty(ctx, width, height) {
  ctx.fillStyle = "#9aa8b5";
  ctx.font = "14px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("等待链上活动记录", width / 2, height / 2);
  ctx.textAlign = "left";
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 2
  }).format(value);
}

function formatInteger(value) {
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 0
  }).format(value);
}

function formatAbbreviated(value) {
  const units = [
    { threshold: 1_000_000_000, suffix: "B" },
    { threshold: 1_000_000, suffix: "M" },
    { threshold: 1_000, suffix: "K" }
  ];
  const abs = Math.abs(value);
  const unit = units.find((item) => abs >= item.threshold);

  if (!unit) {
    return new Intl.NumberFormat("en-US", {
      maximumFractionDigits: 2
    }).format(value);
  }

  const scaled = value / unit.threshold;
  const maximumFractionDigits = Math.abs(scaled) >= 100 ? 1 : 2;
  const text = new Intl.NumberFormat("en-US", {
    maximumFractionDigits
  }).format(scaled);

  return `${text}${unit.suffix}`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    month: "short",
    day: "2-digit"
  }).format(new Date(value));
}

function formatAxisDate(value) {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  })
    .formatToParts(date)
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

function getTimeline(samples) {
  const times = samples
    .map((sample) => sample.time?.getTime())
    .filter((time) => Number.isFinite(time));

  if (times.length < 2) {
    return null;
  }

  const start = Math.min(...times);
  const end = Math.max(...times);

  if (start === end) {
    return null;
  }

  return { start, end };
}

function getSampleX(sample, index, count, timeline, padding, chartWidth) {
  const time = sample.time?.getTime();

  if (timeline && Number.isFinite(time)) {
    const ratio = (time - timeline.start) / (timeline.end - timeline.start);
    return padding.left + Math.max(0, Math.min(1, ratio)) * chartWidth;
  }

  return padding.left + (index / Math.max(count - 1, 1)) * chartWidth;
}

function shortAddress(address) {
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

function closeGroupDialog() {
  if (typeof groupDialog.close === "function") {
    groupDialog.close();
  } else {
    groupDialog.removeAttribute("open");
  }
}
