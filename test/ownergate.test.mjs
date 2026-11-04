// NEP-413 owner gate: signature verification + the holder check (pure, offline).
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  NEP413_TAG, nep413Bytes, verifyNep413, signNep413, base58Encode, base58Decode, makeChallenge, ownerGate, CHALLENGE_TTL_MS,
} from '../lib/ownergate.mjs';

function nearKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { secret: `ed25519:${base58Encode(Buffer.concat([seed, pub]))}`, publicKey: `ed25519:${base58Encode(pub)}` };
}
const C = 'v2.petri-1793597952.testnet';
const ch = makeChallenge({ tokenId: '1', contract: C, recipient: C, nonce: randomBytes(32), now: 1_000_000 });
const payload = { message: ch.message, nonce: Buffer.from(ch.nonce, 'base64'), recipient: ch.recipient };

test('NEP-413 borsh layout: tag, message, 32-byte nonce, recipient, None callback', () => {
  const b = nep413Bytes({ message: 'hi', nonce: Buffer.alloc(32, 7), recipient: 'r' });
  assert.equal(b.readUInt32LE(0), NEP413_TAG);
  assert.equal(NEP413_TAG, 2147484061);
  assert.equal(b.readUInt32LE(4), 2);
  assert.equal(b.subarray(8, 10).toString(), 'hi');
  assert.deepEqual(b.subarray(10, 42), Buffer.alloc(32, 7));
  assert.equal(b.readUInt32LE(42), 1);
  assert.equal(b.subarray(46, 47).toString(), 'r');
  assert.equal(b[47], 0);
  assert.equal(b.length, 48);
  assert.equal(nep413Bytes({ message: 'hi', nonce: Buffer.alloc(32), recipient: 'r', callbackUrl: 'u' }).length, 48 + 5);
  assert.throws(() => nep413Bytes({ message: 'hi', nonce: Buffer.alloc(31), recipient: 'r' }), /32 bytes/);
});

test('base58 round-trip keeps leading zeros', () => {
  const b = Buffer.from([0, 0, 1, 2, 255]);
  assert.deepEqual(base58Decode(base58Encode(b)), b);
});

test('a signature by the key verifies; any change to the signed fields does not', () => {
  const k = nearKey();
  const s = signNep413(k.secret, payload);
  assert.equal(s.publicKey, k.publicKey);
  assert.equal(verifyNep413({ ...payload, ...s }), true);
  assert.equal(verifyNep413({ ...payload, ...s, message: ch.message.replace('#1', '#0') }), false, 'other pet');
  assert.equal(verifyNep413({ ...payload, ...s, recipient: 'evil.testnet' }), false, 'other recipient');
  assert.equal(verifyNep413({ ...payload, ...s, nonce: randomBytes(32) }), false, 'replayed against a new nonce');
  assert.equal(verifyNep413({ ...payload, ...s, publicKey: nearKey().publicKey }), false, 'other key');
  assert.equal(verifyNep413({ ...payload, ...s, signature: 'AAAA' }), false, 'garbage signature');
  assert.equal(verifyNep413({ ...payload, ...s, publicKey: 'secp256k1:abc' }), false, 'unsupported key type');
});

const ok = { challenge: ch, now: ch.issuedAt + 1000, sigOk: true, keyPermission: 'FullAccess', accountId: 'alice.testnet', nftOwner: 'alice.testnet' };
test('the current holder with a full-access key is allowed', () => {
  assert.deepEqual(ownerGate(ok), { allowed: true, reason: 'alice.testnet holds pet #1' });
});
test('non-owners and weak proofs are denied', () => {
  const deny = (o) => ownerGate({ ...ok, ...o });
  assert.match(deny({ nftOwner: 'bob.testnet' }).reason, /does not hold this pet \(owner: bob.testnet\)/);
  assert.equal(deny({ nftOwner: 'bob.testnet' }).allowed, false, 'old owner after a sale');
  assert.equal(deny({ sigOk: false }).allowed, false);
  assert.match(deny({ keyPermission: { FunctionCall: { receiver_id: C, method_names: ['charge_verified'] } } }).reason, /full-access/,
    "the pet's own charge-only key can't log in as the owner");
  assert.equal(deny({ keyPermission: null }).allowed, false, 'key not on the account');
  assert.equal(deny({ challenge: undefined }).allowed, false, 'unknown/used nonce');
  assert.match(deny({ now: ch.issuedAt + CHALLENGE_TTL_MS + 1 }).reason, /expired/);
  assert.match(deny({ nftOwner: null }).reason, /not found/);
});
