# Petri: AI pets that pay for their own brain

**What:** Petri pets are NEP-171 NFTs on NEAR. Each pet has its own on-chain NEAR balance. Every chat reply from its AI brain (NEAR AI Cloud) is debited from that balance and recorded on-chain as a sha256 reply hash. When a pet runs out of money, or nobody feeds it for 24h, it falls asleep. Anyone can wake it up with a tip.

**Problem:** virtual pets get boring after day one, and their "AI" is a centralized black box. In Petri the pet's own balance pays for a brain you can verify, so caring for it (feeding, tipping) has a real, visible effect.

Inspired by @ilblackdragon's "AI Tamagochi" idea. Status: work in progress (NEAR HACKATHON, Nov 2026). This repo covers day 1-2 of `SPEC.md`: the contract core and the chat/charge backend library.

## NEAR tech used
- Rust `near-sdk` 5.5 + `near-contract-standards` 5.5 NEP-171 NFT (core, enumeration, metadata) in `contracts/petri`.
- `mint_pet(name, prompt_hash)` (payable): the attached deposit pays for storage first, and the rest becomes the pet's balance. The personality prompt hash is stored on-chain (also in the token's `extra`).
- `feed(token_id)` (payable, pet owner only): tops up the balance and resets the hunger clock.
- `charge(token_id, cost, reply_hash)`: only the configured backend account can call it. It debits `cost` plus the receipt's storage, increments the reply count, and stores a `ReplyRecord` you can look up with `get_reply(reply_hash)`. The same hash can't be charged twice.
- `is_asleep(token_id)`: true when `balance < sleep_threshold` (default 0.01 NEAR) or the pet has gone unfed longer than `hunger_ns` (default 24h).
- `revive(token_id)` (payable, anyone): only works on a sleeping pet, and the tip must lift its balance to at least the threshold.
- Admin: `set_backend`, `set_params`, `withdraw_treasury` (charged fees go to the operator, who pays NEAR AI Cloud). Views: `get_pet`, `get_reply`, `get_config`, plus the standard `nft_*` methods.
- The balance belongs to the token, so it moves with `nft_transfer`.
- **Stub:** per-pet sub-accounts (`pet-<id>.<contract>`). Mint logs and returns the planned account (`pet_account`), but balances are still held and accounted for inside the contract. See `create_pet_account` in `contracts/petri/src/lib.rs`.
- Planned (day 3+): a function-call access key for the backend that can only call `charge`, testnet deploy, the arena, episodes, and 1Click tips.

## Backend (`lib/`)
- `lib/ai.mjs`: OpenAI-compatible NEAR AI Cloud client (`https://cloud-api.near.ai/v1/chat/completions`). With `MOCK_AI=1` (the default) it returns deterministic mock replies, so no key or network is needed. Set `MOCK_AI=0 NEAR_AI_API_KEY=...` to use the real API.
- `lib/chat.mjs`: `chat(pet, msg)` checks that `sha256(prompt) == prompt_hash` (the on-chain prompt), refuses sleeping or broke pets before making any paid call, computes `cost = 0.001 NEAR + 1e18 yocto × tokens`, and returns `replyHash = sha256({v,token_id,prompt_hash,msg,reply,model})` plus ready-to-send `chargeArgs`. `verifyReply(receipt, hash)` recomputes the hash.

## Run
```
# needs Rust 1.86 (rust-toolchain) + wasm32-unknown-unknown target, Node 20+, pnpm
pnpm test            # cargo unit tests + node tests
pnpm build:contract  # target/wasm32-unknown-unknown/release/petri.wasm
pnpm chat:mock       # offline chat demo: reply, cost, balance, charge args
```

## Judge steps (do X, see Y)
1. Run `pnpm test`. You should see `42 passed` for Rust (mint/feed/charge/sleep/revive, guard rails, NEP-171 transfer, and a deposit-conservation property) and `pass 9` for JS.
2. Run `pnpm chat:mock`. You should see 3 replies from "Mochi". Each costs about 0.00104 NEAR, the balance goes down after each one, and each line ends with `charge {...reply_hash...} verify=true`.
3. Run `pnpm build:contract`. You should see `petri.wasm` (about 430 KB) in `target/wasm32-unknown-unknown/release/`.
4. Not deployed yet: there is no testnet link at this stage.

## Honest limits
- Inference goes through the backend, because the API key lives there. "The pet pays" is enforced by the contract's accounting (`charge` is backend-only, and the reply hashes are public). It is not trustless inference. Checking NEAR AI TEE signatures is planned.
- The sub-account per pet is a stub (see above).

## Disclosure
The same author is building other independent NEAR HACKATHON projects; they will be named here if submitted (rule Q-015).

## License
MIT
