const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { createCaptureService } = require('./capture-service');

let window;
let tray;
let config = {};
let service;
const configPath = () => path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try { config = JSON.parse(fs.readFileSync(configPath(), 'utf8')); }
  catch { config = { backendUrl: 'https://motoboy-conchal.onrender.com', companyId: '', captureKey: '', watchFolder: '', autoStart: false }; }
}

function saveConfig(next) {
  config = { ...config, ...next, companyId: String(next.companyId || config.companyId || '').replace(/\D/g, '') };
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

function sendStatus(status) {
  window?.webContents.send('capture-status', status);
}

function createWindow() {
  window = new BrowserWindow({
    width: 620, height: 700, minWidth: 520, minHeight: 620,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  window.loadFile('index.html');
  window.on('close', (event) => {
    if (!app.isQuitting) { event.preventDefault(); window.hide(); }
  });
}

function trayIcon() {
  const size = 16;
  const bitmap = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const border = x < 2 || y < 2 || x > 13 || y > 13;
      bitmap[offset] = border ? 0 : 255;
      bitmap[offset + 1] = border ? 0 : 115;
      bitmap[offset + 2] = 0;
      bitmap[offset + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width: size, height: size });
}

app.whenReady().then(async () => {
  loadConfig();
  createWindow();
  service = createCaptureService({ getConfig: () => config, onStatus: sendStatus });
  tray = new Tray(trayIcon());
  tray.setToolTip('Nexus Captura');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir Nexus Captura', click: () => window.show() },
    { label: 'Sair', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
  tray.on('double-click', () => window.show());
  if (config.autoStart && config.watchFolder && config.companyId && config.captureKey) service.start().catch((error) => sendStatus({ ok: false, message: error.message }));
});

ipcMain.handle('config:get', () => ({ ...config, captureKey: config.captureKey ? '********' : '' }));
ipcMain.handle('folder:choose', async () => {
  const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? '' : result.filePaths[0];
});
ipcMain.handle('config:save', async (_event, next) => {
  if (next.captureKey === '********') delete next.captureKey;
  saveConfig(next);
  app.setLoginItemSettings({ openAtLogin: !!config.autoStart, args: ['--hidden'] });
  await service.start();
  return { ok: true };
});
ipcMain.handle('capture:stop', async () => { await service.stop(); return { ok: true }; });

app.on('before-quit', () => { app.isQuitting = true; service?.stop(); });
app.on('window-all-closed', () => {});
