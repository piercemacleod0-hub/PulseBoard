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
