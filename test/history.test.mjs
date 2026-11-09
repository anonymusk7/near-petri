// Pure history aggregation: real recorded testnet tx outcomes + synthetic transfers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { eventsFromTx, aggregateHistory, parseEvents, toJSONSafe } from '../lib/history.mjs';

const C = 'v2.petri-1793597952.testnet';
const SNAP = JSON.parse(fs.readFileSync(new URL('../web/history-snapshot.json', import.meta.url)));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const nep = (event, data) => `EVENT_JSON:${JSON.stringify({ standard: 'nep171', version: '1.0.0', event, data })}`;
function tx({ hash = 'H', signer = 'alice.testnet', method, args = {}, deposit = '0', logs = [], ok = true }) {
  return {
    transaction: { hash, signer_id: signer, receiver_id: C, actions: [{ FunctionCall: { method_name: method, args: b64(args), deposit, gas: 1 } }] },
    receipts_outcome: [{ outcome: { logs } }],
    status: ok ? { SuccessValue: '' } : { Failure: { ActionError: {} } },
  };
}

test('parseEvents keeps only NEP-297 lines', () => {
  assert.deepEqual(parseEvents(['hello', nep('nft_mint', [{ owner_id: 'a', token_ids: ['0'] }]), 'EVENT_JSON:{bad'])
    .map((e) => e.event), ['nft_mint']);
});

test('real testnet history: Mochi earned its 0.5 NEAR mint and paid 5 TEE replies (incl. round-6 reply-8)', () => {
  const h = aggregateHistory(SNAP.events, { token_id: '0', currentOwner: 'petri-1793597952.testnet' });
  assert.equal(h.earned.mint, 5n * 10n ** 23n);
  assert.equal(h.paid.replies, 5);
  assert.equal(h.paid.total, 1150000000000000000000n + 1147000000000000000000n + 1130000000000000000000n + 1151000000000000000000n + 1159000000000000000000n);
  assert.deepEqual(h.holders.map((x) => x.account), ['petri-1793597952.testnet']);
  assert.equal(h.unrecorded_transfer, false);
  assert.deepEqual(h.arena, { rounds: 2, wins: 1 }); // lost #0 "puddle", won #1 "bone"
});

test('real testnet history: Moss charged 4 replies from its own account and won arena #0', () => {
  const h = aggregateHistory(SNAP.events, { token_id: '1' });
  assert.equal(h.paid.replies, 4);
  assert.equal(h.paid.by_pet_account, 4);
  assert.deepEqual(h.arena, { rounds: 2, wins: 1 });
  const ts = h.timeline.map((e) => BigInt(e.ts));
  assert.deepEqual(ts, [...ts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), 'timeline is sorted by block time');
});

test('feeds, tips, charges and holders over time', () => {
  const evs = [
    ...eventsFromTx(tx({ hash: 'm', method: 'mint_pet', deposit: '1000', logs: [nep('nft_mint', [{ owner_id: 'alice.testnet', token_ids: ['7'] }])] }), { contract: C, ts: '1' }),
    ...eventsFromTx(tx({ hash: 'f', method: 'feed', args: { token_id: '7' }, deposit: '200' }), { contract: C, ts: '2' }),
    ...eventsFromTx(tx({ hash: 'c', signer: 'backend.testnet', method: 'charge', args: { token_id: '7', cost: '30', reply_hash: 'x' } }), { contract: C, ts: '3' }),
    ...eventsFromTx(tx({ hash: 't', method: 'nft_transfer', args: { token_id: '7', receiver_id: 'bob.testnet' },
      logs: [nep('nft_transfer', [{ old_owner_id: 'alice.testnet', new_owner_id: 'bob.testnet', token_ids: ['7'] }])] }), { contract: C, ts: '4' }),
    ...eventsFromTx(tx({ hash: 'r', signer: 'carol.testnet', method: 'revive', args: { token_id: '7' }, deposit: '50' }), { contract: C, ts: '5' }),
    ...eventsFromTx(tx({ hash: 'x', signer: 'bob.testnet', method: 'feed', args: { token_id: '7' }, deposit: '999', ok: false }), { contract: C, ts: '6' }),
    ...eventsFromTx(tx({ hash: 'o', method: 'feed', args: { token_id: '8' }, deposit: '5' }), { contract: C, ts: '6' }),
  ];
  const h = aggregateHistory(evs, { token_id: '7', currentOwner: 'bob.testnet' });
  assert.equal(h.earned.mint, 1000n);
  assert.deepEqual(h.earned.feeds, { count: 1, total: 200n }, 'failed feed and other pets are not counted');
  assert.deepEqual(h.earned.tips, { count: 1, total: 50n });
  assert.equal(h.earned.total, 1250n);
  assert.deepEqual([h.paid.replies, h.paid.total], [1, 30n]);
  assert.deepEqual(h.holders, [
    { account: 'alice.testnet', since: '1', until: '4', via: 'm' },
    { account: 'bob.testnet', since: '4', until: null, via: 't' },
  ]);
  assert.equal(h.timeline.length, 6, 'the failed tx is still listed');
  assert.equal(h.timeline.find((e) => e.tx === 'x').ok, false);
  assert.equal(toJSONSafe(h).earned.total, '1250');
});

test('rejected nft_transfer_call: the reverse event returns the pet to the seller', () => {
  const evs = [
    ...eventsFromTx(tx({ hash: 'm', method: 'mint_pet', deposit: '1', logs: [nep('nft_mint', [{ owner_id: 'alice.testnet', token_ids: ['0'] }])] }), { contract: C, ts: '1' }),
    ...eventsFromTx(tx({ hash: 'tc', method: 'nft_transfer_call', args: { token_id: '0', receiver_id: 'market.testnet' }, logs: [
      nep('nft_transfer', [{ old_owner_id: 'alice.testnet', new_owner_id: 'market.testnet', token_ids: ['0'] }]),
      nep('nft_transfer', [{ old_owner_id: 'market.testnet', new_owner_id: 'alice.testnet', token_ids: ['0'] }]),
    ] }), { contract: C, ts: '2' }),
  ];
  const h = aggregateHistory(evs, { token_id: '0', currentOwner: 'alice.testnet' });
  assert.deepEqual(h.holders.map((x) => x.account), ['alice.testnet', 'market.testnet', 'alice.testnet']);
  assert.equal(h.unrecorded_transfer, false);
});

test('a transfer we have no tx for is flagged, not invented', () => {
  const h = aggregateHistory(SNAP.events, { token_id: '1', currentOwner: 'someone-else.testnet' });
  assert.equal(h.unrecorded_transfer, true);
  assert.deepEqual(h.holders.at(-1), { account: 'someone-else.testnet', since: null, until: null, via: null, inferred: true });
});

test('txs to other contracts and failed transfers are ignored for holders', () => {
  const other = tx({ method: 'feed', args: { token_id: '0' }, deposit: '5' });
  other.transaction.receiver_id = 'evil.testnet';
  assert.deepEqual(eventsFromTx(other, { contract: C }), []);
  const failed = eventsFromTx(tx({ method: 'nft_transfer', args: { token_id: '0', receiver_id: 'bob.testnet' }, ok: false }), { contract: C });
  assert.equal(failed[0].ok, false);
  assert.deepEqual(aggregateHistory(failed, { token_id: '0' }).holders, []);
});
