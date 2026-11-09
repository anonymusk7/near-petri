// Fail if a static build (or the exported JSON) contains anything secret-looking.
// Usage: node scripts/scan-static.mjs <dir> [...dirs]   (exit 1 on a finding; prints file + rule, never the value)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RULES = [
  ['openai-style API key (sk-…)', /\bsk-[A-Za-z0-9_-]{16,}/],
  ['NEAR_AI env name', /NEAR_AI/],
  // a NEAR ed25519 secret key is 64 bytes (~88 base58 chars); public keys are 32 bytes (~44)
  ['ed25519 secret key', /ed25519:[1-9A-HJ-NP-Za-km-z]{70,}/],
  // (no length rule for secp256k1: the MPC derived_public_key in pets[].tip.key is a 64-byte PUBLIC key;
  //  secret keys are caught by the field-name rule and the env-value check)
  ['secret/private key field', /["'](secret_key|private_key|secretKey|privateKey|seed_phrase|seedPhrase)["']\s*:/],
  ['PEM private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];
// Values of this process's secret-looking env vars must not appear either (checked, never printed).
const envSecrets = Object.entries(process.env)
  .filter(([k, v]) => /KEY|SECRET|TOKEN|PASS|MNEMONIC|SEED/i.test(k) && typeof v === 'string' && v.length >= 12)
  .map(([k, v]) => [k, v]);

function* files(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(f);
    else if (/\.(js|mjs|json|html|css|map|txt|svg)$/.test(e.name)) yield f;
  }
}

/** @returns {{ file: string, rule: string }[]} */
export function scan(dirs) {
  const out = [];
  for (const dir of dirs) for (const f of files(dir)) {
    const text = fs.readFileSync(f, 'utf8');
    for (const [rule, re] of RULES) if (re.test(text)) out.push({ file: f, rule });
    for (const [k, v] of envSecrets) if (text.includes(v)) out.push({ file: f, rule: `value of env ${k}` });
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dirs = process.argv.slice(2);
  if (!dirs.length || !dirs.every((d) => fs.existsSync(d))) { console.error('usage: node scripts/scan-static.mjs <existing dir>…'); process.exit(2); }
  const found = scan(dirs);
  for (const { file, rule } of found) console.error(`✗ ${file}: ${rule}`);
  if (found.length) { console.error(`=> ${found.length} secret-looking finding(s): not publishing`); process.exit(1); }
  console.log(`✓ no secrets in ${dirs.join(', ')}`);
}
