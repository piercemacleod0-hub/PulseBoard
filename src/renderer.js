const state = { points: [], range: 21600000, latest: null };
const colors = { cpu: '#63e5ff', memory: '#9b7cff', gpu: '#ffbd66', vram: '#4de0ac', disk: '#4de0ac', network: '#5f8cff' };
const interactions = new Map();
const $ = (id) => document.getElementById(id);

function clamp(value) { return Math.max(0, Math.min(100, Number(value) || 0)); }
function percent(value) { return clamp(value).toFixed(value < 10 ? 1 : 0); }
function bytes(value) {
  const amount = Number(value) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  if (amount <= 0) return '0 B';
  const index = Math.min(Math.floor(Math.log(amount) / Math.log(1024)), units.length - 1);
  return `${(amount / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}
function rate(value) { return `${bytes(value)}/s`; }
function percentLabel(value) { return `${(Number(value) || 0).toFixed(value < 10 ? 1 : 0)}%`; }

function updateCards(sample) {
  if (!sample) return;
  state.latest = sample;
  const vramPct = sample.gpuMemoryTotal ? sample.gpuMemory / sample.gpuMemoryTotal * 100 : 0;
  $('cpuValue').textContent = percent(sample.cpu);
  $('memoryValue').textContent = percent(sample.memory);
  $('gpuValue').textContent = percent(sample.gpu);
  $('vramValue').textContent = percent(vramPct);
  $('cpuBar').style.width = `${clamp(sample.cpu)}%`;
  $('memoryBar').style.width = `${clamp(sample.memory)}%`;
  $('gpuBar').style.width = `${clamp(sample.gpu)}%`;
  $('vramBar').style.width = `${clamp(vramPct)}%`;
  $('memoryDetail').textContent = `${bytes(sample.memoryUsed)} / ${bytes(sample.memoryTotal)}`;
  $('vramDetail').textContent = sample.gpuMemoryTotal ? `${bytes(sample.gpuMemory)} / ${bytes(sample.gpuMemoryTotal)}` : '暂无数据';
  $('gpuTemp').textContent = sample.gpuTemp ? `${sample.gpuTemp.toFixed(0)} °C` : '-- °C';
  $('gpuName').textContent = sample.gpuName;
  $('diskNow').textContent = `读 ${rate(sample.diskRead)} · 写 ${rate(sample.diskWrite)}`;
  $('netNow').textContent = `下 ${rate(sample.netDown)} · 上 ${rate(sample.netUp)}`;
  $('lastUpdated').textContent = `更新于 ${new Date(sample.t).toLocaleTimeString('zh-CN', { hour12: false })}`;
}

function getInteraction(canvas) {
  if (interactions.has(canvas.id)) return interactions.get(canvas.id);
  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  canvas.parentElement.appendChild(tooltip);
  const interaction = { index: null, locked: false, tooltip, meta: null };
  interactions.set(canvas.id, interaction);

  const nearestIndex = (event) => {
    const meta = interaction.meta;
    if (!meta || meta.count < 1) return null;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, (x - meta.pad.left) / meta.plotW));
    return Math.round(ratio * Math.max(0, meta.count - 1));
  };
  const redraw = () => {
    if (interaction.meta) drawChart(canvas, interaction.meta.series, interaction.meta.options);
  };
  canvas.addEventListener('pointermove', (event) => {
    if (interaction.locked) return;
    interaction.index = nearestIndex(event);
    redraw();
  });
  canvas.addEventListener('pointerleave', () => {
    if (interaction.locked) return;
    interaction.index = null;
    redraw();
  });
  canvas.addEventListener('click', (event) => {
    const index = nearestIndex(event);
    if (interaction.locked && interaction.index === index) {
      interaction.locked = false;
      interaction.index = null;
    } else {
      interaction.locked = true;
      interaction.index = index;
    }
    redraw();
  });
  return interaction;
}

function showTooltip(canvas, interaction, index, meta) {
  if (index === null || !state.points[index]) {
    interaction.tooltip.classList.remove('visible', 'locked');
    return;
  }
  const point = state.points[index];
  const x = meta.pad.left + meta.plotW * (meta.count === 1 ? 1 : index / (meta.count - 1));
  const rows = meta.series.map((item) => {
    const value = item.values[index] ?? 0;
    return `<div><i style="background:${item.color}"></i><span>${item.label}</span><strong>${item.formatter(value)}</strong></div>`;
  }).join('');
  interaction.tooltip.innerHTML = `<time>${formatExactTime(point.t)}</time>${rows}<small>${interaction.locked ? '已锁定 · 再次点击解除' : '点击可锁定数据点'}</small>`;
  interaction.tooltip.style.left = `${canvas.offsetLeft + x}px`;
  interaction.tooltip.style.top = `${canvas.offsetTop + 12}px`;
  interaction.tooltip.classList.toggle('flip', x > canvas.clientWidth * .66);
  interaction.tooltip.classList.toggle('locked', interaction.locked);
  interaction.tooltip.classList.add('visible');
}

function drawChart(canvas, series, options = {}) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const width = rect.width, height = rect.height;
  const pad = { left: options.percent ? 43 : 58, right: 7, top: 10, bottom: 24 };
  const plotW = width - pad.left - pad.right, plotH = height - pad.top - pad.bottom;
  const count = Math.max(0, ...series.map((item) => item.values.length));
  const allValues = series.flatMap((item) => item.values).filter(Number.isFinite);
  let max = options.percent ? 100 : Math.max(...allValues, 1) * 1.12;
  if (!options.percent) max = niceMaximum(max);
  const interaction = getInteraction(canvas);
  interaction.meta = { canvas, series, options, pad, plotW, plotH, max, count };

  ctx.clearRect(0, 0, width, height);
  ctx.font = '10px Microsoft YaHei UI';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const value = max * (1 - i / 4);
    const y = pad.top + plotH * i / 4;
    ctx.strokeStyle = 'rgba(255,255,255,.055)';
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
    ctx.fillStyle = '#667089'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(options.axisFormatter(value), pad.left - 8, y);
  }
  if (!count) {
    ctx.fillStyle = '#667089'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('正在积累历史数据…', pad.left + plotW / 2, pad.top + plotH / 2);
    interaction.tooltip.classList.remove('visible');
    return;
  }

  for (const item of series) {
    const values = item.values;
    if (!values.length) continue;
    ctx.beginPath();
    values.forEach((value, index) => {
      const x = pad.left + plotW * (count === 1 ? 1 : index / (count - 1));
      const y = pad.top + plotH * (1 - Math.min(max, Math.max(0, value)) / max);
      index ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    const lastX = pad.left + plotW, bottom = pad.top + plotH;
    const gradient = ctx.createLinearGradient(0, pad.top, 0, bottom);
    gradient.addColorStop(0, `${item.color}35`); gradient.addColorStop(1, `${item.color}00`);
    ctx.lineTo(lastX, bottom); ctx.lineTo(pad.left, bottom); ctx.closePath(); ctx.fillStyle = gradient; ctx.fill();
    ctx.beginPath();
    values.forEach((value, index) => {
      const x = pad.left + plotW * (count === 1 ? 1 : index / (count - 1));
      const y = pad.top + plotH * (1 - Math.min(max, Math.max(0, value)) / max);
      index ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = item.color; ctx.lineWidth = 1.8; ctx.lineJoin = 'round'; ctx.stroke();
  }

  const first = state.points[0]?.t, last = state.points.at(-1)?.t;
  if (first && last) {
    ctx.fillStyle = '#59647d'; ctx.font = '10px Microsoft YaHei UI'; ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left'; ctx.fillText(formatTime(first), pad.left, height - 4);
    ctx.textAlign = 'right'; ctx.fillText(formatTime(last), width - pad.right, height - 4);
  }

  const index = interaction.index;
  if (index !== null && index >= 0 && index < count) {
    const x = pad.left + plotW * (count === 1 ? 1 : index / (count - 1));
    ctx.save();
    ctx.setLineDash([4, 4]); ctx.strokeStyle = interaction.locked ? 'rgba(255,255,255,.55)' : 'rgba(255,255,255,.3)';
    ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + plotH); ctx.stroke(); ctx.restore();
    for (const item of series) {
      const value = item.values[index] ?? 0;
      const y = pad.top + plotH * (1 - Math.min(max, Math.max(0, value)) / max);
      ctx.beginPath(); ctx.arc(x, y, interaction.locked ? 4.5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#0c1120'; ctx.fill(); ctx.strokeStyle = item.color; ctx.lineWidth = 2; ctx.stroke();
    }
  }
  showTooltip(canvas, interaction, index, interaction.meta);
}

function niceMaximum(value) {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const scaled = value / power;
  const nice = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return nice * power;
}

function formatTime(timestamp) {
  const d = new Date(timestamp);
  if (state.range > 86400000) return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:00`;
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}
function formatExactTime(timestamp) {
  return new Date(timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function renderCharts() {
  const p = state.points;
  const cpu = p.map(x => Number(x.cpu) || 0), memory = p.map(x => Number(x.memory) || 0);
  const gpu = p.map(x => Number(x.gpu) || 0), vram = p.map(x => x.gpuMemoryTotal ? x.gpuMemory / x.gpuMemoryTotal * 100 : 0);
  const disk = p.map(x => (Number(x.diskRead) || 0) + (Number(x.diskWrite) || 0));
  const network = p.map(x => (Number(x.netDown) || 0) + (Number(x.netUp) || 0));
  const percentOptions = { percent: true, axisFormatter: (value) => `${value.toFixed(0)}%` };
  const rateOptions = { percent: false, axisFormatter: (value) => rate(value) };
  drawChart($('cpuChart'), [{ label: 'CPU 使用率', values: cpu, color: colors.cpu, formatter: percentLabel }], percentOptions);
  drawChart($('memoryChart'), [{ label: '内存使用率', values: memory, color: colors.memory, formatter: percentLabel }], percentOptions);
  drawChart($('gpuChart'), [
    { label: 'GPU 使用率', values: gpu, color: colors.gpu, formatter: percentLabel },
    { label: '显存使用率', values: vram, color: colors.vram, formatter: percentLabel }
  ], percentOptions);
  drawChart($('diskChart'), [{ label: '磁盘吞吐', values: disk, color: colors.disk, formatter: rate }], rateOptions);
  drawChart($('networkChart'), [{ label: '网络流量', values: network, color: colors.network, formatter: rate }], rateOptions);
  $('cpuPeak').textContent = `峰值 ${Math.max(...cpu, 0).toFixed(0)}%`;
  $('memoryPeak').textContent = `峰值 ${Math.max(...memory, 0).toFixed(0)}%`;
}

async function loadHistory() {
  state.points = await window.pulseboard.getHistory(state.range);
  interactions.forEach((interaction) => { interaction.index = null; interaction.locked = false; });
  if (state.points.length) updateCards(state.points.at(-1));
  renderCharts();
}

$('rangeSwitch').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-range]');
  if (!button) return;
  document.querySelectorAll('#rangeSwitch button').forEach((item) => item.classList.toggle('active', item === button));
  state.range = Number(button.dataset.range);
  await loadHistory();
});
$('openData').addEventListener('click', () => window.pulseboard.openData());
window.addEventListener('resize', () => requestAnimationFrame(renderCharts));
window.pulseboard.onSample((sample) => {
  updateCards(sample);
  state.points.push(sample);
  const cutoff = Date.now() - state.range;
  state.points = state.points.filter((point) => point.t >= cutoff);
  interactions.forEach((interaction) => {
    if (interaction.locked && interaction.index !== null) interaction.index = Math.min(interaction.index, state.points.length - 1);
  });
  renderCharts();
});
window.pulseboard.onError((message) => {
  $('statusText').textContent = `采集异常：${message}`;
  document.querySelector('.status-dot').style.background = '#ff6b7a';
});

(async () => {
  const info = await window.pulseboard.getAppInfo();
  $('hostInfo').textContent = `${info.host} · PulseBoard ${info.version}`;
  await loadHistory();
  const latest = await window.pulseboard.getLatest();
  updateCards(latest);
})();
