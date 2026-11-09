// Wallet transaction builders (lib/txs.mjs): exact receivers, methods, args, gas and deposits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTRACT, TOKEN, GAS, DEPOSIT, parseAmount, parseNear, formatAmount, tipTx, backTx, storageDepositTx,
  openBookTx, claimTx, voidTx, reviveTx, feedTx, claimJarTx,
  WRAP, REF, REF_POOL, WRAP_STORAGE, swapMsg, minOutFromQuote, swapNearForShitzuTxs, refQuoteArgs } from '../lib/txs.mjs';

const fc = (tx) => { assert.equal(tx.actions.length, 1); assert.equal(tx.actions[0].type, 'FunctionCall'); return tx.actions[0].params; };

test('constants match the deployed contract and token', () => {
  assert.equal(CONTRACT, 'v2.petri-1793597952.testnet');
  assert.equal(TOKEN, 'shitzu-0.factory.v10.meme-cooking.testnet');
  assert.equal(GAS.FT_TRANSFER_CALL, '100000000000000');
  assert.equal(DEPOSIT.ONE_YOCTO, '1');
  assert.equal(DEPOSIT.STORAGE, '1250000000000000000000');
});

test('parseAmount converts human decimals to base units', () => {
  assert.equal(parseAmount('10', 18), 10n * 10n ** 18n);
  assert.equal(parseAmount('1.5', 18), 1_500_000_000_000_000_000n);
  assert.equal(parseAmount('0.000000000000000001', 18), 1n);
  assert.equal(parseAmount(' 2. ', 18), 2n * 10n ** 18n);
  assert.equal(parseAmount('.25', 2), 25n);
  assert.equal(parseNear('0.01'), '10000000000000000000000');
  assert.equal(formatAmount(1_500_000_000_000_000_000n, 18), '1.5');
  assert.equal(formatAmount('10000000000000000000', 18), '10');
});

test('parseAmount rejects negatives, zero, junk and too many decimals', () => {
  for (const bad of ['-1', '-0.5', '0', '0.000', '', ' ', '.', 'abc', '1e18', '1,5', '1.2.3', '0x10', 'Infinity', '+1'])
    assert.throws(() => parseAmount(bad, 18), Error, bad);
  assert.throws(() => parseAmount('0.0000000000000000001', 18), /at most 18 decimal places/);
  assert.throws(() => parseNear('0.0000000000000000000000001'), /at most 24/);
  assert.throws(() => parseAmount('-1', 18), /positive/);
  assert.throws(() => parseAmount('0', 18), /greater than zero/);
});

test('tipTx: ft_transfer_call on the token to Petri with a tip msg, 1 yocto, 100 Tgas', () => {
  const tx = tipTx('1', '10');
  assert.equal(tx.receiverId, TOKEN);
  const p = fc(tx);
  assert.equal(p.methodName, 'ft_transfer_call');
  assert.deepEqual(p.args, { receiver_id: CONTRACT, amount: '10000000000000000000', msg: '{"action":"tip","token_id":"1"}' });
  assert.equal(p.deposit, '1');
  assert.equal(p.gas, '100000000000000');
  assert.throws(() => tipTx('x', '1'), /token_id/);
  assert.throws(() => tipTx('0', '0'), /greater than zero/);
});

test('backTx: msg carries book_id as a U64 string', () => {
  const tx = backTx('2', '0', '0.5', 18);
  assert.equal(tx.receiverId, TOKEN);
  const p = fc(tx);
  assert.equal(p.methodName, 'ft_transfer_call');
  assert.equal(p.args.msg, '{"action":"back","token_id":"0","book_id":"2"}');
  assert.deepEqual(JSON.parse(p.args.msg), { action: 'back', token_id: '0', book_id: '2' });
  assert.equal(p.args.amount, '500000000000000000');
  assert.equal(p.args.receiver_id, CONTRACT);
  assert.equal(p.deposit, '1');
  assert.equal(p.gas, GAS.FT_TRANSFER_CALL);
  assert.throws(() => backTx('-1', '0', '1'), /book_id/);
});

test('storageDepositTx registers the account on the token for 0.00125 NEAR', () => {
  const tx = storageDepositTx('alice.testnet');
  assert.equal(tx.receiverId, TOKEN);
  const p = fc(tx);
  assert.equal(p.methodName, 'storage_deposit');
  assert.deepEqual(p.args, { account_id: 'alice.testnet', registration_only: true });
  assert.equal(p.deposit, '1250000000000000000000');
  assert.equal(p.gas, '30000000000000');
  assert.throws(() => storageDepositTx('Bad Account'), /bad account/);
});

test('openBookTx: meme_open_book on Petri, window as a number, 0.01 NEAR storage deposit', () => {
  const tx = openBookTx('0', '1', 3600);
  assert.equal(tx.receiverId, CONTRACT);
  const p = fc(tx);
  assert.equal(p.methodName, 'meme_open_book');
  assert.deepEqual(p.args, { pet_a: '0', pet_b: '1', window_secs: 3600 });
  assert.equal(p.deposit, '10000000000000000000000');
  assert.equal(p.gas, '30000000000000');
  assert.throws(() => openBookTx('0', '1', 59), /window/);
  assert.throws(() => openBookTx('0', '1', 86401), /window/);
  assert.throws(() => openBookTx('1', '1', 600), /itself/);
});

test('claim / void / claim_jar are not payable: deposit 0', () => {
  const c = fc(claimTx('1'));
  assert.equal(claimTx('1').receiverId, CONTRACT);
  assert.deepEqual([c.methodName, c.args, c.deposit, c.gas], ['meme_claim', { book_id: '1' }, '0', '50000000000000']);
  const v = fc(voidTx('3'));
  assert.deepEqual([v.methodName, v.args, v.deposit, v.gas], ['meme_void_book', { book_id: '3' }, '0', '30000000000000']);
  const j = fc(claimJarTx('0'));
  assert.equal(claimJarTx('0').receiverId, CONTRACT);
  assert.deepEqual([j.methodName, j.args, j.deposit, j.gas], ['meme_claim_jar', { token_id: '0' }, '0', '50000000000000']);
});

test('revive / feed attach NEAR in yocto', () => {
  const r = fc(reviveTx('1', '0.01'));
  assert.equal(reviveTx('1', '0.01').receiverId, CONTRACT);
  assert.deepEqual([r.methodName, r.args, r.deposit, r.gas], ['revive', { token_id: '1' }, '10000000000000000000000', '30000000000000']);
  const f = fc(feedTx('0', '0.1'));
  assert.deepEqual([f.methodName, f.args, f.deposit], ['feed', { token_id: '0' }, '100000000000000000000000']);
  assert.throws(() => reviveTx('1', '0'), /greater than zero/);
  assert.throws(() => feedTx('0', '-1'), /positive/);
});

test('swapNearForShitzuTxs: fresh account = SHITZU registration, then ONE wrap.testnet tx with 3 actions (270 Tgas)', () => {
  const txs = swapNearForShitzuTxs({ account: 'judge.testnet', nearHuman: '0.1', needsWrapStorage: true, needsShitzuStorage: true, minOut: '675000000000000000000' });
  assert.equal(txs.length, 2);
  assert.deepEqual(txs[0], storageDepositTx('judge.testnet'));
  assert.equal(txs[0].receiverId, TOKEN);
  const w = txs[1];
  assert.equal(w.receiverId, 'wrap.testnet');
  assert.deepEqual(w.actions.map((a) => a.type), ['FunctionCall', 'FunctionCall', 'FunctionCall']);
  const [sd, nd, ftc] = w.actions.map((a) => a.params);
  assert.deepEqual(sd, { methodName: 'storage_deposit', args: { account_id: 'judge.testnet', registration_only: true }, gas: '10000000000000', deposit: '1250000000000000000000' });
  assert.deepEqual(nd, { methodName: 'near_deposit', args: {}, gas: '10000000000000', deposit: '100000000000000000000000' });
  assert.equal(ftc.methodName, 'ft_transfer_call');
  assert.equal(ftc.gas, '250000000000000');
  assert.equal(ftc.deposit, '1');
  assert.deepEqual(ftc.args, { receiver_id: 'ref-finance-101.testnet', amount: '100000000000000000000000',
    msg: '{"force":0,"actions":[{"pool_id":2190,"token_in":"wrap.testnet","token_out":"shitzu-0.factory.v10.meme-cooking.testnet","min_amount_out":"675000000000000000000"}]}' });
  const total = w.actions.reduce((g, a) => g + BigInt(a.params.gas), 0n);
  assert.ok(total <= 300n * 10n ** 12n, `total gas ${total}`);
});

test('swapNearForShitzuTxs: registered account = one tx (near_deposit + ft_transfer_call), same msg as the recorded swap', () => {
  const txs = swapNearForShitzuTxs({ account: 'guest1-1793595336.testnet', nearHuman: '0.5' });
  assert.equal(txs.length, 1);
  assert.equal(txs[0].receiverId, WRAP);
  assert.deepEqual(txs[0].actions.map((a) => a.params.methodName), ['near_deposit', 'ft_transfer_call']);
  // byte-for-byte the args of tx 9DHmBWkCDRw5QniEA3rWzrg1E2SofRjrYPWVWGX2D7Vn
  assert.deepEqual(txs[0].actions[1].params.args, { amount: '500000000000000000000000', receiver_id: REF,
    msg: '{"force":0,"actions":[{"pool_id":2190,"token_in":"wrap.testnet","token_out":"shitzu-0.factory.v10.meme-cooking.testnet","min_amount_out":"1"}]}' });
  assert.equal(swapMsg('1'), txs[0].actions[1].params.args.msg);
  // only the wrap storage, no SHITZU registration
  const t2 = swapNearForShitzuTxs({ account: 'a.testnet', nearHuman: '1', needsWrapStorage: true, wrapStorage: '2000' });
  assert.equal(t2.length, 1);
  assert.deepEqual(t2[0].actions.map((a) => a.params.methodName), ['storage_deposit', 'near_deposit', 'ft_transfer_call']);
  assert.equal(t2[0].actions[0].params.deposit, '2000');
  assert.throws(() => swapNearForShitzuTxs({ account: 'a.testnet', nearHuman: '0' }), /greater than zero/);
  assert.throws(() => swapNearForShitzuTxs({ account: 'a.testnet', nearHuman: '1', minOut: '0' }), /minOut/);
  assert.throws(() => swapNearForShitzuTxs({ account: 'Bad', nearHuman: '1', needsShitzuStorage: true }), /bad account/);
});

test('minOutFromQuote: 95% of the get_return quote, "1" without a quote; refQuoteArgs', () => {
  assert.equal(minOutFromQuote('710694998737521562204'), '675160248800645484093');
  assert.equal(minOutFromQuote('100', 9000), '90');
  for (const q of [null, undefined, '', '0', 'abc', '-5']) assert.equal(minOutFromQuote(q), '1');
  assert.equal(minOutFromQuote('1'), '1');
  assert.equal(WRAP_STORAGE, '1250000000000000000000');
  assert.equal(REF_POOL, 2190);
  assert.deepEqual(refQuoteArgs('0.1'), { pool_id: 2190, token_in: 'wrap.testnet', amount_in: '100000000000000000000000', token_out: TOKEN });
});
