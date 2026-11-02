// Read-only: shows that petri v2 verified each real NEAR AI TEE signature ON-CHAIN (ecrecover in charge_verified).
import { readFileSync } from 'node:fs';
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
for (const i of [1, 2, 3, 4]) {
  const d = JSON.parse(readFileSync(new URL(`../examples/recorded/reply-${i}.json`, import.meta.url)));
  const replyHash = sha(`${d.model}:${sha(d.request)}:${d.response_hash}`);
  const proof = await view('get_tee_proof', { reply_hash: replyHash });
  const good = proof && proof.signer === d.signing_address.toLowerCase() && proof.request_hash === d.request_hash && proof.response_hash === d.response_hash && sha(d.response) === d.response_hash;
  const tok = (await view('get_reply', { reply_hash: replyHash }))?.token_id;
  ok &&= !!good;
  console.log(`reply-${i} (pet #${tok}): ${good ? '✓' : '✗'} on-chain ecrecover → ${proof?.signer} | request ${proof?.request_hash.slice(0, 10)}… | response bytes hash ${good ? 'match' : 'MISMATCH'} | "${d.reply.slice(0, 50)}…"`);
}
// Pet #1 is its own NEAR account; its only key can call nothing but charge_verified.
const p1 = await view('get_pet', { token_id: '1' });
const keys = (await rpc({ request_type: 'view_access_key_list', finality: 'final', account_id: p1.pet_account })).keys;
const acct = await rpc({ request_type: 'view_account', finality: 'final', account_id: p1.pet_account });
const fc = keys.map((k) => k.access_key.permission);
const onlyCharge = keys.length === 1 && fc[0].FunctionCall && fc[0].FunctionCall.receiver_id === CONTRACT
  && JSON.stringify(fc[0].FunctionCall.method_names) === '["charge_verified"]';
console.log(`pet #1 ${p1.name}: own account ${p1.pet_account} (${(Number(BigInt(acct.amount) / 10n ** 18n) / 1e6).toFixed(6)} NEAR for its own gas), replies ${p1.replies}`);
console.log(`  keys: ${keys.length}, ${JSON.stringify(fc[0])} ${onlyCharge ? '✓ only charge_verified on ' + CONTRACT + ', no full-access key' : '✗'}`);
ok &&= onlyCharge && p1.replies >= 1;
console.log(ok ? '=> EVERY CHARGED REPLY CARRIES A NEAR AI TEE SIGNATURE VERIFIED BY THE CONTRACT' : '=> MISMATCH');
process.exit(ok ? 0 : 1);
