// Tip-from-any-chain, end to end without moving funds (testnet by default).
//   PETRI_NETWORK=testnet node scripts/tip-prepare.mjs [token_id] [--sign]
// 1) derive the pet's EVM address from the NEAR MPC contract (Chain Signatures)
// 2) read its balance on the EVM chain
// 3) 1Click dry:true quote: tip in ETH on Base -> NEAR for the pet
// 4) build the EIP-1559 sweep tx; with --sign the pet owner asks Petri ->
//    MPC to sign it for real (testnet) and we check it recovers to the pet's address.
// Never broadcasts. Writes examples/tip/tip-<network>.json.
import fs from 'node:fs';
import { ethers } from 'ethers';
import { loadNetwork, petEvmAddress, evmRpc, buildSweepTx, requestForeignSignature, signedSweep } from '../lib/tip.mjs';
import { getQuote } from '../lib/oneclick.mjs';

const cfg = loadNetwork();
const tokenId = process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? '1';
const sign = process.argv.includes('--sign');
if (cfg.name === 'mainnet' && !process.argv.includes('--i-approve-mainnet')) throw new Error('mainnet run needs --i-approve-mainnet (and the user\'s OK)');
console.log(`network ${cfg.name}: Petri ${cfg.petri}, MPC ${cfg.mpc}, EVM ${cfg.evm.name} (${cfg.evm.chainId})`);

const { key, address } = await petEvmAddress(cfg, tokenId);
console.log(`1) pet #${tokenId} EVM address (Chain Signatures, path pet-${tokenId}): ${address}\n   derived key ${key.slice(0, 30)}…`);

const [bal, nonce, fees] = await Promise.all([
  evmRpc(cfg, 'eth_getBalance', [address, 'latest']), evmRpc(cfg, 'eth_getTransactionCount', [address, 'latest']), evmRpc(cfg, 'eth_gasPrice', [])]);
console.log(`2) balance on ${cfg.evm.name}: ${ethers.formatEther(bal)} ETH, nonce ${BigInt(nonce)}`);

const tip = 10n ** 15n; // 0.001 ETH
const oc = cfg.oneclick;
const recipient = oc.recipient === 'pet-account' ? `pet-${tokenId}.${cfg.petri}` : oc.recipient;
let quote = null;
try {
  const q = await getQuote({ originAsset: oc.originAsset, destinationAsset: oc.destinationAsset, amount: tip, recipient, refundTo: address, dry: oc.dry });
  quote = { dry: oc.dry, amountIn: q.quote.amountInFormatted, amountOut: q.quote.amountOutFormatted, amountOutUsd: q.quote.amountOutUsd,
    timeEstimate: q.quote.timeEstimate, depositAddress: q.quote.depositAddress ?? null, recipient, refundTo: address };
  console.log(`3) 1Click ${oc.dry ? 'dry ' : ''}quote: ${quote.amountIn} ETH (Base) -> ${quote.amountOut} NEAR (~$${quote.amountOutUsd}) to ${recipient}, ~${quote.timeEstimate}s`);
} catch (e) { console.log(`3) 1Click quote unavailable: ${e.message.slice(0, 120)}`); }

// Testnet: 1Click has no deposit address, so the sweep goes to the pet's own address (0 value).
const to = quote?.depositAddress ?? address;
const value = quote?.depositAddress ? BigInt(bal) - 21000n * BigInt(fees) * 2n : 0n;
const tx = buildSweepTx({ chainId: cfg.evm.chainId, nonce: Number(BigInt(nonce)), to, value: value > 0n ? value : 0n,
  maxFeePerGas: BigInt(fees) * 2n, maxPriorityFeePerGas: BigInt(fees) / 10n || 1n });
const payload = tx.unsignedHash.slice(2);
console.log(`4) sweep tx -> ${to}, value ${ethers.formatEther(tx.value)} ETH; signing hash ${payload}`);

const outFile = `examples/tip/tip-${cfg.name}.json`;
const prev = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : {};
const out = { network: cfg.name, token_id: tokenId, petri: cfg.petri, mpc: cfg.mpc, path: `pet-${tokenId}`, derived_key: key, evm_address: address,
  evm_chain: cfg.evm, balance_wei: BigInt(bal).toString(), quote, sweep: { unsigned: tx.unsignedSerialized, hash: payload },
  signed: prev.signed ?? null, quoted_at: new Date().toISOString() };
if (sign) {
  const { tx: nearTx, signature } = requestForeignSignature(cfg, tokenId, payload);
  const st = signedSweep(tx, signature, address);
  out.signed = { near_tx: nearTx, mpc_signature: signature, unsigned: tx.unsignedSerialized, raw: st.serialized, from: st.from, at: new Date().toISOString() };
  console.log(`5) Petri.request_foreign_signature tx ${nearTx}\n   MPC signature recovers to ${st.from} ✓ (the pet's address). Signed raw tx ready; NOT broadcast.`);
} else if (out.signed) {
  const st = signedSweep(ethers.Transaction.from(out.signed.unsigned), out.signed.mpc_signature, address);
  console.log(`5) recorded MPC signature (NEAR tx ${out.signed.near_tx}) recovers to ${st.from} ✓`);
}
fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n');
console.log(`saved ${outFile}`);
