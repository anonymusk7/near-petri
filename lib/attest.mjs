// NEAR AI Cloud TEE verification: preflight attestation (gateway + NEAR model
// reports), NVIDIA NRAS GPU check, and provider_tee response signatures.
// Follows docs/nearai/{quote-nonce-signer,gateway-attestation,model-attestations,
// response-signatures,response-signature-verification}.md step by step.
//
// Every check can run offline on recorded evidence: the Intel collateral and the
// NRAS verdict + JWKS are saved next to the report, so `pnpm verify` re-runs the
// quote verification with dcap-qvl at the recorded time.
import { createHash, createPublicKey, randomBytes, verify as cryptoVerify, timingSafeEqual } from 'node:crypto';
import { getCollateral, verify as dcapVerify, PHALA_PCCS_URL } from '@phala/dcap-qvl';
import { ethers } from 'ethers';

export const ACCEPTED_TCB_STATUSES = ['UpToDate']; // our verification policy
export const NRAS_URL = 'https://nras.attestation.nvidia.com/v3/attest/gpu';
export const NRAS_JWKS_URL = 'https://nras.attestation.nvidia.com/.well-known/jwks.json';

const hexBytes = (v) => Buffer.from(String(v).replace(/^0x/i, ''), 'hex');
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const hash = (alg, ...parts) => { const h = createHash(alg); for (const p of parts) h.update(p); return h.digest(); };
export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const newNonce = () => randomBytes(32).toString('hex');

export function replayRtmr3(eventLog) {
  let rtmr3 = Buffer.alloc(48);
  for (const ev of parse(eventLog)) {
    if (ev.imr !== 3) continue;
    const t = Buffer.alloc(4); t.writeUInt32LE(ev.event_type);
    const digest = hash('sha384', t, ':', Buffer.from(ev.event, 'utf8'), ':', hexBytes(ev.event_payload ?? ''));
    if (ev.digest && !hexBytes(ev.digest).equals(digest)) throw new Error(`digest mismatch for event ${ev.event}`);
    rtmr3 = hash('sha384', rtmr3, digest);
  }
  return rtmr3;
}

/** Fetch Intel collateral for a quote (free, Phala PCCS). Saved so verification can be replayed offline. */
export const fetchCollateral = (intelQuoteHex, pccsUrl = PHALA_PCCS_URL) => getCollateral(pccsUrl, hexBytes(intelQuoteHex));

/**
 * One NEAR report (gateway_attestation or a model_attestations[] entry):
 * dcap-qvl quote verify + TCB policy, debug bit, report_data = signer binding || nonce,
 * echoed nonce, MRCONFIGID = 01||sha256(app_compose)||0*15, RTMR3 event-log replay.
 */
export function checkNearReport(report, nonceHex, { collateral, nowSecs, accepted = ACCEPTED_TCB_STATUSES }) {
  const verified = dcapVerify(hexBytes(report.intel_quote), collateral, nowSecs);
  if (!accepted.includes(verified.status)) throw new Error(`TCB status ${verified.status} not accepted: ${verified.advisory_ids}`);
  if (verified.report.type !== 'td10') throw new Error('expected a TDX quote');
  const q = verified.report.data;
  if (q.tdAttributes[0] & 1) throw new Error('TDX debug mode is enabled');

  const identity = hexBytes(report.signing_address);
  if ({ ecdsa: 20, ed25519: 32 }[report.signing_algo] !== identity.length) throw new Error('unsupported signing identity');
  const fp = report.tls_cert_fingerprint;
  const bound = fp ? hash('sha256', identity, hexBytes(fp)) : Buffer.concat([identity, Buffer.alloc(32 - identity.length)]);
  const reportData = Buffer.from(q.reportData);
  if (!reportData.equals(Buffer.concat([bound, hexBytes(nonceHex)]))) throw new Error('report data does not bind the signer and nonce');
  if (String(report.request_nonce).toLowerCase() !== nonceHex.toLowerCase()) throw new Error('echoed nonce does not match');
  if (report.report_data !== undefined && !hexBytes(report.report_data).equals(reportData)) throw new Error('echoed report_data differs from verified quote');

  const appCompose = parse(parse(report.info).tcb_info).app_compose;
  const composeHash = hash('sha256', Buffer.from(appCompose, 'utf8'));
  if (!Buffer.from(q.mrConfigId).equals(Buffer.concat([Buffer.from([1]), composeHash, Buffer.alloc(15)]))) {
    throw new Error('MRCONFIGID does not match app_compose');
  }
  if (!replayRtmr3(report.event_log).equals(Buffer.from(q.rtMr3))) throw new Error('event log does not match RTMR3');
  return {
    tcb_status: verified.status, advisory_ids: verified.advisory_ids,
    signing_address: report.signing_address, signing_algo: report.signing_algo,
    compose_hash: composeHash.toString('hex'), rtmr3: Buffer.from(q.rtMr3).toString('hex'),
    mr_td: Buffer.from(q.mrTd).toString('hex'),
  };
}

const b64url = (s) => Buffer.from(s, 'base64url');

/** Decode + verify an NRAS JWT (ES384) against the NRAS JWKS. */
export function checkNrasJwt(token, jwks, nonceHex) {
  const [h, p, s] = token.split('.');
  const header = JSON.parse(b64url(h)); const payload = JSON.parse(b64url(p));
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error(`NRAS JWT kid ${header.kid} not in JWKS`);
  const alg = { ES384: 'sha384', ES256: 'sha256' }[header.alg];
  if (!alg) throw new Error(`unsupported NRAS JWT alg ${header.alg}`);
  const key = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: 'jwk' });
  if (!cryptoVerify(alg, Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, b64url(s))) {
    throw new Error('NRAS JWT signature invalid');
  }
  if (payload['x-nvidia-overall-att-result'] !== true) throw new Error('NRAS overall attestation result is not true');
  if (String(payload.eat_nonce ?? '').toLowerCase() !== nonceHex.toLowerCase()) throw new Error('NRAS JWT nonce mismatch');
  return { overall: true, iat: payload.iat, gpus: Object.keys(payload.submods ?? {}).length };
}

/** Docs: decode nvidia_payload, require its nonce == ours, POST it unchanged to NRAS. */
export async function nrasAttest(report, nonceHex, { fetch: f = globalThis.fetch } = {}) {
  if (typeof report.nvidia_payload !== 'string') throw new Error('missing GPU evidence (nvidia_payload)');
  const payload = JSON.parse(report.nvidia_payload);
  if (typeof payload.nonce !== 'string' || payload.nonce.toLowerCase() !== nonceHex.toLowerCase()) throw new Error('GPU payload nonce mismatch');
  const r = await f(NRAS_URL, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const text = await r.text();
  if (!r.ok) throw new Error(`NRAS ${r.status}: ${text.slice(0, 300)}`);
  const jwks = await (await f(NRAS_JWKS_URL)).json();
  return { nras_response: JSON.parse(text), jwks };
}

export function checkGpu(report, nonceHex, { nras_response, jwks }) {
  const payload = JSON.parse(report.nvidia_payload);
  if (payload.nonce.toLowerCase() !== nonceHex.toLowerCase()) throw new Error('GPU payload nonce mismatch');
  const first = nras_response?.[0];
  if (!Array.isArray(first) || first[0] !== 'JWT') throw new Error('malformed NRAS response');
  return { ...checkNrasJwt(first[1], jwks, nonceHex), arch: payload.arch };
}

/**
 * Full offline check of a recorded preflight. Throws unless the gateway and
 * every model candidate pass (including GPU). Returns verified signer summaries.
 */
export function checkPreflight(evidence, { model }) {
  const { nonce, report_raw, collateral, nras, verified_at } = evidence;
  const body = JSON.parse(report_raw);
  const gateway = checkNearReport(body.gateway_attestation, nonce, { collateral: collateral.gateway, nowSecs: verified_at });
  const candidates = body.model_attestations ?? [];
  if (!candidates.length) throw new Error('no NEAR model evidence returned');
  const models = candidates.map((c, i) => {
    if (c.model_name !== undefined && c.model_name !== model) throw new Error(`model report ${i} is for ${c.model_name}`);
    return { ...checkNearReport(c, nonce, { collateral: collateral.models[i], nowSecs: verified_at }), gpu: checkGpu(c, nonce, nras[i]) };
  });
  return { nonce, verified_at, model, gateway, models };
}

/** Exactly one verified model report must match the signature's signer + algo. */
export function selectSigner(preflight, sig) {
  const m = preflight.models.filter((r) => r.signing_algo === sig.signing_algo
    && r.signing_address.toLowerCase() === String(sig.signing_address).toLowerCase());
  if (m.length !== 1) throw new Error(`expected exactly 1 verified model report for signer ${sig.signing_address}, found ${m.length}`);
  return m[0];
}

const sameBytes = (a, b) => a.length === b.length && timingSafeEqual(a, b);

/** provider_tee: text = MODEL:sha256(req):sha256(resp), EIP-191 ecrecover == preflight signer. */
export function checkResponseSignature({ signature, requestBytes, responseBytes, model, preflightSigner }) {
  if (signature?.signature_kind !== 'provider_tee') throw new Error(`signature_kind ${signature?.signature_kind} is not provider_tee`);
  if (signature.signing_algo !== 'ecdsa') throw new Error('only ecdsa signatures are supported');
  const expected = `${model}:${sha256Hex(requestBytes)}:${sha256Hex(responseBytes)}`;
  if (signature.text !== expected) throw new Error('signature text does not match the exact request/response bytes');
  const sigBytes = hexBytes(signature.signature);
  if (sigBytes.length !== 65) throw new Error('ecdsa signature must be 65 bytes');
  const recovered = hexBytes(ethers.verifyMessage(Buffer.from(signature.text, 'utf8'), ethers.hexlify(sigBytes)));
  const claimed = hexBytes(signature.signing_address);
  if (claimed.length !== 20 || !sameBytes(recovered, claimed)) throw new Error('ECDSA signature does not match signing_address');
  if (preflightSigner.signing_algo !== 'ecdsa' || !sameBytes(hexBytes(preflightSigner.signing_address), claimed)) {
    throw new Error('signature signer does not match verified preflight evidence');
  }
  return { text: expected, recovered: ethers.getAddress('0x' + recovered.toString('hex')) };
}
