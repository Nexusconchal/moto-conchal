const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('nexus', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  chooseFolder: () => ipcRenderer.invoke('folder:choose'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  stop: () => ipcRenderer.invoke('capture:stop'),
  onStatus: (callback) => ipcRenderer.on('capture-status', (_event, status) => callback(status))
});
