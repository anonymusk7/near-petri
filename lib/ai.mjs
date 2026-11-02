// NEAR AI Cloud client (OpenAI-compatible). MOCK_AI=1 (default) returns
// deterministic replies so tests and demos run offline with no key.
import { createHash } from 'node:crypto';

export const NEAR_AI_BASE = 'https://cloud-api.near.ai/v1';
export const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V3.1';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const approxTokens = (s) => Math.max(1, Math.ceil(s.length / 4));

const MOODS = ['wiggles happily', 'blinks slowly', 'does a little spin', 'purrs', 'tilts its head'];

function mockComplete({ model, messages }) {
  const sys = messages.find((m) => m.role === 'system')?.content ?? '';
  const user = messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
  const h = sha256(JSON.stringify(messages));
  const name = /You are (\S+?)[,.]/.exec(sys)?.[1] ?? 'Pet';
  const text = `*${name} ${MOODS[parseInt(h.slice(0, 8), 16) % MOODS.length]}* You said "${user.slice(0, 60)}". Thanks for keeping me fed! [mock:${h.slice(0, 8)}]`;
  const prompt_tokens = messages.reduce((n, m) => n + approxTokens(m.content), 0);
  return { text, model: `mock/${model}`, id: `mock-${h.slice(0, 16)}`,
    usage: { prompt_tokens, completion_tokens: approxTokens(text) } };
}

export function createAiClient({
  mock = (process.env.MOCK_AI ?? '1') !== '0',
  apiKey = process.env.NEAR_AI_API_KEY,
  baseUrl = process.env.NEAR_AI_BASE_URL ?? NEAR_AI_BASE,
  model = process.env.NEAR_AI_MODEL ?? DEFAULT_MODEL,
  fetch: f = globalThis.fetch,
} = {}) {
  return {
    mock, model,
    async complete({ messages, maxTokens = 200 }) {
      if (mock) return mockComplete({ model, messages });
      if (!apiKey) throw new Error('NEAR_AI_API_KEY missing (or set MOCK_AI=1)');
      const r = await f(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
      });
      if (!r.ok) throw new Error(`NEAR AI ${r.status}: ${await r.text()}`);
      const j = await r.json();
      const text = j.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new Error('NEAR AI: no completion in response');
      return { text, model: j.model ?? model, id: j.id,
        usage: { prompt_tokens: j.usage?.prompt_tokens ?? 0, completion_tokens: j.usage?.completion_tokens ?? 0 } };
    },
  };
}
