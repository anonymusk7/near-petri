// Offline tests on the REAL recorded NEAR AI Cloud evidence in examples/recorded/.
import { test } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs';
import { verifyRecord } from '../lib/verify.mjs';
import { createAiClient, DEFAULT_MODEL } from '../lib/ai.mjs';
import { chat, sha256 } from '../lib/chat.mjs';
import { checkPreflight, replayRtmr3, checkResponseSignature, selectSigner } from '../lib/attest.mjs';

const dir = new URL('../examples/recorded/', import.meta.url);
const load = (f) => JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8'));
const replies = fs.readdirSync(dir).filter((f) => /^reply-\d+\.json$/.test(f)).sort();
const rec1 = load('reply-1.json');
const ev1 = load(rec1.evidence);

test('all recorded real replies verify offline', () => {
  assert.ok(replies.length >= 1 && replies.length <= 4);
  for (const f of replies) {
    const rec = load(f);
    const v = verifyRecord(rec, load(rec.evidence));
    assert.ok(v.ok, `${f}: ${v.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; ')}`);
    assert.equal(rec.model, DEFAULT_MODEL);
    assert.equal(rec.signature.signature_kind, 'provider_tee');
  }
});

test('shipped tampered example is INVALID', () => {
  const v = verifyRecord(load('reply-1.tampered.json'), ev1);
  assert.equal(v.ok, false);
  assert.ok(v.checks.some((c) => !c.ok && /response_hash/.test(c.name)));
});

test('any edit to signed bytes, signature, receipt or evidence is rejected', () => {
  const bad = (rec, ev = ev1) => assert.equal(verifyRecord(rec, ev).ok, false);
  bad({ ...rec1, request: rec1.request.replace('Mochi', 'Moch1') });
  bad({ ...rec1, response: rec1.response.replace('"stop"', '"length"') });
  bad({ ...rec1, reply: rec1.reply + '!' });
  bad({ ...rec1, model: 'deepseek/deepseek-v4.1-flash' });
  bad({ ...rec1, signature: { ...rec1.signature, signature: rec1.signature.signature.replace(/.$/, (c) => (c === '0' ? '1' : '0')) } });
  bad({ ...rec1, signature: { ...rec1.signature, signature_kind: 'gateway' } });
  bad({ ...rec1, receipt: { ...rec1.receipt, token_id: '1' } });
  bad({ ...rec1, pet: { ...rec1.pet, prompt: 'Grumpy rock.' } });
  bad(rec1, null);
  bad(rec1, { ...ev1, nonce: 'ab'.repeat(32) });
  bad(rec1, { ...ev1, report_raw: ev1.report_raw.replace(ev1.nonce, 'cd'.repeat(32)) });
  const otherEv = load(load(replies.at(-1)).evidence);
  if (otherEv.nonce !== ev1.nonce) bad(rec1, otherEv); // a different preflight is not a substitute
});

test('RTMR3 replay rejects a modified event payload (e.g. a swapped compose-hash)', () => {
  const body = JSON.parse(ev1.report_raw);
  const m = body.model_attestations[0];
  const orig = replayRtmr3(m.event_log);
  const ev = m.event_log.find((e) => e.imr === 3 && e.event === 'compose-hash');
  ev.event_payload = 'ff'.repeat(32);
  assert.ok(!replayRtmr3(m.event_log).equals(orig));
  const v = verifyRecord(rec1, { ...ev1, report_raw: JSON.stringify(body) });
  assert.match(v.checks.find((c) => !c.ok).detail, /RTMR3/);
  ev.digest = '00'.repeat(48);
  assert.throws(() => replayRtmr3(m.event_log), /digest mismatch/);
});

test('signer must uniquely match a verified model report', () => {
  const pf = checkPreflight(ev1, { model: rec1.model });
  assert.throws(() => selectSigner(pf, { ...rec1.signature, signing_address: pf.gateway.signing_address }), /exactly 1/);
  assert.throws(() => selectSigner({ ...pf, models: [...pf.models, ...pf.models] }, rec1.signature), /found 2/);
  assert.throws(() => checkResponseSignature({ signature: rec1.signature, requestBytes: Buffer.from(rec1.request),
    responseBytes: Buffer.from(rec1.response), model: rec1.model, preflightSigner: pf.gateway }), /preflight/);
});

test('TEE client replays the recorded run: preflight first, exact headers, verified record', async () => {
  const sig = load('raw/reply-1.signature.json');
  const body = JSON.parse(ev1.report_raw);
  const calls = [];
  const resp = (text, status = 200) => ({ ok: status < 300, status, headers: new Headers(),
    text: async () => text, json: async () => JSON.parse(text), arrayBuffer: async () => Buffer.from(text, 'utf8') });
  let sigTries = 0;
  const f = async (url, o = {}) => {
    calls.push({ url: String(url), method: o.method ?? 'GET', headers: o.headers ?? {}, body: o.body });
    const u = new URL(url);
    if (u.pathname.endsWith('/attestation/report')) return resp(ev1.report_raw);
    if (u.hostname === 'nras.attestation.nvidia.com' && o.method === 'POST') return resp(JSON.stringify(ev1.nras[0].nras_response));
    if (u.hostname === 'nras.attestation.nvidia.com') return resp(JSON.stringify(ev1.nras[0].jwks));
    if (u.pathname.endsWith('/chat/completions')) return resp(rec1.response);
    if (u.pathname.includes('/signature/')) return ++sigTries === 1 ? resp('not yet', 404) : resp(JSON.stringify(sig));
    throw new Error(`unexpected ${url}`);
  };
  const logged = [];
  const client = createAiClient({ mock: false, apiKey: 'test-key', fetch: f, sigRetryMs: 1,
    nonce: () => ev1.nonce, now: () => ev1.verified_at,
    getCollateral: async (q) => (q === body.gateway_attestation.intel_quote ? ev1.collateral.gateway : ev1.collateral.models[0]),
    onCompletion: async (c) => { logged.push(c); } });
  const pet = { ...rec1.pet, balance: 10n ** 24n, asleep: false };
  assert.equal(sha256(pet.prompt), pet.prompt_hash);
  const r = await chat(pet, rec1.msg, { client, maxTokens: 400 });

  const kinds = calls.map((c) => new URL(c.url).pathname);
  assert.ok(kinds.indexOf('/v1/chat/completions') > kinds.indexOf('/v1/attestation/report'));
  assert.ok(kinds.slice(0, kinds.indexOf('/v1/chat/completions')).some((k) => k.includes('attest/gpu')), 'NRAS before completion');
  const comp = calls.find((c) => c.url.endsWith('/chat/completions'));
  assert.equal(comp.body, rec1.request, 'exact request bytes');
  assert.equal(comp.headers['x-no-aliasing'], 'true');
  assert.equal(comp.headers['accept-encoding'], 'identity');
  assert.equal(JSON.parse(comp.body).stream, false);
  const sigCall = calls.filter((c) => c.url.includes('/signature/'));
  assert.equal(sigCall.length, 2, 'bounded retry after 404');
  assert.match(sigCall[0].url, /signing_algo=ecdsa/);
  assert.equal(logged.length, 1);

  assert.equal(r.replyHash, rec1.reply_hash);
  const { evidence, ...stored } = rec1;
  assert.deepEqual(r.record, stored);
  assert.ok(!JSON.stringify(r.record).includes('test-key'), 'no API key in the record');
  assert.ok(!JSON.stringify(r.preflight.evidence).includes('test-key'), 'no API key in the evidence');
});
