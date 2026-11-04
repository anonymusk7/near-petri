// Petri local web app: serves web/dist and a small JSON API.
//   GET  /api/state            pets #0/#1 read live from testnet (falls back to web/snapshot.json offline)
//   GET  /api/replies?token=N  the pet's REAL recorded NEAR AI TEE replies, each re-verified
//                              locally (Intel TDX + NVIDIA + ECDSA) and checked against the
//                              on-chain proof the contract stored (get_tee_proof)
//   POST /api/chat             {token_id,msg}: new replies use the MOCK brain (no credits, unsigned,
//                              never charged on-chain); balance/sleep for them is a local simulation
//   POST /api/sim              {token_id, action: drain|revive|reset}: demo the sleep state locally
//   GET  /api/history?token=N  what the pet earned / paid / who held it, from nearblocks or archival
//                              RPC tx outcomes (falls back to web/history-snapshot.json offline)
//   GET  /api/owner/challenge?token=N   a NEP-413 message to sign with the holder's wallet
//   POST /api/owner/verify     {nonce, accountId, publicKey, signature}: signature + full-access key +
//                              nft_token owner checked on testnet; only the holder gets the owner view
// Usage: node web/server.mjs [--snapshot | --history-snapshot]   (PORT=5174)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto, { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyRecord } from '../lib/verify.mjs';
import { chat, sha256, SLEEP_THRESHOLD } from '../lib/chat.mjs';
import { createAiClient } from '../lib/ai.mjs';
import { eventsFromTx, aggregateHistory, toJSONSafe } from '../lib/history.mjs';
import { makeChallenge, verifyNep413, ownerGate } from '../lib/ownergate.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REC = path.join(ROOT, '..', 'examples', 'recorded');
const DIST = path.join(ROOT, 'dist');
const SNAP = path.join(ROOT, 'snapshot.json');
const HSNAP = path.join(ROOT, 'history-snapshot.json');
const ARCHIVAL = process.env.ARCHIVAL_RPC || 'https://archival-rpc.testnet.near.org';
const NEARBLOCKS = process.env.NEARBLOCKS_API || 'https://api-testnet.nearblocks.io';
const CONTRACT = process.env.PETRI_V2 || 'v2.petri-1793597952.testnet';
const RPCS = process.env.RPC ? [process.env.RPC] : ['https://rpc.testnet.fastnear.com', 'https://rpc.testnet.near.org'];
const PORT = Number(process.env.PORT || 5174);
const PROMPT = 'Cheerful moss creature who loves rain.';
// Which on-chain tx charged each recorded reply (see README tx tables).
const TX = {
  1: 'FzZ1KTAPa7SYECjXfUfofhTimvwRD9GMvHst46zPvWgn', 2: 'G6ApPumCUYTGpaePvTpttcSeRH4rwhvwf9MuJe2CWioW',
  3: 'BHf2psxhF3i7CGBY3zPQhmBps8bnAaAEUBr3BFZSC9qU', 4: 'BBXro5CMCnCotZ4oUYMpU2hdDZXLWvRgE3z2CgKegxZG',
  5: '3aB2ktZ4Dox99TiDti8BLZrFjsAmFmMi2dCZjzZZs1LW', 6: '2xPs1k2q684wF6GVLCQ2Nt1TfPvjb45VuiXytZnyFfA2',
};
const ARENA_TX = { 0: '3WENtHQS3q6Cv9qGscGLw3fDPaxioGfYndXZVdsUdJso' };
// Every contract tx listed in the README for this contract. nearblocks is asked first;
// its testnet indexer returned nothing for this contract when this was written.
const KNOWN_TXS = ['ENUmLpeyArGcoMLUF9EU55Mxit4nD2bEgPFQ3k2E9Krk', 'FzZ1KTAPa7SYECjXfUfofhTimvwRD9GMvHst46zPvWgn',
  'G6ApPumCUYTGpaePvTpttcSeRH4rwhvwf9MuJe2CWioW', 'BHf2psxhF3i7CGBY3zPQhmBps8bnAaAEUBr3BFZSC9qU', 'BUxc5RgrnLS4dqDGwvTdNkUyfDxHs8uR9VgHUi7zFTq2',
  'BBXro5CMCnCotZ4oUYMpU2hdDZXLWvRgE3z2CgKegxZG', '23MFXA2fkdPgNpmirLJt6kcxZjZYrCqszfUEyPux71jV', '3aB2ktZ4Dox99TiDti8BLZrFjsAmFmMi2dCZjzZZs1LW',
  '2xPs1k2q684wF6GVLCQ2Nt1TfPvjb45VuiXytZnyFfA2', '3WENtHQS3q6Cv9qGscGLw3fDPaxioGfYndXZVdsUdJso', '7TueePpC1tA4skZkQy2fATJRHZfGEtDcuBLjEswtSDXk',
  ...(process.env.PETRI_HISTORY_TXS ?? '').split(',').filter(Boolean)];
const SENDERS = ['petri-1793597952.testnet', 'petri-backend-1793597952.testnet', 'pet-1.v2.petri-1793597952.testnet'];
// Chain Signatures tip artifact (real MPC signature, testnet); addresses are re-derived live when online.
const TIP = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'examples', 'tip', 'tip-testnet.json'), 'utf8'));

async function rpc(params) {
  let err;
  for (const url of RPCS) {
    try {
      const ctl = AbortSignal.timeout(6000);
      const r = await fetch(url, { method: 'POST', signal: ctl, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params }) });
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 200));
      return j.result;
    } catch (e) { err = e; }
  }
  throw err;
}
const view = async (m, a) => JSON.parse(Buffer.from((await rpc({ request_type: 'call_function', finality: 'final',
  account_id: CONTRACT, method_name: m, args_base64: Buffer.from(JSON.stringify(a)).toString('base64') })).result).toString());

async function chainState() {
  const [signers, p0, p1] = await Promise.all([view('get_tee_signers', {}), view('get_pet', { token_id: '0' }), view('get_pet', { token_id: '1' })]);
  const pets = [p0, p1];
  for (const p of pets) {
    if (!p.pet_account) continue;
    const keys = (await rpc({ request_type: 'view_access_key_list', finality: 'final', account_id: p.pet_account })).keys;
    const acct = await rpc({ request_type: 'view_account', finality: 'final', account_id: p.pet_account });
    p.account_balance = acct.amount;
    p.keys = keys.map((k) => ({ public_key: k.public_key, permission: k.access_key.permission }));
  }
  const n = Number(await view('get_arena_count', {}));
  const arena = [];
  for (let i = 0; i < n; i++) {
    const r = await view('get_arena', { id: String(i) });
    for (const e of r.entries) { const rec = byHash.get(e.reply_hash); e.response = rec?.reply ?? '(reply not in examples/recorded)'; r.question ??= rec?.msg; }
    arena.push({ ...r, id: i, tx: ARENA_TX[i] ?? null });
  }
  const { petEvmAddress, loadNetwork } = await import('../lib/tip.mjs');
  for (const p of pets) p.tip = { chain: 'Ethereum Sepolia (any EVM)', ...(await petEvmAddress({ ...loadNetwork('testnet'), petri: CONTRACT }, p.token_id)) };
  pets[1].tip.signed_tx = TIP.signed.near_tx;
  return { contract: CONTRACT, network: 'testnet', signers, pets, arena, tip_quote: TIP.quote ?? null, sleep_threshold: SLEEP_THRESHOLD.toString(), fetched_at: new Date().toISOString() };
}

async function archival(method, params, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(ARCHIVAL, { method: 'POST', signal: AbortSignal.timeout(20000), headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (j.error) throw Object.assign(new Error(JSON.stringify(j.error).slice(0, 200)), { rpc: true });
      return j.result;
    } catch (e) { if (e.rpc || i >= tries) throw e; }
  }
}
async function nearblocksTxs() {
  try {
    const r = await fetch(`${NEARBLOCKS}/v1/account/${CONTRACT}/txns?per_page=100`, { signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    return (j.txns ?? []).map((t) => ({ hash: t.transaction_hash, sender: t.predecessor_account_id ?? t.signer_account_id }));
  } catch { return []; }
}
const txCache = new Map();
async function txEvents(hash, senders) {
  if (txCache.has(hash)) return txCache.get(hash);
  for (const sender of senders) {
    let tx;
    try { tx = await archival('EXPERIMENTAL_tx_status', { tx_hash: hash, sender_account_id: sender, wait_until: 'NONE' }); } catch { continue; }
    const block = await archival('block', { block_id: tx.transaction_outcome.block_hash });
    const evs = eventsFromTx(tx, { contract: CONTRACT, ts: String(block.header.timestamp_nanosec ?? block.header.timestamp) });
    txCache.set(hash, evs);
    return evs;
  }
  throw new Error(`tx ${hash} not found on archival RPC`);
}
async function chainHistoryEvents() {
  const nb = await nearblocksTxs();
  const list = [...nb, ...KNOWN_TXS.map((h) => ({ hash: h.split(':')[0], sender: h.split(':')[1] }))];
  const uniq = [...new Map(list.map((t) => [t.hash, t])).values()];
  const events = [];
  for (let i = 0; i < uniq.length; i += 4) { // archival RPC is slow; 4 at a time
    const batch = await Promise.all(uniq.slice(i, i + 4).map(({ hash, sender }) => txEvents(hash, [sender, ...SENDERS].filter(Boolean))));
    events.push(...batch.flat());
  }
  return { events, source: nb.length ? 'nearblocks + archival RPC' : 'archival RPC (known txs)', tx_count: uniq.length };
}
// The live fetch can take a while on archival RPC: the first visitors get the snapshot
// (labelled) until it finishes; a failed fetch is retried on the next request.
let liveHistory = null;
function liveHistoryEvents() {
  liveHistory ??= chainHistoryEvents().catch((e) => { liveHistory = null; throw e; });
  return liveHistory;
}
async function history(token) {
  let h, owner = null;
  try { owner = (await view('get_pet', { token_id: token }))?.owner_id ?? null; } catch { /* offline */ }
  const snap = (why) => ({ ...JSON.parse(fs.readFileSync(HSNAP, 'utf8')), source: 'snapshot', error: why });
  try {
    h = await Promise.race([liveHistoryEvents(), new Promise((r) => setTimeout(() => r(null), 8000))]) ?? snap('live fetch still running');
  } catch (e) { h = snap(String(e.message).slice(0, 120)); }
  return toJSONSafe({ ...aggregateHistory(h.events, { token_id: token, currentOwner: owner ?? undefined }), source: h.source,
    tx_count: h.tx_count, error: h.error, current_owner: owner });
}

// NEP-413 owner gate. Challenges are single-use and expire after 5 minutes.
const challenges = new Map();
function newChallenge(token) {
  const now = Date.now();
  for (const [k, c] of challenges) if (now - c.issuedAt > 10 * 60 * 1000) challenges.delete(k);
  const c = makeChallenge({ tokenId: token, contract: CONTRACT, recipient: CONTRACT, nonce: crypto.randomBytes(32), now });
  challenges.set(c.nonce, c);
  return c;
}
async function verifyOwner({ nonce, accountId, publicKey, signature }) {
  const challenge = challenges.get(nonce);
  challenges.delete(nonce);
  const now = Date.now();
  const sigOk = Boolean(challenge) && verifyNep413({ publicKey, signature, message: challenge.message,
    nonce: Buffer.from(nonce, 'base64'), recipient: challenge.recipient });
  let keyPermission = null, nftOwner = null;
  if (sigOk) {
    try { keyPermission = (await rpc({ request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey })).permission; }
    catch { keyPermission = null; }
    nftOwner = (await view('nft_token', { token_id: challenge.tokenId }))?.owner_id ?? null;
  }
  const d = ownerGate({ challenge, now, sigOk, keyPermission, accountId, nftOwner });
  if (!d.allowed) return d;
  const pet = await view('get_pet', { token_id: challenge.tokenId });
  let keys = [];
  if (pet.pet_account) keys = (await rpc({ request_type: 'view_access_key_list', finality: 'final', account_id: pet.pet_account })).keys;
  return { ...d, pet, pet_keys: keys.map((k) => ({ public_key: k.public_key, permission: k.access_key.permission })) };
}

// Recorded replies, verified once at startup (the Intel quote checks take ~100 ms each).
const records = fs.readdirSync(REC).filter((f) => /^reply-\d+\.json$/.test(f))
  .map((f) => ({ i: Number(f.match(/\d+/)[0]), rec: JSON.parse(fs.readFileSync(path.join(REC, f), 'utf8')) }))
  .sort((a, b) => a.i - b.i);
const local = new Map(records.map(({ i, rec }) => {
  const ev = JSON.parse(fs.readFileSync(path.join(REC, rec.evidence), 'utf8'));
  return [i, verifyRecord(rec, ev)];
}));
const byHash = new Map(records.map(({ rec }) => [sha256(`${rec.model}:${rec.request_hash}:${rec.response_hash}`), rec]));
const TOKEN_OF = { 1: '0', 2: '0', 3: '0', 4: '1', 5: '0', 6: '1' };
const LEGACY = { 4: "built on Mochi's prompt; accepted by v2, rejected by the v3 contract" };

async function replies(token) {
  const out = [];
  for (const { i, rec } of records.filter((r) => TOKEN_OF[r.i] === token)) {
    const replyHash = sha256(`${rec.model}:${rec.request_hash}:${rec.response_hash}`);
    let proof = null, onchainErr = null;
    try { proof = await view('get_tee_proof', { reply_hash: replyHash }); } catch (e) { onchainErr = e.message; }
    const v = local.get(i);
    out.push({
      id: `reply-${i}`, msg: rec.msg, reply: rec.reply, cost: rec.cost, chat_id: rec.chat_id, model: rec.model,
      signer: rec.signing_address, tx: TX[i], reply_hash: replyHash, legacy: LEGACY[i] ?? null,
      local: { ok: v.ok, passed: v.checks.filter((c) => c.ok).length, total: v.checks.length, checks: v.checks.map((c) => ({ name: c.name, ok: c.ok })) },
      onchain: proof ? { ok: proof.signer === rec.signing_address.toLowerCase() && proof.response_hash === rec.response_hash, signer: proof.signer }
        : { ok: false, error: onchainErr ?? 'no proof on-chain' },
    });
  }
  return out;
}

// Local simulation for mock chats only (never sent on-chain).
const sim = new Map();
const client = createAiClient({ mock: true });
function simOf(token, chainBalance) {
  if (!sim.has(token)) sim.set(token, { balance: BigInt(chainBalance ?? 0), forcedSleep: false });
  return sim.get(token);
}
let lastState = null;
async function state() {
  try { lastState = { ...(await chainState()), source: 'testnet' }; } catch (e) {
    lastState = { ...JSON.parse(fs.readFileSync(SNAP, 'utf8')), source: 'snapshot', error: String(e.message).slice(0, 120) };
  }
  for (const p of lastState.pets) {
    const s = simOf(p.token_id, p.balance);
    p.sim_balance = s.balance.toString();
    p.sim_asleep = p.asleep || s.forcedSleep || s.balance < SLEEP_THRESHOLD;
  }
  return lastState;
}

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok) => { let d = ''; req.on('data', (c) => { d += c; if (d.length > 1e4) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch { ok({}); } }); });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/state') return json(res, 200, await state());
    if (url.pathname === '/api/history') return json(res, 200, await history(url.searchParams.get('token') ?? '0'));
    if (url.pathname === '/api/owner/challenge') return json(res, 200, newChallenge(url.searchParams.get('token') ?? '0'));
    if (url.pathname === '/api/owner/verify' && req.method === 'POST') return json(res, 200, await verifyOwner(await readBody(req)));
    if (url.pathname === '/api/replies') return json(res, 200, await replies(url.searchParams.get('token') ?? '0'));
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const { token_id = '0', msg } = await readBody(req);
      const st = lastState ?? await state();
      const p = st.pets.find((x) => x.token_id === token_id);
      if (!p) return json(res, 404, { error: 'no such pet' });
      const s = simOf(token_id, p.balance);
      const pet = { token_id, name: p.name, prompt: PROMPT, prompt_hash: p.prompt_hash, balance: s.balance,
        asleep: p.asleep || s.forcedSleep || s.balance < SLEEP_THRESHOLD };
      try {
        const r = await chat(pet, String(msg ?? ''), { client });
        s.balance -= BigInt(r.cost);
        return json(res, 200, { reply: r.reply, cost: r.cost, mock: true, reply_hash: r.replyHash,
          sim_balance: s.balance.toString(), sim_asleep: s.forcedSleep || s.balance < SLEEP_THRESHOLD });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (url.pathname === '/api/sim' && req.method === 'POST') {
      const { token_id = '0', action } = await readBody(req);
      const st = lastState ?? await state();
      const p = st.pets.find((x) => x.token_id === token_id);
      if (!p) return json(res, 404, { error: 'no such pet' });
      const s = simOf(token_id, p.balance);
      if (action === 'drain') { s.balance = SLEEP_THRESHOLD - 1n; s.forcedSleep = true; }
      else if (action === 'revive') { s.balance += SLEEP_THRESHOLD * 5n; s.forcedSleep = false; }
      else if (action === 'reset') sim.delete(token_id);
      else return json(res, 400, { error: 'action must be drain|revive|reset' });
      return json(res, 200, await state());
    }
    // static
    let f = path.join(DIST, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
    if (!fs.existsSync(f)) return json(res, 503, { error: 'UI not built: run `pnpm web` (or `pnpm --dir web build`)' });
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] ?? 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  } catch (e) { json(res, 500, { error: e.message }); }
});

if (process.argv.includes('--snapshot')) {
  const s = await chainState();
  fs.writeFileSync(SNAP, JSON.stringify(s, null, 2) + '\n');
  console.log(`wrote ${SNAP}`);
}
if (process.argv.includes('--snapshot') || process.argv.includes('--history-snapshot')) {
  const h = await chainHistoryEvents();
  fs.writeFileSync(HSNAP, JSON.stringify({ contract: CONTRACT, fetched_at: new Date().toISOString(), ...h }, null, 2) + '\n');
  console.log(`wrote ${HSNAP}`);
  process.exit(0);
}
server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `port ${PORT} busy: PORT=5175 pnpm web` : e.message); process.exit(1); });
liveHistoryEvents().catch(() => {});
server.listen(PORT, '127.0.0.1', () => console.log(`Petri web: http://127.0.0.1:${PORT}  (contract ${CONTRACT}, AI brain: mock for new chats)`));
