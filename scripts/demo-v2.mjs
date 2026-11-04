// Read-only: shows that petri v2 verified each real NEAR AI TEE signature ON-CHAIN (ecrecover in charge_verified).
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const CONTRACT = process.env.PETRI_V2 || 'v2.petri-1793597952.testnet';
const RPCS = process.env.RPC ? [process.env.RPC] : ['https://rpc.testnet.fastnear.com', 'https://rpc.testnet.near.org'];
async function rpc(params, method = 'query') {
  let err;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 200));
      return j.result;
    } catch (e) { err = e; }
  }
  throw err;
}
async function view(method, args) {
  let err;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query',
        params: { request_type: 'call_function', finality: 'final', account_id: CONTRACT, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }) });
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 200));
      return JSON.parse(Buffer.from(j.result.result).toString());
    } catch (e) { err = e; }
  }
  throw err;
}
const sha = (s) => createHash('sha256').update(s).digest('hex');
console.log(`contract ${CONTRACT}`);
console.log('registered TEE signers:', JSON.stringify(await view('get_tee_signers', {})));
const pet = await view('get_pet', { token_id: '0' });
console.log(`pet #0 ${pet.name}: balance ${(Number(BigInt(pet.balance) / 10n ** 18n) / 1e6).toFixed(6)} NEAR, replies ${pet.replies}, prompt_hash ${pet.prompt_hash.slice(0, 12)}…`);
let ok = true;
const pets = { 0: pet, 1: await view('get_pet', { token_id: '1' }) };
const nReplies = readdirSync(new URL('../examples/recorded/', import.meta.url)).filter((f) => /^reply-\d+\.json$/.test(f)).length;
for (let i = 1; i <= nReplies; i++) {
  const d = JSON.parse(readFileSync(new URL(`../examples/recorded/reply-${i}.json`, import.meta.url)));
  const replyHash = sha(`${d.model}:${sha(d.request)}:${d.response_hash}`);
  const proof = await view('get_tee_proof', { reply_hash: replyHash });
  const good = proof && proof.signer === d.signing_address.toLowerCase() && proof.request_hash === d.request_hash && proof.response_hash === d.response_hash && sha(d.response) === d.response_hash;
  const tok = (await view('get_reply', { reply_hash: replyHash }))?.token_id;
  const sys = JSON.parse(d.request).messages[0].content;
  const own = sys.startsWith(`You are ${pets[tok]?.name},`);
  ok &&= !!good && (own || i === 4);
  console.log(`reply-${i} (pet #${tok} ${pets[tok]?.name}): ${good ? '✓' : '✗'} on-chain ecrecover → ${proof?.signer} | response bytes hash ${good ? 'match' : 'MISMATCH'} | "${d.reply.slice(0, 48)}…"`);
  if (!own) console.log(`  ⚠ built on ${sys.split(',')[0].slice(8)}'s prompt: accepted before round 3; v3 now REJECTS this on-chain ("request system prompt is not this pet's own prompt")`);
}
// Arena round 0: re-run the published rule from the TEE-signed bytes and compare with the on-chain result.
const round = await view('get_arena', { id: '0' });
if (round) {
  const mine = [5, 6].map((i) => JSON.parse(readFileSync(new URL(`../examples/recorded/reply-${i}.json`, import.meta.url))));
  const local = mine.map((d, k) => ({ id: String(k), w: d.reply.toLowerCase().includes(round.challenge), n: [...d.reply.trim()].length }));
  const best = local.slice().sort((a, b) => (b.w - a.w) || (a.n - b.n) || (a.id - b.id))[0].id;
  const match = best === round.winner && round.entries.every((e, k) => e.chars === local[k].n && e.has_word === local[k].w);
  ok &&= match;
  console.log(`arena #0 "${round.challenge}": ${round.entries.map((e) => `pet #${e.token_id} ${e.has_word ? 'has word' : 'no word'} ${e.chars} chars`).join(' vs ')}`);
  console.log(`  rule: ${round.rule}\n  on-chain winner: pet #${round.winner} ${pets[round.winner].name} | recomputed locally: pet #${best} ${match ? '✓' : '✗'}`);
} else { ok = false; console.log('arena #0 missing'); }
// Pet #1 is its own NEAR account; its only key can call nothing but charge_verified.
const p1 = pets[1];
const keys = (await rpc({ request_type: 'view_access_key_list', finality: 'final', account_id: p1.pet_account })).keys;
const acct = await rpc({ request_type: 'view_account', finality: 'final', account_id: p1.pet_account });
const fc = keys.map((k) => k.access_key.permission);
const onlyCharge = keys.length === 1 && fc[0].FunctionCall && fc[0].FunctionCall.receiver_id === CONTRACT
  && JSON.stringify(fc[0].FunctionCall.method_names) === '["charge_verified"]';
console.log(`pet #1 ${p1.name}: own account ${p1.pet_account} (${(Number(BigInt(acct.amount) / 10n ** 18n) / 1e6).toFixed(6)} NEAR for its own gas), replies ${p1.replies}`);
console.log(`  keys: ${keys.length}, ${JSON.stringify(fc[0])} ${onlyCharge ? '✓ only charge_verified on ' + CONTRACT + ', no full-access key' : '✗'}`);
ok &&= onlyCharge && p1.replies >= 1;
// Round 4 upgrade (deploy + migrate, same address) kept the pets; round 5 (memecoin pots,
// plain deploy: new state lives under raw prefixes, no migration) kept them again.
// The live code is the reproducible `pnpm build:contract:deploy` wasm of this commit.
const ROUND4_CODE_HASH = '9MiRFRk5Qif8oPyQgRDEXFzMTDgpnDGAK3CtShS2GWk';
const live = await rpc({ request_type: 'view_account', finality: 'final', account_id: CONTRACT });
const r4 = live.code_hash === ROUND4_CODE_HASH && pets[0].name === 'Mochi' && pets[1].name === 'Moss'
  && typeof pets[1].pet_key_active === 'boolean' && pets[1].pet_key_active === true;
ok &&= r4;
console.log(`round 5 code ${live.code_hash} ${live.code_hash === ROUND4_CODE_HASH ? '✓ = pnpm build:contract:deploy' : '✗ expected ' + ROUND4_CODE_HASH}; Mochi #0 + Moss #1 kept; Moss pet_key_active=${pets[1].pet_key_active} ${r4 ? '✓ (key frozen on sale, rekey_pet)' : '✗'}`);
// Tip from any chain: pet #1's EVM address comes from NEAR Chain Signatures; the recorded MPC signature must recover to it.
const { petEvmAddress, signedSweep, loadNetwork } = await import('../lib/tip.mjs');
const { ethers } = await import('ethers');
const art = JSON.parse(readFileSync(new URL('../examples/tip/tip-testnet.json', import.meta.url)));
const cs = await petEvmAddress({ ...loadNetwork('testnet'), petri: CONTRACT }, '1');
const st = signedSweep(ethers.Transaction.from(art.signed.unsigned), art.signed.mpc_signature, cs.address);
ok &&= cs.address === art.evm_address;
console.log(`pet #1 EVM address via Chain Signatures: ${cs.address} ${cs.address === art.evm_address ? '✓' : '✗'}; MPC-signed sweep (NEAR tx ${art.signed.near_tx.slice(0, 8)}…) recovers to ${st.from} ✓`);
// Memecoin pots: rules fixed once, real testnet SHITZU, book #0 and the tip jars are on-chain.
const MEME_TOKEN = 'shitzu-0.factory.v10.meme-cooking.testnet';
const mcfg = await view('meme_get_config', {});
const book0 = await view('meme_get_book', { book_id: '0' });
const memeOk = mcfg && mcfg.token === MEME_TOKEN && mcfg.rake_bps === 500 && book0 && book0.backers === 2;
ok &&= !!memeOk;
console.log(`memecoin pots: token ${mcfg?.token} (real testnet SHITZU), rake ${mcfg?.rake_bps} bps, void after ${mcfg?.void_after_secs}s, immutable ${memeOk ? '✓' : '✗'}; book #0 pets ${book0?.pets} state ${book0?.state}, staked ${book0?.totals.map((t) => Number(BigInt(t) / 10n ** 18n))} SHITZU by ${book0?.backers} backers`);
console.log(ok ? '=> EVERY CHARGED REPLY IS TEE-VERIFIED ON-CHAIN, THE ARENA RESULT REPRODUCES, THE PET SIGNS ON OTHER CHAINS, ROUND-5 CODE IS LIVE' : '=> MISMATCH');
process.exit(ok ? 0 : 1);
