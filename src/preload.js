const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pulseboard', {
  getHistory: (rangeMs) => ipcRenderer.invoke('history:get', rangeMs),
  getLatest: () => ipcRenderer.invoke('latest:get'),
  openData: () => ipcRenderer.invoke('data:open'),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  getSharing: () => ipcRenderer.invoke('sharing:get'),
  updateSharing: (settings) => ipcRenderer.invoke('sharing:update', settings),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  onSample: (callback) => ipcRenderer.on('sample', (_event, sample) => callback(sample)),
  onError: (callback) => ipcRenderer.on('collector-error', (_event, message) => callback(message)),
  onSharingError: (callback) => ipcRenderer.on('sharing-error', (_event, message) => callback(message))
});
