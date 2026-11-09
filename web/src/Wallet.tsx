import { useCallback, useEffect, useState, type ReactNode } from "react"
import { ExternalLinkIcon, LogOutIcon, TerminalIcon, WalletIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { explorer, explorerAccount, short } from "@/lib/format"
import { viewAt } from "@/lib/rpc"
import { formatAmount, storageDepositTx, TOKEN, TOKEN_DECIMALS, type TxDesc } from "@/lib/txs"
import { initWallet, onTx, send, signIn, signOut, takeRedirectResult, txDone, useAccount } from "@/lib/wallet"

export const SHITZU_URL = "https://testnet.meme.cooking"

function txToast(label: string, hashes: string[], failed: string | null) {
  const links = (
    <span className="flex flex-wrap gap-2">
      {hashes.map((h) => (
        <a key={h} className="inline-flex items-center gap-1 underline" href={explorer(h)} target="_blank" rel="noreferrer">
          tx {short(h, 5)}<ExternalLinkIcon className="size-3" />
        </a>
      ))}
    </span>
  )
  if (failed) toast.warning(`${label}: sent, but a receipt failed`, { description: <span>{failed}. Tokens sent with ft_transfer_call are refunded by the token. {links}</span>, duration: 20000 })
  else toast.success(label, { description: links, duration: 15000 })
}

/** Sign + send with the connected wallet; toasts the NEAR Rocks link or the wallet error, then refreshes pages. */
export async function runTx(label: string, txs: TxDesc[]): Promise<boolean> {
  try {
    const r = await send(txs)
    if (!r) return false // redirected to the wallet; the result comes back in the URL
    txToast(label, r.hashes, r.failed)
    txDone()
    return !r.failed
  } catch (e) {
    toast.error(`${label} failed`, { description: (e as Error).message?.slice(0, 300) || String(e) })
    return false
  }
}

/** Restores a previous wallet session and reports a redirect-wallet result once, on page load. */
export function useWalletBoot() {
  useEffect(() => {
    initWallet().catch((e) => toast.error("Wallet selector failed to load", { description: (e as Error).message }))
    const r = takeRedirectResult()
    if (r?.error) toast.error("Wallet transaction not sent", { description: r.error })
    else if (r) { txToast("Wallet transaction sent", r.hashes, null); txDone() }
  }, [])
}

/** SHITZU balance and token registration (storage_balance_of) of the connected account. */
export function useShitzu(account: string | null) {
  const [s, setS] = useState<{ balance: bigint; registered: boolean } | null>(null)
  const load = useCallback(() => {
    if (!account) { setS(null); return }
    Promise.all([viewAt<string>(TOKEN, "ft_balance_of", { account_id: account }), viewAt<unknown>(TOKEN, "storage_balance_of", { account_id: account })])
      .then(([b, reg]) => setS({ balance: BigInt(b ?? "0"), registered: reg !== null }))
      .catch(() => setS(null))
  }, [account])
  useEffect(() => { load(); return onTx(() => setTimeout(load, 2500)) }, [load])
  return s
}

export const fmtShitzu = (v: bigint) => {
  const [w, f = ""] = formatAmount(v, TOKEN_DECIMALS).split(".")
  return `${BigInt(w).toLocaleString()}${f ? "." + f.slice(0, 2) : ""}`
}

export function WalletButton() {
  const account = useAccount()
  const sh = useShitzu(account)
  if (!account) return <Button size="sm" onClick={() => signIn().catch((e) => toast.error(e.message))}><WalletIcon data-icon="inline-start" />Connect wallet</Button>
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <a href={explorerAccount(account)} target="_blank" rel="noreferrer" className="min-w-0">
        <Badge variant="outline" className="max-w-[14rem] font-mono"><WalletIcon data-icon="inline-start" /><span className="truncate">{account}</span></Badge>
      </a>
      {sh && <Badge variant="secondary" className="font-mono">{fmtShitzu(sh.balance)} SHITZU</Badge>}
      <Button size="xs" variant="ghost" onClick={() => signOut().catch((e) => toast.error(e.message))}><LogOutIcon data-icon="inline-start" />Sign out</Button>
    </div>
  )
}

/** Shown when the connected account holds no SHITZU (NEAR actions still work). */
export function NoShitzu() {
  return (
    <p className="text-xs text-muted-foreground">
      You need testnet SHITZU to tip or bet: swap testnet NEAR for it in the "Get SHITZU" card on the Pots tab, or get it on{" "}
      <a className="underline" href={SHITZU_URL} target="_blank" rel="noreferrer">meme.cooking (testnet)</a>. Opening a book and reviving a pet only need NEAR.
    </p>
  )
}

/** CLI fallback behind a disclosure. */
export function Terminal({ children }: { children: ReactNode }) {
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="inline-flex cursor-pointer items-center gap-1 select-none"><TerminalIcon className="size-3" />Prefer a terminal?</summary>
      <div className="mt-2 flex flex-wrap items-center gap-2">{children}</div>
    </details>
  )
}

/** Payouts are ft_transfer to the caller: register them on the token first if they never were (one extra tx, 0.00125 NEAR). */
export const withRegistration = (account: string, registered: boolean | undefined, tx: TxDesc): TxDesc[] =>
  registered === false ? [storageDepositTx(account), tx] : [tx]
