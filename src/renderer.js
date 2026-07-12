const state = { points: [], range: 21600000, latest: null };
const colors = { cpu: '#63e5ff', memory: '#9b7cff', gpu: '#ffbd66', vram: '#4de0ac', disk: '#4de0ac', network: '#5f8cff' };
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
  $('diskNow').textContent = `读 ${bytes(sample.diskRead)}/s · 写 ${bytes(sample.diskWrite)}/s`;
  $('netNow').textContent = `下 ${bytes(sample.netDown)}/s · 上 ${bytes(sample.netUp)}/s`;
  $('lastUpdated').textContent = `更新于 ${new Date(sample.t).toLocaleTimeString('zh-CN', { hour12: false })}`;
}

function drawChart(canvas, series, options = {}) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const width = rect.width, height = rect.height;
  const pad = { left: 4, right: 4, top: 10, bottom: 22 };
  const plotW = width - pad.left - pad.right, plotH = height - pad.top - pad.bottom;
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(255,255,255,.055)'; ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) { const y = pad.top + plotH * i / 3; ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke(); }
  if (!series.length || !series[0].values.length) {
    ctx.fillStyle = '#667089'; ctx.font = '12px Microsoft YaHei UI'; ctx.textAlign = 'center'; ctx.fillText('正在积累历史数据…', width / 2, height / 2); return;
  }
  const allValues = series.flatMap((item) => item.values).filter(Number.isFinite);
  let max = options.max || Math.max(...allValues, 1) * 1.12;
  if (options.percent) max = 100;
  const count = Math.max(...series.map((item) => item.values.length));
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
    ctx.fillStyle = '#59647d'; ctx.font = '10px Microsoft YaHei UI';
    ctx.textAlign = 'left'; ctx.fillText(formatTime(first), pad.left, height - 4);
    ctx.textAlign = 'right'; ctx.fillText(formatTime(last), width - pad.right, height - 4);
  }
}

function formatTime(timestamp) {
  const d = new Date(timestamp);
  if (state.range > 86400000) return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:00`;
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function renderCharts() {
  const p = state.points;
  const cpu = p.map(x => Number(x.cpu) || 0), memory = p.map(x => Number(x.memory) || 0);
  const gpu = p.map(x => Number(x.gpu) || 0), vram = p.map(x => x.gpuMemoryTotal ? x.gpuMemory / x.gpuMemoryTotal * 100 : 0);
  const disk = p.map(x => (Number(x.diskRead) || 0) + (Number(x.diskWrite) || 0));
  const network = p.map(x => (Number(x.netDown) || 0) + (Number(x.netUp) || 0));
  drawChart($('cpuChart'), [{ values: cpu, color: colors.cpu }], { percent: true });
  drawChart($('memoryChart'), [{ values: memory, color: colors.memory }], { percent: true });
  drawChart($('gpuChart'), [{ values: gpu, color: colors.gpu }, { values: vram, color: colors.vram }], { percent: true });
  drawChart($('diskChart'), [{ values: disk, color: colors.disk }]);
  drawChart($('networkChart'), [{ values: network, color: colors.network }]);
  $('cpuPeak').textContent = `峰值 ${Math.max(...cpu, 0).toFixed(0)}%`;
  $('memoryPeak').textContent = `峰值 ${Math.max(...memory, 0).toFixed(0)}%`;
}

async function loadHistory() {
  state.points = await window.pulseboard.getHistory(state.range);
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
