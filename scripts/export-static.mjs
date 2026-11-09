// Build-time data for the hosted (static, serverless) demo: starts web/server.mjs as a child on
// PORT (default 5199), reads its API exactly as the local app would, writes JSON next to the static
// build, then stops only that child. The replies keep the server's results: every recorded NEAR AI
// TEE reply re-verified (Intel TDX + NVIDIA + ECDSA) and checked against get_tee_proof on testnet,
// at build time. Finally scans the output for anything secret-looking.
// Usage: node scripts/export-static.mjs [--out web/public-static]   (HISTORY_WAIT_MS=90000)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from './scan-static.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg('--out', path.join(ROOT, 'web', 'public-static')));
const DATA = path.join(OUT, 'data');
const PORT = Number(process.env.PORT || 5199);
const HISTORY_WAIT_MS = Number(process.env.HISTORY_WAIT_MS ?? 90_000);
const TOKENS = ['0', '1'];

// The child gets no secret-looking env (the mock-brain server needs none).
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/KEY|SECRET|TOKEN|PASS|MNEMONIC|SEED/i.test(k)));
const child = spawn(process.execPath, [path.join(ROOT, 'web', 'server.mjs')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, PORT: String(PORT) } });
const base = `http://127.0.0.1:${PORT}`;
try {
  let log = '';
  await new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`server did not start:\n${log}`)), 30_000);
    const on = (d) => { log += d; if (log.includes('Petri web:')) { clearTimeout(t); ok(); } };
    child.stdout.on('data', on); child.stderr.on('data', on);
    child.on('exit', (c) => { clearTimeout(t); fail(new Error(`server exited ${c}:\n${log}`)); });
  });
  const get = async (p) => {
    const r = await fetch(base + p);
    if (!r.ok) throw new Error(`${p}: ${r.status} ${await r.text()}`);
    return r.json();
  };

  fs.mkdirSync(DATA, { recursive: true });
  const write = (name, v) => fs.writeFileSync(path.join(DATA, name), JSON.stringify(v, null, 1) + '\n');

  const state = await get('/api/state');
  // the browser recomputes the sleep simulation itself
  for (const p of state.pets) for (const k of ['sim_balance', 'sim_asleep', 'sim_woke', 'sleep_reason', 'chain_sleep_reason']) delete p[k];
  write('state.json', state);
  write('meme.json', await get('/api/meme'));
  const counts = {};
  for (const t of TOKENS) {
    const rs = await get(`/api/replies?token=${t}`);
    write(`replies-${t}.json`, rs);
    counts[t] = { replies: rs.length, tee_ok: rs.filter((r) => r.local.ok).length, onchain_ok: rs.filter((r) => r.onchain.ok).length };
  }
  // history is read from archival RPC on the server's first request; wait for the live result, else keep its snapshot
  const until = Date.now() + HISTORY_WAIT_MS;
  let hist;
  for (;;) {
    hist = await Promise.all(TOKENS.map((t) => get(`/api/history?token=${t}`)));
    if (hist.every((h) => h.source !== 'snapshot') || Date.now() >= until) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  TOKENS.forEach((t, i) => write(`history-${t}.json`, hist[i]));
  // RPC-failure fallbacks for the live reads in the browser
  fs.copyFileSync(path.join(ROOT, 'web', 'snapshot.json'), path.join(DATA, 'snapshot.json'));
  fs.copyFileSync(path.join(ROOT, 'web', 'meme-snapshot.json'), path.join(DATA, 'meme-snapshot.json'));
  for (const f of fs.readdirSync(path.join(ROOT, 'web', 'public'))) fs.copyFileSync(path.join(ROOT, 'web', 'public', f), path.join(OUT, f));
  write('meta.json', { exported_at: new Date().toISOString(), contract: state.contract, network: state.network,
    state_source: state.source, history_source: hist[0].source, replies: counts,
    verification: 'verified at build time — re-run locally with pnpm verify' });

  const found = scan([OUT]);
  if (found.length) {
    for (const { file, rule } of found) console.error(`✗ ${file}: ${rule}`);
    throw new Error('secret-looking content in the static export');
  }
  console.log(`wrote ${DATA} (state: ${state.source}, history: ${hist[0].source}, replies ${JSON.stringify(counts)}); no secrets found`);
} finally {
  child.kill();
}
