const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const chokidar = require('chokidar');
const pdf = require('pdf-parse');

async function readOrderText(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const buffer = await fs.readFile(filePath);
  if (extension === '.pdf') return (await pdf(buffer)).text;
  if (['.txt', '.prn', '.spl'].includes(extension)) {
    const utf8 = buffer.toString('utf8').replace(/\0/g, '');
    const printable = utf8.replace(/[^\x09\x0a\x0d\x20-\x7e\u00c0-\u024f]/g, ' ');
    if (printable.replace(/\s/g, '').length < 30) throw new Error('Cupom sem texto legivel. Configure o BeeFood para imprimir em PDF ou TXT.');
    return printable;
  }
  throw new Error(`Formato nao suportado: ${extension}`);
}

function createCaptureService({ getConfig, onStatus }) {
  let watcher = null;
  const handled = new Set();

  async function processFile(filePath) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const config = getConfig();
    const stats = await fs.stat(filePath).catch(() => null);
    if (!stats || !stats.isFile()) return;
    const identity = crypto.createHash('sha256').update(`${filePath}:${stats.size}:${stats.mtimeMs}`).digest('hex');
    if (handled.has(identity)) return;
    handled.add(identity);
    try {
      const rawText = await readOrderText(filePath);
      const backend = String(config.backendUrl || '').replace(/\/$/, '');
      const response = await fetch(`${backend}/api/integrations/orders/${config.companyId}/beefood`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-nexus-capture-key': config.captureKey },
        body: JSON.stringify({ source: 'print', rawText, fileName: path.basename(filePath), capturedAt: Date.now() })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || data.error || `Servidor respondeu ${response.status}`);
      onStatus({ ok: true, message: data.duplicated ? 'Cupom repetido ignorado.' : `Pedido enviado: ${path.basename(filePath)}` });
    } catch (error) {
      onStatus({ ok: false, message: `${path.basename(filePath)}: ${error.message}` });
    }
  }

  async function start() {
    await stop();
    const config = getConfig();
    if (!config.watchFolder || !config.companyId || !config.captureKey) throw new Error('Informe pasta, WhatsApp da empresa e chave.');
    watcher = chokidar.watch(config.watchFolder, {
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
      depth: 0
    });
    watcher.on('add', processFile);
    watcher.on('error', (error) => onStatus({ ok: false, message: error.message }));
    onStatus({ ok: true, message: `Monitorando ${config.watchFolder}` });
  }

  async function stop() {
    if (watcher) await watcher.close();
    watcher = null;
  }

  return { start, stop, processFile };
}

module.exports = { createCaptureService, readOrderText };
