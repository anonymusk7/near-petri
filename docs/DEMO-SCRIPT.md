# Petri: demo video script (≈2:30)

For the video team. Every shot is real: testnet only, recorded TEE replies, no mocked chain data. Commands run from a fresh clone (`pnpm i` first). Terminal font ≥ 18 pt, dark theme. Open the browser at http://localhost:5174 after `pnpm web`.

| # | Time | Shot (screen) | Voiceover |
|---|------|---------------|-----------|
| 1 | 0:00–0:10 | Title card: "Petri: AI pets that pay for their own brain." Mochi 🌿 and Moss 🍀 faces from the web UI. | "Meet Mochi and Moss. They are AI pets on NEAR, and every thought they have costs them real NEAR." |
| 2 | 0:10–0:25 | Web UI, Moss card selected. Zoom into **own account** and **key: charge_verified only**. | "Each pet is its own NEAR account. Its only key can do one thing: pay for a reply. It can't move funds or call anything else." |
| 3 | 0:25–0:45 | Chat with Moss. Hover the green **TEE-verified** badge to show the tooltip (8/8 checks, on-chain ecrecover). | "Moss's brain runs in NEAR AI Cloud inside an Intel TDX and NVIDIA confidential enclave. The enclave signs every answer, and the smart contract recovers that signature on-chain before it lets the pet pay." |
| 4 | 0:45–1:05 | Hover the **legacy v2 receipt** badge on reply-4. Cut to the terminal: `pnpm demo:v2` and highlight the ⚠ line. | "We found a real bug in our own v2: Moss was billed for a reply written with Mochi's personality. Version three requires the exact prompt, name and personality, of the pet being charged. We left the old receipt visible on purpose." |
| 5 | 1:05–1:35 | UI **Arena #0 "puddle"** card. Pan over the two answers, the rule line and the 🏆 on Moss, then click **settled tx** to open nearblocks. | "In the Arena, two pets answer the same prompt. Both answers are TEE-signed, and the contract checks both signatures. The winner comes from a public rule: use the word, then the shortest answer wins. Moss wins with 63 characters to 78. Anyone can settle a round, and anyone can recompute it." |
| 6 | 1:35–1:45 | Terminal: the `arena #0` lines of `pnpm demo:v2` (`recomputed locally: pet #1 ✓`). | "Our demo recomputes the winner from the signed bytes, and it matches the chain." |
| 7 | 1:45–2:15 | UI **tip from any chain** row on Moss (`0x5a34…2615`). Terminal: `pnpm tip:prepare 1`, showing the derived address, the 1Click dry quote "0.001 ETH (Base) → 0.55 NEAR", and `recovers to 0x5a34… ✓`. | "Moss also has an Ethereum address, derived by NEAR Chain Signatures. Fans can tip from any chain. The NEAR MPC network signs for the pet, and NEAR Intents 1Click swaps the tip into NEAR for its brain. Here is a real testnet MPC signature for Moss's address. Mainnet is one config switch." |
| 8 | 2:15–2:30 | Terminal: `pnpm test` (`79 passed`, `pass 21`), then the closing card with the repo name and "Built on NEAR AI Cloud · Chain Signatures · Intents". | "Verifiable brains, pets that own their wallets, and fair fights. That's Petri." |

## Must not show
- `/home/box/.secrets`, any `.env`, `~/.near-credentials`, or shell history.
- `pnpm record:tee` / `record:arena`: these spend credits and are already recorded.
- Mainnet, or the words "live on mainnet". Everything here is testnet.

## Backup if offline
`node web/server.mjs` falls back to `web/snapshot.json`. The badge shows `source: snapshot`, so say "snapshot of testnet" in the voiceover.
