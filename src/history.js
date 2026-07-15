const DEFAULT_SAMPLE_MS = 5000;
const DEFAULT_OFFLINE_AFTER_MS = 20000;

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function offlineSample(reference = {}, timestamp = Date.now(), phase = 'offline', reason = 'gap') {
  return {
    t: timestamp,
    cpu: 0,
    memory: 0,
    memoryUsed: 0,
    memoryTotal: number(reference.memoryTotal),
    gpu: 0,
    gpuMemory: 0,
    gpuMemoryTotal: number(reference.gpuMemoryTotal),
    gpuTemp: 0,
    gpuName: reference.gpuName || '设备离线',
    diskRead: 0,
    diskWrite: 0,
    netDown: 0,
    netUp: 0,
    offline: true,
    offlinePhase: phase,
    offlineReason: reason
  };
}

function gapMarkers(previous, next, options = {}) {
  if (!previous?.t || !next?.t || next.t <= previous.t) return [];
  const sampleMs = number(options.sampleMs, DEFAULT_SAMPLE_MS);
  const offlineAfterMs = number(options.offlineAfterMs, DEFAULT_OFFLINE_AFTER_MS);
  if (next.t - previous.t <= offlineAfterMs) return [];

  const start = previous.offline
    ? previous.t
    : Math.min(previous.t + sampleMs, next.t - 1);
  const end = Math.max(start, next.t - sampleMs);
  const markers = [];
  if (!previous.offline) markers.push(offlineSample(previous, start, 'start', options.reason || 'gap'));
  if (end > start || !markers.length) markers.push(offlineSample(previous, end, 'end', options.reason || 'gap'));
  return markers;
}

function expandOfflineGaps(points, options = {}) {
  const expanded = [];
  for (const point of points || []) {
    const previous = expanded.at(-1);
    if (previous) expanded.push(...gapMarkers(previous, point, options));
    expanded.push(point);
  }
  return expanded;
}

function downsampleHistory(points, maxPoints = 1200) {
  if (points.length <= maxPoints) return points;
  const stride = Math.ceil(points.length / maxPoints);
  const keep = new Set([0, points.length - 1]);
  for (let index = 0; index < points.length; index += stride) keep.add(index);
  points.forEach((point, index) => {
    if (!point.offline) return;
    keep.add(index);
    if (index > 0) keep.add(index - 1);
    if (index + 1 < points.length) keep.add(index + 1);
  });
  return [...keep].sort((left, right) => left - right).map((index) => points[index]);
}

function prepareHistory(points, maxPoints = 1200, options = {}) {
  return downsampleHistory(expandOfflineGaps(points, options), maxPoints);
}

module.exports = {
  DEFAULT_SAMPLE_MS,
  DEFAULT_OFFLINE_AFTER_MS,
  offlineSample,
  gapMarkers,
  expandOfflineGaps,
  downsampleHistory,
  prepareHistory
};
