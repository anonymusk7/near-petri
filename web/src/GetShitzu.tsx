import { useEffect, useRef, useState } from "react"
import { ArrowRightLeftIcon, WalletIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { rpc, viewAt } from "@/lib/rpc"
import { DEPOSIT, formatAmount, minOutFromQuote, NEAR_DECIMALS, parseNear, REF, REF_POOL, refQuoteArgs, swapMsg, swapNearForShitzuTxs, TOKEN,
  WRAP, WRAP_STORAGE } from "@/lib/txs"
import { onTx, signIn, useAccount } from "@/lib/wallet"
import { fmtShitzu, runTx, Terminal, useShitzu } from "@/Wallet"

// prepaid gas the wallet must be able to cover up front (270 Tgas at 0.1 Gyocto/gas); the unused part is refunded
const GAS_RESERVE = 30_000_000_000_000_000_000_000n // 0.03 NEAR
const fmtNear = (y: bigint) => { const [w, f = ""] = formatAmount(y, NEAR_DECIMALS).split("."); return `${w}${f ? "." + f.slice(0, 4) : ""}` }

/** wrap.testnet registration + storage_balance_bounds, and the account's spendable NEAR (amount minus storage stake). */
function useSwapAccount(account: string | null) {
  const [s, setS] = useState<{ account: string; wrapRegistered: boolean; wrapStorage: string; near: bigint } | null>(null)
  useEffect(() => {
    if (!account) return
    const load = () => Promise.all([
      viewAt<unknown>(WRAP, "storage_balance_of", { account_id: account }),
      viewAt<{ min: string }>(WRAP, "storage_balance_bounds").then((b) => b.min).catch(() => WRAP_STORAGE),
      rpc<{ amount: string; storage_usage: number }>({ request_type: "view_account", finality: "final", account_id: account }),
    ]).then(([reg, min, a]) => setS({ account, wrapRegistered: reg !== null, wrapStorage: min,
      near: BigInt(a.amount) - BigInt(a.storage_usage) * 10n ** 19n }))
      .catch(() => setS((p) => (p?.account === account ? null : p)))
    load()
    return onTx(() => setTimeout(load, 2500))
  }, [account])
  return s && s.account === account ? s : null
}

/** Live Ref quote for `nearHuman` wNEAR -> SHITZU (debounced); null while loading or when the view fails. */
function useQuote(nearHuman: string) {
  const [q, setQ] = useState<{ amt: string; out: string | null } | null>(null)
  const seq = useRef(0)
  useEffect(() => {
    let args: ReturnType<typeof refQuoteArgs>
    try { args = refQuoteArgs(nearHuman) } catch { return }
    const n = ++seq.current
    const t = setTimeout(() => viewAt<string>(REF, "get_return", args)
      .then((out) => n === seq.current && setQ({ amt: nearHuman, out: String(out) }))
      .catch(() => n === seq.current && setQ({ amt: nearHuman, out: null })), 350)
    return () => clearTimeout(t)
  }, [nearHuman])
  return q?.amt === nearHuman ? q : null
}

/** "Get SHITZU": wrap testnet NEAR and swap it on Ref Finance (pool 2190) so a judge with only NEAR can tip and bet. */
export function GetShitzu() {
  const account = useAccount()
  const sh = useShitzu(account)
  const acc = useSwapAccount(account)
  const [amt, setAmt] = useState("0.1")
  const [busy, setBusy] = useState(false)
  const [before, setBefore] = useState<bigint | null>(null)
  const quote = useQuote(amt)
  let err: string | null = null, yocto = 0n
  try { yocto = BigInt(parseNear(amt)) } catch (e) { err = (e as Error).message }
  const minOut = minOutFromQuote(quote?.out)
  const needsWrap = acc ? !acc.wrapRegistered : false, needsShitzu = sh ? !sh.registered : false
  const need = yocto + (needsWrap ? BigInt(acc!.wrapStorage) : 0n) + (needsShitzu ? BigInt(DEPOSIT.STORAGE) : 0n) + GAS_RESERVE
  const short = acc !== null && !err && need > acc.near
  const txs = () => swapNearForShitzuTxs({ account: account!, nearHuman: amt, needsWrapStorage: needsWrap, needsShitzuStorage: needsShitzu,
    wrapStorage: acc?.wrapStorage ?? WRAP_STORAGE, minOut })
  const gained = before !== null && sh && sh.balance > before ? sh.balance - before : null

  const cli = (method: string, receiver: string, args: object, gas: string, dep: string) =>
    `near contract call-function as-transaction ${receiver} ${method} json-args '${JSON.stringify(args)}' prepaid-gas '${gas}' attached-deposit '${dep}' sign-as <your-account>.testnet network-config testnet sign-with-keychain send`
  const nearAmt = err ? "100000000000000000000000" : yocto.toString()
  const cmds = [
    cli("storage_deposit", TOKEN, { account_id: "<your-account>.testnet", registration_only: true }, "30 Tgas", "0.00125 NEAR"),
    cli("near_deposit", WRAP, {}, "10 Tgas", `${err ? "0.1" : amt.trim()} NEAR`),
    cli("ft_transfer_call", WRAP, { receiver_id: REF, amount: nearAmt, msg: swapMsg(minOut) }, "250 Tgas", "1 yoctoNEAR"),
  ]

  return (
    <Card size="sm" data-testid="get-shitzu">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ArrowRightLeftIcon className="size-4" />Get SHITZU</CardTitle>
        <CardDescription>Only have testnet NEAR? Swap it for SHITZU on Ref Finance testnet (pool {REF_POOL}, wNEAR/SHITZU), then tip or back a pet.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Input className="w-24 font-mono" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} aria-label="NEAR to swap" />
          <span className="text-muted-foreground">NEAR</span>
          <span className="font-mono" aria-live="polite">
            {err ? "" : quote === null ? "≈ …" : quote.out === null ? "no quote" : `≈ ${fmtShitzu(BigInt(quote.out))} SHITZU`}
          </span>
        </div>
        {err && amt.trim() && <span className="text-xs text-destructive">{err}</span>}
        {account
          ? <Button size="sm" className="self-start" disabled={busy || Boolean(err) || short || !acc || !sh}
              onClick={async () => { setBusy(true); setBefore(sh?.balance ?? null); try { await runTx(`Swapped ${amt.trim()} NEAR for SHITZU`, txs()) } finally { setBusy(false) } }}>
              <ArrowRightLeftIcon data-icon="inline-start" />Swap on Ref (testnet)
            </Button>
          : <Button size="sm" variant="outline" className="self-start" onClick={() => signIn()}><WalletIcon data-icon="inline-start" />Connect wallet to swap</Button>}
        {short && <span className="text-xs text-destructive">Needs about {fmtNear(need)} NEAR available (amount, registrations and up to 0.03 NEAR prepaid gas, mostly refunded); you have {fmtNear(acc!.near)}.</span>}
        {sh && <span className="text-xs text-muted-foreground">Your balance: <span className="font-mono">{fmtShitzu(sh.balance)} SHITZU</span>{gained !== null && <span className="text-foreground"> (+{fmtShitzu(gained)} from the swap)</span>}</span>}
        {account && (needsWrap || needsShitzu) && <span className="text-xs text-muted-foreground">
          First swap also registers you on {[needsShitzu && "SHITZU", needsWrap && "wrap.testnet"].filter(Boolean).join(" and ")} (0.00125 NEAR each).</span>}
        <p className="text-xs text-muted-foreground">
          Slippage: the swap asks for at least 95% of the live quote ({quote?.out ? `${fmtShitzu(BigInt(minOut))} SHITZU` : "no quote: any amount"}). If the pool moves more than that,
          Ref rejects it and your NEAR stays in wrap.testnet as wNEAR. {needsShitzu ? "Two transactions" : "One transaction"}: wrap + swap go to wrap.testnet together (near_deposit, then ft_transfer_call to {REF}).
        </p>
      </CardContent>
      <CardFooter>
        <Terminal>
          <span>Register on SHITZU once, wrap, then swap:</span>
          {cmds.map((c, i) => <code key={i} className="block w-full overflow-x-auto rounded border bg-muted p-1.5 font-mono text-[11px] whitespace-pre">{c}</code>)}
        </Terminal>
      </CardFooter>
    </Card>
  )
}
