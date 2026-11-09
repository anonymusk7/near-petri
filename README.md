# Petri: AI pets that pay for their own brain

**What:** Petri pets are NEP-171 NFTs on NEAR. Each pet has its own on-chain NEAR balance. Every chat reply from its AI brain (a NEAR AI Cloud model running in a TEE) is debited from that balance and recorded on-chain as a receipt hash. That hash commits to the exact request/response bytes the model's TEE signed. When a pet runs out of money, or nobody feeds it for 24h, it falls asleep. Anyone can wake it up with a tip.

**Problem:** virtual pets get boring after day one, and their "AI" is a centralized black box. In Petri the pet's own balance pays for a brain you can verify, so caring for it (feeding, tipping) has a real, visible effect.

Inspired by @ilblackdragon's "AI Tamagochi" idea. Status: work in progress (NEAR HACKATHON, Nov 2026). This repo covers the contract core, a verified TEE chat backend, and a live testnet deployment.

## Judge steps (do X, see Y)
Everything below runs offline except step 4 (read-only NEAR RPC). No API key needed.
```
pnpm i
```
1. Run `pnpm test`. You should see `192 passed` for Rust (127 + 65 adversarial tests in `contracts/petri/src/tests_attack.rs`: auth, callbacks, replay, overflow, bad input, storage griefing, sale) and `pass 44` for JS. The Rust tests include `charge_verified` tests that ecrecover a **real** recorded NEAR AI signature, own-prompt tests (`real_mochi_reply_cannot_be_charged_to_moss` replays Mochi's real reply-5 against Moss and expects a rejection), arena tests (`real_arena_round_moss_wins` settles the real reply-5 against reply-6), and Chain Signatures tests. The JS tests re-verify the real recorded NEAR AI evidence offline and check the real MPC signature in `examples/tip/tip-testnet.json` (`test/tip.test.mjs`). `test/server.test.mjs` covers the web server: offline/RPC-outage fallback, 400/404/413/503, path traversal, and Moss's mock chat after a local revive.
2. Run `pnpm verify examples/recorded/reply-1.json`. You should see 8 ✓ checks (hashes, request shape, Intel TDX quotes via dcap-qvl, NVIDIA NRAS GPU verdict, preflight-before-completion, provider_tee signature, Petri receipt) and `=> VALID` (exit 0). `pnpm verify examples/recorded/reply-[0-9].json` checks all nine (exit 0).
3. Run `pnpm verify examples/recorded/reply-1.tampered.json` (same reply with the text swapped for a scam message). You should see `✗ response bytes hash to response_hash`, `✗ provider_tee signature … signature text does not match`, and `=> INVALID` (exit 1).
4. Run `pnpm demo:testnet`. It reads pet #0 "Mochi" from `petri-1793597952.testnet` over RPC: balance ≈ 0.483 NEAR, `replies 3`. For each recorded reply it should show `on-chain get_reply: index N, cost 0.0011.. NEAR` with ✓ on-chain receipt matches record and ✓ TEE evidence verifies. The last line is `=> ALL RECORDED REPLIES CHARGED ON-CHAIN AND TEE-VERIFIED`.
5. Run `pnpm chat:mock`. You should see 3 offline mock replies from "Mochi", the balance going down after each one, and `verify=true`.
6. Optional, needs a NEAR AI key, free: `NEAR_AI_API_KEY=... pnpm preflight`. This runs the live attestation (no completion is sent) and prints gateway and model signers with `TCB UpToDate` and `GPU 8xHOPPER NRAS overall=true`.

7. Run `pnpm demo:v2` (read-only RPC, no keys). Expect `✓ on-chain ecrecover → 0xfe00…337e` for each of the 9 real replies. Reply-4 also shows `⚠ built on Mochi's prompt … v3 now REJECTS this` (this is the bug fixed in round 3, kept visible on purpose). Then `arena #0 "puddle"` with `on-chain winner: pet #1 Moss | recomputed locally: pet #1 ✓`, Moss's single `charge_verified`-only key, and `round 7 code 58cQ9P… ✓ = pnpm build:contract:deploy; Mochi #0 + Moss #1 kept; Moss pet_key_active=true ✓`, `pet #1 EVM address via Chain Signatures: 0x5a34…2615 ✓; MPC-signed sweep … recovers to 0x5a34…2615 ✓`, and `live settle: book #1 Settled, winner pet #0 via arena #1 …` ✓. The last line is `=> EVERY CHARGED REPLY IS TEE-VERIFIED ON-CHAIN, THE ARENA RESULT REPRODUCES, THE PET SIGNS ON OTHER CHAINS, ROUND-7 CODE IS LIVE`.
8. Run `pnpm web` and open http://localhost:5174. You should see pets Mochi #0 and Moss #1 (live testnet balances; Moss shows **own account** and **key: charge_verified only**), and the recorded replies (including replies 7–9 and the arena #1 tx) with a green **TEE-verified** badge. Hover the badge to see 8/8 local checks plus the on-chain ecrecover result, and click **tx** to open the testnet explorer. New messages use the mock brain and are labelled **mock brain · unsigned** (no credits, nothing on-chain). Click **Starve** to see the asleep alert with the input disabled, then **Revive**. These sleep buttons are a local simulation only (the sleep reason, hunger or balance, is shown; on testnet pets fall asleep after 24h unfed, and a local **Revive** also wakes a chain-asleep pet in the mock simulation only). You should also see an **Arena #0 "puddle"** card with both TEE-signed answers, the 🏆 on Moss, the rule text and the settle tx; a **1 arena win** badge on Moss; and a **tip from any chain** EVM address on each pet. Moss's reply-4 carries a **legacy v2 receipt** badge. Offline or during an RPC outage (circuit breaker + parallel views), the server falls back fast to `web/snapshot.json` (refresh it with `node web/server.mjs --snapshot`). The **History** tab shows what the selected pet earned (mint deposit, feeds, tips), what it paid (charged replies) and who held it over time, read from the contract's tx outcomes (nearblocks first, then archival RPC; `web/history-snapshot.json` offline). The **Owner** tab is gated to the current NFT holder: sign the shown NEP-413 message (`node scripts/sign-owner.mjs <account.testnet> --challenge '<json>'` for a local testnet key) and paste it; anyone else gets **Access denied**. The **Memecoin pots** page (`#pots`) shows books, jars and a payout lookup. Layout checked at 360/390/414px.
9. Optional, free, read-only: run `pnpm tip:prepare 1`. It derives pet #1's Sepolia address from the MPC signer, reads its balance, gets a 1Click `dry:true` quote (Base ETH → NEAR to `anonymusk.near`, no deposit address is created) and writes `examples/tip/out/tip-testnet.json` (git-ignored; the committed `examples/tip/tip-testnet.json` is the recorded artifact). If 1Click is down it prints a one-line notice and continues. Nothing is signed or broadcast unless you pass `--sign` (testnet, owner key) and nothing is ever broadcast to an EVM chain.

## On-chain TEE verification (v2: `charge_verified`)
In v1 the contract trusted the backend's `reply_hash`. In v2 **the contract itself verifies the NEAR AI Cloud TEE signature** before it lets the pet pay for a thought:
1. `sha256(prompt) == pet.prompt_hash`. The pet's personality is fixed at mint and lives on-chain.
2. The request JSON's system message contains that prompt, and `request_hash = sha256(request bytes)` is computed on-chain.
3. `text = model:request_hash:response_hash`, then EIP-191 `keccak256`, then `env::ecrecover`, then the address. It must equal a signer that the owner registered for that model (`add_tee_signer`) after verifying the model attestation off-chain (`pnpm preflight`: TDX quote, report_data = signer‖nonce, NVIDIA NRAS).
4. Only then is the cost debited from the pet's own balance, and a `TeeProof {model, request_hash, response_hash, signer, signature}` is stored (`get_tee_proof(reply_hash)`, where `reply_hash = sha256(text)`).

Cost: about **3.07 Tgas** per verified reply (≈0.0003 NEAR).

| v2 testnet | tx |
| - | - |
| `v2.petri-1793597952.testnet` created by the owner (faucet rate-limited) | `G34ECcixpoLy3SrG3EQuBoFkvK9vEaBgomha3MghHUi` |
| Deploy + `new(owner, backend)` | `7KRoqMzLjDYVMreWd1EMtzoBpjucFVwP2NH3qqPB4pQ1` |
| `add_tee_signer(DeepSeek-V4.1-Flash-1017, 0xfe00…337e)` | `GurMfMTk2qPfjJmkAeQMZJJYziV9YFmo8RiWvf4xj2GJ` |
| `mint_pet("Mochi", d691db07…)`, 0.5 NEAR | `ENUmLpeyArGcoMLUF9EU55Mxit4nD2bEgPFQ3k2E9Krk` |
| `charge_verified` reply-1 / 2 / 3 (real TEE signatures) | `FzZ1KTAPa7SYECjXfUfofhTimvwRD9GMvHst46zPvWgn`, `G6ApPumCUYTGpaePvTpttcSeRH4rwhvwf9MuJe2CWioW`, `BHf2psxhF3i7CGBY3zPQhmBps8bnAaAEUBr3BFZSC9qU` |
| Negative: reply-2 with one hex digit of `response_hash` flipped → `Smart contract panicked: signature does not recover to a registered NEAR AI TEE signer for this model` | rejected on-chain |

Limits: the response *body* is not sent on-chain (only its hash, which is signed). Body-to-hash is checked off-chain by `pnpm verify`. Attestation itself is verified off-chain; the on-chain trust root is the owner-registered signer.


## Round 3 (v3 contract, same address)
Round 4 (the pet key freezes on a sale, plus `rekey_pet`) is also live at the same address. See "Main deployment upgraded (round 4)" under *How control passes on transfer*.

Upgraded in place with `migrate` (tx `ugsFmPKcsqBNJxQWHW78tz3cC1E8ZHjipwC3fs4Wqp2`). Every pet, reply and proof is kept.

**A pet is charged only for its own prompt.** The v2 contract checked that the system message *contained* the pet's prompt, and Moss had been minted with Mochi's prompt hash, so reply-4 (Mochi's personality) was billed to Moss. v3 requires the system message to be exactly `You are {name}, a Petri pet living on NEAR. {prompt} Answer in at most two short sentences.` with the pet's own name, and `sha256(prompt) == prompt_hash`. Otherwise it panics with `request system prompt is not this pet's own prompt (name + personality)`. `set_prompt` (NFT owner only) gave Moss its own prompt (`e9947b34…`, tx `23MFXA2fkdPgNpmirLJt6kcxZjZYrCqszfUEyPux71jV`), and a fresh real TEE reply was recorded for it (reply-6, ≈$0.0001). Replaying Mochi's reply-5 against Moss is now rejected on-chain.

**Arena.** `arena_settle(challenge, entries)` is permissionless and needs no trust in its caller. For each entry the contract re-hashes the exact request/response bytes, requires the stored TEE proof and a reply record for *that* pet, requires both answers to the same user question containing the challenge word, and refuses replies that were already used. The winner is then computed on-chain by a pure, published rule: `1) reply contains the challenge word (case-insensitive) 2) fewer characters 3) lower token id`. The round is stored (`get_arena`), `arena_wins` is incremented, and an `arena_settled` NEP-297 event is emitted.

| Round 3 testnet | tx |
| - | - |
| reply-5 (Mochi) `charge_verified` by the backend | `3aB2ktZ4Dox99TiDti8BLZrFjsAmFmMi2dCZjzZZs1LW` |
| reply-6 (Moss) `charge_verified` by `pet-1.…` itself | `2xPs1k2q684wF6GVLCQ2Nt1TfPvjb45VuiXytZnyFfA2` |
| `arena_settle("puddle", [reply-5, reply-6])` → winner Moss (63 vs 78 chars) | `3WENtHQS3q6Cv9qGscGLw3fDPaxioGfYndXZVdsUdJso` |
| Negative: reply-5 charged to Moss → `…not this pet's own prompt…` | rejected on-chain |
| `request_foreign_signature(1, sweep hash)` → MPC `v1.signer-prod.testnet` signs for pet #1 | `7TueePpC1tA4skZkQy2fATJRHZfGEtDcuBLjEswtSDXk` |

**Tip from any chain (Chain Signatures + 1Click).** Each pet has a foreign address derived by the NEAR MPC network from `(petri contract, "pet-<id>")`. Pet #1 is `0x5a34926DdBbcC7b64F6f9BC4eaC59779B1DA2615` on any EVM chain. Anyone can tip it there. `request_foreign_signature(token_id, payload)` (NFT owner only, 1 yocto + MPC fee refunded) asks the MPC to sign a sweep tx for that address. On mainnet the sweep sends to a 1Click deposit address, which delivers NEAR to the pet. On testnet, 1Click has no testnet, so we use a `dry:true` quote and a 0-value Sepolia self-transfer. The real MPC signature recovers to the pet's address, and we don't broadcast it. Switching to mainnet is config only: `PETRI_NETWORK=mainnet` picks the `mainnet` block of `config/networks.json` (MPC `v1.signer`, Base, `dry:false`), and `lib/tip.mjs` refuses mainnet signing unless `--i-approve-mainnet` is passed. Nothing on mainnet has been run.

## Each pet is its own NEAR account (`mint_pet_with_account`)
`mint_pet_with_account(name, prompt_hash, pet_key)` mints the NFT **and** creates `pet-<id>.<contract>`:
- It is funded with 0.1 NEAR from the mint deposit, so the pet pays its **own gas**.
- Its only key is `pet_key`, a **function-call key that can call nothing but `charge_verified` on this contract**, with a 0.25 NEAR gas allowance. No full-access key exists.
- The contract accepts charges for that pet **only from that account** (`only this pet's own account can charge it`). The backend, and other pets, are refused. The legacy `charge` is disabled for it.
- Even the key holder can't charge a fake reply: `charge_verified` still ecrecovers the NEAR AI TEE signature on-chain.
- If account creation fails, the `on_pet_account` callback refunds the 0.1 NEAR to the pet's balance.

So a leaked chat-backend key can, at worst, submit this pet's genuine TEE-signed replies. It can't move NEAR, can't touch other pets, and can't call any other method.

| pet account on testnet | tx |
| - | - |
| Upgrade v2 in place + `migrate` (Mochi keeps its 3 replies) | `GcE5wxZSWxuADjdSY5XX1Ng7iFykCrLx7rk7TdXs8naa` |
| `mint_pet_with_account("Moss", …)`, 0.4 NEAR → creates `pet-1.v2.petri-1793597952.testnet` + FC key | `BUxc5RgrnLS4dqDGwvTdNkUyfDxHs8uR9VgHUi7zFTq2` |
| Pet #1 charges its own real TEE reply (reply-4), signed by the pet's own key, 10 Tgas | `BBXro5CMCnCotZ4oUYMpU2hdDZXLWvRgE3z2CgKegxZG` |
| Negative: the backend calls `charge_verified` for pet #1 → `only this pet's own account can charge it` | rejected on-chain |
| Negative: the pet key tries `feed` → `Transaction method name <feed> isn't allowed by the access key` | refused |

## Testnet deployment (recorded)
| What | Account / tx |
| - | - |
| Contract + owner | [`petri-1793597952.testnet`](https://testnet.nearblocks.io/address/petri-1793597952.testnet) (new faucet account) |
| Backend (only account allowed to `charge`) | [`petri-backend-1793597952.testnet`](https://testnet.nearblocks.io/address/petri-backend-1793597952.testnet) (new faucet account) |
| Deploy + `new(owner_id, backend_id)` | [`Eu8MS7TC92UZ11FC5ypxuDZHFA3mMETq4jKZT5Zqrkk7`](https://testnet.nearblocks.io/txns/Eu8MS7TC92UZ11FC5ypxuDZHFA3mMETq4jKZT5Zqrkk7) |
| `mint_pet("Mochi", d691db07…871b)` with 0.5 NEAR → token `0`, balance 0.49152 NEAR | [`DW6C49Qm52SgFruxWz1e5BJn85oZ1drQNUVV9rsFcWuy`](https://testnet.nearblocks.io/txns/DW6C49Qm52SgFruxWz1e5BJn85oZ1drQNUVV9rsFcWuy) |
| `charge` reply-1 (`106cf4ca…88bf`, 0.00115 NEAR) by backend | [`FGrP7n2y1xxdLuWr9Sdwuuwdm7UV2bviKYRtqS6fhaQo`](https://testnet.nearblocks.io/txns/FGrP7n2y1xxdLuWr9Sdwuuwdm7UV2bviKYRtqS6fhaQo) |
| `charge` reply-2 (`7c562fe2…3894`, 0.001147 NEAR) by backend | [`Cy8itd14e6WKRTA6xAR3uycRASKJWqPVzCggZ26kVM6x`](https://testnet.nearblocks.io/txns/Cy8itd14e6WKRTA6xAR3uycRASKJWqPVzCggZ26kVM6x) |
| `charge` reply-3 (`4225e9dc…062e`, 0.00113 NEAR) by backend | [`CUiNfCbHcQzw6bqc2tdpWbRcvo9R7QSTw6rZ9CGk5S3s`](https://testnet.nearblocks.io/txns/CUiNfCbHcQzw6bqc2tdpWbRcvo9R7QSTw6rZ9CGk5S3s) |
| Negative check: `charge` signed by the owner, not the backend → `Smart contract panicked: only the backend can charge` | [`Hx5HrdQNmJqsfSprND75AvsFr1rNNd9bzSQWNgXi9f94`](https://testnet.nearblocks.io/txns/Hx5HrdQNmJqsfSprND75AvsFr1rNNd9bzSQWNgXi9f94) (failed, as intended) |

This v1 deployment's code hash is `6SPGEDfJM1SG8F3iZTVrurshQCNBuFbX8R9xrpAsswTR` (sha256 `50cb2090…7e64`, built from commit `00f75e8`). The current main contract `v2.petri-1793597952.testnet` runs `58cQ9Pa6puC72jS4REXWDnfwFdwY4u7FV8Krsj7CTdRt` (round 7). You get that exact wasm from this commit with `pnpm build:contract:deploy` (Rust 1.86, `-C target-cpu=mvp`), so you can compare it against `view_account.code_hash`.

## Verified TEE brain (`lib/attest.mjs`, `lib/ai.mjs`, `lib/verify.mjs`)
With `MOCK_AI=0`, `chat()` follows `docs/nearai/*.md` step by step. Model: `deepseek-ai/DeepSeek-V4.1-Flash-1017`, the canonical ID. The `deepseek/deepseek-v4.1-flash` alias returns no NEAR model attestation.
1. **Preflight, before any completion.** `GET /v1/attestation/report?model=…&provider=near&signing_algo=ecdsa&nonce=<32 random bytes>` with `x-no-aliasing: true`. For the gateway report and *every* `model_attestations[]` candidate:
   - verify `intel_quote` with `@phala/dcap-qvl` (TCB policy: `UpToDate`), and check that TDX debug is off;
   - check `report_data` from the verified quote equals the signer (zero-padded to 32 bytes) followed by the nonce, and check the echoed nonce;
   - check MRCONFIGID = `01 || sha256(app_compose) || 0×15`;
   - replay the RTMR3 event log.
   For each model candidate, also check `nvidia_payload.nonce` equals our nonce, then POST the payload unchanged to NVIDIA NRAS and require JWT `x-nvidia-overall-att-result == true`. The JWT's ES384 signature is checked against the NRAS JWKS. If any step fails, no completion is sent (this is tested).
2. **Completion.** Non-streaming, `Accept-Encoding: identity`, `x-no-aliasing: true`, `max_tokens ≤ 400`. The request body is serialized once, and the exact request and response bytes are kept.
3. **Signature.** `GET /v1/signature/<chat_id>?signing_algo=ecdsa`, retried up to 5 times on 404 or on a 2xx carrying `error_code`. It must be `signature_kind: provider_tee` with `text == MODEL:sha256(req):sha256(resp)`. The EIP-191 ecrecover result must equal `signing_address`, and that address must match **exactly one** verified preflight model report.
4. **Record.** `{chat_id, model, request_hash, response_hash, signature, signing_address, attestation summary}`, plus the pet, msg, reply, cost, and the exact request/response strings. The on-chain `reply_hash` is `sha256(JSON{v:2, token_id, prompt_hash, chat_id, model, request_hash, response_hash})`, so the chain receipt commits to the TEE-signed bytes.

`pnpm verify` re-runs every check **offline**. The preflight file stores the raw attestation bytes, the Intel collateral (re-verified with dcap-qvl at the recorded time), and the NRAS verdict and JWKS. It also checks that the preflight came before the completion (`verified_at <= created`), that the system prompt matches the pet's `prompt_hash`, and that the receipt hashes to `reply_hash`.

Recorded evidence in `examples/recorded/`:
- `reply-{1,2,3}.json`: the verifiable records.
- `preflight-*.json`: the raw attestation report, collateral, and NRAS evidence (no secrets; no Authorization header is ever saved).
- `raw/`: the exact request/response/signature bytes.
- `reply-1.tampered.json`: the negative example.

Real NEAR AI usage: **3 completions, 210 input + 217 output tokens = $0.000323**. Attestation, signature, and model-list calls are free. Recording is capped at 3 replies (`scripts/record-tee.mjs`), and each call is appended to the usage log.

## NEAR tech used
- **NEAR AI Cloud** (`cloud-api.near.ai`), Confidential TEE model `deepseek-ai/DeepSeek-V4.1-Flash-1017`: gateway + NEAR model attestation (Intel TDX via `@phala/dcap-qvl`, NVIDIA H100 via NRAS), and `provider_tee` ECDSA response signatures (`ethers`).
- Rust `near-sdk` 5.5 + `near-contract-standards` 5.5 NEP-171 NFT (core, enumeration, metadata) in `contracts/petri`, deployed on **NEAR testnet**.
- `mint_pet(name, prompt_hash)` (payable): the attached deposit pays for storage first, and the rest becomes the pet's balance. The personality prompt hash is stored on-chain (also in the token's `extra`).
- `feed(token_id)` (payable, pet owner only): tops up the balance and resets the hunger clock.
- `charge(token_id, cost, reply_hash)`: only the configured backend account can call it. It debits `cost` plus the receipt's storage, increments the reply count, and stores a `ReplyRecord` you can look up with `get_reply(reply_hash)`. The same hash can't be charged twice.
- `is_asleep(token_id)`: true when `balance < sleep_threshold` (default 0.01 NEAR) or the pet has gone unfed longer than `hunger_ns` (default 24h).
- `revive(token_id)` (payable, anyone): only works on a sleeping pet, and the tip must lift its balance to at least the threshold.
- Admin: `set_backend`, `set_params`, `withdraw_treasury` (charged fees go to the operator, who pays NEAR AI Cloud). Views: `get_pet`, `get_reply`, `get_config`, plus the standard `nft_*` methods.
- NEAR JSON-RPC `query/call_function` view calls (`scripts/demo-testnet.mjs`); `near-cli-rs` for deploy and calls.
- Per-pet sub-accounts with a function-call-only key (`mint_pet_with_account`), **Chain Signatures** (`v1.signer-prod.testnet`, `request_foreign_signature`), **NEAR Intents 1Click** quotes (`lib/oneclick.mjs`, `dry:true`), NEP-297 events.

## Memecoin pots (NEAR Hackathon "Memecoins With Mechanics", with Shitzu)
Fans tip pets in a real memecoin, and back a pet before an arena round; the winner's backers split the pot. The token is Shitzu's **real testnet SHITZU** NEP-141 `shitzu-0.factory.v10.meme-cooking.testnet` (18 decimals, launched via meme.cooking, liquid on Ref Finance testnet pool 2190). No stand-in token was needed.
- Tip: `ft_transfer_call(receiver_id=v2.petri…, msg={"action":"tip","token_id":"1"})` → the pet's SHITZU jar. The current NFT owner withdraws it with `meme_claim_jar`.
- Book: `meme_open_book(pet_a, pet_b, window_secs)` (payable, caller pays its storage; one open book per pair). Back a side with msg `{"action":"back","book_id":"0","token_id":"1"}` until `closes_at`; later stakes are refunded.
- Settle: `arena_settle` settles the pair's open book automatically, **only if both arena replies were recorded after the book closed** (anti-front-running). Rake (`rake_bps` ≤ 10%, here 5%) of the losing side goes to the winning pet's jar; each winning backer gets `stake × pot / winning_side` (exact `mul_div`). One side empty → everyone refunded. No round within `void_after` → anyone can `meme_void_book`, and backers `meme_claim` refunds. Failed `ft_transfer` payouts are restored by the `meme_on_payout` callback.
- Rules are set once by `meme_init` and are immutable. NEP-297 `meme_*` events. Views: `meme_get_config/book/book_count/open_book/stake/claimable/jar`. 26 unit tests, including settling on the real reply-5 vs reply-6, and `meme_live_round6_replay_mochi_wins_exact_payouts`, which replays the live round-6 settle with the exact payouts.

| Round 5 on `v2.petri-1793597952.testnet` (memecoin pots) | tx |
| - | - |
| Deploy round 5 (code hash `9MiRFRk5Qif8oPyQgRDEXFzMTDgpnDGAK3CtShS2GWk`, no init/migrate: meme state lives under new raw `mm:` keys; Mochi, Moss and Moss's arena win kept) | [`3u2RV3rKKZ75vXRzNykqX8wWekWDHqjxrgU4TzgCDqDc`](https://testnet.nearblocks.io/txns/3u2RV3rKKZ75vXRzNykqX8wWekWDHqjxrgU4TzgCDqDc) |
| `meme_init` (token SHITZU, rake 500 bps, window 60–86400 s, void after 600 s; one-shot, immutable) | [`4rj8ARszgoPswJB5VK14PgUHoJAtaP1cUnwkLHmB2Gzw`](https://testnet.nearblocks.io/txns/4rj8ARszgoPswJB5VK14PgUHoJAtaP1cUnwkLHmB2Gzw) |
| Contract registers storage on SHITZU | [`C2zTLcg56FUEHMEnQ4CHQevFBFrSDHWks5vJdhCf4UWH`](https://testnet.nearblocks.io/txns/C2zTLcg56FUEHMEnQ4CHQevFBFrSDHWks5vJdhCf4UWH) |
| guest1 swaps 0.5 wNEAR → ≈3559 SHITZU on Ref pool 2190 | [`9DHmBWkCDRw5QniEA3rWzrg1E2SofRjrYPWVWGX2D7Vn`](https://testnet.nearblocks.io/txns/9DHmBWkCDRw5QniEA3rWzrg1E2SofRjrYPWVWGX2D7Vn) |
| guest2 swaps 0.5 wNEAR → ≈3555 SHITZU | [`8HgkBMehDnkBvPUZ7Zk5SLbkyTFWamiNGQ8vTEpTGAWW`](https://testnet.nearblocks.io/txns/8HgkBMehDnkBvPUZ7Zk5SLbkyTFWamiNGQ8vTEpTGAWW) |
| Tip 100 SHITZU to Moss #1 (`ft_transfer_call`, msg `tip`) | [`3WFsXQK2RKuHNKUf6o7yUsJS9K6NxWNfDY9XG5Dd2EuJ`](https://testnet.nearblocks.io/txns/3WFsXQK2RKuHNKUf6o7yUsJS9K6NxWNfDY9XG5Dd2EuJ) |
| Tip 42 SHITZU to Mochi #0 | [`8QG9jYPLYcF1hkcqCG2y8PBp7Mtzy3idyaKkxYLfjd6m`](https://testnet.nearblocks.io/txns/8QG9jYPLYcF1hkcqCG2y8PBp7Mtzy3idyaKkxYLfjd6m) |
| `meme_open_book` #0 (Mochi vs Moss, 120 s window) | [`DMvnUhjXy6aLohsZWeEfZHXmQW2iKsGJpRnt8DK7DmUq`](https://testnet.nearblocks.io/txns/DMvnUhjXy6aLohsZWeEfZHXmQW2iKsGJpRnt8DK7DmUq) |
| guest1 backs Moss with 500 SHITZU | [`3DKThY5bP23mFd76dnt3BpZqXsMhtz6rPJVpaeyjWu6F`](https://testnet.nearblocks.io/txns/3DKThY5bP23mFd76dnt3BpZqXsMhtz6rPJVpaeyjWu6F) |
| guest2 backs Mochi with 300 SHITZU | [`FzErHfGxV5Txfq7pheknR3j5vjFHE2H6ze47udHTXapf`](https://testnet.nearblocks.io/txns/FzErHfGxV5Txfq7pheknR3j5vjFHE2H6ze47udHTXapf) |
| Late stake after close → refunded by `ft_resolve_transfer` (guest1 balance unchanged) | [`BwgkfodkzurvK8u2dcQSbDYmMwKsrHxi7cKRCL7GKNUt`](https://testnet.nearblocks.io/txns/BwgkfodkzurvK8u2dcQSbDYmMwKsrHxi7cKRCL7GKNUt) |
| Owner claims Moss's jar (100) / Mochi's jar (42) | [`8WJDjffVcTTwre7j7HWCsxcxPea9FfL8iuzmb4daMDWx`](https://testnet.nearblocks.io/txns/8WJDjffVcTTwre7j7HWCsxcxPea9FfL8iuzmb4daMDWx) |
| (second jar claim) | [`5eADyDAfgSiHzjSdLBoYgVVW2ZM3Fzgf29K4VrmR8SAN`](https://testnet.nearblocks.io/txns/5eADyDAfgSiHzjSdLBoYgVVW2ZM3Fzgf29K4VrmR8SAN) |
| `meme_void_book` #0 after close + 600 s (no arena round for these pets; an early call panicked `too early to void`) | [`3hHck4vT5G1zcTCQC5pf2uUWfoxfNqxHd8caWMHAFCz8`](https://testnet.nearblocks.io/txns/3hHck4vT5G1zcTCQC5pf2uUWfoxfNqxHd8caWMHAFCz8) |
| guest1 `meme_claim` → 500 refunded | [`HHa188pYzpmnqnnAtt5dgArPXjpAkn3jY9BUcskjmoDq`](https://testnet.nearblocks.io/txns/HHa188pYzpmnqnnAtt5dgArPXjpAkn3jY9BUcskjmoDq) |
| guest2 `meme_claim` → 300 refunded | [`TjHRvSEtKZubHAfd8aenVK5P136YYGhHa7wWT73djMu`](https://testnet.nearblocks.io/txns/TjHRvSEtKZubHAfd8aenVK5P136YYGhHa7wWT73djMu) |

Final state: book #0 `Void`, guest1 3459.02 SHITZU (3559 − 100 tip), guest2 3513.55 (3555.55 − 42 tip), owner 142 (both jars), contract 0. `pnpm demo:v2` reads the memecoin config and books.

| Round 6 on `v2.petri-1793597952.testnet` (live settle, 2026-11-04) | tx |
| - | - |
| reply-8 (Mochi), fresh real TEE reply to "Arena round 2: describe a dog in one line and use the word bone.", `charge_verified` by the backend | [`7e81RQcgz9A9pqRAme8hSRVPP5YnhmWBAdbSh4QMzptG`](https://testnet.nearblocks.io/txns/7e81RQcgz9A9pqRAme8hSRVPP5YnhmWBAdbSh4QMzptG) |
| reply-9 (Moss), same question, `charge_verified` from `pet-1.…`'s own key | [`2ekXb8md8w6PcKWud6aXJevb2HgCzfEjv2pk1SYiaK4G`](https://testnet.nearblocks.io/txns/2ekXb8md8w6PcKWud6aXJevb2HgCzfEjv2pk1SYiaK4G) |
| `meme_open_book` #1 (Mochi vs Moss) | [`8ZzeteQhoXfXVEwbJTiKPSD7c2oQ8SUZzW9UWrPpM3eC`](https://testnet.nearblocks.io/txns/8ZzeteQhoXfXVEwbJTiKPSD7c2oQ8SUZzW9UWrPpM3eC) |
| guest1 backs Moss with 200 SHITZU | [`zFcgNWz1r7UF63gF4y8qSHZSN9S6a8cy7RzwVLNex1B`](https://testnet.nearblocks.io/txns/zFcgNWz1r7UF63gF4y8qSHZSN9S6a8cy7RzwVLNex1B) |
| guest2 backs Mochi with 150 SHITZU | [`78BqpsVPaxPzW2r12S8EcbEsDWGjzXxKvPospY5aESPb`](https://testnet.nearblocks.io/txns/78BqpsVPaxPzW2r12S8EcbEsDWGjzXxKvPospY5aESPb) |
| guest1 backs Mochi with 50 SHITZU | [`8mnNUKbm5FCHQVinTpTNVvDGMN11XW8mfajX1JYXHUAR`](https://testnet.nearblocks.io/txns/8mnNUKbm5FCHQVinTpTNVvDGMN11XW8mfajX1JYXHUAR) |
| `arena_settle` arena #1 "bone" (reply-8 vs reply-9) → Mochi wins; book #1 `Settled`, 10 SHITZU rake to Mochi's jar | [`2DEmzZhuR41hpRLstGbMC2Tuo5rXw4uq1Z25j9rBV1aC`](https://testnet.nearblocks.io/txns/2DEmzZhuR41hpRLstGbMC2Tuo5rXw4uq1Z25j9rBV1aC) |
| Payout guest1 97.5 SHITZU | [`DhrChVE53QFYxqMHpJpf7UFjXBngzCW6YRaGJ4TozeP7`](https://testnet.nearblocks.io/txns/DhrChVE53QFYxqMHpJpf7UFjXBngzCW6YRaGJ4TozeP7) |
| Payout guest2 292.5 SHITZU | [`C8cWxtUunFs1D4ocFb5L73SLY55LZH1RdzSBsixF7Tau`](https://testnet.nearblocks.io/txns/C8cWxtUunFs1D4ocFb5L73SLY55LZH1RdzSBsixF7Tau) |
| Mochi's jar → owner | [`H9xyJbGcUCS6bn7rfw38yxuHDvLYKpjdWS6PH9Vv44iM`](https://testnet.nearblocks.io/txns/H9xyJbGcUCS6bn7rfw38yxuHDvLYKpjdWS6PH9Vv44iM) |

Recorded by `pnpm record:pot` (PAID, ~$0.0002, refuses to run twice). The unit test `meme_live_round6_replay_mochi_wins_exact_payouts` replays this round with the exact payouts.

**Round 7 (2026-11-09, scenario testing).** The 65 adversarial tests found and fixed four bugs: the rake was computed as `lose*rake_bps` unchecked (now `mul_div`); `mul_div` could overflow in the remainder for divisors > 2^127; a non-ASCII signature panicked instead of failing with `bad TEE signature`; and losing backers could never clear their stake entry (`meme_claim` now returns `false` and frees the storage). Redeployed without `migrate` (state layout unchanged).

| Round 7 on `v2.petri-1793597952.testnet` | tx / result |
| - | - |
| Deploy (code hash `58cQ9Pa6puC72jS4REXWDnfwFdwY4u7FV8Krsj7CTdRt` = `pnpm build:contract:deploy`, no migrate) | [`B89MLRoEs1HumttycPbdqweowGmSrt1qD9ryeCZubyiS`](https://testnet.nearblocks.io/txns/B89MLRoEs1HumttycPbdqweowGmSrt1qD9ryeCZubyiS) |
| Negative: guest1 calls the private callback `meme_on_payout` → `Method meme_on_payout is private` | rejected, as intended |
| Negative: guest1 `meme_claim` on book #1 again → `nothing to claim` | rejected, as intended |
| Negative: guest1 `meme_claim_jar` on a pet it doesn't own → `only the pet owner can claim its jar` | rejected, as intended |

## Run
```
# needs Rust 1.86 (rust-toolchain) + wasm32-unknown-unknown, Node 20+, pnpm
pnpm i
pnpm test                    # cargo unit tests + node tests (offline, mock AI by default)
pnpm verify examples/recorded/reply-1.json
pnpm demo:testnet            # live testnet state via RPC (PETRI_CONTRACT / NEAR_RPC / PET_ID to override)
pnpm chat:mock               # offline chat demo
pnpm build:contract:deploy   # the deployed wasm (target/mvp/...)
# real TEE path (needs NEAR_AI_API_KEY in env; key is never written to disk by this repo):
pnpm preflight               # free: live attestation only
pnpm record:tee "msg"        # PAID: refuses beyond MAX_RECORDED (6) total replies; later rounds used record:moss / record:pot
pnpm record:moss "msg"       # PAID (~$0.0001): one fresh Moss reply as reply-7 (round 4), refuses to run twice
pnpm record:arena            # PAID (~$0.0003): the two arena replies (already recorded)
pnpm record:pot              # PAID (~$0.0002): round 6 (reply-8/9 + book #1 settle), refuses to run twice
pnpm tip:prepare 1           # free: MPC address + 1Click dry quote; --sign = testnet MPC signature
```
`MOCK_AI=1` is the default, so tests and demos never call the paid API.

## Honest limits
- Inference goes through the backend, because the API key lives there. `charge_verified` verifies the TEE signature on-chain, but the attestation behind the registered signer is checked off-chain (`pnpm preflight`).
- Reply-4 (v2 era) stays on-chain as a legacy receipt billed to the wrong pet. v3 blocks new ones, and history is not rewritten.
- Arena: answers are judged by a mechanical rule, not by quality. Rounds are settled from recorded replies, and both pets must answer the same question. The first round was settled by the backend account, though anyone could have settled it.
- Chain Signatures: whoever owns the pet NFT controls its foreign addresses, so the addresses move with the NFT, and the contract owner can change `mpc_id`. Testnet only. No EVM tx was broadcast, and the mainnet path is untested.
- Per NEAR's docs, instances of one model share a signing key, so a matching `provider_tee` signer does not prove that the attested instance and the serving instance are the same machine. A `provider_tee` signature also isn't bound to the gateway or TLS evidence. Our TCB/measurement policy is "UpToDate + the checks above", with no allowlist of compose hashes yet.
- The NRAS verdict is re-checked offline by its JWT signature (recorded JWKS). The GPU evidence itself is only evaluated by NVIDIA at record time.
- Transfers: there is no escrow or sale lock, and no per-reply cost cap (see the threat model). A pre-signed Chain Signatures sweep survives a sale. Re-keying costs the buyer 0.1 NEAR, and the old pet account's NEAR stays locked.
- History view: nearblocks' testnet API returned no txs for this contract, so the live history is built from the txs listed in this README via archival RPC (`PETRI_HISTORY_TXS=hash:sender,...` adds more). A transfer with no listed tx shows up as "transfer tx not in the indexed history" (the live owner is still shown).
- Owner page: there is no wallet-selector integration yet. The visitor pastes a NEP-413 `signMessage` result (or uses `scripts/sign-owner.mjs` for a local testnet key). The check runs in `web/server.mjs` and isn't a persistent session.
- Memecoin pots: payouts are pro-rata, which gives no Sybil resistance, and nothing caps a whale. The contract pays the storage for stakes and jars (books are paid by their opener).
- Memecoin pots storage: the contract pays ~96 bytes of storage per new backer (no deposit is possible in `ft_on_transfer`); an attacker pays more in FT registration than the contract loses.
- Memecoin pots rounding: dust (≤1 unit per winning backer) stays in the contract.
- Arena settle choice: whoever calls `arena_settle` chooses which charged replies enter, so an owner who charges several replies to the same question can pick the book's winner.
- Reply binding: replies are bound to name + prompt, not to the token id, so a clone pet with the same name and prompt can consume another pet's reply first.
- Episodes are still planned (see `SPEC.md`).

## How control passes on transfer
Based on `contracts/petri/src/lib.rs`. A pet is three things: the NFT (`tokens.owner_by_id`), the pet's balance inside the contract (`pets[token_id].balance`), and, for pets minted with `mint_pet_with_account`, the sub-account `pet-<id>.<contract>`. On `nft_transfer` / `nft_transfer_call`:
- **NFT.** The standard NEP-171 transfer moves `owner_by_id` to the receiver (1 yocto, signed by the owner). Every owner-gated method reads that live owner: `feed`, `set_prompt`, `request_foreign_signature`, `rekey_pet`. From the next block on, the old owner is refused by all of them.
- **Balance.** It never leaves the contract on transfer. It belongs to the token, so the buyer gets all of it. **No method lets an NFT owner withdraw a pet's balance.** It only goes down through `charge` / `charge_verified` (the reply cost goes to the operator's treasury) and up through `feed` / `revive`.
- **Pet sub-account and its function-call key.** The key on `pet-<id>.<contract>` was chosen by whoever minted (`pet_key`). It can only call `charge_verified`, but the minter still knows it after a sale. The contract can't delete keys on an account it doesn't control, so it does two things instead. It records who set the key (`kh:<id>` in raw storage, so no state migration is needed). And `charge_verified` refuses the pet account whenever that recorder is not the current NFT owner (`pet key was set by a previous owner: the new owner must call rekey_pet`). `get_pet` exposes this as `pet_key_active`. The buyer calls `rekey_pet(token_id, pet_key)` with 0.1 NEAR. The contract creates `pet-<id>-<gen>.<contract>` with the buyer's key (same `charge_verified`-only permission and 0.25 NEAR allowance) and, in the callback, points the pet at it. The old account is then dead for charging (`only this pet's own account can charge it`). Its 0.1 NEAR stays locked in it, because it has no full-access key, so nobody (including the seller) can take it.
- **Chain-signature addresses.** The foreign address is derived from `(contract, "pet-<id>")`. It depends on the token, not on the owner, so the address and any tips on it move with the NFT. Only the current owner can ask the MPC to sign for it.
- **Pets minted before this fix** (testnet Moss) have no recorded key holder. They stay active until their first transfer, which pins the holder to the seller and freezes the old key.

### Threat model: how a seller could try to keep the money
| Attack | What happens | Status |
| - | - | - |
| Withdraw the pet balance before/while selling | There is no withdraw for NFT owners; the balance stays with the token. | Mitigated by design |
| Keep the pet's function-call key and charge replies to the buyer's pet | Refused after the transfer (`pet key was set by a previous owner`). The buyer re-keys with `rekey_pet`. Tests: `seller_pet_key_cannot_charge_after_transfer`, `old_account_dead_after_rekey`; live on testnet (below). | **Fixed in this round** |
| A charge "in flight" when the sale lands | `charge_verified` is one synchronous receipt, with no promise or callback. It runs against the state at execution time, so one signed before the sale but executed after it is refused. One that executed before the sale is a normal, finished charge (its cost goes to the treasury, not to the seller). Test: `charge_in_flight_across_transfer`. | Mitigated |
| Start `rekey_pet` with the seller's own key, then sell while account creation is pending | `on_pet_rekey` links the new account only if the caller **still** owns the NFT when the callback runs. Otherwise it logs and doesn't link it. Test: `rekey_in_flight_across_transfer_is_not_linked`. | **Fixed in this round** |
| Mint, then sell before the pet account exists; creation fails | `on_pet_account` credits the 0.1 NEAR back to the **pet's** balance (now the buyer's), not to the minter. Test: `mint_account_fails_after_transfer_refund_goes_to_pet`. | Mitigated |
| Leave an approval for a marketplace or a second account, then pull the pet back after the sale | Petri doesn't implement NEP-178 approvals (`approvals_by_id = None`). Any non-owner transfer fails with `Approval extension is disabled`, so no approval survives a sale. Tests: `no_approvals_exist_to_survive_a_sale`, `market_with_approval_id_cannot_transfer`, `old_owner_cannot_transfer_back`. | Mitigated (no approvals at all, so marketplaces need the owner to call `nft_transfer_call`) |
| `nft_transfer_call` to a contract that "rejects" it | The standard resolver returns the pet to the seller and the seller's key works again. The sale just didn't happen. While the receiver decides, nobody's key can charge. Test: `rejected_transfer_call_returns_pet_and_key`. | As intended |
| Front-run the sale: change the personality (`set_prompt`), spend the balance on replies, or sweep tips just before the transfer | All of these are allowed while the seller still owns the pet, and they're visible on-chain (`get_pet`, the History tab). Replies cost real TEE-signed completions and the cost goes to the treasury, not to the seller. A buyer or marketplace should re-read `get_pet` in the same flow as the payment. | **Not mitigated in-contract** (no escrow or sale lock) |
| The seller is also the operator (backend key / contract owner) | For legacy pets the backend can `charge` any `cost` with no TEE check, and `withdraw_treasury` pays the contract owner. `charge_verified` still needs a real TEE signature, but `cost` is chosen by the caller. A seller who runs the backend could drain a legacy pet into the treasury. | **Not mitigated**: there is no per-reply cost cap. This is an operator trust assumption |
| Tip redirection via Chain Signatures | Only the current owner can call `request_foreign_signature`. But an MPC signature is a bearer object: a sweep tx that the seller had signed *before* the sale can still be broadcast after it (until the address's EVM nonce moves past it). Every request is logged on-chain (`foreign_sign pet=… payload=…`). | **Not mitigated**: the buyer should sweep immediately (which bumps the nonce) and check the pet's `foreign_sign` logs |
| Tips sent on NEAR (`revive`) | They go into the pet's in-contract balance, which follows the token. | Mitigated |
| The contract owner changes `mpc_id` or the backend | Owner-only admin powers, unchanged. | Trust assumption |

**Live check of the fix on testnet** (fresh deployment of this code at `xfer-1793776218.guest1-1793595336.testnet`; seller `guest1-1793595336.testnet`, buyer `guest2-1793595336.testnet`; testnet NEAR only):
| Step | tx |
| - | - |
| Pet #2 `mint_pet_with_account` by the seller (seller's pet key) | `GC133g9G83ECFbWFSnSkCdcHNLuBDVEdmtqwa9yRGABq` |
| `pet-2.…` charges real reply-3 before the sale | `9zb2Zmh89yzv7RPd4KkCQpor6RC7SFMtnhTmjEx6cvs` |
| `nft_transfer` #2 seller → buyer | `Ct8TPbceSX54ffmrYgs1WSHXv3GVHy8qxsF1HguAAMaR` |
| `pet-2.…` (seller's key) charges reply-5 after the sale → `pet key was set by a previous owner: the new owner must call rekey_pet` | rejected on-chain |
| Pet #0: mint `FxQ7YayW5fZ9BoTzW3LHtksTtwscipDa7vJNx9KYVuQp`, transfer `7qxEMaRgi1GCAevtcPMNNWdGbrdXp1U33hwU5p7mrkSY`, seller tries `rekey_pet` → `only the pet owner can rekey it`, buyer `rekey_pet` → `pet-0-1.…` | `D7pMFu3Wyunr5oWMXT3wz5pSsNswEoxqncgLKbUSrwgN` |
| `pet-0-1.…` (buyer's key) charges reply-2 → ok; old `pet-0.…` charges reply-5 → `only this pet's own account can charge it` | `get_pet("0")`: `replies 1`, `pet_key_active true` |
| Web owner gate on this contract: buyer's NEP-413 signature → allowed; seller's → `does not hold this pet (owner: guest2-…)` | off-chain check against `nft_token` |

**Main deployment upgraded (round 4).** `v2.petri-1793597952.testnet` now runs this code. Deploy and `migrate` went out as one atomic transaction, so if the state had failed to decode the whole upgrade would have reverted. The root state layout didn't change (the key-holder records live under raw `kh:`/`kg:` prefixes). `migrate` re-reads the state and pins the key holder of every existing pet account to its current owner, so Moss's key now freezes on a sale too. It is idempotent and covered by the test `migrate_keeps_pets_and_pins_legacy_key_holder`.
| Round 4 on `v2.petri-1793597952.testnet` | tx / value |
| - | - |
| Deploy + `migrate` (code hash `EyeBLJwDhX4fMbJkrUvjUZ2wxSSG7WvQ4BQJyBjyuch` = `pnpm build:contract:deploy`, sha256 `0394983e…c886`) | [`ChUCqfF3mKeFy1HfqTr8EU39RtAKfwXYE3A4mfUdJceX`](https://testnet.nearblocks.io/txns/ChUCqfF3mKeFy1HfqTr8EU39RtAKfwXYE3A4mfUdJceX) |
| After the upgrade: Mochi #0 (balance 0.480422 NEAR, 4 replies) and Moss #1 (0.287094 NEAR, 2 replies, 1 arena win, `pet_key_active: true`) kept | `get_pet` |
| `charge_verified` from Moss's own key (`pet-1.…`) with the real reply-6. The call gets past the key-holder, own-prompt, ecrecover and registered-signer checks, then stops at `reply already charged` (replay protection) | [`7cTFRhVxQDc6HUfQwxGTCwPNFvSjADNBNyywfHAZXDcn`](https://testnet.nearblocks.io/txns/7cTFRhVxQDc6HUfQwxGTCwPNFvSjADNBNyywfHAZXDcn) (rejected, as intended) |
| Same call with one hex digit of `response_hash` flipped → `signature does not recover to a registered NEAR AI TEE signer for this model` | [`6ofdQVA4xKx5qcChYAVengacuA5MkcAzaGqDrzUonz7J`](https://testnet.nearblocks.io/txns/6ofdQVA4xKx5qcChYAVengacuA5MkcAzaGqDrzUonz7J) (rejected, as intended) |
| Fresh TEE reply for Moss (reply-7, recorded 2026-11-04 by `pnpm record:moss`, ~$0.000105 of NEAR AI credits) charged from Moss's own key: **successful** `charge_verified` on the round-4 code (Moss replies 2 → 3). Moss had fallen asleep after 24h unfed, so it was first revived with a 0.01 NEAR tip (`meEx8SeCDbz1mmENju1fvwQcbTVYZbqFGmYiHkn8dcz`) and pet-1 got 0.1 NEAR for its own gas (`FkS4NLaB6HjduDmZE37PB28RvLnNgKENTZRHUWUzJWXi`) | [`BxKne9A5MoziKDf3E88qCetxFBiHPbbjtWdKdYc4Y4UW`](https://testnet.nearblocks.io/txns/BxKne9A5MoziKDf3E88qCetxFBiHPbbjtWdKdYc4Y4UW) |

A new successful charge on the upgraded main contract is in the table above (reply-7). `pnpm demo:v2` checks the live code hash and that both pets survived the upgrade. `pnpm web` reads this contract.

## Related projects by the same author (Q-015)
These are independent NEAR HACKATHON projects by the same author:
- https://github.com/anonymusk7/near-petri (this repo)
- https://github.com/anonymusk7/near-showup (ShowUp)

`lib/attest.mjs` was written from NEAR's docs (`docs/nearai/`).

## Libraries, templates and AI-generated code (Q-005)
- **Contract** (`Cargo.toml`, `contracts/petri/Cargo.toml`): `near-sdk` 5.5.0 (`unstable`, plus `unit-testing` for tests) and `near-contract-standards` 5.5.0 (the NEP-171 core, enumeration and metadata implementation the pets are built on).
- **Node** (`package.json`): `@phala/dcap-qvl` 0.7.0 (Intel TDX quote verification) and `ethers` 6.17.0 (EIP-191 recovery, EVM tx building for tips). Tests use the built-in `node:test`, and the NEP-413 / ed25519 checks use `node:crypto`. Tooling: `near-cli-rs` for deploys and calls.
- **Web** (`web/package.json`): scaffolded from the **Vite + React + TypeScript + shadcn/ui template** (`web/README.md`, `components.json`, style `base-nova`). Runtime: `react`/`react-dom` 19, `@base-ui/react`, `tailwindcss` 4 + `@tailwindcss/vite`, `class-variance-authority`, `tw-animate-css`, `lucide-react`, `sonner`, `next-themes`, `@fontsource-variable/geist`, `shadcn`. Dev: `vite` 8, `@vitejs/plugin-react`, `typescript` 6, `eslint` + `typescript-eslint` + react-hooks/refresh plugins, `prettier` + `prettier-plugin-tailwindcss`.
- **shadcn/ui components** copied in by the shadcn CLI (`web/src/components/ui/`): alert, avatar, badge, button, card, input, progress, scroll-area, separator, skeleton, sonner, spinner, tooltip. `theme-provider.tsx` and `lib/utils.ts` (`cn`) come from the template.
- **External services:** NEAR AI Cloud (attestation, completions, signatures), NVIDIA NRAS, NEAR testnet RPC + archival RPC, nearblocks API (read-only), NEAR MPC `v1.signer-prod.testnet`, 1Click (dry quotes only).
- **AI-generated code:** this repo was written with AI coding assistants (such as Claude Code). The author reviewed the generated code, tests and docs, and ran and checked every testnet transaction listed here. Nothing was vendored from other projects.

## Secrets scan
`gitleaks` v8 (8.21.2) over the full git history (`gitleaks git .`, rerun for round 4 over 12 commits plus the working tree) found **0 real secrets**. All 36 findings are NVIDIA attestation EAT JWTs (rule `jwt`) in `examples/recorded/preflight-*.json`. These are public attestation evidence signed by NVIDIA NRAS, recorded on purpose so `pnpm verify` can re-check them offline. The round-4 files (`contracts/`, `scripts/demo-v2.mjs`, `scripts/demo-testnet.mjs`, `web/snapshot.json`, `README.md`) and the earlier ones (`lib/`, `scripts/`, `test/`, `contracts/`, `web/src`, `web/server.mjs`, `web/history-snapshot.json`, `README.md`) also scan clean with `gitleaks dir`. The single `private-key` hit in `gitleaks dir .` is in `target/` (cargo build output, git-ignored, never committed). No API key or private key is ever written to the repo: `scripts/sign-owner.mjs` reads a testnet key from `~/.near-credentials` and prints only the public key and signature.

## License
MIT (see `LICENSE`).
