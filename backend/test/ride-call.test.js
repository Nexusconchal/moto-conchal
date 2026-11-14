import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { createCallStore, CALL_RING_MS } from '../src/ride-call.js';

const offer = { type: 'offer', sdp: 'v=0 oferta de teste' };
const answer = { type: 'answer', sdp: 'v=0 resposta de teste' };

test('ligacao pelo app: cliente liga, motoboy ve o convite, atende e cada lado ve so o que precisa', () => {
  let at = 1000;
  const store = createCallStore({ now: () => at, randomId: () => 'c1' });
  const call = store.start('r1', 'cliente', offer);
  assert.equal(call.status, 'chamando');
  assert.equal(store.view('r1', 'motoboy').offer.sdp, offer.sdp);
  assert.equal(store.view('r1', 'cliente').offer, null);
  assert.throws(() => store.start('r1', 'motoboy', offer), /em andamento/);
  assert.throws(() => store.answer('r1', 'cliente', 'c1', answer), /So quem recebeu/);
  store.answer('r1', 'motoboy', 'c1', answer);
  assert.equal(store.view('r1', 'cliente').answer.sdp, answer.sdp);
  assert.equal(store.view('r1', 'motoboy').answer, null);
  store.end('r1', 'cliente', 'c1');
  assert.deepEqual([store.view('r1', 'motoboy').status, store.view('r1', 'motoboy').motivo], ['encerrada', 'encerrada']);
  at += 61000;
  assert.equal(store.view('r1', 'motoboy'), null);
});

test('ligacao sem resposta encerra sozinha; recusar e cancelar ficam registrados; convite invalido e recusado', () => {
  let at = 0;
  const store = createCallStore({ now: () => at });
  store.start('r2', 'motoboy', offer);
  at += CALL_RING_MS + 1;
  assert.equal(store.view('r2', 'cliente').motivo, 'sem_resposta');
  at += 70000;
  const id = store.start('r2', 'motoboy', offer).id;
  store.end('r2', 'cliente', id);
  assert.equal(store.view('r2', 'motoboy').motivo, 'recusada');
  at += 70000;
  const id2 = store.start('r2', 'cliente', offer).id;
  store.end('r2', 'cliente', id2);
  assert.equal(store.view('r2', 'motoboy').motivo, 'cancelada');
  assert.throws(() => store.start('r3', 'cliente', { type: 'answer', sdp: 'x'.repeat(20) }), /invalido/);
  assert.throws(() => store.start('r3', 'outro', offer), /nao autorizada/);
  assert.equal(store.view('r1', 'cliente'), null);
});

test('ficha da ligacao vale so para a corrida e o lado dela', () => {
  const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const ctx = vm.createContext({ crypto, Buffer, Date, CALL_TOKEN_SECRET: 'segredo', CALL_TOKEN_MS: 60000 });
  vm.runInContext(source.slice(source.indexOf('function callToken('), source.indexOf('async function rideCallContext(')), ctx);
  const token = ctx.callToken('r1', 'motoboy');
  assert.equal(ctx.callTokenRole('r1', token), 'motoboy');
  assert.equal(ctx.callTokenRole('r2', token), '');
  assert.equal(ctx.callTokenRole('r1', token.replace('motoboy.', 'cliente.')), '');
  assert.equal(ctx.callTokenRole('r1', 'lixo'), '');
});
