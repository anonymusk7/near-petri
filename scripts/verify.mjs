// pnpm verify <reply.json> [more.json ...]: offline check of recorded TEE replies.
// Exit code 0 only if every file is VALID.
import fs from 'node:fs';
import path from 'node:path';
import { verifyRecord } from '../lib/verify.mjs';

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: pnpm verify <reply.json> [...]'); process.exit(2); }
let allOk = true;
for (const file of files) {
  let ok = false;
  try {
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    const evPath = rec.evidence ? path.resolve(path.dirname(file), rec.evidence) : null;
    const evidence = evPath && fs.existsSync(evPath) ? JSON.parse(fs.readFileSync(evPath, 'utf8')) : null;
    console.log(`\n${file}\n  pet ${rec.pet?.name} #${rec.pet?.token_id}  model ${rec.model}  chat_id ${rec.chat_id}`);
    console.log(`  > ${rec.msg}\n  < ${rec.reply}`);
    const v = verifyRecord(rec, evidence);
    for (const c of v.checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? `\n      ${c.detail}` : ''}`);
    ok = v.ok;
  } catch (e) { console.log(`  ✗ unreadable record: ${e.message}`); }
  console.log(`  => ${ok ? 'VALID' : 'INVALID'}`);
  allOk &&= ok;
}
process.exit(allOk ? 0 : 1);
