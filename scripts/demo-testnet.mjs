// pnpm demo:testnet: read the deployed Petri pet over NEAR RPC (view calls, no
// keys) and match every recorded TEE reply to its on-chain charge receipt.
// Env: PETRI_CONTRACT, NEAR_RPC, PET_ID.
import fs from 'node:fs';
import path from 'node:path';
import { verifyRecord } from '../lib/verify.mjs';

export const DEFAULT_CONTRACT = 'petri-1793597952.testnet';
const CONTRACT = process.env.PETRI_CONTRACT ?? DEFAULT_CONTRACT;
const RPCS = process.env.NEAR_RPC ? [process.env.NEAR_RPC] : ['https://rpc.testnet.near.org', 'https://rpc.testnet.fastnear.com'];
const PET_ID = process.env.PET_ID ?? '0';
const DIR = path.resolve('examples/recorded');

async function view(method, args) {
  let last;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        jsonrpc: '2.0', id: 'petri', method: 'query',
        params: { request_type: 'call_function', finality: 'final', account_id: CONTRACT, method_name: method,
          args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }) });
      const j = await r.json();
      if (j.error || j.result?.error) throw new Error(JSON.stringify(j.error ?? j.result.error).slice(0, 300));
      return JSON.parse(Buffer.from(j.result.result).toString('utf8'));
    } catch (e) { last = e; }
  }
  throw last;
}

const near = (y) => (Number(BigInt(y) / 10n ** 18n) / 1e6).toFixed(6);
const cfg = await view('get_config', {});
const pet = await view('get_pet', { token_id: PET_ID });
if (!pet) throw new Error(`pet ${PET_ID} not found on ${CONTRACT}`);
console.log(`contract ${CONTRACT}  owner ${cfg.owner_id}  backend ${cfg.backend_id}  pets ${cfg.total_pets}  treasury ${near(cfg.treasury)} NEAR`);
console.log(`pet #${pet.token_id} "${pet.name}"  owner ${pet.owner_id}  balance ${near(pet.balance)} NEAR  replies ${pet.replies}  asleep ${pet.asleep}`);
console.log(`  prompt_hash ${pet.prompt_hash}\n  last_reply_hash ${pet.last_reply_hash}`);

let allOk = true;
const files = fs.readdirSync(DIR).filter((f) => /^reply-\d+\.json$/.test(f)).sort();
for (const f of files) {
  const rec = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  const onChain = await view('get_reply', { reply_hash: rec.reply_hash });
  const tee = verifyRecord(rec, JSON.parse(fs.readFileSync(path.join(DIR, rec.evidence), 'utf8')));
  const match = !!onChain && onChain.token_id === rec.pet.token_id && onChain.cost === rec.cost && rec.pet.prompt_hash === pet.prompt_hash;
  allOk &&= match && tee.ok;
  console.log(`\n${f}: "${rec.reply}"`);
  console.log(`  reply_hash ${rec.reply_hash}`);
  console.log(`  on-chain get_reply: ${onChain ? `index ${onChain.index}, cost ${near(onChain.cost)} NEAR, at ${new Date(Number(BigInt(onChain.at_ns.toString()) / 1000000n)).toISOString()}` : 'NOT FOUND'}`);
  console.log(`  ${match ? '✓' : '✗'} on-chain receipt matches record (token, cost, prompt_hash)   ${tee.ok ? '✓' : '✗'} TEE evidence verifies offline (pnpm verify ${path.join('examples/recorded', f)})`);
}
console.log(`\n=> ${allOk ? 'ALL RECORDED REPLIES CHARGED ON-CHAIN AND TEE-VERIFIED' : 'MISMATCH'}`);
process.exit(allOk ? 0 : 1);
