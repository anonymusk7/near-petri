# Petri: AI pets that pay for their own brain

**What:** Petri pets are NEP-171 NFTs on NEAR. Each pet has its own on-chain NEAR balance. Every chat reply from its AI brain (a NEAR AI Cloud model running in a TEE) is debited from that balance and recorded on-chain as a receipt hash. That hash commits to the exact request/response bytes the model's TEE signed. When a pet runs out of money, or nobody feeds it for 24h, it falls asleep. Anyone can wake it up with a tip.

**Problem:** virtual pets get boring after day one, and their "AI" is a centralized black box. In Petri the pet's own balance pays for a brain you can verify, so caring for it (feeding, tipping) has a real, visible effect.

Inspired by @ilblackdragon's "AI Tamagochi" idea. Status: work in progress (NEAR HACKATHON, Nov 2026). This repo covers the contract core, a verified TEE chat backend, and a live testnet deployment.

## Judge steps (do X, see Y)
Everything below runs offline except step 4 (read-only NEAR RPC). No API key needed.
```
pnpm i
```
1. Run `pnpm test`. You should see `79 passed` for Rust and `pass 22` for JS. The Rust tests include `charge_verified` tests that ecrecover a **real** recorded NEAR AI signature, own-prompt tests (`real_mochi_reply_cannot_be_charged_to_moss` replays Mochi's real reply-5 against Moss and expects a rejection), arena tests (`real_arena_round_moss_wins` settles the real reply-5 against reply-6), and Chain Signatures tests. The JS tests re-verify the real recorded NEAR AI evidence offline and check the real MPC signature in `examples/tip/tip-testnet.json` (`test/tip.test.mjs`).
2. Run `pnpm verify examples/recorded/reply-1.json`. You should see 8 ✓ checks (hashes, request shape, Intel TDX quotes via dcap-qvl, NVIDIA NRAS GPU verdict, preflight-before-completion, provider_tee signature, Petri receipt) and `=> VALID` (exit 0). `pnpm verify examples/recorded/reply-[0-9].json` checks all six (exit 0).
3. Run `pnpm verify examples/recorded/reply-1.tampered.json` (same reply with the text swapped for a scam message). You should see `✗ response bytes hash to response_hash`, `✗ provider_tee signature … signature text does not match`, and `=> INVALID` (exit 1).
4. Run `pnpm demo:testnet`. It reads pet #0 "Mochi" from `petri-1793597952.testnet` over RPC: balance ≈ 0.483 NEAR, `replies 3`. For each recorded reply it should show `on-chain get_reply: index N, cost 0.0011.. NEAR` with ✓ on-chain receipt matches record and ✓ TEE evidence verifies. The last line is `=> ALL RECORDED REPLIES CHARGED ON-CHAIN AND TEE-VERIFIED`.
5. Run `pnpm chat:mock`. You should see 3 offline mock replies from "Mochi", the balance going down after each one, and `verify=true`.
6. Optional, needs a NEAR AI key, free: `NEAR_AI_API_KEY=... pnpm preflight`. This runs the live attestation (no completion is sent) and prints gateway and model signers with `TCB UpToDate` and `GPU 8xHOPPER NRAS overall=true`.

7. Run `pnpm demo:v2` (read-only RPC, no keys). Expect `✓ on-chain ecrecover → 0xfe00…337e` for each of the 6 real replies. Reply-4 also shows `⚠ built on Mochi's prompt … v3 now REJECTS this` (this is the bug fixed in round 3, kept visible on purpose). Then `arena #0 "puddle"` with `on-chain winner: pet #1 Moss | recomputed locally: pet #1 ✓`, Moss's single `charge_verified`-only key, and `pet #1 EVM address via Chain Signatures: 0x5a34…2615 ✓; MPC-signed sweep … recovers to 0x5a34…2615 ✓`. The last line is `=> EVERY CHARGED REPLY IS TEE-VERIFIED ON-CHAIN, THE ARENA RESULT REPRODUCES, THE PET SIGNS ON OTHER CHAINS`.
8. Run `pnpm web` and open http://localhost:5174. You should see pets Mochi #0 and Moss #1 (live testnet balances; Moss shows **own account** and **key: charge_verified only**), and the recorded replies with a green **TEE-verified** badge. Hover the badge to see 8/8 local checks plus the on-chain ecrecover result, and click **tx** to open the testnet explorer. New messages use the mock brain and are labelled **mock brain · unsigned** (no credits, nothing on-chain). Click **Starve** to see the asleep alert with the input disabled, then **Revive**. These sleep buttons are a local simulation only. You should also see an **Arena #0 "puddle"** card with both TEE-signed answers, the 🏆 on Moss, the rule text and the settle tx; a **1 arena win** badge on Moss; and a **tip from any chain** EVM address on each pet. Moss's reply-4 carries a **legacy v2 receipt** badge. Offline, the server falls back to `web/snapshot.json` (refresh it with `node web/server.mjs --snapshot`).
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

Deployed code hash `6SPGEDfJM1SG8F3iZTVrurshQCNBuFbX8R9xrpAsswTR` (sha256 `50cb2090…7e64`). You get the same wasm with `pnpm build:contract:deploy` (Rust 1.86, `-C target-cpu=mvp`), so you can compare it against `view_account.code_hash`.

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
pnpm record:tee "msg"        # PAID: refuses beyond 6 recorded replies
pnpm record:arena            # PAID (~$0.0003): the two arena replies (already recorded)
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
- Episodes are still planned (see `SPEC.md`).

## Related projects by the same author (Q-015)
These are independent NEAR HACKATHON projects by the same author:
- https://github.com/anonymusk7/near-petri (this repo)
- https://github.com/anonymusk7/near-sealed: SEALED, attested AI code-review certificates using NEAR AI Cloud TEE signatures and an on-chain registry.
- https://github.com/anonymusk7/near-showup

No code was vendored from SEALED: it had no attestation verifier yet, so `lib/attest.mjs` was written from NEAR's docs (`docs/nearai/`).

## License
MIT (see `LICENSE`).
