// web/server.mjs with every RPC refused: snapshot fallbacks, fail-fast circuit breaker,
// input validation, local sim revive over a pet asleep on testnet, body limit, static path safety.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';

const ROOT = new URL('..', import.meta.url);
const DOWN = 'http://127.0.0.1:9'; // discard port: connection refused
const freePort = () => new Promise((ok, fail) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }).on('error', fail);
});

let srv, base, port;
before(async () => {
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['web/server.mjs'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), RPC: DOWN, ARCHIVAL_RPC: DOWN, NEARBLOCKS_API: DOWN, RPC_TIMEOUT_MS: '500' } });
  let log = '';
  await new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`server did not start:\n${log}`)), 15000);
    const on = (d) => { log += d; if (log.includes('Petri web:')) { clearTimeout(t); ok(); } };
    srv.stdout.on('data', on); srv.stderr.on('data', on);
    srv.on('exit', (c) => { clearTimeout(t); fail(new Error(`server exited ${c}:\n${log}`)); });
  });
});
after(() => { srv?.kill(); });

const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const post = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
// raw request: fetch() would normalize /../ away before sending
const raw = (p, { method = 'GET', body } = {}) => new Promise((ok, fail) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, method }, (res) => {
    let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => ok({ status: res.statusCode, text: d }));
  });
  req.on('error', fail);
  req.end(body);
});

test('/api/state falls back to the snapshot and explains the sleep', async () => {
  const { status, body } = await get('/api/state');
  assert.equal(status, 200);
  assert.equal(body.source, 'snapshot');
  assert.match(body.error, /testnet RPC unreachable/);
  const mochi = body.pets.find((p) => p.token_id === '0');
  assert.equal(mochi.asleep, true);
  // 0.48 NEAR > threshold, so the snapshot pet is asleep from hunger, not balance
  assert.equal(mochi.chain_sleep_reason, 'hunger');
});

test('/api/meme falls back to the snapshot', async () => {
  const { status, body } = await get('/api/meme');
  assert.equal(status, 200);
  assert.equal(body.source, 'snapshot');
});

test('/api/replies lists every recorded reply per pet, fast, while RPC is down', async () => {
  const t0 = Date.now();
  const r0 = await get('/api/replies?token=0');
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  assert.equal(r0.status, 200);
  const ids0 = r0.body.map((r) => r.id);
  assert.ok(ids0.includes('reply-8'), ids0.join());
  assert.equal(r0.body.find((r) => r.id === 'reply-8').tx, '7e81RQcgz9A9pqRAme8hSRVPP5YnhmWBAdbSh4QMzptG');
  assert.ok(r0.body.every((r) => r.local.ok && !r.onchain.ok));
  const ids1 = (await get('/api/replies?token=1')).body.map((r) => r.id);
  for (const id of ['reply-4', 'reply-6', 'reply-7', 'reply-9']) assert.ok(ids1.includes(id), ids1.join());
  assert.ok(!ids1.includes('reply-8'));
});

test('bad params are 400, unknown API paths 404', async () => {
  for (const p of ['/api/replies?token=abc', '/api/history?token=1;drop', '/api/owner/challenge?token=1234567',
    '/api/meme/account?book=x&account=guest1.testnet', '/api/meme/account?book=1&account=NOPE!']) {
    const { status, body } = await get(p);
    assert.equal(status, 400, p);
    assert.ok(body.error, p);
  }
  assert.equal((await get('/api/meme/account?book=x&account=guest1.testnet')).body.error, 'bad account or book id');
  const nf = await get('/api/x');
  assert.equal(nf.status, 404);
  assert.match(nf.body.error, /no such API endpoint/);
});

test('/api/meme/account during the outage is 503', async () => {
  const { status, body } = await get('/api/meme/account?book=1&account=guest1-1793595336.testnet');
  assert.equal(status, 503);
  assert.equal(body.error, 'testnet RPC unreachable, try again later');
});

test('local revive lets you chat with a pet asleep on testnet; reset restores the chain state', async () => {
  await get('/api/state');
  const asleep = await post('/api/chat', { token_id: '0', msg: 'hi' });
  assert.equal(asleep.status, 400);
  const st = await post('/api/sim', { token_id: '0', action: 'revive' });
  assert.equal(st.status, 200);
  const p = st.body.pets.find((x) => x.token_id === '0');
  assert.equal(p.asleep, true); // still asleep on testnet
  assert.equal(p.sim_asleep, false);
  assert.equal(p.sim_woke, true);
  const r = await post('/api/chat', { token_id: '0', msg: 'hello Mochi' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mock, true);
  assert.ok(r.body.reply);
  assert.equal(r.body.sim_asleep, false);
  const reset = await post('/api/sim', { token_id: '0', action: 'reset' });
  const p2 = reset.body.pets.find((x) => x.token_id === '0');
  assert.equal(p2.sim_asleep, true);
  assert.equal(p2.sleep_reason, 'hunger');
});

test('chat with Moss (#1) uses its own prompt, picked by on-chain prompt_hash', async () => {
  const st = await post('/api/sim', { token_id: '1', action: 'revive' });
  assert.equal(st.status, 200);
  assert.match(st.body.pets.find((x) => x.token_id === '1').prompt_hash, /^e9947b34/);
  const r = await post('/api/chat', { token_id: '1', msg: 'hello Moss' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mock, true);
  assert.ok(r.body.reply);
  await post('/api/sim', { token_id: '1', action: 'reset' });
});

test('POST body over 10 KB is 413', async () => {
  const r = await raw('/api/chat', { method: 'POST', body: JSON.stringify({ token_id: '0', msg: 'x'.repeat(20000) }) });
  assert.equal(r.status, 413);
});

test('path traversal does not leak files outside web/dist', async () => {
  const pkg = fs.readFileSync(new URL('package.json', ROOT), 'utf8');
  for (const p of ['/../../package.json', '/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/package.json']) {
    const r = await raw(p);
    assert.ok(!r.text.includes('"name": "near-petri"') && r.text !== pkg, p);
  }
});

test('static UI is served', { skip: !fs.existsSync(new URL('web/dist/index.html', ROOT)) && 'web/dist not built' }, async () => {
  const r = await raw('/');
  assert.equal(r.status, 200);
  assert.match(r.text, /<html/i);
});
