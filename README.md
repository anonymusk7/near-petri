# Petri: AI pets that pay for their own brain

**What:** Petri pets are NEP-171 NFTs on NEAR. Each pet has its own on-chain NEAR balance. Every chat reply from its AI brain (a NEAR AI Cloud model running in a TEE) is debited from that balance and recorded on-chain as a receipt hash. That hash commits to the exact request/response bytes the model's TEE signed. When a pet runs out of money, or nobody feeds it for 24h, it falls asleep. Anyone can wake it up with a tip.

**Problem:** virtual pets get boring after day one, and their "AI" is a centralized black box. In Petri the pet's own balance pays for a brain you can verify, so caring for it (feeding, tipping) has a real, visible effect.

Inspired by @ilblackdragon's "AI Tamagochi" idea. Status: work in progress (NEAR HACKATHON, Nov 2026). This repo covers the contract core, a verified TEE chat backend, and a live testnet deployment.

## Judge steps (do X, see Y)
Everything below runs offline except step 4 (read-only NEAR RPC). No API key needed.
```
pnpm i
```
1. Run `pnpm test`. You should see `58 passed` for Rust (including 7 pet-account tests and 9 `charge_verified` tests that ecrecover a **real** recorded NEAR AI signature and reject a tampered response, a tampered request, a wrong prompt, an unregistered signer, a non-backend caller and a replay) and `pass 16` for JS. The JS tests include offline re-verification of the **real** recorded NEAR AI evidence and a full replay of the TEE client against the recorded bytes.
2. Run `pnpm verify examples/recorded/reply-1.json`. You should see 8 ✓ checks (hashes, request shape, Intel TDX quotes via dcap-qvl, NVIDIA NRAS GPU verdict, preflight-before-completion, provider_tee signature, Petri receipt) and `=> VALID` (exit 0). `pnpm verify examples/recorded/reply-[0-9].json` checks all three (exit 0).
3. Run `pnpm verify examples/recorded/reply-1.tampered.json` (same reply with the text swapped for a scam message). You should see `✗ response bytes hash to response_hash`, `✗ provider_tee signature … signature text does not match`, and `=> INVALID` (exit 1).
4. Run `pnpm demo:testnet`. It reads pet #0 "Mochi" from `petri-1793597952.testnet` over RPC: balance ≈ 0.483 NEAR, `replies 3`. For each recorded reply it should show `on-chain get_reply: index N, cost 0.0011.. NEAR` with ✓ on-chain receipt matches record and ✓ TEE evidence verifies. The last line is `=> ALL RECORDED REPLIES CHARGED ON-CHAIN AND TEE-VERIFIED`.
5. Run `pnpm chat:mock`. You should see 3 offline mock replies from "Mochi", the balance going down after each one, and `verify=true`.
6. Optional, needs a NEAR AI key, free: `NEAR_AI_API_KEY=... pnpm preflight`. This runs the live attestation (no completion is sent) and prints gateway and model signers with `TCB UpToDate` and `GPU 8xHOPPER NRAS overall=true`.

7. Run `pnpm demo:v2`. It reads `v2.petri-1793597952.testnet` over RPC. You should see the registered TEE signer `0xfe00…337e`, pet #0 Mochi with `replies 3`, and for each of the 4 real replies `✓ on-chain ecrecover → 0xfe0071895500a9755c18044948ab4f4e1a7f337e`, then pet #1 Moss with its own account `pet-1.v2.petri-1793597952.testnet` and exactly one key, `✓ only charge_verified on v2.petri-1793597952.testnet, no full-access key`. The last line is `=> EVERY CHARGED REPLY CARRIES A NEAR AI TEE SIGNATURE VERIFIED BY THE CONTRACT`.
8. Run `pnpm web` and open http://localhost:5174. You should see pets Mochi #0 and Moss #1 (live testnet balances; Moss shows **own account** and **key: charge_verified only**), and the recorded replies with a green **TEE-verified** badge. Hover the badge to see 8/8 local checks plus the on-chain ecrecover result, and click **tx** to open the testnet explorer. New messages use the mock brain and are labelled **mock brain · unsigned** (no credits, nothing on-chain). Click **Starve** to see the asleep alert with the input disabled, then **Revive**. These sleep buttons are a local simulation only. If you are offline, run `node web/server.mjs --snapshot`.

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
- **Stub:** per-pet sub-accounts (`pet-<id>.<contract>`). Mint logs and returns the planned account (`pet_account`), but balances are still held and accounted for inside the contract.

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
pnpm record:tee "msg"        # PAID: refuses beyond 4 recorded replies
```
`MOCK_AI=1` is the default, so tests and demos never call the paid API.

## Honest limits
- Inference goes through the backend, because the API key lives there. "The pet pays" is enforced by the contract's accounting (`charge` is backend-only) and is publicly auditable: every on-chain `reply_hash` opens to a TEE-signed request/response. The contract does not verify the TEE signature on-chain.
- Per NEAR's docs, instances of one model share a signing key, so a matching `provider_tee` signer does not prove that the attested instance and the serving instance are the same machine. A `provider_tee` signature also isn't bound to the gateway or TLS evidence. Our TCB/measurement policy is "UpToDate + the checks above", with no allowlist of compose hashes yet.
- The NRAS verdict is re-checked offline by its JWT signature (recorded JWKS). The GPU evidence itself is only evaluated by NVIDIA at record time.
- The sub-account per pet is a stub. Arena, episodes, 1Click tips, and a function-call-only backend key are planned (see `SPEC.md`).

## Related projects by the same author (Q-015)
These are independent NEAR HACKATHON projects by the same author:
- https://github.com/anonymusk7/near-petri (this repo)
- https://github.com/anonymusk7/near-sealed: SEALED, attested AI code-review certificates using NEAR AI Cloud TEE signatures and an on-chain registry.
- https://github.com/anonymusk7/near-showup

No code was vendored from SEALED: it had no attestation verifier yet, so `lib/attest.mjs` was written from NEAR's docs (`docs/nearai/`).

## License
MIT (see `LICENSE`).
