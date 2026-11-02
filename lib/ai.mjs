// NEAR AI Cloud client (OpenAI-compatible). MOCK_AI=1 (default) returns
// deterministic replies so tests and demos run offline with no key.
// MOCK_AI=0 runs the verified TEE path (docs/nearai/*.md):
//   1. preflight: /v1/attestation/report with a client nonce (gateway + NEAR
//      model reports), each quote verified with dcap-qvl, signer/nonce binding,
//      MRCONFIGID, RTMR3 replay, NVIDIA NRAS GPU check. Done before any completion.
//   2. non-streaming completion, exact request/response bytes retained.
//   3. /v1/signature/<chat_id>?signing_algo=ecdsa (bounded retry), verified as
//      provider_tee against the one matching verified model report.
import { createHash } from 'node:crypto';
import { checkPreflight, checkResponseSignature, fetchCollateral, newNonce, nrasAttest, selectSigner, sha256Hex } from './attest.mjs';

export const NEAR_AI_BASE = 'https://cloud-api.near.ai/v1';
// Canonical ID (not the deepseek/deepseek-v4.1-flash alias, which has no NEAR model attestation).
export const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
export const MAX_TOKENS_CAP = 400;
export const PRICE_PER_M = { input: 0.30, output: 1.20 }; // USD

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const approxTokens = (s) => Math.max(1, Math.ceil(s.length / 4));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

export function usageCostUsd({ prompt_tokens = 0, completion_tokens = 0 }) {
  return (prompt_tokens * PRICE_PER_M.input + completion_tokens * PRICE_PER_M.output) / 1e6;
}

export function createAiClient({
  mock = (process.env.MOCK_AI ?? '1') !== '0',
  apiKey = process.env.NEAR_AI_API_KEY,
  baseUrl = process.env.NEAR_AI_BASE_URL ?? NEAR_AI_BASE,
  model = process.env.NEAR_AI_MODEL ?? DEFAULT_MODEL,
  fetch: f = globalThis.fetch,
  sigRetries = 5, sigRetryMs = 1500,
  now = () => Math.floor(Date.now() / 1000),
  nonce: makeNonce = newNonce, getCollateral = fetchCollateral,
  // Called right after a (paid) completion returns, before signature checks, so
  // usage is logged and raw bytes saved even if verification later fails.
  onCompletion = async () => {},
} = {}) {
  const auth = () => {
    if (!apiKey) throw new Error('NEAR_AI_API_KEY missing (or set MOCK_AI=1)');
    return { authorization: `Bearer ${apiKey}` };
  };
  let preflightRun; // one verified preflight per client, always before the first completion

  /** Step 1. Returns { evidence (recordable, no secrets), summary (verified) }. */
  async function preflight() {
    const nonce = makeNonce();
    const qs = new URLSearchParams({ model, provider: 'near', include_tls_fingerprint: 'false', signing_algo: 'ecdsa', nonce });
    const r = await f(`${baseUrl}/attestation/report?${qs}`, {
      headers: { accept: 'application/json', 'accept-encoding': 'identity', 'x-no-aliasing': 'true', ...auth() },
    });
    const report_raw = await r.text();
    if (!r.ok) throw new Error(`attestation ${r.status}: ${report_raw.slice(0, 300)}`);
    const body = JSON.parse(report_raw);
    const candidates = body.model_attestations ?? [];
    if (!candidates.length) throw new Error('no NEAR model evidence returned (alias or non-TEE model?)');
    const collateral = {
      gateway: await getCollateral(body.gateway_attestation.intel_quote),
      models: await Promise.all(candidates.map((c) => getCollateral(c.intel_quote))),
    };
    const nras = [];
    for (const c of candidates) nras.push(await nrasAttest(c, nonce, { fetch: f }));
    const evidence = { v: 1, url: `${baseUrl}/attestation/report?${qs}`, nonce, verified_at: now(), report_raw, collateral, nras };
    const summary = checkPreflight(evidence, { model });
    return { evidence, summary };
  }

  /** Step 3: GET /v1/signature/<id>, bounded retry on 404 / 2xx-with-error_code. */
  async function fetchSignature(chatId) {
    const url = `${baseUrl}/signature/${encodeURIComponent(chatId)}?signing_algo=ecdsa`;
    let last;
    for (let i = 0; i < sigRetries; i++) {
      const r = await f(url, { headers: { accept: 'application/json', 'accept-encoding': 'identity', ...auth() } });
      const text = await r.text();
      if (r.ok) {
        const j = JSON.parse(text);
        if (!j.error_code) return j;
        last = `unavailable: ${j.error_code} ${j.message ?? ''}`;
      } else if (r.status === 404) last = '404 not found yet';
      else throw new Error(`signature ${r.status}: ${text.slice(0, 300)}`);
      if (i < sigRetries - 1) await sleep(sigRetryMs);
    }
    throw new Error(`signature unavailable after ${sigRetries} tries: ${last}`);
  }

  async function teeComplete({ messages, maxTokens }) {
    preflightRun ??= preflight();
    const pf = await preflightRun; // throws (and no completion is sent) if preflight fails
    // Step 2: build the body once; these exact bytes are what we hash.
    const requestBody = JSON.stringify({ model, messages, max_tokens: maxTokens, stream: false });
    const r = await f(`${baseUrl}/chat/completions`, {
      method: 'POST', body: requestBody,
      headers: { 'content-type': 'application/json', accept: 'application/json', 'accept-encoding': 'identity', 'x-no-aliasing': 'true', ...auth() },
    });
    const responseBytes = Buffer.from(await r.arrayBuffer());
    const responseBody = responseBytes.toString('utf8');
    if (!r.ok) throw new Error(`NEAR AI ${r.status}: ${responseBody.slice(0, 300)}`);
    if (!Buffer.from(responseBody, 'utf8').equals(responseBytes)) throw new Error('response is not round-trippable UTF-8');
    const encoding = r.headers?.get?.('content-encoding');
    if (encoding && encoding !== 'identity') throw new Error(`unexpected content-encoding ${encoding}`);
    const j = JSON.parse(responseBody);
    await onCompletion({ requestBody, responseBody, id: j.id, usage: j.usage, model });
    const text = j.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error('NEAR AI: no completion in response');

    const signature = await fetchSignature(j.id);
    const signer = selectSigner(pf.summary, signature);
    checkResponseSignature({ signature, requestBytes: Buffer.from(requestBody, 'utf8'), responseBytes, model, preflightSigner: signer });
    const usage = { prompt_tokens: j.usage?.prompt_tokens ?? 0, completion_tokens: j.usage?.completion_tokens ?? 0 };
    return {
      text, model, id: j.id, usage,
      tee: {
        chat_id: j.id, model,
        request_hash: sha256Hex(requestBody), response_hash: sha256Hex(responseBytes),
        signature, signing_address: signature.signing_address,
        attestation: attestationSummary(pf.summary, signer),
        request: requestBody, response: responseBody,
      },
      preflight: pf,
    };
  }

  return {
    mock, model,
    preflight: () => (preflightRun ??= preflight()),
    async complete({ messages, maxTokens = MAX_TOKENS_CAP }) {
      if (mock) return mockComplete({ model, messages });
      if (maxTokens > MAX_TOKENS_CAP) throw new Error(`maxTokens capped at ${MAX_TOKENS_CAP}`);
      return teeComplete({ messages, maxTokens });
    },
  };
}

export function attestationSummary(summary, signer) {
  return {
    nonce: summary.nonce, verified_at: summary.verified_at,
    gateway: { signing_address: summary.gateway.signing_address, tcb_status: summary.gateway.tcb_status, compose_hash: summary.gateway.compose_hash },
    model: { signing_address: signer.signing_address, signing_algo: signer.signing_algo, tcb_status: signer.tcb_status,
      compose_hash: signer.compose_hash, rtmr3: signer.rtmr3, gpu: signer.gpu },
    candidates: summary.models.length,
  };
}
