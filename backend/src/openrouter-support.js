import { filterGeminiText, validateGeminiAnswer, SUPPORT_AI_INSTRUCTIONS } from './gemini-support.js';

export const OPENROUTER_FREE_MODEL = 'openrouter/free';
export function createOpenRouterSupport({ fetchImpl = fetch, now = () => Date.now(), reserveBudget = async () => true } = {}) {
  let cooldownUntil = 0, reason = '', lastSuccessAt = 0;
  function status() { return { reason: cooldownUntil > now() ? reason : '', cooldownUntil, lastSuccessAt }; }
  async function generate({ apiKey, text, history = [], topic = 'menu' }) {
    const filtered = filterGeminiText(text);
    if (!apiKey || !filtered) return { answer: null, reason: 'not_ready' };
    if (cooldownUntil > now()) return { answer: null, reason };
    if (!await reserveBudget()) return { answer: null, reason: 'local_limit' };
    const turns = history.slice(-4).flatMap(turn => {
      const safe = filterGeminiText(turn.text);
      return safe && ['user', 'model'].includes(turn.role) ? [{ role: turn.role, text: safe }] : [];
    });
    try {
      const response = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(12000),
        body: JSON.stringify({ model: OPENROUTER_FREE_MODEL, temperature: 0.3, max_tokens: 500,
          provider: { require_parameters: true, data_collection: 'deny', max_price: { prompt: 0, completion: 0 } },
          messages: [{ role: 'system', content: SUPPORT_AI_INSTRUCTIONS }, ...turns.map(turn => ({ role: turn.role === 'model' ? 'assistant' : 'user', content: turn.text })), { role: 'user', content: `Assunto anterior: ${['request', 'address', 'payment', 'menu', 'other'].includes(topic) ? topic : 'menu'}. Dúvida: ${filtered}` }],
          response_format: { type: 'json_schema', json_schema: { name: 'support_reply', strict: true, schema: { type: 'object', properties: { reply: { type: 'string' }, topic: { type: 'string', enum: ['request', 'address', 'payment', 'menu', 'other', 'human'] } }, required: ['reply', 'topic'], additionalProperties: false } } }
        })
      });
      if (!response.ok) {
        reason = response.status === 429 ? 'quota' : 'unavailable'; cooldownUntil = now() + (response.status === 429 ? 5 * 60000 : 60000);
        return { answer: null, reason };
      }
      const data = await response.json();
      const choice = data.choices?.[0];
      if (choice?.finish_reason !== 'stop' || typeof choice.message?.content !== 'string') return { answer: null, reason: 'invalid_answer' };
      const answer = validateGeminiAnswer(JSON.parse(choice.message.content));
      if (!answer) return { answer: null, reason: 'invalid_answer' };
      lastSuccessAt = now(); cooldownUntil = 0; reason = '';
      return { answer, history: [...turns, { role: 'user', text: filtered }, { role: 'model', text: answer.text }].slice(-4) };
    } catch {
      reason = 'unavailable'; cooldownUntil = now() + 60000;
      return { answer: null, reason };
    }
  }
  return { generate, status, reset: () => { cooldownUntil = 0; reason = ''; } };
}

export function createSupportAiChain({ gemini, openRouter, decrypt }) {
  return async function generateReply(input, settings) {
    if (settings.geminiEnabled && settings.geminiFreeTierConfirmed && settings.geminiKeyEncrypted) {
      const apiKey = decrypt(settings.geminiKeyEncrypted);
      if (apiKey) {
        const result = await gemini.generate({ ...input, apiKey, model: settings.geminiModel }).catch(() => null);
        if (result?.answer) return { ...result, provider: 'gemini' };
      }
    }
    if (settings.openrouterEnabled && settings.openrouterKeyEncrypted) {
      const apiKey = decrypt(settings.openrouterKeyEncrypted);
      if (apiKey) {
        const result = await openRouter.generate({ ...input, apiKey }).catch(() => null);
        if (result?.answer) return { ...result, provider: 'openrouter' };
      }
    }
    return null;
  };
}
