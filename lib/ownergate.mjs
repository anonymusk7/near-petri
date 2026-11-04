// Owner-only gate for the web UI: the visitor proves they control the NEAR
// account that currently holds the pet NFT by signing a NEP-413 message.
// Verification here is pure (no network); the server adds the two chain reads:
// the signing key must be a full-access key of `accountId`, and `accountId`
// must equal `nft_token(token_id).owner_id` on testnet.
import { createHash, createPublicKey, createPrivateKey, verify, sign } from 'node:crypto';

/** NEP-413 prefix tag: 2^31 + 413, borsh u32 little-endian. */
export const NEP413_TAG = 2 ** 31 + 413;
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error('bad base58');
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c !== '1') break; bytes.unshift(0); }
  return Buffer.from(bytes);
}
export function base58Encode(buf) {
  let n = BigInt('0x' + (Buffer.from(buf).toString('hex') || '0'));
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; s = '1' + s; }
  return s;
}

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const str = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u32(b.length), b]); };

/** borsh(tag) ++ borsh({message, nonce: [u8;32], recipient, callbackUrl: Option<string>}). */
export function nep413Bytes({ message, nonce, recipient, callbackUrl = null }) {
  const n = Buffer.from(nonce);
  if (n.length !== 32) throw new Error('nonce must be 32 bytes');
  return Buffer.concat([u32(NEP413_TAG), str(message), n, str(recipient),
    callbackUrl == null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), str(callbackUrl)])]);
}
export const nep413Hash = (p) => createHash('sha256').update(nep413Bytes(p)).digest();

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Verify a NEP-413 signature. publicKey = "ed25519:<base58>", signature = base64 (or base58). */
export function verifyNep413({ publicKey, signature, message, nonce, recipient, callbackUrl = null }) {
  if (typeof publicKey !== 'string' || !publicKey.startsWith('ed25519:')) return false;
  try {
    const raw = base58Decode(publicKey.slice(8));
    if (raw.length !== 32) return false;
    let sig = Buffer.from(signature, 'base64');
    if (sig.length !== 64) sig = base58Decode(signature);
    if (sig.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki' });
    return verify(null, nep413Hash({ message, nonce, recipient, callbackUrl }), key, sig);
  } catch { return false; }
}

/** Sign like a wallet's `signMessage` (used by scripts/sign-owner.mjs; testnet keys only). */
export function signNep413(secretKey, payload) {
  const raw = base58Decode(secretKey.replace(/^ed25519:/, ''));
  const seed = raw.subarray(0, 32);
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });
  const pub = createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(SPKI_ED25519.length);
  return { publicKey: `ed25519:${base58Encode(pub)}`, signature: sign(null, nep413Hash(payload), priv).toString('base64') };
}

/** The exact message the visitor signs; binds pet, contract and issue time. */
export function challengeMessage({ tokenId, contract, issuedAt }) {
  return `Petri owner check: I hold pet #${tokenId} on ${contract} (issued ${new Date(issuedAt).toISOString()})`;
}
export function makeChallenge({ tokenId, contract, recipient, nonce, now }) {
  return { message: challengeMessage({ tokenId, contract, issuedAt: now }), nonce: Buffer.from(nonce).toString('base64'),
    recipient, tokenId, contract, issuedAt: now };
}

/**
 * Final decision. Everything must hold:
 *  - the challenge exists, is unused and not expired,
 *  - the NEP-413 signature verifies for the challenge bytes,
 *  - the key is a FullAccess key of accountId (function-call keys can't sign in as the account),
 *  - accountId is the current NFT owner.
 */
export function ownerGate({ challenge, now, sigOk, keyPermission, accountId, nftOwner }) {
  if (!challenge) return { allowed: false, reason: 'unknown or already used challenge' };
  if (now - challenge.issuedAt > CHALLENGE_TTL_MS) return { allowed: false, reason: 'challenge expired' };
  if (!sigOk) return { allowed: false, reason: 'signature does not verify' };
  if (keyPermission !== 'FullAccess') return { allowed: false, reason: `key is not a full-access key of ${accountId}` };
  if (!nftOwner) return { allowed: false, reason: 'pet not found' };
  if (accountId !== nftOwner) return { allowed: false, reason: `${accountId} does not hold this pet (owner: ${nftOwner})` };
  return { allowed: true, reason: `${accountId} holds pet #${challenge.tokenId}` };
}
