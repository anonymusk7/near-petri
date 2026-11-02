// Tip a Petri pet from any chain.
//  1. Every pet has a permanent EVM address derived by NEAR Chain Signatures from
//     (Petri contract, "pet-<id>"): anyone can send ETH/tokens there from any wallet.
//  2. A 1Click (NEAR Intents) quote swaps that deposit into NEAR for the pet.
//  3. The pet's NFT owner calls Petri.request_foreign_signature(token_id, txHash):
//     the contract asks the MPC network to sign the sweep tx (deposit -> 1Click).
// The network (testnet/mainnet) is config/networks.json + PETRI_NETWORK only.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ethers } from 'ethers';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58decode(s) {
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); }
  const hex = n.toString(16);
  const bytes = n === 0n ? Buffer.alloc(0) : Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex');
  const zeros = s.match(/^1*/)[0].length;
  return Buffer.concat([Buffer.alloc(zeros), bytes]);
}

export function loadNetwork(name = process.env.PETRI_NETWORK || 'testnet', file = new URL('../config/networks.json', import.meta.url)) {
  const all = JSON.parse(readFileSync(file, 'utf8'));
  const cfg = all[name];
  if (!cfg) throw new Error(`unknown network ${name}`);
  return { name, ...cfg };
}

/** "secp256k1:<base58 64-byte x||y>" (MPC derived_public_key) -> 0x EVM address. */
export function evmAddressFromMpcKey(key) {
  const [curve, data] = key.split(':');
  if (curve !== 'secp256k1') throw new Error(`expected secp256k1 key, got ${curve}`);
  const xy = b58decode(data);
  if (xy.length !== 64) throw new Error('derived key must be 64 bytes');
  return ethers.computeAddress('0x04' + xy.toString('hex'));
}

/** MPC sign() result -> ethers Signature (r = x of big_R, s, v = recovery_id). */
export function mpcToEvmSignature(sig) {
  const R = sig.big_r.affine_point;
  if (!/^0[23][0-9a-fA-F]{64}$/.test(R)) throw new Error('bad big_r');
  return ethers.Signature.from({ r: '0x' + R.slice(2), s: '0x' + sig.s.scalar, yParity: sig.recovery_id });
}

export function foreignPath(tokenId) { return `pet-${tokenId}`; }

export async function nearView(cfg, account, method, args, fetchImpl = fetch) {
  let err;
  for (const url of cfg.nearRpc) {
    try {
      const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query',
        params: { request_type: 'call_function', finality: 'final', account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }) });
      const j = await r.json();
      if (j.error || j.result?.error) throw new Error(JSON.stringify(j.error ?? j.result.error).slice(0, 200));
      return JSON.parse(Buffer.from(j.result.result).toString());
    } catch (e) { err = e; }
  }
  throw err;
}

/** The pet's EVM deposit address, derived on-chain by the MPC contract (free view call). */
export async function petEvmAddress(cfg, tokenId, fetchImpl = fetch) {
  const key = await nearView(cfg, cfg.mpc, 'derived_public_key', { path: foreignPath(tokenId), predecessor: cfg.petri, domain_id: 0 }, fetchImpl);
  return { key, address: evmAddressFromMpcKey(key) };
}

export async function evmRpc(cfg, method, params, fetchImpl = fetch) {
  const r = await fetchImpl(cfg.evm.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

/** Unsigned EIP-1559 sweep of `value` wei from the pet's address to `to`. */
export function buildSweepTx({ chainId, nonce, to, value, maxFeePerGas, maxPriorityFeePerGas, gasLimit = 21000n }) {
  return ethers.Transaction.from({ type: 2, chainId, nonce, to, value, gasLimit, maxFeePerGas, maxPriorityFeePerGas, data: '0x' });
}

/** Attach the MPC signature and check it recovers to the pet's derived address. */
export function signedSweep(tx, mpcSig, expectedFrom) {
  const t = tx.clone();
  t.signature = mpcToEvmSignature(mpcSig);
  if (t.from.toLowerCase() !== expectedFrom.toLowerCase()) throw new Error(`signature recovers to ${t.from}, not the pet's ${expectedFrom}`);
  return t;
}

/** Real chain-signatures call through the Petri contract, signed by the pet owner's local key (near-cli keychain). */
export function requestForeignSignature(cfg, tokenId, payloadHex) {
  if (cfg.name === 'mainnet' && !process.argv.includes('--i-approve-mainnet')) throw new Error('mainnet signing needs --i-approve-mainnet');
  const r = spawnSync('near', ['contract', 'call-function', 'as-transaction', cfg.petri, 'request_foreign_signature', 'json-args',
    JSON.stringify({ token_id: String(tokenId), payload_hex: payloadHex }), 'prepaid-gas', '300 Tgas', 'attached-deposit', '1 yoctoNEAR',
    'sign-as', cfg.petOwner, 'network-config', cfg.name, 'sign-with-legacy-keychain', 'send'], { encoding: 'utf8', timeout: 240000 });
  const out = `${r.stderr}\n${r.stdout}`;
  if (r.status !== 0 || !/succeeded/.test(out)) throw new Error(`request_foreign_signature failed: ${out.match(/panicked: ([^\n]+)/)?.[1] ?? r.status}`);
  const tx = out.match(/Transaction ID: (\w+)/)?.[1];
  const json = r.stdout.slice(r.stdout.indexOf('{'), r.stdout.lastIndexOf('}') + 1);
  return { tx, signature: JSON.parse(json) };
}
