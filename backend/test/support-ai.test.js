import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiSupport, filterGeminiText, validateGeminiAnswer, reserveSupportAiQuota } from '../src/gemini-support.js';
import { createOpenRouterSupport, createSupportAiChain } from '../src/openrouter-support.js';

const good = { reply: 'Abra o app e confira o ponto no mapa. O problema aparece na saída ou no destino?', topic: 'address' };
const geminiResponse = (value = good, finishReason = 'STOP') => ({ ok: true, json: async () => ({ candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(value) }] } }] }) });
const routerResponse = (value = good) => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }) });

test('filters contact details, addresses, ride codes and refuses credentials before either provider', async () => {
  const raw = 'Olá João, email cliente@example.com, telefone (19) 99999-0000; pedido c59de63b4-39799232; Rua Antônio Coraini 610; https://example.com/privado';
  const filtered = filterGeminiText(raw);
  for (const secret of ['João', 'cliente@example.com', '99999', 'c59de63b4', 'Coraini', 'example.com']) assert.ok(!filtered.includes(secret));
  assert.equal(filterGeminiText('meu CPF é 12345678901'), '');
  assert.equal(filterGeminiText('minha senha é abc'), '');
  let calls = 0;
  for (const create of [createGeminiSupport, createOpenRouterSupport]) {
    const service = create({ fetchImpl: async () => { calls++; } });
    await service.generate({ apiKey: 'test-key', text: 'meu CPF é 12345678901' });
  }
  assert.equal(calls, 0);
});

test('validates AI output and rejects action claims, prices, ETA, foreign links and malformed output', () => {
  assert.ok(validateGeminiAnswer(good));
  for (const reply of ['Cancelei sua corrida.', 'Sua corrida está confirmada.', 'Motorista está a caminho.', 'Chega em 5 minutos.', 'Custa R$ 15.', 'Clique https://evil.example/', 'Digite sua senha aqui.', '<script>alert(1)</script>']) assert.equal(validateGeminiAnswer({ reply, topic: 'other' }), null, reply);
  assert.equal(validateGeminiAnswer({ reply: 'Olá', topic: 'unknown' }), null);
});

test('Gemini sends filtered text, bounded context and secret header to a fixed endpoint, no customer record', async () => {
  let request;
  const service = createGeminiSupport({ fetchImpl: async (url, options) => { request = { url, options }; return geminiResponse(); } });
  const result = await service.generate({ apiKey: 'secret-key', text: 'Quero corrigir GPS', topic: 'address', history: [{ role: 'user', text: 'Meu telefone (19) 99999-0000' }] });
  assert.ok(result.answer);
  assert.ok(!request.url.includes('secret-key'));
  assert.equal(request.options.headers['x-goog-api-key'], 'secret-key');
  const payload = JSON.parse(request.options.body);
  assert.ok(!request.options.body.includes('99999-0000'));
  assert.equal(payload.generationConfig.maxOutputTokens, 500);
  assert.equal(payload.tools, undefined);
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
  assert.ok(result.history.length <= 4);
});

test('429 cooldown stops repeated requests and recovers; missing key and paid model never call API', async () => {
  let time = 1800000000000, calls = 0;
  const service = createGeminiSupport({ now: () => time, fetchImpl: async () => { calls++; return calls === 1 ? { ok: false, status: 429 } : geminiResponse(); } });
  const input = { apiKey: 'secret', text: 'Quero corrigir GPS' };
  assert.equal((await service.generate(input)).reason, 'quota');
  await service.generate(input); assert.equal(calls, 1);
  time += 301000; assert.ok((await service.generate(input)).answer); assert.equal(calls, 2);
  await service.generate({ ...input, model: 'expensive-model' }); await service.generate({ ...input, apiKey: '' }); assert.equal(calls, 2);
});

test('network failure, truncated JSON and unsafe model answer return null rather than breaking support', async () => {
  for (const fetchImpl of [async () => { throw Error('offline secret-key'); }, async () => geminiResponse(good, 'MAX_TOKENS'), async () => geminiResponse({ reply: 'Cancelei sua corrida', topic: 'other' })]) {
    const service = createGeminiSupport({ fetchImpl });
    assert.equal((await service.generate({ apiKey: 'secret', text: 'Quero ajuda' })).answer, null);
  }
});

test('OpenRouter can only select the free router and zero-price endpoints with data-policy restriction', async () => {
  let payload;
  const service = createOpenRouterSupport({ fetchImpl: async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer router-key'); payload = JSON.parse(options.body); return routerResponse();
  } });
  assert.ok((await service.generate({ apiKey: 'router-key', text: 'Quero corrigir GPS', model: 'paid/model' })).answer);
  assert.equal(payload.model, 'openrouter/free');
  assert.deepEqual(payload.provider.max_price, { prompt: 0, completion: 0 });
  assert.equal(payload.provider.data_collection, 'deny');
  assert.equal(payload.provider.require_parameters, true);
  assert.equal(payload.tools, undefined);
});

test('chain uses Gemini first, OpenRouter only after failure, then deterministic fallback', async () => {
  const calls = []; let primary = true, secondary = true;
  const chain = createSupportAiChain({ decrypt: x => x, gemini: { generate: async () => { calls.push('gemini'); return primary ? { answer: good } : { answer: null }; } }, openRouter: { generate: async () => { calls.push('openrouter'); return secondary ? { answer: good } : { answer: null }; } } });
  const config = { geminiEnabled: true, geminiFreeTierConfirmed: true, geminiKeyEncrypted: 'secret', openrouterEnabled: true, openrouterKeyEncrypted: 'backup' };
  assert.equal((await chain({}, config)).provider, 'gemini'); assert.deepEqual(calls, ['gemini']);
  calls.length = 0; primary = false; assert.equal((await chain({}, config)).provider, 'openrouter'); assert.deepEqual(calls, ['gemini', 'openrouter']);
  secondary = false; assert.equal(await chain({}, config), null);
  calls.length = 0; await chain({}, { ...config, geminiFreeTierConfirmed: false }); assert.deepEqual(calls, ['openrouter']);
});

test('shared atomic quotas survive helper recreation and separate free provider allowances', async () => {
  const docs = new Map(); let lock = Promise.resolve();
  const db = { collection: name => ({ doc: id => ({ path: `${name}/${id}` }) }), runTransaction: callback => {
    const work = lock.then(() => callback({ get: async ref => ({ data: () => docs.get(ref.path) }), set: (ref, data) => docs.set(ref.path, data) })); lock = work.catch(() => {}); return work;
  } };
  const time = 1800000000000;
  const results = await Promise.all(Array.from({ length: 8 }, () => reserveSupportAiQuota(db, 'gemini', time)));
  assert.equal(results.filter(Boolean).length, 4);
  assert.equal(await reserveSupportAiQuota(db, 'gemini', time + 60000), true);
  docs.set('supportAutomationUsage/openrouter', { day: new Date(time).toISOString().slice(0, 10), daily: 50 });
  assert.equal(await reserveSupportAiQuota(db, 'openrouter', time), false);
  assert.equal(await reserveSupportAiQuota(db, 'paid-provider', time), false);
});
