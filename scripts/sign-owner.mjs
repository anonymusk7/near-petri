// Sign a Petri owner-check challenge (NEP-413) with a TESTNET key from ~/.near-credentials,
// as a wallet's signMessage would. Prints only {nonce, accountId, publicKey, signature}.
// Usage: node scripts/sign-owner.mjs <account.testnet> [token_id] [--server http://127.0.0.1:5174] [--verify]
//   or:  node scripts/sign-owner.mjs <account.testnet> --challenge '<json from the web page>'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signNep413 } from '../lib/ownergate.mjs';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const server = flag('--server') ?? 'http://127.0.0.1:5174';
const given = flag('--challenge');
const verify = args.includes('--verify');
const [accountId, token = '0'] = args.filter((a) => !a.startsWith('--'));
if (!accountId?.endsWith('.testnet')) { console.error('usage: sign-owner.mjs <account.testnet> [token_id] [--verify]  (testnet accounts only)'); process.exit(2); }

const credFile = path.join(os.homedir(), '.near-credentials', 'testnet', `${accountId}.json`);
const cred = JSON.parse(fs.readFileSync(credFile, 'utf8'));
const challenge = given ? JSON.parse(given) : await (await fetch(`${server}/api/owner/challenge?token=${token}`)).json();
const { publicKey, signature } = signNep413(cred.private_key, {
  message: challenge.message, nonce: Buffer.from(challenge.nonce, 'base64'), recipient: challenge.recipient,
});
const signed = { nonce: challenge.nonce, accountId, publicKey, signature };
console.log(JSON.stringify(signed));
if (verify) {
  const r = await fetch(`${server}/api/owner/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signed) });
  const j = await r.json();
  console.log(JSON.stringify({ allowed: j.allowed, reason: j.reason }));
}
