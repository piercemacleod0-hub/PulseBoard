let lastTimestamp = 0;
const sampleListeners = [];
const errorListeners = [];

async function request(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (response.status === 401 || response.redirected && response.url.includes('/login')) {
    location.href = '/login';
    throw new Error('登录已失效');
  }
  if (!response.ok) throw new Error(`请求失败：${response.status}`);
  return response.json();
}

window.pulseboard = {
  getHistory: async (rangeMs) => {
    const points = await request(`/api/history?range=${encodeURIComponent(rangeMs)}`);
    lastTimestamp = points.at(-1)?.t || 0;
    return points;
  },
  getLatest: () => request('/api/latest'),
  getAppInfo: () => request('/api/info'),
  exportHistory: async (rangeMs) => {
    const points = await request(`/api/history?range=${encodeURIComponent(rangeMs)}`);
    const cell = (value) => {
      const text = String(value ?? '');
      return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    const headers = ['时间', '状态', 'CPU(%)', '内存(%)', 'GPU(%)', 'GPU温度(°C)', '磁盘读取(B/s)', '磁盘写入(B/s)', '网络下载(B/s)', '网络上传(B/s)'];
    const rows = points.map((point) => [new Date(point.t).toLocaleString('zh-CN', { hour12: false }), point.offline ? '离线' : '在线', point.cpu, point.memory, point.gpu, point.gpuTemp, point.diskRead, point.diskWrite, point.netDown, point.netUp].map(cell).join(','));
    const blob = new Blob([`\uFEFF${headers.join(',')}\r\n${rows.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `PulseBoard-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
    return { canceled: false, count: points.length };
  },
  openData: () => { location.href = '/logout'; },
  onSample: (callback) => sampleListeners.push(callback),
  onError: (callback) => errorListeners.push(callback)
};

setInterval(async () => {
  try {
    const sample = await request('/api/latest');
    if (sample?.t && sample.t > lastTimestamp) {
      lastTimestamp = sample.t;
      sampleListeners.forEach((callback) => callback(sample));
    }
  } catch (error) {
    errorListeners.forEach((callback) => callback(error.message));
  }
}, 5000);
