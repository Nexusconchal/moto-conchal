import test from 'node:test';
import assert from 'node:assert/strict';
import { iosAlert, driverPlatform, IOS_CALL_SOUND } from '../src/ios-push.js';

test('aviso de chamada no iPhone: som de chamada, urgente (passa pelo modo Foco) e troca o aviso anterior', () => {
  const a = iosAlert('corrida_abc123');
  assert.equal(a.headers['apns-priority'], '10');
  assert.equal(a.headers['apns-push-type'], 'alert');
  assert.equal(a.headers['apns-collapse-id'], 'corrida_abc123', 'reenvio troca o aviso em vez de empilhar');
  assert.equal(a.payload.aps.sound, IOS_CALL_SOUND);
  assert.equal(a.payload.aps['interruption-level'], 'time-sensitive');
  assert.equal(a.payload.aps.threadId, 'corrida_abc123');
});

test('aviso comum no iPhone: som padrão, sem urgência; identificador sempre válido', () => {
  const a = iosAlert('cancelada', { urgent: false, sound: 'default' });
  assert.equal(a.payload.aps.sound, 'default');
  assert.equal(a.payload.aps['interruption-level'], undefined);
  assert.equal(iosAlert('a b/c'.repeat(30)).headers['apns-collapse-id'].length, 64);
  assert.match(iosAlert('a b/c').headers['apns-collapse-id'], /^[\w-]+$/);
  assert.notEqual(iosAlert('x'), iosAlert('x'), 'objeto novo a cada mensagem');
});

test('plataforma do aparelho: Android do app, iPhone do app ou navegador', () => {
  assert.equal(driverPlatform('android_nativo'), 'android_nativo');
  assert.equal(driverPlatform('ios_nativo'), 'ios_nativo');
  assert.equal(driverPlatform('qualquer'), 'web');
  assert.equal(driverPlatform(undefined), 'web');
});
