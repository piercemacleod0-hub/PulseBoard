const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const si = require('systeminformation');

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(__dirname, 'public');
let DATA_DIR = path.resolve(process.env.PULSEBOARD_DATA_DIR || path.join(__dirname, 'data'));
const HOST_PROC = path.resolve(process.env.HOST_PROC || '/proc');
const HOST_SYS = path.resolve(process.env.HOST_SYS || '/sys');
let PORT = Math.max(1, Math.min(65535, Number(process.env.PORT) || 8090));
const SAMPLE_MS = Math.max(2000, Number(process.env.PULSEBOARD_SAMPLE_MS) || 5000);
let RETENTION_DAYS = Math.max(1, Math.min(3650, Number(process.env.PULSEBOARD_RETENTION_DAYS) || 30));
let PASSWORD = process.env.PULSEBOARD_PASSWORD || 'pulseboard';
const MAX_POINTS = 1200;
const SESSION_TTL = 7 * 86400000;

let latest = null;
let collecting = false;
let lastCleanup = 0;
let readOnly = false;
let collectorTimer = null;
let serverVersion = '2.1.0';
let serverPlatform = 'NAS / Linux Web';
let serverHostName = null;
let previous = { cpu: null, disk: null, net: null, time: null };
const sessions = new Map();

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function dayKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function historyFile(timestamp = Date.now()) {
  return path.join(DATA_DIR, `${dayKey(timestamp)}.jsonl`);
}

function hasLinuxHostMetrics() {
  return process.platform === 'linux' && fs.existsSync(path.join(HOST_PROC, 'stat'));
}

function readCpuSnapshot() {
  const line = readText(path.join(HOST_PROC, 'stat')).split('\n').find((item) => item.startsWith('cpu '));
  const fields = line.trim().split(/\s+/).slice(1).map(number);
  const idle = (fields[3] || 0) + (fields[4] || 0);
  return { idle, total: fields.reduce((sum, value) => sum + value, 0) };
}

function readMemorySnapshot() {
  const values = {};
  for (const line of readText(path.join(HOST_PROC, 'meminfo')).split('\n')) {
    const match = line.match(/^([^:]+):\s+(\d+)/);
    if (match) values[match[1]] = Number(match[2]) * 1024;
  }
  const total = number(values.MemTotal);
  const available = number(values.MemAvailable, number(values.MemFree));
  return { total, used: Math.max(0, total - available) };
}

function readDiskSnapshot() {
  let readSectors = 0;
  let writeSectors = 0;
  const physical = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+|md\d+)$/;
  for (const line of readText(path.join(HOST_PROC, 'diskstats')).trim().split('\n')) {
    const fields = line.trim().split(/\s+/);
    const device = fields[2];
    if (!physical.test(device)) continue;
    readSectors += number(fields[5]);
    writeSectors += number(fields[9]);
  }
  return { readBytes: readSectors * 512, writeBytes: writeSectors * 512 };
}

function readNetworkSnapshot() {
  let down = 0;
  let up = 0;
  const ignored = /^(lo|docker\d*|veth|br-|virbr|cni|flannel|kube|zt)/;
  for (const line of readText(path.join(HOST_PROC, 'net', 'dev')).split('\n').slice(2)) {
    if (!line.includes(':')) continue;
    const [rawName, rawValues] = line.split(':');
    const name = rawName.trim();
    if (ignored.test(name)) continue;
    const values = rawValues.trim().split(/\s+/).map(number);
    down += values[0] || 0;
    up += values[8] || 0;
  }
  return { down, up };
}

function readHostName() {
  try { return readText(path.join(HOST_PROC, 'sys', 'kernel', 'hostname')).trim(); }
  catch { return os.hostname(); }
}

async function readGpu() {
  try {
    const query = '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu';
    const { stdout } = await execFileAsync('nvidia-smi', [query, '--format=csv,noheader,nounits'], { timeout: 3500 });
    const rows = stdout.trim().split('\n').map((line) => line.split(',').map((item) => item.trim()));
    if (!rows.length) throw new Error('no gpu');
    return {
      name: rows.length === 1 ? rows[0][0] : `${rows[0][0]} 等 ${rows.length} 张显卡`,
      utilization: rows.reduce((sum, row) => sum + number(row[1]), 0) / rows.length,
      memoryUsed: rows.reduce((sum, row) => sum + number(row[2]) * 1024 * 1024, 0),
      memoryTotal: rows.reduce((sum, row) => sum + number(row[3]) * 1024 * 1024, 0),
      temperature: Math.max(...rows.map((row) => number(row[4])))
    };
  } catch {
    return { name: '未检测到 NVIDIA GPU', utilization: 0, memoryUsed: 0, memoryTotal: 0, temperature: 0 };
  }
}

async function collectLinuxHost() {
  const now = Date.now();
  const cpu = readCpuSnapshot();
  const memory = readMemorySnapshot();
  const disk = readDiskSnapshot();
  const net = readNetworkSnapshot();
  const gpu = await readGpu();
  const elapsed = previous.time ? Math.max(.001, (now - previous.time) / 1000) : 0;
  const cpuDelta = previous.cpu ? cpu.total - previous.cpu.total : 0;
  const idleDelta = previous.cpu ? cpu.idle - previous.cpu.idle : 0;
  const cpuLoad = cpuDelta > 0 ? (cpuDelta - idleDelta) / cpuDelta * 100 : 0;
  const diskRead = previous.disk && elapsed ? Math.max(0, disk.readBytes - previous.disk.readBytes) / elapsed : 0;
  const diskWrite = previous.disk && elapsed ? Math.max(0, disk.writeBytes - previous.disk.writeBytes) / elapsed : 0;
  const netDown = previous.net && elapsed ? Math.max(0, net.down - previous.net.down) / elapsed : 0;
  const netUp = previous.net && elapsed ? Math.max(0, net.up - previous.net.up) / elapsed : 0;
  previous = { cpu, disk, net, time: now };
  return {
    t: now,
    cpu: cpuLoad,
    memory: memory.total ? memory.used / memory.total * 100 : 0,
    memoryUsed: memory.used,
    memoryTotal: memory.total,
    gpu: gpu.utilization,
    gpuMemory: gpu.memoryUsed,
    gpuMemoryTotal: gpu.memoryTotal,
    gpuTemp: gpu.temperature,
    gpuName: gpu.name,
    diskRead,
    diskWrite,
    netDown,
    netUp
  };
}

async function collectFallback() {
  const [load, memory, graphics, diskStats, networks] = await Promise.all([
    si.currentLoad(), si.mem(), si.graphics(), si.fsStats(), si.networkStats('*')
  ]);
  const controllers = graphics.controllers || [];
  const gpu = controllers.find((item) => /nvidia/i.test(item.vendor || item.model || '')) || controllers[0] || {};
  const net = (networks || []).filter((item) => item.operstate === 'up' || item.rx_sec > 0 || item.tx_sec > 0);
  return {
    t: Date.now(),
    cpu: number(load.currentLoad),
    memory: memory.total ? memory.active / memory.total * 100 : 0,
    memoryUsed: number(memory.active),
    memoryTotal: number(memory.total),
    gpu: number(gpu.utilizationGpu),
    gpuMemory: number(gpu.memoryUsed) * 1024 * 1024,
    gpuMemoryTotal: number(gpu.memoryTotal) * 1024 * 1024,
    gpuTemp: number(gpu.temperatureGpu),
    gpuName: gpu.model || '未检测到独立显卡',
    diskRead: number(diskStats?.rx_sec),
    diskWrite: number(diskStats?.wx_sec),
    netDown: net.reduce((sum, item) => sum + number(item.rx_sec), 0),
    netUp: net.reduce((sum, item) => sum + number(item.tx_sec), 0)
  };
}

async function collectSample() {
  if (collecting) return;
  collecting = true;
  try {
    latest = hasLinuxHostMetrics() ? await collectLinuxHost() : await collectFallback();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(historyFile(latest.t), `${JSON.stringify(latest)}\n`, 'utf8');
    if (Date.now() - lastCleanup > 3600000) cleanupOldFiles();
  } catch (error) {
    console.error('[PulseBoard] 采集失败:', error.message);
  } finally {
    collecting = false;
  }
}

function cleanupOldFiles() {
  lastCleanup = Date.now();
  if (!fs.existsSync(DATA_DIR)) return;
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  for (const file of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
    const timestamp = Date.parse(file.name.slice(0, 10));
    if (Number.isFinite(timestamp) && timestamp < cutoff - 86400000) fs.rmSync(path.join(DATA_DIR, file.name), { force: true });
  }
}

function readHistory(since) {
  if (!fs.existsSync(DATA_DIR)) return latest ? [latest] : [];
  const points = [];
  for (const file of fs.readdirSync(DATA_DIR).filter((name) => name.endsWith('.jsonl')).sort()) {
    const fileDate = Date.parse(file.slice(0, 10));
    if (Number.isFinite(fileDate) && fileDate + 86400000 < since) continue;
    for (const line of fs.readFileSync(path.join(DATA_DIR, file), 'utf8').split('\n')) {
      if (!line) continue;
      try { const point = JSON.parse(line); if (point.t >= since) points.push(point); }
      catch { /* 忽略异常末行 */ }
    }
  }
  if (points.length <= MAX_POINTS) return points;
  const stride = Math.ceil(points.length / MAX_POINTS);
  const sampled = points.filter((_point, index) => index % stride === 0);
  if (sampled.at(-1)?.t !== points.at(-1)?.t) sampled.push(points.at(-1));
  return sampled;
}

function readLatestFromHistory() {
  if (!fs.existsSync(DATA_DIR)) return latest;
  const file = fs.readdirSync(DATA_DIR).filter((name) => name.endsWith('.jsonl')).sort().at(-1);
  if (!file) return latest;
  const lines = fs.readFileSync(path.join(DATA_DIR, file), 'utf8').trim().split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch { /* 继续寻找上一条完整记录 */ }
  }
  return latest;
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((item) => item.trim().split('=').map(decodeURIComponent)).filter((pair) => pair.length === 2));
}

function isAuthenticated(request) {
  const token = parseCookies(request.headers.cookie).pb_session;
  const expires = token && sessions.get(token);
  if (!expires || expires < Date.now()) { if (token) sessions.delete(token); return false; }
  return true;
}

function secureEqual(input, expected) {
  const left = Buffer.from(input || '');
  const right = Buffer.from(expected || '');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function send(response, status, body, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'; connect-src 'self'",
    ...extraHeaders
  });
  response.end(body);
}

function json(response, value, status = 200) {
  send(response, status, JSON.stringify(value), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });
}

function redirect(response, location, cookie) {
  const headers = { Location: location };
  if (cookie) headers['Set-Cookie'] = cookie;
  response.writeHead(302, headers);
  response.end();
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; if (body.length > 8192) request.destroy(); });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function serveFile(response, file, contentType) {
  try { send(response, 200, fs.readFileSync(file), contentType, { 'Cache-Control': 'no-cache' }); }
  catch { send(response, 404, 'Not Found'); }
}

function loginPage(error) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 PulseBoard</title><link rel="stylesheet" href="/login.css"></head><body><main><div class="mark"><i></i><b></b><span></span></div><p class="eyebrow">PULSEBOARD NAS</p><h1>访问资源看板</h1><p class="copy">输入部署时设置的访问密码</p>${error ? '<p class="error">密码不正确，请重新输入</p>' : ''}<form method="post" action="/login"><label for="password">访问密码</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus><button type="submit">进入看板</button></form><small>所有监控数据仅保存在这台 NAS 上</small></main></body></html>`;
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (url.pathname === '/api/health') return json(response, { ok: true, version: serverVersion, mode: readOnly ? 'desktop-share' : 'standalone' });
  if (url.pathname === '/favicon.ico') { response.writeHead(204); return response.end(); }
  if (url.pathname === '/login.css') return serveFile(response, path.join(PUBLIC_DIR, 'login.css'), 'text/css; charset=utf-8');
  if (url.pathname === '/login' && request.method === 'GET') return send(response, 200, loginPage(url.searchParams.has('error')), 'text/html; charset=utf-8');
  if (url.pathname === '/login' && request.method === 'POST') {
    const form = new URLSearchParams(await readBody(request));
    if (!secureEqual(form.get('password'), PASSWORD)) return redirect(response, '/login?error=1');
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + SESSION_TTL);
    return redirect(response, '/', `pb_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}`);
  }
  if (url.pathname === '/logout') return redirect(response, '/login', 'pb_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  if (!isAuthenticated(request)) return redirect(response, '/login');

  if (url.pathname === '/api/latest') { if (readOnly) latest = readLatestFromHistory(); return json(response, latest); }
  if (url.pathname === '/api/info') return json(response, { version: serverVersion, retentionDays: RETENTION_DAYS, host: serverHostName || readHostName(), platform: serverPlatform });
  if (url.pathname === '/api/history') {
    const range = Math.min(Math.max(number(url.searchParams.get('range'), 21600000), 3600000), RETENTION_DAYS * 86400000);
    return json(response, readHistory(Date.now() - range));
  }
  if (url.pathname === '/') return serveFile(response, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8');
  if (url.pathname === '/web.css') return serveFile(response, path.join(PUBLIC_DIR, 'web.css'), 'text/css; charset=utf-8');
  if (url.pathname === '/bridge.js') return serveFile(response, path.join(PUBLIC_DIR, 'bridge.js'), 'text/javascript; charset=utf-8');
  if (url.pathname === '/assets/styles.css') return serveFile(response, path.join(ROOT, 'src', 'styles.css'), 'text/css; charset=utf-8');
  if (url.pathname === '/assets/renderer.js') return serveFile(response, path.join(ROOT, 'src', 'renderer.js'), 'text/javascript; charset=utf-8');
  send(response, 404, 'Not Found');
});

async function startServer(options = {}) {
  if (server.listening) return server;
  DATA_DIR = path.resolve(options.dataDir || DATA_DIR);
  PORT = Math.max(1, Math.min(65535, number(options.port, PORT)));
  PASSWORD = options.password || PASSWORD;
  if (!options.password && !process.env.PULSEBOARD_PASSWORD) console.warn('[PulseBoard] 未设置 PULSEBOARD_PASSWORD，当前使用开发密码 pulseboard。');
  RETENTION_DAYS = Math.max(1, Math.min(3650, number(options.retentionDays, RETENTION_DAYS)));
  readOnly = Boolean(options.readOnly);
  serverVersion = options.version || serverVersion;
  serverPlatform = options.platform || serverPlatform;
  serverHostName = options.hostName || null;
  sessions.clear();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (readOnly) latest = readLatestFromHistory();
  else {
    await collectSample();
    collectorTimer = setInterval(collectSample, SAMPLE_MS);
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '0.0.0.0', () => { server.removeListener('error', reject); resolve(); });
  });
  console.log(`[PulseBoard] Web 已启动：http://0.0.0.0:${PORT}`);
  return server;
}

async function stopServer() {
  if (collectorTimer) { clearInterval(collectorTimer); collectorTimer = null; }
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
  sessions.clear();
}

function shutdown() {
  stopServer().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { startServer, stopServer };

if (require.main === module) {
  startServer().catch((error) => {
    console.error('[PulseBoard] 启动失败:', error.message);
    process.exit(1);
  });
}
