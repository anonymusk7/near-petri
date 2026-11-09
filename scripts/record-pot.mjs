// Round 6: record TWO fresh real TEE replies (Mochi #0, Moss #1) to the same arena
// question, AFTER a SHITZU book has closed, so the round can settle that book live.
// Saves examples/recorded/reply-8.json (Mochi) + reply-9.json (Moss) + raw bytes,
// logs usage to /workspace/near-ai-usage.log. Refuses to run twice (PAID, ~$0.0003).
// Usage: MOCK_AI=0 node scripts/record-pot.mjs
import fs from 'node:fs';
import path from 'node:path';
import { chat, sha256 } from '../lib/chat.mjs';
import { createAiClient, usageCostUsd } from '../lib/ai.mjs';
import { DEMO_PET, MOSS_PET } from './demo-pet.mjs';

export const POT = { challenge: 'bone', question: 'Arena round 2: describe a dog in one line and use the word bone.' };
const DIR = path.resolve('examples/recorded');
const LOG = '/workspace/near-ai-usage.log';
if (process.env.MOCK_AI !== '0') throw new Error('set MOCK_AI=0 to record real replies');
let n = fs.readdirSync(DIR).filter((f) => /^reply-\d+\.json$/.test(f)).length;
if (n !== 7) throw new Error(`expected 7 recorded replies, found ${n}; refusing`);
const client = createAiClient({
  mock: false,
  async onCompletion({ requestBody, responseBody, id, usage, model }) {
    const u = { prompt_tokens: usage?.prompt_tokens ?? 0, completion_tokens: usage?.completion_tokens ?? 0 };
    fs.appendFileSync(LOG, `${new Date().toISOString()} project=near-petri round6-pot model=${model} chat_id=${id} `
      + `prompt_tokens=${u.prompt_tokens} completion_tokens=${u.completion_tokens} cost_usd=${usageCostUsd(u).toFixed(6)}\n`);
    const base = path.join(DIR, 'raw', `reply-${n + 1}`);
    fs.writeFileSync(`${base}.request.json`, requestBody);
    fs.writeFileSync(`${base}.response.json`, responseBody);
  },
});
const { evidence, summary } = await client.preflight();
const evName = `preflight-${evidence.nonce.slice(0, 12)}.json`;
fs.writeFileSync(path.join(DIR, evName), JSON.stringify(evidence));
console.log(`preflight OK, nonce ${summary.nonce}; saved ${evName}`);
for (const p of [DEMO_PET, MOSS_PET]) {
  const pet = { ...p, prompt_hash: sha256(p.prompt), balance: 10n ** 24n, asleep: false };
  const r = await chat(pet, POT.question, { client });
  n += 1;
  fs.writeFileSync(path.join(DIR, 'raw', `reply-${n}.signature.json`), JSON.stringify(r.record.signature, null, 2));
  const rec = { ...r.record, evidence: evName, arena: { round: 'arena-1', challenge: POT.challenge, meme_book: '1' } };
  fs.writeFileSync(path.join(DIR, `reply-${n}.json`), JSON.stringify(rec, null, 2) + '\n');
  console.log(`reply-${n} ${p.name}: ${r.reply}\n  usage ${JSON.stringify(r.usage)} cost ${r.record.cost}`);
}
