const SAMPLE_MS = 5000;
const OFFLINE_AFTER_MS = 20000;
const state = { points: [], range: 21600000, latest: null, info: null };
const colors = { cpu: '#63e5ff', memory: '#9b7cff', gpu: '#ffbd66', vram: '#4de0ac', disk: '#4de0ac', network: '#5f8cff' };
const interactions = new Map();
const $ = (id) => document.getElementById(id);

function clamp(value) { return Math.max(0, Math.min(100, Number(value) || 0)); }
function percent(value) { return clamp(value).toFixed(value < 10 ? 1 : 0); }
function bytes(value) {
  const amount = Number(value) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  if (amount <= 0) return '0 B';
  if (amount < 1) return `${amount.toFixed(1)} B`;
  const index = Math.min(Math.floor(Math.log(amount) / Math.log(1024)), units.length - 1);
  return `${(amount / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}
function rate(value) { return `${bytes(value)}/s`; }
function percentLabel(value) { return `${(Number(value) || 0).toFixed(value < 10 ? 1 : 0)}%`; }
function formatDuration(value) {
  const ms = Math.max(0, Number(value) || 0);
  if (ms < 10000) return '刚刚开始';
  if (ms < 60000) return `${Math.floor(ms / 1000)} 秒`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)} 分钟`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)} 小时 ${Math.floor(ms % 3600000 / 60000)} 分`;
  return `${Math.floor(ms / 86400000)} 天 ${Math.floor(ms % 86400000 / 3600000)} 小时`;
}

function offlinePoint(reference, timestamp, phase) {
  return {
    ...reference,
    t: timestamp,
    cpu: 0,
    memory: 0,
    memoryUsed: 0,
    gpu: 0,
    gpuMemory: 0,
    gpuTemp: 0,
    diskRead: 0,
    diskWrite: 0,
    netDown: 0,
    netUp: 0,
    offline: true,
    offlinePhase: phase
  };
}

function updateCards(sample) {
  if (!sample || sample.offline) return;
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
  $('lastUpdated').textContent = `更新于 ${new Date(sample.t).toLocaleString('zh-CN', { hour12: false })}`;
  $('statusText').textContent = '实时记录中';
  document.querySelector('.status')?.classList.remove('error');
}

function offlineRanges() {
  const ranges = [];
  let current = null;
  for (const point of state.points) {
    if (point.offline) {
      if (!current) current = { start: point.t, end: point.t };
      current.end = point.t;
    } else if (current) {
      ranges.push(current);
      current = null;
    }
  }
  if (current) {
    current.end = Math.max(current.end, Date.now());
    ranges.push(current);
  }
  return ranges;
}

function renderOverview() {
  const onlinePoints = state.points.filter((point) => !point.offline);
  const ranges = offlineRanges();
  const offlineMs = ranges.reduce((sum, range) => sum + Math.max(0, range.end - range.start), 0);
  let streakStart = onlinePoints[0]?.t;
  for (let index = state.points.length - 1; index >= 0; index -= 1) {
    if (state.points[index].offline) {
      streakStart = state.points.slice(index + 1).find((point) => !point.offline)?.t;
      break;
    }
  }
  const latestTime = onlinePoints.at(-1)?.t;
  if ($('streakValue')) $('streakValue').textContent = streakStart && latestTime ? formatDuration(latestTime - streakStart) : '--';
  if ($('offlineValue')) $('offlineValue').textContent = offlineMs ? formatDuration(offlineMs) : '无离线';
  if ($('pointsValue')) $('pointsValue').textContent = `${onlinePoints.length.toLocaleString('zh-CN')} 条`;
  if ($('autoStartValue')) {
    const autoStart = state.info?.autoStart;
    $('autoStartValue').textContent = autoStart?.supported ? (autoStart.active ? '已开启' : '未开启') : '后台常驻';
    $('autoStartValue').classList.toggle('warning', Boolean(autoStart?.supported && !autoStart.active));
  }
}

function nearestPointIndex(targetTime) {
  let bestIndex = 0;
  let bestDistance = Infinity;
  state.points.forEach((point, index) => {
    const distance = Math.abs(point.t - targetTime);
    if (distance < bestDistance) { bestDistance = distance; bestIndex = index; }
  });
  return bestIndex;
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
    return nearestPointIndex(meta.xMin + ratio * (meta.xMax - meta.xMin));
  };
  const redraw = () => { if (interaction.meta) drawChart(canvas, interaction.meta.series, interaction.meta.options); };
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
    interaction.tooltip.classList.remove('visible', 'locked', 'offline');
    return;
  }
  const point = state.points[index];
  const x = meta.xForTime(point.t);
  const rows = meta.series.map((item) => {
    const value = item.values[index] ?? 0;
    return `<div><i style="background:${item.color}"></i><span>${item.label}</span><strong>${item.formatter(value)}</strong></div>`;
  }).join('');
  const status = point.offline ? '<b>设备离线</b>' : '';
  interaction.tooltip.innerHTML = `<time>${formatExactTime(point.t)}${status}</time>${rows}<small>${interaction.locked ? '已锁定 · 再次点击解除' : '点击可锁定数据点'}</small>`;
  interaction.tooltip.style.left = `${canvas.offsetLeft + x}px`;
  interaction.tooltip.style.top = `${canvas.offsetTop + 12}px`;
  interaction.tooltip.classList.toggle('flip', x > canvas.clientWidth * .66);
  interaction.tooltip.classList.toggle('locked', interaction.locked);
  interaction.tooltip.classList.toggle('offline', Boolean(point.offline));
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
  const count = state.points.length;
  const allValues = series.flatMap((item) => item.values).filter(Number.isFinite);
  let max = options.percent ? 100 : Math.max(...allValues, 1) * 1.12;
  if (!options.percent) max = niceMaximum(max);
  const xMin = state.points[0]?.t || Date.now() - state.range;
  const xMax = Math.max(state.points.at(-1)?.t || Date.now(), xMin + 1);
  const xForTime = (timestamp) => pad.left + plotW * (timestamp - xMin) / (xMax - xMin);
  const interaction = getInteraction(canvas);
  interaction.meta = { canvas, series, options, pad, plotW, plotH, max, count, xMin, xMax, xForTime };

  ctx.clearRect(0, 0, width, height);
  ctx.font = '10px Microsoft YaHei UI';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const value = max * (1 - i / 4);
    const y = pad.top + plotH * i / 4;
    ctx.strokeStyle = 'rgba(255,255,255,.055)';
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
    ctx.fillStyle = '#74809a'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(options.axisFormatter(value), pad.left - 8, y);
  }
  if (!count) {
    ctx.fillStyle = '#74809a'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('正在积累历史数据…', pad.left + plotW / 2, pad.top + plotH / 2);
    interaction.tooltip.classList.remove('visible');
    return;
  }

  for (const range of offlineRanges()) {
    const left = Math.max(pad.left, xForTime(range.start));
    const right = Math.min(width - pad.right, xForTime(range.end));
    ctx.fillStyle = 'rgba(117,128,153,.085)';
    ctx.fillRect(left, pad.top, Math.max(2, right - left), plotH);
    ctx.save();
    ctx.setLineDash([3, 4]); ctx.strokeStyle = 'rgba(151,162,187,.24)';
    ctx.beginPath(); ctx.moveTo(left, pad.top); ctx.lineTo(left, pad.top + plotH); ctx.moveTo(right, pad.top); ctx.lineTo(right, pad.top + plotH); ctx.stroke();
    ctx.restore();
    if (right - left > 34) {
      ctx.fillStyle = 'rgba(171,181,201,.55)'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText('离线', (left + right) / 2, pad.top + 7);
    }
  }

  for (const item of series) {
    const values = item.values;
    if (!values.length) continue;
    const firstX = xForTime(state.points[0].t), lastX = xForTime(state.points.at(-1).t), bottom = pad.top + plotH;
    ctx.beginPath();
    values.forEach((value, index) => {
      const x = xForTime(state.points[index].t);
      const y = pad.top + plotH * (1 - Math.min(max, Math.max(0, value)) / max);
      index ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    const gradient = ctx.createLinearGradient(0, pad.top, 0, bottom);
    gradient.addColorStop(0, `${item.color}32`); gradient.addColorStop(1, `${item.color}00`);
    ctx.lineTo(lastX, bottom); ctx.lineTo(firstX, bottom); ctx.closePath(); ctx.fillStyle = gradient; ctx.fill();
    ctx.beginPath();
    values.forEach((value, index) => {
      const x = xForTime(state.points[index].t);
      const y = pad.top + plotH * (1 - Math.min(max, Math.max(0, value)) / max);
      index ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = item.color; ctx.lineWidth = 1.8; ctx.lineJoin = 'round'; ctx.stroke();
  }

  const timeLabels = [xMin, xMin + (xMax - xMin) / 2, xMax];
  ctx.fillStyle = '#65718a'; ctx.font = '10px Microsoft YaHei UI'; ctx.textBaseline = 'alphabetic';
  timeLabels.forEach((timestamp, index) => {
    ctx.textAlign = index === 0 ? 'left' : index === 2 ? 'right' : 'center';
    ctx.fillText(formatTime(timestamp), xForTime(timestamp), height - 4);
  });

  const index = interaction.index;
  if (index !== null && index >= 0 && index < count) {
    const x = xForTime(state.points[index].t);
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
  const date = new Date(timestamp);
  if (state.range > 86400000) return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:00`;
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}
function formatExactTime(timestamp) {
  return new Date(timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function renderCharts() {
  const points = state.points;
  const cpu = points.map((point) => Number(point.cpu) || 0), memory = points.map((point) => Number(point.memory) || 0);
  const gpu = points.map((point) => Number(point.gpu) || 0), vram = points.map((point) => point.gpuMemoryTotal ? point.gpuMemory / point.gpuMemoryTotal * 100 : 0);
  const disk = points.map((point) => (Number(point.diskRead) || 0) + (Number(point.diskWrite) || 0));
  const network = points.map((point) => (Number(point.netDown) || 0) + (Number(point.netUp) || 0));
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
  renderOverview();
}

async function loadHistory() {
  state.points = await window.pulseboard.getHistory(state.range);
  interactions.forEach((interaction) => { interaction.index = null; interaction.locked = false; });
  const latestOnline = [...state.points].reverse().find((point) => !point.offline);
  if (latestOnline) updateCards(latestOnline);
  renderCharts();
}

function showToast(message, kind = 'success') {
  const toast = $('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast show ${kind}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.className = 'toast'; }, 2600);
}

$('rangeSwitch').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-range]');
  if (!button) return;
  document.querySelectorAll('#rangeSwitch button').forEach((item) => item.classList.toggle('active', item === button));
  state.range = Number(button.dataset.range);
  await loadHistory();
});
$('openData').addEventListener('click', () => window.pulseboard.openData());
$('exportData')?.addEventListener('click', async () => {
  const button = $('exportData');
  button.disabled = true;
  const original = button.textContent;
  button.textContent = '正在导出…';
  try {
    const result = await window.pulseboard.exportHistory(state.range);
    if (!result?.canceled) showToast(`已导出 ${result.count || 0} 条记录`);
  } catch (error) { showToast(`导出失败：${error.message}`, 'error'); }
  finally { button.disabled = false; button.textContent = original; }
});

const settingsModal = $('settingsModal');
$('settingsButton')?.addEventListener('click', async () => {
  const current = await window.pulseboard.getSettings();
  $('launchAtLogin').checked = current.launchAtLogin;
  $('settingsMessage').textContent = current.autoStart.packaged ? '开机后会静默在系统托盘开始记录。' : '安装版中生效；开发预览不会修改 Windows 启动项。';
  settingsModal.classList.add('open');
  settingsModal.setAttribute('aria-hidden', 'false');
});
$('settingsClose')?.addEventListener('click', () => {
  settingsModal.classList.remove('open');
  settingsModal.setAttribute('aria-hidden', 'true');
});
$('settingsSave')?.addEventListener('click', async () => {
  const result = await window.pulseboard.updateSettings({ launchAtLogin: $('launchAtLogin').checked });
  state.info = state.info || {};
  state.info.autoStart = result.autoStart;
  renderOverview();
  $('settingsClose').click();
  showToast(result.launchAtLogin ? '开机自启动已开启' : '开机自启动已关闭');
});
settingsModal?.addEventListener('click', (event) => { if (event.target === settingsModal) $('settingsClose').click(); });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && settingsModal?.classList.contains('open')) $('settingsClose').click();
});

window.addEventListener('resize', () => requestAnimationFrame(renderCharts));
window.pulseboard.onSample((sample) => {
  updateCards(sample);
  const previous = state.points.at(-1);
  if (previous && sample.t - previous.t > OFFLINE_AFTER_MS) {
    if (!previous.offline) state.points.push(offlinePoint(previous, previous.t + SAMPLE_MS, 'start'));
    state.points.push(offlinePoint(previous, sample.t - SAMPLE_MS, 'end'));
  }
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
  document.querySelector('.status')?.classList.add('error');
});

(async () => {
  state.info = await window.pulseboard.getAppInfo();
  $('hostInfo').textContent = `${state.info.host} · PulseBoard ${state.info.version}`;
  await loadHistory();
  const latest = await window.pulseboard.getLatest();
  updateCards(latest);
})();
