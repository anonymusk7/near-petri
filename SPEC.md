# Petri: AI pets that are self-funded businesses
Inspired by @ilblackdragon's "AI Tamagochi" idea (https://x.com/ilblackdragon/status/2106269343881519444). Retention critique: https://x.com/Paul_pl03/status/2108398388719001649.
Facts and sources: ../FEASIBILITY.md. Tracks: games, nfts, agents (memecoins optional).

## Problem
- Virtual pets get boring after day one. Their "AI" is a centralized black box.
- His idea: the pet's own NEAR balance pays for its own verifiable brain.

## User flow
1. Mint a pet (NEP-171). The factory creates `<pet>.petri.testnet` as the pet's own sub-account, holding the deposit. The personality prompt hash is stored on-chain.
2. Feed or dress it. Each action is a contract call that also tops up the pet's balance. It can use a social login or any-chain deposit through Aurora Intents Connect or 1Click (stretch goal).
3. Talk to it. The backend calls NEAR AI Cloud with the on-chain prompt, debits the pet's balance via `charge(pet, cost)`, and stores a response-signature hash, giving a verifiable brain.
4. Daily "episode": the pet's day becomes a short captioned video (script from NEAR AI, render via Hypit) posted to a feed. Tips go to the pet.
5. Arena: two pets debate or battle. A NEAR AI judge picks the winner, and the winner takes the stake.
6. When the balance hits 0, the pet sleeps (grey sprite). Anyone can revive it by tipping.

## Architecture
```mermaid
flowchart LR
  U[Player wallet / social login] --> FE[Next.js app]
  FE -->|mint/feed/tip| FAC[(petri.near factory + NEP-171)]
  FAC -->|creates| PET[(pet sub-accounts)]
  FE --> API[Petri backend]
  API -->|prompt from chain| NAI[NEAR AI Cloud TEE model]
  API -->|charge(pet, cost) FC key| FAC
  API -->|episode script| HYP[Hypit render pipeline]
  ARENA[Arena contract] --> FAC
  TIP[Any chain tip] -->|1Click| PET
```

## NEAR components
- NEP-171 NFT.
- Factory sub-accounts.
- Function-call key restricted to `charge` and `record_reply`.
- Optional meta transactions (gasless feed).
- NEAR AI Cloud with signature verification.
- 1Click for tips.
- Optional Staking-for-Inference ("the pet's stake pays its brain", U).

## MVP vs stretch
**MVP:**
- Mint, feed, chat; each chat is charged from the pet's balance, with signature hashes.
- Sleep/revive.
- Arena 1v1.
- One daily episode per pet, rendered with Hypit as a batch job.
- Testnet.

**Stretch:**
- Any-chain tips on mainnet.
- Wardrobe NFTs (NEP-245).
- Staking-funded pets.
- A shared X bot.

## Day-by-day (UTC)
- **Nov 1:** Repo, NFT+factory contract skeleton.
- **Nov 2:** Sub-account creation and the charge logic, with sandbox tests.
- **Nov 3:** Testnet deploy and FC key backend.
- **Nov 4:** Chat with NEAR AI and the charge plus signature.
- **Nov 5:** Pet sprites and UI (generated assets).
- **Nov 6:** Feed/dress mechanics and decay timers.
- **Nov 7:** Sleep/revive.
- **Nov 8:** Arena contract plus AI judge.
- **Nov 9:** Episode script → Hypit render pipeline.
- **Nov 10:** Episode feed and tips via 1Click (mainnet, small amounts).
- **Nov 11:** Balance tuning and seeding 5 pets.
- **Nov 12:** README.
- **Nov 13:** Demo video.
- **Nov 14:** Freeze.

## Demo script (60 s)
1. "This pet pays for its own brain."
2. Mint; NearBlocks shows the sub-account and balance.
3. Chat. The balance ticks down and a "verified TEE reply" badge appears.
4. Arena fight; the winner takes the pot.
5. The pet starves and sleeps. A tip from Base via Intents revives it.
6. Show its auto-made daily episode.
7. "Built at NEAR HACKATHON."

## README outline for the AI judges
- What, problem, architecture, NEAR tech.
- Run: `pnpm i; pnpm dev` (testnet, demo key or recorded mode).
- Judge steps:
  - Open `/pet/demo` → see the balance.
  - Send "hi" → reply plus balance drops by X.
  - Run `pnpm verify <reply-id>` → valid.
  - Open `/arena` → result.
- Economics table.

## Risks and fallbacks
- Retention or game feel too thin (the games track is "judged on the game loop") → focus on the arena and episodes.
- Video cost and latency → pre-render episodes; fall back to an image plus captions.
- Inference has to go through the backend (API key), so the claim "the pet pays" depends on the contract accounting → document this honestly.
- Similar toy already exists ($GOCHI) → differentiate with verifiable, self-funded agents.
- Petri carries the most scope risk of the three.
