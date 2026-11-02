// Record real TEE replies (PAID). One verified preflight, then one completion per
// message, each saved as examples/recorded/reply-N.json (+ raw bytes) and logged
// to /workspace/near-ai-usage.log. Refuses to exceed MAX_RECORDED replies.
// Usage: MOCK_AI=0 node scripts/record-tee.mjs "msg 1" ["msg 2" ...]
import fs from 'node:fs';
import path from 'node:path';
import { chat, sha256 } from '../lib/chat.mjs';
import { createAiClient, usageCostUsd } from '../lib/ai.mjs';
import { DEMO_PET } from './demo-pet.mjs';

const MAX_RECORDED = 4;
const DIR = path.resolve('examples/recorded');
const LOG = '/workspace/near-ai-usage.log';
const msgs = process.argv.slice(2);
if (process.env.MOCK_AI !== '0') throw new Error('set MOCK_AI=0 to record real replies');
fs.mkdirSync(path.join(DIR, 'raw'), { recursive: true });
const existing = fs.readdirSync(DIR).filter((f) => /^reply-\d+\.json$/.test(f)).length;
if (!msgs.length || existing + msgs.length > MAX_RECORDED) {
  throw new Error(`have ${existing} recorded replies; at most ${MAX_RECORDED} allowed (got ${msgs.length} new messages)`);
}

let n = existing;
const client = createAiClient({
  mock: false,
  async onCompletion({ requestBody, responseBody, id, usage, model }) {
    const u = { prompt_tokens: usage?.prompt_tokens ?? 0, completion_tokens: usage?.completion_tokens ?? 0 };
    fs.appendFileSync(LOG, `${new Date().toISOString()} project=near-petri model=${model} chat_id=${id} `
      + `prompt_tokens=${u.prompt_tokens} completion_tokens=${u.completion_tokens} cost_usd=${usageCostUsd(u).toFixed(6)}\n`);
    const base = path.join(DIR, 'raw', `reply-${n + 1}`);
    fs.writeFileSync(`${base}.request.json`, requestBody);
    fs.writeFileSync(`${base}.response.json`, responseBody);
  },
});

const { evidence, summary } = await client.preflight();
const evName = `preflight-${evidence.nonce.slice(0, 12)}.json`;
fs.writeFileSync(path.join(DIR, evName), JSON.stringify(evidence));
console.log(`preflight OK, nonce ${summary.nonce}; ${summary.models.length} model report(s); saved ${evName}`);

const pet = { ...DEMO_PET, prompt_hash: sha256(DEMO_PET.prompt), balance: 10n ** 24n, asleep: false };
for (const msg of msgs) {
  const r = await chat(pet, msg, { client });
  n += 1;
  fs.writeFileSync(path.join(DIR, 'raw', `reply-${n}.signature.json`), JSON.stringify(r.record.signature, null, 2));
  const rec = { ...r.record, evidence: evName };
  fs.writeFileSync(path.join(DIR, `reply-${n}.json`), JSON.stringify(rec, null, 2) + '\n');
  console.log(`\nreply-${n}: > ${msg}\n< ${r.reply}\nchat_id ${rec.chat_id} usage ${JSON.stringify(r.usage)} reply_hash ${rec.reply_hash}`);
}
