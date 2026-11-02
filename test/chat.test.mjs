import { test } from 'node:test'; import assert from 'node:assert/strict';
import { chat, computeCost, replyHash, verifyReply, sha256, PRICING, MAX_MSG_LEN } from '../lib/chat.mjs';
import { createAiClient, NEAR_AI_BASE, DEFAULT_MODEL } from '../lib/ai.mjs';

const prompt = 'Cheerful moss creature who loves rain.';
const pet = { token_id: '0', name: 'Mochi', prompt, prompt_hash: sha256(prompt), balance: (10n ** 24n).toString(), asleep: false };
const mock = createAiClient({ mock: true });

test('sha256 matches known vector', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('mock chat is deterministic and returns contract-ready charge args', async () => {
  const a = await chat(pet, 'hi', { client: mock });
  const b = await chat(pet, 'hi', { client: mock });
  assert.deepEqual(a, b);
  assert.match(a.reply, /^\*Mochi .*hi.*\[mock:[0-9a-f]{8}\]$/);
  assert.match(a.replyHash, /^[0-9a-f]{64}$/);
  assert.equal(a.cost, computeCost(a.usage).toString());
  assert.deepEqual(a.chargeArgs, { token_id: '0', cost: a.cost, reply_hash: a.replyHash });
  assert.ok(verifyReply(a.receipt, a.replyHash));
  const c = await chat(pet, 'hello', { client: mock });
  assert.notEqual(c.replyHash, a.replyHash);
});

test('reply hash detects any tampering', async () => {
  const r = await chat(pet, 'hi', { client: mock });
  for (const k of ['token_id', 'prompt_hash', 'msg', 'reply', 'model'])
    assert.equal(verifyReply({ ...r.receipt, [k]: r.receipt[k] + 'x' }, r.replyHash), false, k);
  assert.equal(replyHash(r.receipt), r.replyHash);
});

test('cost = base + perToken * tokens (yocto BigInt)', () => {
  assert.equal(computeCost({ prompt_tokens: 0, completion_tokens: 0 }), PRICING.base);
  assert.equal(computeCost({ prompt_tokens: 10, completion_tokens: 5 }), PRICING.base + 15n * PRICING.perToken);
  assert.equal(computeCost({ prompt_tokens: 3 }, { base: 1n, perToken: 2n }), 7n);
  assert.equal(computeCost({}), PRICING.base);
});

test('chat guard rails', async () => {
  const o = { client: mock };
  await assert.rejects(chat(pet, '', o), /message required/);
  await assert.rejects(chat(pet, 'x'.repeat(MAX_MSG_LEN + 1), o), /too long/);
  await assert.rejects(chat({ ...pet, token_id: undefined }, 'hi', o), /token_id/);
  await assert.rejects(chat({ ...pet, prompt: 'tampered' }, 'hi', o), /prompt_hash/);
  await assert.rejects(chat({ ...pet, asleep: true }, 'hi', o), /asleep/);
  await assert.rejects(chat({ ...pet, balance: '5' }, 'hi', o), /insufficient/);
  // can afford base but not the tokens
  await assert.rejects(chat({ ...pet, balance: (PRICING.base + 1n).toString() }, 'hi', o), /need \d+ yocto/);
});

test('broke pet never triggers an AI call', async () => {
  let called = false;
  const spy = { complete: async () => { called = true; throw new Error('should not run'); } };
  await assert.rejects(chat({ ...pet, balance: '0' }, 'hi', { client: spy }), /insufficient/);
  assert.equal(called, false);
});

test('real client: no completion is sent when preflight attestation fails', async () => {
  const seen = [];
  const f = async (url, o = {}) => { seen.push({ url, headers: o.headers });
    return { ok: true, status: 200, text: async () => JSON.stringify({ gateway_attestation: {}, model_attestations: [] }) }; };
  const client = createAiClient({ mock: false, apiKey: 'k', fetch: f });
  await assert.rejects(chat(pet, 'hi', { client }), /no NEAR model evidence/);
  assert.equal(seen.length, 1);
  const u = new URL(seen[0].url);
  assert.equal(u.origin + u.pathname, `${NEAR_AI_BASE}/attestation/report`);
  assert.equal(u.searchParams.get('model'), DEFAULT_MODEL);
  assert.equal(u.searchParams.get('provider'), 'near');
  assert.equal(u.searchParams.get('signing_algo'), 'ecdsa');
  assert.match(u.searchParams.get('nonce'), /^[0-9a-f]{64}$/);
  assert.equal(seen[0].headers['x-no-aliasing'], 'true');
  assert.equal(seen[0].headers.authorization, 'Bearer k');
});

test('real client errors', async () => {
  const msgs = [{ role: 'user', content: 'hi' }];
  await assert.rejects(createAiClient({ mock: false, apiKey: '', fetch: async () => ({}) }).complete({ messages: msgs }), /NEAR_AI_API_KEY/);
  await assert.rejects(createAiClient({ mock: false, apiKey: 'k', fetch: async () => ({ ok: false, status: 401, text: async () => 'nope' }) }).complete({ messages: msgs }), /401/);
  await assert.rejects(createAiClient({ mock: false, apiKey: 'k', fetch: async () => { throw new Error('x'); } }).complete({ messages: msgs, maxTokens: 401 }), /capped at 400/);
});

test('default model is the canonical TEE id, not an alias', () => {
  assert.equal(DEFAULT_MODEL, 'deepseek-ai/DeepSeek-V4.1-Flash-1017');
});

test('MOCK_AI env defaults to mock', () => {
  const prev = process.env.MOCK_AI;
  delete process.env.MOCK_AI; assert.equal(createAiClient().mock, true);
  process.env.MOCK_AI = '0'; assert.equal(createAiClient().mock, false);
  if (prev === undefined) delete process.env.MOCK_AI; else process.env.MOCK_AI = prev;
});
