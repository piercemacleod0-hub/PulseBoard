const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const si = require('systeminformation');
const execFileAsync = promisify(execFile);

const SAMPLE_MS = 5000;
const RETENTION_DAYS = 30;
const MAX_POINTS = 1200;
let mainWindow;
let tray;
let quitting = false;
let collecting = false;
let timer;
let latest = null;

const dataDir = path.join(app.getPath('userData'), 'history');

function dayKey(timestamp = Date.now()) {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function historyFile(timestamp = Date.now()) {
  return path.join(dataDir, `${dayKey(timestamp)}.jsonl`);
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function readDiskStats() {
  if (process.platform !== 'win32') return si.fsStats();
  try {
    const command = "Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk | Where-Object {$_.Name -eq '_Total'} | Select-Object DiskReadBytesPersec,DiskWriteBytesPersec | ConvertTo-Json -Compress";
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 4000 });
    const result = JSON.parse(stdout.trim());
    return { rx_sec: number(result.DiskReadBytesPersec), wx_sec: number(result.DiskWriteBytesPersec) };
  } catch {
    return { rx_sec: 0, wx_sec: 0 };
  }
}

async function collectSample() {
  if (collecting) return latest;
  collecting = true;
  try {
    const [load, memory, graphics, disks, networks] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.graphics(),
      readDiskStats(),
      si.networkStats('*')
    ]);

    const controllers = graphics.controllers || [];
    const gpu = controllers.find((item) => /nvidia/i.test(item.vendor || item.model || '')) || controllers[0] || {};
    const net = (networks || []).filter((item) => item.operstate === 'up' || item.rx_sec > 0 || item.tx_sec > 0);
    const diskStats = disks || {};
    latest = {
      t: Date.now(),
      cpu: number(load.currentLoad),
      memory: memory.total ? (memory.active / memory.total) * 100 : 0,
      memoryUsed: number(memory.active),
      memoryTotal: number(memory.total),
      gpu: number(gpu.utilizationGpu),
      gpuMemory: number(gpu.memoryUsed) * 1024 * 1024,
      gpuMemoryTotal: number(gpu.memoryTotal) * 1024 * 1024,
      gpuTemp: number(gpu.temperatureGpu),
      gpuName: gpu.model || '未检测到独立显卡',
      diskRead: number(diskStats.rx_sec),
      diskWrite: number(diskStats.wx_sec),
      netDown: net.reduce((sum, item) => sum + number(item.rx_sec), 0),
      netUp: net.reduce((sum, item) => sum + number(item.tx_sec), 0)
    };
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(historyFile(latest.t), `${JSON.stringify(latest)}\n`, 'utf8');
    cleanupOldFiles();
    mainWindow?.webContents.send('sample', latest);
    return latest;
  } catch (error) {
    mainWindow?.webContents.send('collector-error', error.message);
    return latest;
  } finally {
    collecting = false;
  }
}

function cleanupOldFiles() {
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  for (const file of fs.readdirSync(dataDir, { withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
    const stamp = Date.parse(file.name.slice(0, 10));
    if (Number.isFinite(stamp) && stamp < cutoff - 86400000) {
      fs.rmSync(path.join(dataDir, file.name), { force: true });
    }
  }
}

function readHistory(since) {
  if (!fs.existsSync(dataDir)) return latest ? [latest] : [];
  const points = [];
  const files = fs.readdirSync(dataDir).filter((name) => name.endsWith('.jsonl')).sort();
  for (const file of files) {
    const fileDate = Date.parse(file.slice(0, 10));
    if (Number.isFinite(fileDate) && fileDate + 86400000 < since) continue;
    const lines = fs.readFileSync(path.join(dataDir, file), 'utf8').split('\n');
    for (const line of lines) {
      if (!line) continue;
      try {
        const point = JSON.parse(line);
        if (point.t >= since) points.push(point);
      } catch { /* 跳过不完整的末行 */ }
    }
  }
  if (points.length <= MAX_POINTS) return points;
  const stride = Math.ceil(points.length / MAX_POINTS);
  const sampled = [];
  for (let i = 0; i < points.length; i += stride) sampled.push(points[i]);
  if (sampled.at(-1)?.t !== points.at(-1)?.t) sampled.push(points.at(-1));
  return sampled;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: '#080b14',
    title: 'PulseBoard 资源看板',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  if (process.env.PULSEBOARD_SCREENSHOT) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        await mainWindow.webContents.executeJavaScript(`
          (() => {
            const canvas = document.getElementById('cpuChart');
            const rect = canvas.getBoundingClientRect();
            canvas.dispatchEvent(new MouseEvent('click', {
              bubbles: true,
              clientX: rect.left + rect.width * 0.72,
              clientY: rect.top + rect.height * 0.45
            }));
          })()
        `);
        await new Promise((resolve) => setTimeout(resolve, 250));
        const image = await mainWindow.webContents.capturePage();
        fs.writeFileSync(process.env.PULSEBOARD_SCREENSHOT, image.toPNG());
      }, 7000);
    });
  }
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'build', 'icon.svg');
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) icon = nativeImage.createEmpty();
  tray = new Tray(icon.resize({ width: 20, height: 20 }));
  tray.setToolTip('PulseBoard 资源看板');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开看板', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { label: '打开数据目录', click: () => shell.openPath(dataDir) },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
}

app.whenReady().then(async () => {
  createWindow();
  createTray();
  await collectSample();
  timer = setInterval(collectSample, SAMPLE_MS);
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
  mainWindow.show();
});

app.on('before-quit', () => {
  quitting = true;
  clearInterval(timer);
});

app.on('window-all-closed', (event) => event.preventDefault());

ipcMain.handle('history:get', (_event, rangeMs) => {
  const safeRange = Math.min(Math.max(number(rangeMs, 3600000), 3600000), RETENTION_DAYS * 86400000);
  return readHistory(Date.now() - safeRange);
});
ipcMain.handle('latest:get', () => latest);
ipcMain.handle('data:open', () => shell.openPath(dataDir));
ipcMain.handle('app:info', () => ({ version: app.getVersion(), retentionDays: RETENTION_DAYS, host: os.hostname() }));
