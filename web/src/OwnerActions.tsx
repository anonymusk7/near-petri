import { useCallback, useEffect, useState } from "react"
import { CoinsIcon, ShieldAlertIcon, ShieldCheckIcon, WalletIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { near } from "@/lib/format"
import { view } from "@/lib/rpc"
import { claimJarTx } from "@/lib/txs"
import { onTx, signIn, useAccount } from "@/lib/wallet"
import { PetActions } from "@/PetActions"
import { fmtShitzu, runTx, useShitzu, withRegistration } from "@/Wallet"

type Pet = { token_id: string; name: string; owner_id: string; balance: string; asleep: boolean; pet_account: string | null }

/**
 * Owner actions with the connected wallet, gated on wallet account == nft owner (read live via get_pet).
 * The contract enforces the same rule on every call (feed, meme_claim_jar); this gate only decides what to show.
 */
export function OwnerActions({ tokenId, gate }: { tokenId: string; gate: boolean }) {
  const account = useAccount()
  const sh = useShitzu(account)
  const [pet, setPet] = useState<Pet | null>(null)
  const [jar, setJar] = useState<bigint | null>(null)
  const [threshold, setThreshold] = useState("10000000000000000000000")
  const [err, setErr] = useState<string | null>(null)
  const load = useCallback(() => {
    Promise.all([view<Pet>("get_pet", { token_id: tokenId }), view<string>("meme_get_jar", { token_id: tokenId }).catch(() => "0"),
      view<{ sleep_threshold: string }>("get_config").catch(() => null)])
      .then(([p, j, c]) => { setPet(p); setJar(BigInt(j)); if (c) setThreshold(c.sleep_threshold); setErr(null) })
      .catch((e) => setErr(e.message))
  }, [tokenId])
  useEffect(() => { load(); return onTx(() => setTimeout(load, 2500)) }, [load])

  if (!account) {
    if (!gate) return null
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-muted-foreground">Connect the wallet that holds pet #{tokenId}. The page compares your account with <code>nft_token({tokenId}).owner_id</code> read live from testnet.</p>
        <Button size="sm" onClick={() => signIn()}><WalletIcon data-icon="inline-start" />Connect wallet</Button>
      </div>
    )
  }
  if (err) return <Alert variant="destructive"><ShieldAlertIcon /><AlertTitle>Could not read pet #{tokenId}</AlertTitle><AlertDescription>{err}</AlertDescription></Alert>
  if (!pet || jar === null) return <Skeleton className="h-24" />
  if (pet.owner_id !== account) {
    if (!gate) return null
    return (
      <Alert variant="destructive">
        <ShieldAlertIcon />
        <AlertTitle>Access denied</AlertTitle>
        <AlertDescription>{account} is not the holder of {pet.name} #{tokenId} (owner: {pet.owner_id}).</AlertDescription>
      </Alert>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <Alert>
        <ShieldCheckIcon />
        <AlertTitle>Owner actions: {pet.name} #{pet.token_id}</AlertTitle>
        <AlertDescription>Your connected wallet {account} is the current NFT holder (get_pet on testnet). The contract checks this again on every owner call.</AlertDescription>
      </Alert>
      <div className="flex justify-between"><span>Brain balance</span><span className="font-mono">{near(pet.balance)} NEAR</span></div>
      <PetActions pet={pet} threshold={threshold} />
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2">
        <span className="flex items-center gap-1.5"><CoinsIcon className="size-4" />Tip jar <span className="font-mono">{fmtShitzu(jar)} SHITZU</span></span>
        <Button size="xs" disabled={jar === 0n} onClick={() => runTx(`Withdrew ${pet.name}'s tip jar`, withRegistration(account, sh?.registered, claimJarTx(pet.token_id)))}>
          Withdraw tip jar
        </Button>
      </div>
      {sh?.registered === false && jar > 0n && <p className="text-xs text-muted-foreground">Your account is not registered on the SHITZU token yet: the wallet will first send storage_deposit (0.00125 NEAR), then meme_claim_jar.</p>}
    </div>
  )
}
