// Offline verification of a recorded TEE reply (examples/recorded/*.reply.json).
// Re-runs every check from the live path on the recorded bytes: Intel quotes
// via dcap-qvl with the recorded collateral at the recorded time, NRAS JWT
// against the recorded JWKS, the provider_tee signature, and the Petri receipt.
import { checkPreflight, checkResponseSignature, selectSigner, sha256Hex } from './attest.mjs';
import { replyHash, systemPrompt } from './chat.mjs';
import { MAX_TOKENS_CAP } from './ai.mjs';

/** Returns { ok, checks: [{ name, ok, detail }] }; never throws on bad input. */
export function verifyRecord(rec, evidence) {
  const checks = [];
  const check = (name, fn) => {
    try { const detail = fn(); checks.push({ name, ok: true, detail: detail ?? '' }); return true; }
    catch (e) { checks.push({ name, ok: false, detail: e.message }); return false; }
  };
  const must = (cond, msg) => { if (!cond) throw new Error(msg); };
  let req, res, pf, signer;

  check('request bytes hash to request_hash', () => {
    must(sha256Hex(Buffer.from(rec.request, 'utf8')) === rec.request_hash, 'sha256(request) != request_hash');
    return rec.request_hash;
  });
  check('response bytes hash to response_hash', () => {
    must(sha256Hex(Buffer.from(rec.response, 'utf8')) === rec.response_hash, 'sha256(response) != response_hash');
    return rec.response_hash;
  });
  check('request = canonical model, non-streaming, pet prompt from prompt_hash', () => {
    req = JSON.parse(rec.request);
    must(req.model === rec.model, `request model ${req.model} != ${rec.model}`);
    must(req.stream === false, 'request must be non-streaming');
    must(req.max_tokens <= MAX_TOKENS_CAP, 'max_tokens over cap');
    must(sha256Hex(rec.pet.prompt) === rec.pet.prompt_hash, 'sha256(pet.prompt) != prompt_hash');
    must(req.messages[0]?.role === 'system' && req.messages[0].content === systemPrompt(rec.pet), 'system message is not the pet prompt');
    must(req.messages.at(-1)?.content === rec.msg, 'user message differs from msg');
    return `${req.model}, max_tokens=${req.max_tokens}`;
  });
  check('response id = chat_id and content = reply', () => {
    res = JSON.parse(rec.response);
    must(res.id === rec.chat_id, `response id ${res.id} != chat_id`);
    must(res.choices?.[0]?.message?.content === rec.reply, 'reply text differs from signed response');
    return rec.chat_id;
  });
  check('preflight attestation (gateway + model quotes, nonce/signer binding, MRCONFIGID, RTMR3, NRAS GPU)', () => {
    must(evidence, 'evidence file missing');
    must(evidence.nonce === rec.attestation?.nonce, 'evidence nonce differs from record');
    pf = checkPreflight(evidence, { model: rec.model });
    const g = pf.gateway;
    return `nonce ${pf.nonce.slice(0, 16)}…, gateway ${g.signing_address} ${g.tcb_status}, ${pf.models.length} model report(s) `
      + pf.models.map((m) => `${m.signing_address} ${m.tcb_status} GPU ${m.gpu.gpus}x${m.gpu.arch} NRAS=true`).join('; ');
  });
  check('preflight verified before the completion', () => {
    must(pf && res, 'needs preflight + response');
    must(pf.verified_at <= res.created, `preflight at ${pf.verified_at} is after completion created ${res.created}`);
    return `preflight ${new Date(pf.verified_at * 1000).toISOString()} <= completion ${new Date(res.created * 1000).toISOString()}`;
  });
  check('provider_tee signature: text = MODEL:req_hash:resp_hash, ecrecover = verified model signer', () => {
    must(pf, 'needs verified preflight');
    must(rec.signing_address?.toLowerCase() === rec.signature?.signing_address?.toLowerCase(), 'record signing_address differs from signature');
    signer = selectSigner(pf, rec.signature);
    const { recovered } = checkResponseSignature({ signature: rec.signature, requestBytes: Buffer.from(rec.request, 'utf8'),
      responseBytes: Buffer.from(rec.response, 'utf8'), model: rec.model, preflightSigner: signer });
    return `recovered ${recovered}`;
  });
  check('Petri receipt (v2) hashes to the on-chain reply_hash', () => {
    const r = rec.receipt;
    must(r?.v === 2, 'receipt must be v2');
    for (const [k, v] of Object.entries({ token_id: rec.pet.token_id, prompt_hash: rec.pet.prompt_hash, chat_id: rec.chat_id,
      model: rec.model, request_hash: rec.request_hash, response_hash: rec.response_hash })) must(r[k] === v, `receipt.${k} differs`);
    must(replyHash(r) === rec.reply_hash, 'replyHash(receipt) != reply_hash');
    return rec.reply_hash;
  });
  return { ok: checks.every((c) => c.ok), checks };
}
