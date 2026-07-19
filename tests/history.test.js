const test = require('node:test');
const assert = require('node:assert/strict');
const { gapMarkers, expandOfflineGaps, prepareHistory } = require('../src/history');

function sample(t, overrides = {}) {
  return {
    t,
    cpu: 42,
    memory: 35,
    memoryTotal: 64 * 1024 ** 3,
    gpu: 18,
    gpuMemoryTotal: 24 * 1024 ** 3,
    gpuName: 'Test GPU',
    ...overrides
  };
}

test('短暂采集抖动不会被标记为离线', () => {
  assert.deepEqual(gapMarkers(sample(1000), sample(16000)), []);
});

test('30 秒低频采样不会把正常间隔误判为离线', () => {
  const first = sample(1000, { sampleIntervalMs: 30000 });
  const second = sample(31000, { sampleIntervalMs: 30000 });
  assert.deepEqual(gapMarkers(first, second), []);
});

test('切换采样频率时采用较长间隔判断离线', () => {
  const first = sample(1000, { sampleIntervalMs: 5000 });
  const second = sample(31000, { sampleIntervalMs: 30000 });
  assert.deepEqual(gapMarkers(first, second), []);
});

test('长时间空档会补齐离线开始和结束两个零值点', () => {
  const markers = gapMarkers(sample(1000), sample(31000), { sampleMs: 5000, offlineAfterMs: 20000 });
  assert.equal(markers.length, 2);
  assert.deepEqual(markers.map((point) => point.t), [6000, 26000]);
  assert.ok(markers.every((point) => point.offline && point.cpu === 0 && point.memory === 0 && point.gpu === 0));
});

test('已有退出标记时只补齐恢复前的离线结束点', () => {
  const previous = sample(6000, { offline: true });
  const markers = gapMarkers(previous, sample(31000), { sampleMs: 5000, offlineAfterMs: 20000 });
  assert.equal(markers.length, 1);
  assert.equal(markers[0].t, 26000);
  assert.equal(markers[0].offlinePhase, 'end');
});

test('历史抽样仍保留离线区间及其相邻在线点', () => {
  const points = Array.from({ length: 2000 }, (_value, index) => sample(1000 + index * 5000));
  points.splice(1000, 0, sample(points[999].t + 5000, { offline: true, cpu: 0, memory: 0, gpu: 0 }));
  const prepared = prepareHistory(points, 120, { sampleMs: 5000 });
  const offlineIndex = prepared.findIndex((point) => point.offline);
  assert.ok(offlineIndex > 0);
  assert.ok(offlineIndex < prepared.length - 1);
  assert.equal(prepared[offlineIndex - 1].offline, undefined);
  assert.equal(prepared[offlineIndex + 1].offline, undefined);
});

test('读取历史时可根据时间戳推断未正常退出造成的空档', () => {
  const expanded = expandOfflineGaps([sample(1000), sample(61000)], { sampleMs: 5000, offlineAfterMs: 20000 });
  assert.deepEqual(expanded.map((point) => [point.t, Boolean(point.offline)]), [
    [1000, false], [6000, true], [56000, true], [61000, false]
  ]);
});
