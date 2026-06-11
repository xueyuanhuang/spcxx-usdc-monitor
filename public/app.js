const state = {
  balanceSamples: [],
  participantSamples: [],
  charts: {
    balance: { activeIndex: null },
    participants: { activeIndex: null }
  }
};

const elements = {
  status: document.querySelector("#status"),
  stakedUsdc: document.querySelector("#staked-usdc"),
  stakedUsd: document.querySelector("#staked-usd"),
  campaignLink: document.querySelector("#campaign-link"),
  usdcLink: document.querySelector("#usdc-link"),
  blockNumber: document.querySelector("#block-number"),
  participantCount: document.querySelector("#participant-count"),
  checkedAt: document.querySelector("#checked-at"),
  implementation: document.querySelector("#implementation"),
  paused: document.querySelector("#paused"),
  refreshButton: document.querySelector("#refresh-button"),
  balanceCanvas: document.querySelector("#history-chart"),
  participantCanvas: document.querySelector("#participant-chart"),
  sampleCount: document.querySelector("#sample-count"),
  participantSampleCount: document.querySelector("#participant-sample-count")
};

elements.refreshButton.addEventListener("click", () => refreshMetrics({ manual: true }));
setupChartInteraction("balance", elements.balanceCanvas);
setupChartInteraction("participants", elements.participantCanvas);
window.addEventListener("resize", () => {
  redrawChart("balance");
  redrawChart("participants");
});

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
  const participantCount = Number(data.metrics.participantAddresses || 0);

  elements.stakedUsdc.textContent = `${formatAbbreviated(staked)} USDC`;
  elements.stakedUsd.textContent = `约合美元：$${formatAbbreviated(staked)}`;
  elements.blockNumber.textContent = formatInteger(data.chain.blockNumber);
  elements.participantCount.textContent = `${formatInteger(participantCount)} 个地址`;
  elements.checkedAt.textContent = formatDate(data.checkedAt);
  elements.implementation.textContent = data.campaign.implementation;
  elements.paused.textContent = data.campaign.paused ? "是" : "否";

  setAddressLink(elements.campaignLink, data.campaign.contract, "address");
  setAddressLink(elements.usdcLink, data.asset.contract, "token");

  if (Array.isArray(data.history) && data.history.length > 0) {
    state.balanceSamples = data.history.map((sample) => ({
      value: Number(sample.stakedUsdc),
      time: new Date(sample.checkedAt),
      blockNumber: sample.blockNumber
    }));
    state.participantSamples = data.history.map((sample) => ({
      value: Number(sample.participantCount || 0),
      time: new Date(sample.checkedAt),
      blockNumber: sample.blockNumber
    }));
  } else {
    state.balanceSamples.push({
      value: staked,
      time: new Date(data.checkedAt),
      blockNumber: data.chain.blockNumber
    });
    state.participantSamples.push({
      value: participantCount,
      time: new Date(data.checkedAt),
      blockNumber: data.chain.blockNumber
    });

    if (state.balanceSamples.length > 80) {
      state.balanceSamples.shift();
      state.participantSamples.shift();
    }
  }

  const sourceLabel = getHistorySourceLabel(data.historyMeta?.source);
  elements.sampleCount.textContent = `${sourceLabel} · ${state.balanceSamples.length} 个趋势点`;
  elements.participantSampleCount.textContent = `独立转入地址 · ${state.participantSamples.length} 个趋势点`;
  drawTrendChart("balance", elements.balanceCanvas, state.balanceSamples, {
    unitLabel: "USDC",
    formatValue: formatAbbreviated,
    formatTooltipValue: (value) => `${formatNumber(value)} USDC`,
    tooltipLabel: "余额",
    lineColor: "#46d4a3"
  });
  drawTrendChart("participants", elements.participantCanvas, state.participantSamples, {
    unitLabel: "地址",
    formatValue: formatCompactCount,
    formatTooltipValue: (value) => `${formatInteger(value)} 个地址`,
    tooltipLabel: "参与地址",
    lineColor: "#89b4ff"
  });
}

function setAddressLink(element, address, path) {
  element.textContent = shortAddress(address);
  element.href = `https://bscscan.com/${path}/${address}`;
}

function setStatus(text, modifier) {
  elements.status.className = `status ${modifier}`.trim();
  elements.status.querySelector("span:last-child").textContent = text;
}

function getHistorySourceLabel(source) {
  if (source === "bsc_usdc_transfer_logs") {
    return "从活动开始至今";
  }

  if (source === "supabase_samples" || source === "supabase_samples_fallback") {
    return "Supabase 历史采样";
  }

  return "当前余额";
}

function drawTrendChart(chartKey, canvas, samples, options = {}) {
  const chart = state.charts[chartKey];
  chart.canvas = canvas;
  chart.samples = samples;
  chart.options = options;

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
  const values = samples.map((sample) => sample.value).filter((value) => Number.isFinite(value));

  if (!values.length) {
    drawEmpty(ctx, width, height);
    return;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, Math.max(Math.abs(max) * 0.002, 1));
  const lower = Math.max(0, min - span * 0.15);
  const upper = Math.max(max + span * 0.15, lower + span);
  const timeline = getTimeline(samples);
  const layout = {
    padding,
    chartWidth,
    chartHeight,
    lower,
    upper,
    timeline,
    width,
    height
  };
  chart.layout = layout;

  drawGrid(ctx, width, height, padding, chartWidth, chartHeight, lower, upper, timeline, options);

  if (samples.length < 2) {
    drawEmpty(ctx, width, height);
    return;
  }

  ctx.beginPath();
  samples.forEach((sample, index) => {
    const { x, y } = getPointPosition(sample, index, samples.length, layout);

    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });

  ctx.lineWidth = 3;
  ctx.strokeStyle = options.lineColor || "#46d4a3";
  ctx.stroke();

  const latest = samples[samples.length - 1];
  const { x: latestX, y: latestY } = getPointPosition(latest, samples.length - 1, samples.length, layout);
  ctx.fillStyle = "#f0b90b";
  ctx.beginPath();
  ctx.arc(latestX, latestY, 5, 0, Math.PI * 2);
  ctx.fill();

  if (Number.isInteger(chart.activeIndex) && samples[chart.activeIndex]) {
    drawActivePoint(ctx, samples[chart.activeIndex], chart.activeIndex, samples, layout, options);
  }
}

function drawGrid(ctx, width, height, padding, chartWidth, chartHeight, lower, upper, timeline, options = {}) {
  const formatValue = options.formatValue || formatAbbreviated;

  ctx.strokeStyle = "rgba(154, 168, 181, 0.16)";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#9aa8b5";
  ctx.font = "12px Inter, system-ui, sans-serif";
  ctx.textAlign = "left";

  for (let step = 0; step <= 4; step += 1) {
    const y = padding.top + (step / 4) * chartHeight;
    const value = upper - (step / 4) * (upper - lower);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
    ctx.fillText(formatValue(value), 12, y + 4);
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
  ctx.fillText(options.unitLabel || "", 12, 18);
}

function drawEmpty(ctx, width, height) {
  ctx.fillStyle = "#9aa8b5";
  ctx.font = "14px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("等待链上活动记录", width / 2, height / 2);
  ctx.textAlign = "left";
}

function setupChartInteraction(chartKey, canvas) {
  const updateActivePoint = (event) => {
    const chart = state.charts[chartKey];

    if (!chart?.layout || !chart.samples?.length) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    chart.activeIndex = findNearestPointIndex(chart, x, y);
    redrawChart(chartKey);
  };

  canvas.addEventListener("pointermove", updateActivePoint);
  canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture?.(event.pointerId);
    updateActivePoint(event);
  });
  canvas.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse") {
      state.charts[chartKey].activeIndex = null;
      redrawChart(chartKey);
    }
  });
}

function redrawChart(chartKey) {
  const chart = state.charts[chartKey];

  if (!chart?.canvas || !chart.samples || !chart.options) {
    return;
  }

  drawTrendChart(chartKey, chart.canvas, chart.samples, chart.options);
}

function findNearestPointIndex(chart, x, y) {
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  const samples = chart.samples;

  samples.forEach((sample, index) => {
    const point = getPointPosition(sample, index, samples.length, chart.layout);
    const distance = Math.abs(point.x - x) + Math.abs(point.y - y) * 0.18;

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  });

  return nearestIndex;
}

function getPointPosition(sample, index, count, layout) {
  const { padding, chartWidth, chartHeight, lower, upper, timeline } = layout;
  const x = getSampleX(sample, index, count, timeline, padding, chartWidth);
  const y = padding.top + (1 - (sample.value - lower) / (upper - lower)) * chartHeight;

  return { x, y };
}

function drawActivePoint(ctx, sample, index, samples, layout, options) {
  const point = getPointPosition(sample, index, samples.length, layout);
  const valueText = options.formatTooltipValue
    ? options.formatTooltipValue(sample.value)
    : options.formatValue(sample.value);
  const lines = [formatTooltipDate(sample.time), `${options.tooltipLabel || "数值"}：${valueText}`];

  ctx.save();
  ctx.strokeStyle = "rgba(240, 185, 11, 0.5)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(point.x, layout.padding.top);
  ctx.lineTo(point.x, layout.padding.top + layout.chartHeight);
  ctx.stroke();

  ctx.fillStyle = "#f0b90b";
  ctx.beginPath();
  ctx.arc(point.x, point.y, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#0b0f14";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.font = "12px Inter, system-ui, sans-serif";
  const boxWidth = Math.ceil(Math.max(...lines.map((line) => ctx.measureText(line).width)) + 26);
  const boxHeight = 58;
  const boxX =
    point.x + boxWidth + 16 > layout.width
      ? Math.max(8, point.x - boxWidth - 12)
      : Math.min(layout.width - boxWidth - 8, point.x + 12);
  const boxY =
    point.y - boxHeight - 14 < 8
      ? Math.min(layout.height - boxHeight - 8, point.y + 14)
      : point.y - boxHeight - 14;

  drawTooltipBox(ctx, boxX, boxY, boxWidth, boxHeight);
  ctx.fillStyle = "#9aa8b5";
  ctx.textAlign = "left";
  ctx.fillText(lines[0], boxX + 13, boxY + 22);
  ctx.fillStyle = "#f6f8fb";
  ctx.font = "13px Inter, system-ui, sans-serif";
  ctx.fillText(lines[1], boxX + 13, boxY + 43);
  ctx.restore();
}

function drawTooltipBox(ctx, x, y, width, height) {
  const radius = 8;

  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  ctx.fillStyle = "rgba(11, 15, 20, 0.95)";
  ctx.fill();
  ctx.strokeStyle = "rgba(154, 168, 181, 0.32)";
  ctx.lineWidth = 1;
  ctx.stroke();
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

function formatCompactCount(value) {
  if (Math.abs(value) < 1_000) {
    return formatInteger(value);
  }

  return formatAbbreviated(value);
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

function formatTooltipDate(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(value instanceof Date ? value : new Date(value));
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
