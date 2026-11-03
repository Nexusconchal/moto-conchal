import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const block = source.slice(source.indexOf('const CAPTURE_PLATFORMS'), source.indexOf('function normalizeCapturedOrder('));
const context = vm.createContext({
  normalizeText: (v) => String(v || '').toLowerCase(),
  cleanText: (v, n) => String(v || '').slice(0, n)
});
vm.runInContext(`${block}
this.api = { capturePlatform, captureSource, companyCaptureConfig, captureSecretField };`, context);
const { capturePlatform, captureSource, companyCaptureConfig, captureSecretField } = context.api;

test('SeuComercioAqui e uma plataforma de captura que envia pela API', () => {
  assert.equal(capturePlatform('seucomercio'), 'seucomercio');
  assert.equal(captureSource('extension', 'seucomercio'), 'api');
  assert.equal(captureSource('', 'seucomercio'), 'api');
  assert.equal(companyCaptureConfig({}, 'seucomercio').captureMode, 'api');
  assert.equal(captureSecretField('seucomercio', 'api'), 'seucomercio_api');
});

test('outras plataformas continuam com a captura de antes', () => {
  assert.equal(captureSource('', 'anotaai'), 'whatsapp');
  assert.equal(captureSource('', 'beefood'), 'extension');
  assert.equal(captureSource('print', 'beefood'), 'print');
  assert.equal(capturePlatform('pediplus'), '');
});

test('consulta de status exige a chave da integracao e nao expoe outra empresa', () => {
  const route = source.slice(source.indexOf("app.get('/api/integrations/orders/:companyId/:platform/status'"), source.indexOf("app.get('/api/companies/me/captured-orders'"));
  assert.match(route, /safeEqual\(hashSecret\(suppliedKey\), expectedHash\)/);
  assert.match(route, /deliverySnap\.data\(\)\.empresaId === companyId/);
});
