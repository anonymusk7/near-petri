import { useCallback, useEffect, useState } from "react"
import { KeyRoundIcon, LockIcon, ShieldAlertIcon, ShieldCheckIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { api, near } from "@/lib/format"

type Challenge = { message: string; nonce: string; recipient: string; tokenId: string; contract: string }
type PetView = { token_id: string; name: string; owner_id: string; balance: string; pet_account: string | null; pet_key_active?: boolean }
type Result = { allowed: boolean; reason: string; pet?: PetView; pet_keys?: { public_key: string; permission: unknown }[] }

/** Owner-only view, gated to the CURRENT holder of the pet NFT by a NEP-413 signed message. */
export function OwnerPage({ tokenId }: { tokenId: string }) {
  const [ch, setCh] = useState<Challenge | null>(null)
  const [signed, setSigned] = useState("")
  const [res, setRes] = useState<Result | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => api<Challenge>(`/api/owner/challenge?token=${tokenId}`).then(setCh)
    .catch((e) => setRes({ allowed: false, reason: e.message })), [tokenId])
  const fresh = () => { setRes(null); setSigned(""); load() }
  useEffect(() => { load() }, [load])

  async function check() {
    setBusy(true)
    try {
      const s = JSON.parse(signed)
      setRes(await api<Result>("/api/owner/verify", { nonce: ch?.nonce, accountId: s.accountId, publicKey: s.publicKey, signature: s.signature }))
    } catch (e) { setRes({ allowed: false, reason: (e as Error).message }) } finally { setBusy(false) }
  }

  if (res?.allowed && res.pet) {
    const p = res.pet
    return (
      <div className="flex flex-col gap-4 p-4 text-sm">
        <Alert>
          <ShieldCheckIcon />
          <AlertTitle>Owner view: {p.name} #{p.token_id}</AlertTitle>
          <AlertDescription>{res.reason}. Checked now against nft_token on testnet.</AlertDescription>
        </Alert>
        <div className="flex justify-between"><span>Brain balance</span><span className="font-mono">{near(p.balance)} NEAR</span></div>
        <div className="flex justify-between"><span>Pet account</span><span className="font-mono">{p.pet_account ?? "none (backend-charged)"}</span></div>
        {p.pet_account && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <KeyRoundIcon className="size-4" />Charging key
              {p.pet_key_active === false
                ? <Badge variant="destructive">set by a previous owner: frozen</Badge>
                : p.pet_key_active ? <Badge>yours, active</Badge> : <Badge variant="outline">contract predates key tracking</Badge>}
            </div>
            {res.pet_keys?.map((k) => <code key={k.public_key} className="break-all text-xs">{k.public_key} {JSON.stringify(k.permission)}</code>)}
            {p.pet_key_active === false && (
              <p className="text-xs text-muted-foreground">
                Give the pet a key only you know: <code>near contract call-function as-transaction {ch?.contract} rekey_pet json-args {"'{\"token_id\":\""+p.token_id+"\",\"pet_key\":\"ed25519:…\"}'"} prepaid-gas '50 Tgas' attached-deposit '0.1 NEAR' …</code>
              </p>
            )}
          </div>
        )}
        <Button variant="outline" size="sm" className="self-start" onClick={fresh}>Sign out</Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 p-4 text-sm">
      <div className="flex items-center gap-2 font-medium"><LockIcon className="size-4" />Only the current holder of pet #{tokenId} can open this page.</div>
      <p className="text-muted-foreground">
        Sign this NEP-413 message with the wallet that holds the NFT (wallet <code>signMessage</code>, or locally for a testnet account:
        <code> node scripts/sign-owner.mjs &lt;account.testnet&gt; --challenge '&lt;json below&gt;'</code>) and paste the result.
        The server checks the signature, that the key is a full-access key of that account, and that the account is <code>nft_token({tokenId}).owner_id</code>.
      </p>
      {ch ? <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs">{JSON.stringify({ message: ch.message, nonce: ch.nonce, recipient: ch.recipient })}</pre> : <Skeleton className="h-16" />}
      <textarea className="min-h-24 rounded-lg border bg-background p-2 font-mono text-xs" placeholder='{"accountId":"you.testnet","publicKey":"ed25519:…","signature":"base64…"}'
        value={signed} onChange={(e) => setSigned(e.target.value)} />
      <div className="flex gap-2">
        <Button size="sm" disabled={!ch || !signed.trim() || busy} onClick={check}>Verify</Button>
        <Button size="sm" variant="ghost" onClick={fresh}>New challenge</Button>
      </div>
      {res && !res.allowed && (
        <Alert variant="destructive">
          <ShieldAlertIcon />
          <AlertTitle>Access denied</AlertTitle>
          <AlertDescription>{res.reason}. Request a new challenge to try again.</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
