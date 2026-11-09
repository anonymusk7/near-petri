// Live proof that the transactions the browser wallet sends (built by lib/txs.mjs) work on testnet.
// Signs each TxDesc with guest1's local key (~/.near-credentials, kept in memory, never printed), sends it,
// waits for FINAL and checks every receipt. Prints only hashes and results; writes
// examples/wallet-live/wallet-live-testnet.json (hashes, args, amounts, block times; no keys).
//   pnpm wallet:live          (steps: swap 0.05 NEAR, tip Mochi 1 SHITZU, open 0 vs 1 for 24 h if none, back Moss 1 SHITZU)
// Steps that would obviously fail (not enough NEAR for deposits + prepaid gas, no SHITZU, no open book) are skipped with the reason.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { KeyPair } from '@near-js/crypto';
import { actionCreators, createTransaction, encodeTransaction, SignedTransaction, Signature } from '@near-js/transactions';
import { baseDecode, baseEncode } from '@near-js/utils';
import { CONTRACT, TOKEN, WRAP, REF, formatAmount, minOutFromQuote, openBookTx, backTx, tipTx, refQuoteArgs, swapNearForShitzuTxs } from '../lib/txs.mjs';

const SIGNER = 'guest1-1793595336.testnet';
const RPCS = ['https://rpc.testnet.fastnear.com', 'https://rpc.testnet.near.org'];
const OUT = new URL('../examples/wallet-live/wallet-live-testnet.json', import.meta.url);
const ONE_SHITZU = 10n ** 18n;

async function rpc(method, params) {
  let last;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (j.error) { last = new Error(JSON.stringify(j.error).slice(0, 400)); continue; }
      return j.result;
    } catch (e) { last = e; }
  }
  throw last;
}
const view = async (account_id, method_name, args = {}) => {
  const r = await rpc('query', { request_type: 'call_function', finality: 'final', account_id, method_name, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  if (r.error) throw new Error(r.error);
  return JSON.parse(Buffer.from(r.result).toString());
};
/** liquid NEAR minus what storage staking locks (10^19 yocto per byte) */
async function spendable(account_id) {
  const a = await rpc('query', { request_type: 'view_account', finality: 'final', account_id });
  return BigInt(a.amount) - BigInt(a.storage_usage) * 10n ** 19n;
}
/** deposits + prepaid gas at the current gas price: what the signer must hold up front */
async function upfront(txs) {
  const { gas_price } = await rpc('gas_price', [null]);
  let y = 0n;
  for (const t of txs) for (const { params: p } of t.actions) y += BigInt(p.deposit) + BigInt(p.gas) * BigInt(gas_price);
  return y;
}
const near = (y) => formatAmount(y < 0n ? 0n : y, 24);
const shitzu = (v) => formatAmount(BigInt(v), 18);

// The key stays in this closure; nothing below logs or stores it.
const keyPair = (() => {
  const f = JSON.parse(readFileSync(`${homedir()}/.near-credentials/testnet/${SIGNER}.json`, 'utf8'));
  return KeyPair.fromString(f.private_key);
})();

async function sendTx(desc) {
  const pk = keyPair.getPublicKey();
  const ak = await rpc('query', { request_type: 'view_access_key', finality: 'final', account_id: SIGNER, public_key: pk.toString() });
  const block = await rpc('block', { finality: 'final' });
  const actions = desc.actions.map(({ params: p }) => actionCreators.functionCall(p.methodName, p.args, BigInt(p.gas), BigInt(p.deposit)));
  const tx = createTransaction(SIGNER, pk, desc.receiverId, BigInt(ak.nonce) + 1n, actions, baseDecode(block.header.hash));
  const digest = createHash('sha256').update(encodeTransaction(tx)).digest();
  const { signature } = keyPair.sign(digest);
  const signed = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: pk.keyType, data: signature }) });
  const hash = baseEncode(digest);
  let res;
  try {
    res = await rpc('send_tx', { signed_tx_base64: Buffer.from(signed.encode()).toString('base64'), wait_until: 'FINAL' });
  } catch (e) {
    // a slow RPC can time out before FINAL: poll by hash
    for (let i = 0; i < 20 && !res; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      res = await rpc('tx', { tx_hash: hash, sender_account_id: SIGNER, wait_until: 'FINAL' }).catch(() => null);
    }
    if (!res) throw e;
  }
  const failures = [];
  if (res.status?.Failure) failures.push(res.status.Failure);
  for (const r of res.receipts_outcome) if (r.outcome.status?.Failure) failures.push({ executor: r.outcome.executor_id, failure: r.outcome.status.Failure });
  const blk = await rpc('block', { block_id: res.transaction_outcome.block_hash });
  const logs = res.receipts_outcome.flatMap((r) => r.outcome.logs).filter((l) => !l.startsWith('EVENT_JSON')).slice(0, 6);
  return { hash, receiver: desc.receiverId, actions: desc.actions.map((a) => a.params), ok: failures.length === 0, failures,
    block_height: blk.header.height, block_timestamp_utc: new Date(Number(BigInt(blk.header.timestamp) / 1_000_000n)).toISOString(),
    gas_burnt_tgas: Number(res.receipts_outcome.reduce((g, r) => g + BigInt(r.outcome.gas_burnt), BigInt(res.transaction_outcome.outcome.gas_burnt)) / 10n ** 9n) / 1000,
    logs, url: `https://testnet.near.rocks/tx/${hash}` };
}

const steps = [];
const record = (s) => { steps.push(s); console.log(`${s.step}: ${s.status}${s.txs ? ' ' + s.txs.map((t) => `${t.hash} ${t.ok ? 'ok' : 'FAILED'}`).join(', ') : ''}${s.reason ? ' (' + s.reason + ')' : ''}${s.check ? ' | ' + s.check : ''}`); };
async function run(step, txs, check) {
  const have = await spendable(SIGNER), need = await upfront(txs);
  if (need > have) return record({ step, status: 'skipped', reason: `needs ${near(need)} NEAR up front (deposits + prepaid gas), ${SIGNER} has ${near(have)} spendable`, planned: txs });
  const sent = [];
  for (const t of txs) {
    const r = await sendTx(t);
    sent.push(r);
    if (!r.ok) break;
  }
  const ok = sent.every((t) => t.ok) && sent.length === txs.length;
  record({ step, status: ok ? 'ok' : 'failed', txs: sent, ...(ok && check ? { check: await check() } : {}) });
  return ok;
}

const start = { near_spendable: near(await spendable(SIGNER)), shitzu: shitzu(await view(TOKEN, 'ft_balance_of', { account_id: SIGNER })) };
console.log(`${SIGNER}: ${start.near_spendable} NEAR spendable, ${start.shitzu} SHITZU`);

// 1. swap 0.05 NEAR -> SHITZU on Ref (pool 2190)
{
  const nearHuman = '0.05';
  const [wrapReg, shReg, quote] = await Promise.all([view(WRAP, 'storage_balance_of', { account_id: SIGNER }), view(TOKEN, 'storage_balance_of', { account_id: SIGNER }),
    view(REF, 'get_return', refQuoteArgs(nearHuman)).catch(() => null)]);
  const minOut = minOutFromQuote(quote);
  const txs = swapNearForShitzuTxs({ account: SIGNER, nearHuman, needsWrapStorage: wrapReg === null, needsShitzuStorage: shReg === null, minOut });
  const before = BigInt(await view(TOKEN, 'ft_balance_of', { account_id: SIGNER }));
  await run(`1. swap ${nearHuman} NEAR for SHITZU (quote ${quote ? shitzu(quote) : 'n/a'}, min_amount_out ${shitzu(minOut)})`, txs,
    async () => `SHITZU ${shitzu(before)} -> ${shitzu(await view(TOKEN, 'ft_balance_of', { account_id: SIGNER }))}`);
}
// 2. tip Mochi ("0") 1 SHITZU
{
  const bal = BigInt(await view(TOKEN, 'ft_balance_of', { account_id: SIGNER }));
  const jar0 = BigInt(await view(CONTRACT, 'meme_get_jar', { token_id: '0' }));
  if (bal < ONE_SHITZU) record({ step: '2. tip Mochi 1 SHITZU', status: 'skipped', reason: `only ${shitzu(bal)} SHITZU` });
  else await run('2. tip Mochi 1 SHITZU', [tipTx('0', '1')], async () => {
    const jar1 = BigInt(await view(CONTRACT, 'meme_get_jar', { token_id: '0' }));
    return `Mochi jar ${shitzu(jar0)} -> ${shitzu(jar1)} (${jar1 - jar0 === ONE_SHITZU ? '+1 SHITZU' : 'UNEXPECTED delta ' + shitzu(jar1 - jar0)})`;
  });
}
// 3. open a 24 h book for 0 vs 1 if none is open
let book = await view(CONTRACT, 'meme_get_open_book', { pet_a: '0', pet_b: '1' });
if (book) record({ step: '3. open book 0 vs 1 (24 h)', status: 'skipped', reason: `book #${book.id} is already open` });
else if (await run('3. open book 0 vs 1 (24 h)', [openBookTx('0', '1', 86400)])) {
  book = await view(CONTRACT, 'meme_get_open_book', { pet_a: '0', pet_b: '1' });
  steps.at(-1).check = `book #${book?.id} opened, closes ${book ? new Date(Number(BigInt(book.closes_at_ns) / 1_000_000n)).toISOString() : '?'}`;
}
// 4. back Moss ("1") with 1 SHITZU on the open book
{
  const bal = BigInt(await view(TOKEN, 'ft_balance_of', { account_id: SIGNER }));
  if (!book) record({ step: '4. back Moss 1 SHITZU', status: 'skipped', reason: 'no open book for 0 vs 1' });
  else if (BigInt(book.closes_at_ns) <= BigInt(Date.now()) * 1_000_000n) record({ step: `4. back Moss 1 SHITZU on book #${book.id}`, status: 'skipped', reason: 'its staking window has closed' });
  else if (bal < ONE_SHITZU) record({ step: `4. back Moss 1 SHITZU on book #${book.id}`, status: 'skipped', reason: `only ${shitzu(bal)} SHITZU` });
  else {
    const s0 = await view(CONTRACT, 'meme_get_stake', { book_id: String(book.id), account_id: SIGNER });
    await run(`4. back Moss 1 SHITZU on book #${book.id}`, [backTx(String(book.id), '1', '1')], async () => {
      const s1 = await view(CONTRACT, 'meme_get_stake', { book_id: String(book.id), account_id: SIGNER });
      return `meme_get_stake [Mochi, Moss] ${s0.map(shitzu).join(', ')} -> ${s1.map(shitzu).join(', ')}`;
    });
  }
}

const end = { near_spendable: near(await spendable(SIGNER)), shitzu: shitzu(await view(TOKEN, 'ft_balance_of', { account_id: SIGNER })) };
const openBook = book ? { id: String(book.id), closes_at_utc: new Date(Number(BigInt(book.closes_at_ns) / 1_000_000n)).toISOString() } : null;
mkdirSync(new URL('.', OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ network: 'testnet', signer: SIGNER, contract: CONTRACT, token: TOKEN, ran_at_utc: new Date().toISOString(),
  built_by: 'lib/txs.mjs (swapNearForShitzuTxs, tipTx, openBookTx, backTx)', start, end, open_book: openBook, steps }, null, 2) + '\n');
console.log(`end: ${end.near_spendable} NEAR spendable, ${end.shitzu} SHITZU${openBook ? ` | open book #${openBook.id} closes ${openBook.closes_at_utc}` : ''}`);
console.log(`wrote ${OUT.pathname}`);
if (steps.some((s) => s.status === 'failed')) process.exitCode = 1;
