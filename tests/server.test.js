const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, stopServer } = require('../server');

function dayKey(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

test('Web 历史接口返回真实时间离线零值点', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulseboard-server-test-'));
  const now = Date.now();
  const first = { t: now - 60000, cpu: 70, memory: 40, gpu: 20, memoryTotal: 100, gpuMemoryTotal: 100, gpuName: 'Test GPU' };
  const last = { ...first, t: now, cpu: 30 };
  fs.writeFileSync(path.join(dataDir, `${dayKey(now)}.jsonl`), `${JSON.stringify(first)}\n${JSON.stringify(last)}\n`, 'utf8');
  const port = 18000 + process.pid % 1000;

  try {
    await startServer({ readOnly: true, dataDir, password: 'test-pass', port, version: 'test' });
    const login = await fetch(`http://127.0.0.1:${port}/login`, {
      method: 'POST',
      body: new URLSearchParams({ password: 'test-pass' }),
      redirect: 'manual'
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const response = await fetch(`http://127.0.0.1:${port}/api/history?range=3600000`, { headers: { cookie } });
    const points = await response.json();
    const offline = points.filter((point) => point.offline);
    assert.equal(response.status, 200);
    assert.equal(offline.length, 2);
    assert.ok(offline.every((point) => point.cpu === 0 && point.memory === 0 && point.gpu === 0));
    assert.deepEqual(points.map((point) => Boolean(point.offline)), [false, true, true, false]);
  } finally {
    await stopServer();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
