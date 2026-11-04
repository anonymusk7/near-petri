// Round 4: record ONE fresh real TEE reply for Moss (#1) on its own on-chain prompt (PAID, tiny).
// Saves examples/recorded/reply-7.json + raw bytes, logs usage to /workspace/near-ai-usage.log.
// Usage: MOCK_AI=0 node scripts/record-moss.mjs "message"
import fs from 'node:fs';
import path from 'node:path';
import { chat, sha256 } from '../lib/chat.mjs';
import { createAiClient, usageCostUsd } from '../lib/ai.mjs';
import { MOSS_PET } from './demo-pet.mjs';

const DIR = path.resolve('examples/recorded');
const LOG = '/workspace/near-ai-usage.log';
const msg = process.argv[2];
if (process.env.MOCK_AI !== '0') throw new Error('set MOCK_AI=0 to record real replies');
if (!msg) throw new Error('usage: record-moss.mjs "message"');
const n = fs.readdirSync(DIR).filter((f) => /^reply-\d+\.json$/.test(f)).length + 1;
if (n !== 7) throw new Error(`expected to write reply-7, would write reply-${n}; refusing`);
const client = createAiClient({
  mock: false,
  async onCompletion({ requestBody, responseBody, id, usage, model }) {
    const u = { prompt_tokens: usage?.prompt_tokens ?? 0, completion_tokens: usage?.completion_tokens ?? 0 };
    fs.appendFileSync(LOG, `${new Date().toISOString()} project=near-petri round4 model=${model} chat_id=${id} `
      + `prompt_tokens=${u.prompt_tokens} completion_tokens=${u.completion_tokens} cost_usd=${usageCostUsd(u).toFixed(6)}\n`);
    const base = path.join(DIR, 'raw', `reply-${n}`);
    fs.writeFileSync(`${base}.request.json`, requestBody);
    fs.writeFileSync(`${base}.response.json`, responseBody);
  },
});
const { evidence, summary } = await client.preflight();
const evName = `preflight-${evidence.nonce.slice(0, 12)}.json`;
fs.writeFileSync(path.join(DIR, evName), JSON.stringify(evidence));
console.log(`preflight OK, nonce ${summary.nonce}; saved ${evName}`);
const pet = { ...MOSS_PET, prompt_hash: sha256(MOSS_PET.prompt), balance: 10n ** 24n, asleep: false };
const r = await chat(pet, msg, { client });
fs.writeFileSync(path.join(DIR, 'raw', `reply-${n}.signature.json`), JSON.stringify(r.record.signature, null, 2));
fs.writeFileSync(path.join(DIR, `reply-${n}.json`), JSON.stringify({ ...r.record, evidence: evName }, null, 2) + '\n');
console.log(`reply-${n} Moss: ${r.reply}\n  usage ${JSON.stringify(r.usage)} cost ${r.record.cost}`);
