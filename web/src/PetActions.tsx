import { useState } from "react"
import { SparklesIcon, UtensilsIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { near } from "@/lib/format"
import { feedTx, parseNear, reviveTx } from "@/lib/txs"
import { signIn, useAccount } from "@/lib/wallet"
import { runTx } from "@/Wallet"

type PetLite = { token_id: string; name: string; owner_id: string; balance: string; asleep: boolean }

const valid = (v: string) => { try { parseNear(v); return true } catch { return false } }

/** Real testnet NEAR actions on a pet: revive (anyone, only while asleep on-chain) and feed (NFT owner, only while awake). */
export function PetActions({ pet, threshold }: { pet: PetLite; threshold: string }) {
  const account = useAccount()
  const isOwner = account === pet.owner_id
  // revive must lift the balance to >= sleep_threshold; asleep from hunger accepts any tip
  const need = BigInt(threshold) - BigInt(pet.balance)
  const [amt, setAmt] = useState(() => (need > 0n ? near(need + 10n ** 21n).replace(/0+$/, "").replace(/\.$/, "") : "0.01"))
  const [busy, setBusy] = useState(false)
  if (!pet.asleep && !isOwner) return null
  const tooSmall = pet.asleep && valid(amt) && BigInt(parseNear(amt)) < need
  async function go() {
    if (!account) return signIn()
    setBusy(true)
    try { await runTx(pet.asleep ? `Revived ${pet.name}` : `Fed ${pet.name}`, [pet.asleep ? reviveTx(pet.token_id, amt) : feedTx(pet.token_id, amt)]) }
    finally { setBusy(false) }
  }
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border p-2" onClick={(e) => e.stopPropagation()}>
      <div className="flex flex-wrap items-center gap-2">
        <Input className="h-7 w-24 font-mono text-xs" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} aria-label="amount in NEAR" />
        <span className="text-xs text-muted-foreground">NEAR</span>
        <Button size="xs" disabled={busy || (Boolean(account) && (!valid(amt) || tooSmall))} onClick={go}>
          {busy ? <Spinner data-icon="inline-start" /> : pet.asleep ? <SparklesIcon data-icon="inline-start" /> : <UtensilsIcon data-icon="inline-start" />}
          {!account ? "Connect wallet to " + (pet.asleep ? "revive" : "feed") : pet.asleep ? "Revive with NEAR" : "Feed with NEAR"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {pet.asleep
          ? `Asleep on testnet. Anyone can wake it: revive adds the NEAR to its brain balance${need > 0n ? ` (needs at least ${near(need)} NEAR to reach the ${near(threshold)} threshold)` : ""}. Real testnet tx.`
          : "You hold this pet: feed tops up its brain balance and resets its hunger clock (owner only). Real testnet tx."}
      </p>
      {tooSmall && <p className="text-xs text-destructive">Too small: the contract rejects a revive that leaves the balance under the threshold.</p>}
    </div>
  )
}
