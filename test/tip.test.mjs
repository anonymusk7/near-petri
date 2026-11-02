// Offline checks of the tip-from-any-chain flow, on the REAL testnet artifact
// (examples/tip/tip-testnet.json: MPC-derived key + a real MPC signature).
import { test } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ethers } from 'ethers';
import { loadNetwork, evmAddressFromMpcKey, mpcToEvmSignature, signedSweep, buildSweepTx, requestForeignSignature, b58decode } from '../lib/tip.mjs';

const art = JSON.parse(fs.readFileSync(new URL('../examples/tip/tip-testnet.json', import.meta.url), 'utf8'));

test('MPC derived key -> the pet EVM address', () => {
  assert.equal(evmAddressFromMpcKey(art.derived_key), art.evm_address);
  assert.throws(() => evmAddressFromMpcKey('ed25519:' + art.derived_key.split(':')[1]), /secp256k1/);
});
test('real MPC signature (via Petri.request_foreign_signature) recovers to the pet address', () => {
  assert.ok(art.signed?.near_tx, 'artifact has a signed sweep');
  const st = signedSweep(ethers.Transaction.from(art.signed.unsigned), art.signed.mpc_signature, art.evm_address);
  assert.equal(st.serialized, art.signed.raw);
  assert.equal(st.chainId, 11155111n);
});
test('signature does not transfer to a different tx', () => {
  const t = ethers.Transaction.from(art.signed.unsigned);
  const other = buildSweepTx({ chainId: 11155111, nonce: t.nonce, to: '0x000000000000000000000000000000000000dEaD', value: 1n,
    maxFeePerGas: t.maxFeePerGas, maxPriorityFeePerGas: t.maxPriorityFeePerGas });
  assert.throws(() => signedSweep(other, art.signed.mpc_signature, art.evm_address), /not the pet's/);
  assert.throws(() => mpcToEvmSignature({ ...art.signed.mpc_signature, big_r: { affine_point: '05' + 'aa'.repeat(32) } }), /big_r/);
});
test('mainnet is a config switch, and guarded', () => {
  const t = loadNetwork('testnet'), m = loadNetwork('mainnet');
  assert.deepEqual(Object.keys(t).sort(), Object.keys(m).sort());
  assert.equal(t.mpc, 'v1.signer-prod.testnet'); assert.equal(m.mpc, 'v1.signer');
  assert.equal(t.oneclick.dry, true);
  assert.throws(() => requestForeignSignature(m, '1', 'aa'.repeat(32)), /i-approve-mainnet/);
  assert.throws(() => loadNetwork('devnet'), /unknown network/);
});
test('base58 decode keeps leading zeros', () => {
  assert.deepEqual([...b58decode('11')], [0, 0]);
  assert.equal(b58decode('2g').toString('hex'), '61');
});
