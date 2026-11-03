import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiReceiptReader, validateReceiptAddresses } from '../src/gemini-support.js';

const image = { mimeType: 'image/jpeg', data: 'AAAA' };
const answer = enderecos => ({ ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ enderecos }) }] } }] }) });

test('only clean delivery addresses come back from the photo reader', () => {
  assert.deepEqual(validateReceiptAddresses({ enderecos: ['Rua das Azaleias, 65, Centro', '  Rua das Azaleias, 65, Centro ', '(19) 99876-5432', 'ab', 'Av. Brasil 10'] }),
    ['Rua das Azaleias, 65, Centro', 'Av. Brasil 10']);
  assert.deepEqual(validateReceiptAddresses({}), []);
});

test('the photo is sent as inline image and the answer is the delivery address', async () => {
  let body;
  const reader = createGeminiReceiptReader({ fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return answer(['Rua Avelino Stivão, 412, Jd São Paulo']); } });
  const result = await reader.read({ apiKey: 'test-only-key-0000000000', image });
  assert.deepEqual(result.enderecos, ['Rua Avelino Stivão, 412, Jd São Paulo']);
  assert.equal(body.contents[0].parts[0].inlineData.mimeType, 'image/jpeg');
});

test('when the free limit ends (429) it stops calling Google for a while', async () => {
  let calls = 0, time = 0;
  const reader = createGeminiReceiptReader({ now: () => time, fetchImpl: async () => { calls++; return { ok: false, status: 429 }; } });
  assert.equal((await reader.read({ apiKey: 'test-only-key-0000000000', image })).reason, 'quota');
  assert.equal((await reader.read({ apiKey: 'test-only-key-0000000000', image })).reason, 'quota');
  assert.equal(calls, 1);
  time = 31 * 60000;
  await reader.read({ apiKey: 'test-only-key-0000000000', image });
  assert.equal(calls, 2);
});

test('our own daily cap also stops it, without calling Google', async () => {
  let calls = 0;
  const reader = createGeminiReceiptReader({ reserveBudget: async () => false, fetchImpl: async () => { calls++; return answer(['Rua X 1']); } });
  assert.equal((await reader.read({ apiKey: 'test-only-key-0000000000', image })).reason, 'local_limit');
  assert.equal(calls, 0);
});
