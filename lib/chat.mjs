// chat(pet, msg): ask the pet's brain (NEAR AI) and return the reply, its
// yocto cost, and the sha256 reply hash to record on-chain via
// `charge(token_id, cost, reply_hash)`.
import { createHash } from 'node:crypto';
import { createAiClient } from './ai.mjs';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// Pricing in yoctoNEAR. Defaults: 0.001 NEAR per reply + 1e18 yocto per token.
export const PRICING = { base: 10n ** 21n, perToken: 10n ** 18n };
// Mirrors the contract's DEFAULT_SLEEP_THRESHOLD (0.01 NEAR).
export const SLEEP_THRESHOLD = 10n ** 22n;
export const MAX_MSG_LEN = 500;

export function computeCost({ prompt_tokens = 0, completion_tokens = 0 }, pricing = PRICING) {
  return pricing.base + pricing.perToken * BigInt(prompt_tokens + completion_tokens);
}

/**
 * Canonical receipt hash: anyone holding the reply can recompute it.
 * v1 (mock): commits to the reply text. v2 (TEE): commits to the chat_id and the
 * exact request/response hashes that the model TEE signed (provider_tee).
 */
export function replyHash(r) {
  if (r.v === 2) {
    const { token_id, prompt_hash, chat_id, model, request_hash, response_hash } = r;
    return sha256(JSON.stringify({ v: 2, token_id, prompt_hash, chat_id, model, request_hash, response_hash }));
  }
  const { token_id, prompt_hash, msg, reply, model } = r;
  return sha256(JSON.stringify({ v: 1, token_id, prompt_hash, msg, reply, model }));
}

export function verifyReply(receipt, onChainHash) {
  return replyHash(receipt) === onChainHash;
}

export function systemPrompt(pet) {
  return `You are ${pet.name}, a Petri pet living on NEAR. ${pet.prompt} Answer in at most two short sentences.`;
}

/**
 * pet: { token_id, name, prompt, prompt_hash, balance (yocto string|bigint), asleep }
 * Returns { reply, cost, replyHash, receipt, usage, chargeArgs } and, on the
 * MOCK_AI=0 TEE path, `record` (the verifiable reply record) + `preflight`.
 */
export async function chat(pet, msg, { client = createAiClient(), pricing = PRICING, maxTokens } = {}) {
  if (!pet?.token_id) throw new Error('pet.token_id required');
  if (typeof msg !== 'string' || !msg.trim()) throw new Error('message required');
  if (msg.length > MAX_MSG_LEN) throw new Error(`message too long (max ${MAX_MSG_LEN})`);
  if (sha256(pet.prompt ?? '') !== pet.prompt_hash) throw new Error('prompt does not match on-chain prompt_hash');
  if (pet.asleep) throw new Error('pet is asleep: revive it with a tip');

  const balance = BigInt(pet.balance ?? 0);
  // Cheap precheck so a broke pet never triggers a paid inference call.
  if (balance < pricing.base) throw new Error(`insufficient pet balance: need at least ${pricing.base} yocto, have ${balance}`);

  const messages = [{ role: 'system', content: systemPrompt(pet) }, { role: 'user', content: msg }];
  const out = await client.complete({ messages, maxTokens });
  const cost = computeCost(out.usage, pricing);
  // The contract additionally debits the receipt's storage (~0.001 NEAR) and is the final check.
  if (balance < cost) throw new Error(`insufficient pet balance: need ${cost} yocto, have ${balance}`);

  const t = out.tee;
  const receipt = t
    ? { v: 2, token_id: pet.token_id, prompt_hash: pet.prompt_hash, chat_id: t.chat_id, model: t.model,
        request_hash: t.request_hash, response_hash: t.response_hash }
    : { token_id: pet.token_id, prompt_hash: pet.prompt_hash, msg, reply: out.text, model: out.model };
  const hash = replyHash(receipt);
  const res = {
    reply: out.text, cost: cost.toString(), replyHash: hash, receipt, usage: out.usage,
    chargeArgs: { token_id: pet.token_id, cost: cost.toString(), reply_hash: hash },
  };
  if (!t) return res;
  res.preflight = out.preflight;
  res.record = {
    v: 1, chat_id: t.chat_id, model: t.model, request_hash: t.request_hash, response_hash: t.response_hash,
    signature: t.signature, signing_address: t.signing_address, attestation: t.attestation,
    pet: { token_id: pet.token_id, name: pet.name, prompt: pet.prompt, prompt_hash: pet.prompt_hash },
    msg, reply: out.text, usage: out.usage, cost: res.cost, receipt, reply_hash: hash,
    request: t.request, response: t.response,
  };
  return res;
}
