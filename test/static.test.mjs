// Hosted-demo export (scripts/export-static.mjs) with every RPC refused: the JSON the static build
// bundles has the shapes the UI reads, and neither it nor a built web/dist-static holds secrets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { scan } from '../scripts/scan-static.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOWN = 'http://127.0.0.1:9';
const freePort = () => new Promise((ok, fail) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }).on('error', fail);
});
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'petri-static-'));
const read = (f) => JSON.parse(fs.readFileSync(path.join(out, 'data', f), 'utf8'));

test('export-static writes the JSON the hosted demo reads', async () => {
  await promisify(execFile)(process.execPath, ['scripts/export-static.mjs', '--out', out], { cwd: ROOT, timeout: 60_000,
    env: { ...process.env, PORT: String(await freePort()), RPC: DOWN, ARCHIVAL_RPC: DOWN, NEARBLOCKS_API: DOWN, RPC_TIMEOUT_MS: '500', HISTORY_WAIT_MS: '0' } });
  for (const f of ['state.json', 'meme.json', 'replies-0.json', 'replies-1.json', 'history-0.json', 'history-1.json', 'snapshot.json', 'meme-snapshot.json', 'meta.json'])
    assert.ok(fs.existsSync(path.join(out, 'data', f)), f);
  const st = read('state.json');
  assert.equal(st.contract, 'v2.petri-1793597952.testnet');
  assert.deepEqual(st.pets.map((p) => [p.token_id, p.name]), [['0', 'Mochi'], ['1', 'Moss']]);
  for (const p of st.pets) { assert.match(p.tip.address, /^0x[0-9a-fA-F]{40}$/); assert.equal(p.sim_balance, undefined); }
  assert.ok(st.arena.length >= 1 && st.arena[0].entries.every((e) => typeof e.response === 'string'));
  const m = read('meme.json');
  assert.ok(m.config && Array.isArray(m.books) && Array.isArray(m.jars));
  assert.ok(m.books.find((b) => b.id === '1')?.txs.length > 0);
  const rs = [...read('replies-0.json'), ...read('replies-1.json')];
  assert.equal(rs.length, 9);
  for (const r of rs) {
    assert.match(r.id, /^reply-\d$/);
    assert.equal(r.local.ok, true, `${r.id} TEE checks`);
    assert.equal(r.local.passed, r.local.total);
    assert.match(r.tx, /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    assert.ok('ok' in r.onchain); // RPC is down here, so the on-chain check reports its error instead
  }
  const h = read('history-0.json');
  assert.equal(h.token_id, '0');
  assert.ok(h.earned && h.paid && Array.isArray(h.holders) && Array.isArray(h.timeline), 'history shape');
  assert.equal(read('meta.json').verification, 'verified at build time — re-run locally with pnpm verify');
  assert.deepEqual(scan([out]), []);
});

test('the secret scanner catches keys and passes public keys', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'petri-scan-'));
  const w = (n, s) => fs.writeFileSync(path.join(d, n), s);
  w('ok.json', JSON.stringify({ public_key: 'ed25519:' + '1'.repeat(44), key: 'secp256k1:' + '2'.repeat(88), css: '.mask-image{}' }));
  assert.deepEqual(scan([d]), []);
  w('a.js', 'const k="sk-' + 'a'.repeat(30) + '"');
  w('b.json', JSON.stringify({ secret_key: 'x' }));
  w('c.json', JSON.stringify({ k: 'ed25519:' + '3'.repeat(88) }));
  w('d.js', 'process.env.NEAR_AI_API_KEY');
  assert.deepEqual(scan([d]).map((f) => path.basename(f.file)).sort(), ['a.js', 'b.json', 'c.json', 'd.js']);
});

test('built web/dist-static holds no secrets', { skip: !fs.existsSync(path.join(ROOT, 'web', 'dist-static')) && 'web/dist-static not built (pnpm web:static)' }, () => {
  assert.deepEqual(scan([path.join(ROOT, 'web', 'dist-static')]), []);
});
