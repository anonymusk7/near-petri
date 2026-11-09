import { useCallback, useEffect, useState } from "react"
import { BookOpenIcon, CheckIcon, CoinsIcon, CopyIcon, ExternalLinkIcon, HourglassIcon, SearchIcon, TrophyIcon, UndoIcon, WalletIcon } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { api, explorer, short } from "@/lib/format"
import { view } from "@/lib/rpc"
import { backTx, claimTx, DEPOSIT, openBookTx, parseAmount, tipTx, voidTx, WINDOWS } from "@/lib/txs"
import { onTx, signIn, useAccount } from "@/lib/wallet"
import { fmtShitzu, NoShitzu, runTx, Terminal, useShitzu, withRegistration } from "@/Wallet"
import { GetShitzu } from "@/GetShitzu"

type Config = { token: string; rake_bps: number; min_window_secs: number; max_window_secs: number; void_after_secs: number }
type Book = {
  id: string; pets: [string, string]; opened_by: string; closes_at_ns: string; totals: [string, string]
  backers: number; state: "Open" | "Settled" | "Void"; winner: string | null; arena_id: string | null; rake: string
  txs: [string, string][]
}
export type MemeState = {
  config: Config | null; token: { symbol: string; decimals: number; icon: string | null }; books: Book[]
  jars: { token_id: string; amount: string }[]; contract: string; now_ms: number; source: string; error?: string
}
type Acct = { book: string; account: string; stake: [string, string]; claimable: string }
type PetLite = { token_id: string; name: string }
type Shitzu = { balance: bigint; registered: boolean } | null
const amountOf = (v: string, decimals: number) => { try { return parseAmount(v, decimals) } catch { return 0n } }

/** Amount input + wallet button for a SHITZU ft_transfer_call (tip or back). */
function SendShitzu({ label, button, amt, setAmt, sym, decimals, sh, make }: { label: string; button: string; amt: string; setAmt: (v: string) => void; sym: string
  decimals: number; sh: Shitzu; make: () => Parameters<typeof runTx>[1] }) {
  const account = useAccount()
  const [busy, setBusy] = useState(false)
  const v = amountOf(amt, decimals)
  const over = sh !== null && v > sh.balance
  const empty = sh !== null && sh.balance === 0n
  let err: string | null = null
  try { parseAmount(amt, decimals) } catch (e) { err = (e as Error).message }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="w-28 font-mono" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} aria-label={`amount in ${sym}`} />
        <span className="text-sm text-muted-foreground">{sym}</span>
        {account
          ? <Button size="sm" disabled={busy || Boolean(err) || over || empty} onClick={async () => { setBusy(true); try { await runTx(label, make()) } finally { setBusy(false) } }}>
              <WalletIcon data-icon="inline-start" />{button}
            </Button>
          : <Button size="sm" variant="outline" onClick={() => signIn()}><WalletIcon data-icon="inline-start" />Connect wallet to {label.startsWith("Tip") ? "tip" : "back"}</Button>}
      </div>
      {err && amt.trim() && <span className="text-xs text-destructive">{err}</span>}
      {over && !empty && <span className="text-xs text-destructive">More than your {fmtShitzu(sh!.balance)} {sym}.</span>}
      {account && empty && <NoShitzu />}
    </div>
  )
}

/** The connected account's stake in a settled / void book, and the Claim button. */
function MyStake({ b, sym, name, account, sh }: { b: Book; sym: string; name: (t: string) => string; account: string; sh: Shitzu }) {
  const [r, setR] = useState<{ stake: [string, string]; claimable: string } | null>(null)
  const load = useCallback(() => {
    Promise.all([view<[string, string]>("meme_get_stake", { book_id: b.id, account_id: account }), view<string>("meme_get_claimable", { book_id: b.id, account_id: account })])
      .then(([stake, claimable]) => setR({ stake, claimable })).catch(() => setR(null))
  }, [b.id, account])
  useEffect(() => { load(); return onTx(() => setTimeout(load, 2500)) }, [load])
  if (!r) return null
  const mine = BigInt(r.stake[0]) + BigInt(r.stake[1]), claimable = BigInt(r.claimable)
  if (mine === 0n) return <p className="text-xs text-muted-foreground">{account} has no stake left in this book.</p>
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
      <span>
        Your stake: {[0, 1].filter((i) => r.stake[i] !== "0").map((i) => `${fmtShitzu(BigInt(r.stake[i]))} on ${name(b.pets[i])}`).join(", ")} ·
        claimable <span className="font-mono font-semibold">{fmtShitzu(claimable)} {sym}</span>
      </span>
      <Button size="sm" onClick={() => runTx(claimable ? `Claimed ${fmtShitzu(claimable)} ${sym} from book #${b.id}` : `Cleared your stake in book #${b.id}`,
        claimable ? withRegistration(account, sh?.registered, claimTx(b.id)) : [claimTx(b.id)])}>
        {claimable ? "Claim" : "Clear stake (nothing to pay)"}
      </Button>
    </div>
  )
}

const E18 = 10n ** 18n
/** Whole-token display of an 18-decimal amount (2 dp). */
export const tok = (y: string | bigint) => {
  const v = BigInt(y); const whole = v / E18; const frac = ((v % E18) * 100n) / E18
  return `${whole.toLocaleString()}${frac ? "." + frac.toString().padStart(2, "0").replace(/0$/, "") : ""}`
}
/** Exactly what the contract pays a winning backer: stake + stake × (losing − rake) / winning. */
export function projectedPayout(stake: bigint, mySide: 0 | 1, totals: [bigint, bigint], rakeBps: number) {
  const win = totals[mySide] + stake; const lose = totals[1 - mySide]
  if (lose === 0n) return stake // nobody on the other side: refund
  const rake = (lose * BigInt(rakeBps)) / 10000n
  return (stake * (win + lose - rake)) / win
}
const fmtLeft = (ms: number) => {
  if (ms <= 0) return "0s"
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s % 60}s`
}
function useNow(skewMs: number) {
  const [now, setNow] = useState(() => Date.now() + skewMs)
  useEffect(() => { const t = setInterval(() => setNow(Date.now() + skewMs), 500); return () => clearInterval(t) }, [skewMs])
  return now
}
function Copy({ text, label }: { text: string; label: string }) {
  const [ok, setOk] = useState(false)
  return (
    <Button size="xs" variant="outline" onClick={() => navigator.clipboard.writeText(text).then(() => { setOk(true); toast.success(`${label} copied`); setTimeout(() => setOk(false), 1500) })}>
      {ok ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}{label}
    </Button>
  )
}

function Phase({ b, now, cfg }: { b: Book; now: number; cfg: Config }) {
  const close = Number(BigInt(b.closes_at_ns) / 1_000_000n), voidAt = close + cfg.void_after_secs * 1000
  if (b.state === "Settled") return <Badge><TrophyIcon data-icon="inline-start" />Settled by arena #{b.arena_id}</Badge>
  if (b.state === "Void") return <Badge variant="secondary"><UndoIcon data-icon="inline-start" />Void: stakes refundable</Badge>
  if (now < close) return <Badge variant="outline" className="font-mono tabular-nums"><HourglassIcon data-icon="inline-start" />staking closes in {fmtLeft(close - now)}</Badge>
  if (now < voidAt) return <Badge variant="outline" className="font-mono tabular-nums">closed · awaiting arena · voidable in {fmtLeft(voidAt - now)}</Badge>
  return <Badge variant="destructive">no arena round in time: anyone can void</Badge>
}

function BookCard({ b, cfg, pets, now, sym, contract, decimals, sh }: { b: Book; cfg: Config; pets: PetLite[]; now: number; sym: string; contract: string; decimals: number; sh: Shitzu }) {
  const account = useAccount()
  const name = (t: string) => pets.find((p) => p.token_id === t)?.name ?? `#${t}`
  const totals: [bigint, bigint] = [BigInt(b.totals[0]), BigInt(b.totals[1])]
  const sum = totals[0] + totals[1]
  const share = sum ? Number((totals[0] * 1000n) / sum) / 10 : 50
  const close = Number(BigInt(b.closes_at_ns) / 1_000_000n)
  const open = b.state === "Open" && now < close
  const [side, setSide] = useState<0 | 1>(0)
  const [amt, setAmt] = useState("100")
  const stake = amountOf(amt, decimals)
  const payout = projectedPayout(stake, side, totals, cfg.rake_bps)
  const msg = JSON.stringify({ action: "back", book_id: b.id, token_id: b.pets[side] })
  const cmd = `near contract call-function as-transaction ${cfg.token} ft_transfer_call json-args '${JSON.stringify({ receiver_id: contract, amount: stake.toString(), msg })}' prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as <your-account>.testnet network-config testnet sign-with-keychain send`
  const claimCmd = `near contract call-function as-transaction ${contract} meme_claim json-args '{"book_id":"${b.id}"}' prepaid-gas '50 Tgas' attached-deposit '0 NEAR' sign-as <your-account>.testnet network-config testnet sign-with-keychain send`
  const voidCmd = `near contract call-function as-transaction ${contract} meme_void_book json-args '{"book_id":"${b.id}"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as <your-account>.testnet network-config testnet sign-with-keychain send`
  const voidable = b.state === "Open" && now >= close + cfg.void_after_secs * 1000

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Book #{b.id}: {name(b.pets[0])} vs {name(b.pets[1])}</CardTitle>
          <Phase b={b} now={now} cfg={cfg} />
        </div>
        <CardDescription>Opened by {short(b.opened_by, 8)} · {now >= close || b.state !== "Open" ? "closed" : "closes"} {new Date(close).toLocaleString()} · {b.backers} backer{b.backers === 1 ? "" : "s"}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <div className="flex justify-between text-sm font-medium">
            {[0, 1].map((i) => (
              <span key={i} className={cn("flex items-center gap-1", b.winner === b.pets[i] && "text-primary")}>
                {b.winner === b.pets[i] && <TrophyIcon className="size-3.5" />}{name(b.pets[i])}: <span className="font-mono">{tok(totals[i])} {sym}</span>
              </span>
            ))}
          </div>
          <div className="flex h-3 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${share.toFixed(1)}% on ${name(b.pets[0])}`}>
            <div className={cn("bg-primary transition-all", b.winner && b.winner !== b.pets[0] && "opacity-30")} style={{ width: `${share}%` }} />
            <div className={cn("flex-1 bg-amber-500 transition-all", b.winner && b.winner !== b.pets[1] && "opacity-30")} />
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{share.toFixed(1)}%</span><span>pot {tok(sum)} {sym}</span><span>{(100 - share).toFixed(1)}%</span>
          </div>
        </div>

        {b.state === "Settled" && (
          <Alert>
            <TrophyIcon />
            <AlertTitle>{name(b.winner!)} won arena #{b.arena_id}</AlertTitle>
            <AlertDescription>
              {tok(b.rake)} {sym} rake ({cfg.rake_bps / 100}% of the losing side) went to {name(b.winner!)}'s jar. Every {name(b.winner!)} backer gets
              stake × {tok(sum - BigInt(b.rake))} / {tok(totals[b.pets.indexOf(b.winner!)])}. Look up your payout below.
            </AlertDescription>
          </Alert>
        )}

        {open && (
          <div className="flex flex-col gap-2 rounded-lg border p-3">
            <div className="text-sm font-medium">Back a pet</div>
            <div className="flex flex-wrap items-center gap-2">
              {[0, 1].map((i) => (
                <Button key={i} size="sm" variant={side === i ? "default" : "outline"} onClick={() => setSide(i as 0 | 1)}>{name(b.pets[i])}</Button>
              ))}
            </div>
            <div className="text-sm">
              If {name(b.pets[side])} wins at today's totals you get <span className="font-mono font-semibold">{tok(payout)} {sym}</span>
              {stake > 0n && <span className="text-muted-foreground"> ({(Number((payout * 1000n) / stake) / 1000).toFixed(2)}×)</span>}. If it loses you get 0; if nobody backs the other side, or no arena round comes, you are refunded.
            </div>
            <SendShitzu label={`Backed ${name(b.pets[side])}`} button={`Back ${name(b.pets[side])} with wallet`} amt={amt} setAmt={setAmt} sym={sym} decimals={decimals} sh={sh}
              make={() => [backTx(b.id, b.pets[side], amt, decimals)]} />
            <p className="text-xs text-muted-foreground">Your wallet signs ft_transfer_call on the {sym} token (1 yoctoNEAR, 100 Tgas); this page never holds keys. A stake that arrives after the close is refunded by the token.</p>
            <Terminal>Stake with your own testnet key: <Copy text={cmd} label="Copy CLI command" /></Terminal>
          </div>
        )}
        {voidable && (
          <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              No arena round came in time. Anyone may void this book so every backer gets their stake back:
              <Button size="sm" variant="outline" onClick={() => account ? runTx(`Voided book #${b.id}`, [voidTx(b.id)]) : signIn()}>
                <UndoIcon data-icon="inline-start" />{account ? "Void book" : "Connect wallet to void"}
              </Button>
            </div>
            <Terminal><Copy text={voidCmd} label="Copy void command" /></Terminal>
          </div>
        )}
        {b.state !== "Open" && account && <MyStake b={b} sym={sym} name={name} account={account} sh={sh} />}
        {b.state !== "Open" && <Terminal>Backers withdraw with <Copy text={claimCmd} label="Copy claim command" /></Terminal>}

        {b.txs.length > 0 && (
          <>
            <Separator />
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
              {b.txs.map(([l, h]) => (
                <a key={h} className="inline-flex items-center gap-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" href={explorer(h)} target="_blank" rel="noreferrer">
                  {l} {short(h, 4)}<ExternalLinkIcon className="size-3" />
                </a>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function Lookup({ books, sym, pets }: { books: Book[]; sym: string; pets: PetLite[] }) {
  const [acct, setAcct] = useState("")
  const [book, setBook] = useState(books[0]?.id ?? "0")
  const [r, setR] = useState<Acct | null>(null)
  const [busy, setBusy] = useState(false)
  const b = books.find((x) => x.id === book)
  async function go() {
    setBusy(true)
    try { setR(await api<Acct>(`/api/meme/account?book=${book}&account=${encodeURIComponent(acct.trim())}`)) }
    catch (e) { toast.error((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Card size="sm">
      <CardHeader><CardTitle className="flex items-center gap-2"><SearchIcon className="size-4" />Your stake and payout</CardTitle>
        <CardDescription>Read live from the contract. A stake reads 0 once it has been claimed.</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-2">
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); go() }}>
          <Input className="min-w-48 flex-1 font-mono" placeholder="you.testnet" value={acct} onChange={(e) => setAcct(e.target.value)} />
          <select className="rounded-md border bg-background px-2 text-sm" value={book} onChange={(e) => setBook(e.target.value)} aria-label="book">
            {books.map((x) => <option key={x.id} value={x.id}>Book #{x.id}</option>)}
          </select>
          <Button type="submit" size="sm" disabled={busy || !acct.trim()}>Check</Button>
        </form>
        {r && b && (
          <div className="grid grid-cols-3 gap-2 text-sm">
            {[0, 1].map((i) => <div key={i}><div className="text-xs text-muted-foreground">on {pets.find((p) => p.token_id === b.pets[i])?.name}</div><div className="font-mono">{tok(r.stake[i])}</div></div>)}
            <div><div className="text-xs text-muted-foreground">claimable now</div><div className="font-mono font-semibold">{tok(r.claimable)} {sym}</div></div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** Memecoin pots: SHITZU tip jars per pet and prediction books on the next arena round. */
export function MemePage({ pets }: { pets: PetLite[] }) {
  const [m, setM] = useState<MemeState | null>(null)
  const [skew, setSkew] = useState(0)
  const load = useCallback(() => api<MemeState>("/api/meme").then((r) => { setM(r); setSkew(r.now_ms - Date.now()) }).catch((e) => toast.error(e.message)), [])
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t) }, [load])
  useEffect(() => onTx(() => { setTimeout(load, 2500); setTimeout(load, 7000) }), [load])
  const account = useAccount()
  const sh = useShitzu(account)
  const [tipAmt, setTipAmt] = useState<Record<string, string>>({})
  const [win, setWin] = useState(3600)
  const now = useNow(skew)
  if (!m) return <div className="grid gap-4 md:grid-cols-2"><Skeleton className="h-64" /><Skeleton className="h-64" /></div>
  if (!m.config) return <Alert><AlertTitle>Memecoin pots are not initialised on {m.contract}</AlertTitle></Alert>
  const cfg = m.config, sym = m.token.symbol
  const tipCmd = (t: string) => `near contract call-function as-transaction ${cfg.token} ft_transfer_call json-args '${JSON.stringify({ receiver_id: m.contract, amount: "10" + "0".repeat(18), msg: JSON.stringify({ action: "tip", token_id: t }) })}' prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as <your-account>.testnet network-config testnet sign-with-keychain send`
  const decimals = m.token.decimals ?? 18
  const openCmd = `near contract call-function as-transaction ${m.contract} meme_open_book json-args '{"pet_a":"0","pet_b":"1","window_secs":${win}}' prepaid-gas '30 Tgas' attached-deposit '0.01 NEAR' sign-as <your-account>.testnet network-config testnet sign-with-keychain send`
  const hasOpen = m.books.some((b) => b.state === "Open")

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-3">
            {m.token.icon ? <img src={m.token.icon} alt="" className="size-10 rounded-full" /> : <CoinsIcon className="size-8" />}
            <div className="flex flex-col gap-0.5">
              <CardTitle>Memecoin pots · {sym}</CardTitle>
              <CardDescription>Tip pets in Shitzu's real testnet {sym}, and back a pet before its next arena round. Winners' backers split the pot.</CardDescription>
            </div>
            <div className="ml-auto flex flex-wrap gap-1.5">
              <Badge variant="outline" className="font-mono">{short(cfg.token, 10)}</Badge>
              {m.source === "snapshot" && <Badge variant="destructive">offline snapshot</Badge>}
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-4">
          {[["Rake to winning pet", `${cfg.rake_bps / 100}% of losers`], ["Staking window", `${fmtLeft(cfg.min_window_secs * 1000)} – ${fmtLeft(cfg.max_window_secs * 1000)}`],
            ["Void if no round", `${fmtLeft(cfg.void_after_secs * 1000)} after close`], ["Rules", "set once, immutable"]].map(([k, v]) => (
            <div key={k} className="rounded-lg border p-3"><div className="text-xs text-muted-foreground">{k}</div><div className="font-medium">{v}</div></div>
          ))}
        </CardContent>
        <CardFooter className="text-xs text-muted-foreground">
          Fair by construction: a book only settles if both arena replies were TEE-signed and charged after it closed, so nobody can bet on an answer they have already seen.
        </CardFooter>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        {m.jars.map((j) => {
          const p = pets.find((x) => x.token_id === j.token_id)
          return (
            <Card size="sm" key={j.token_id}>
              <CardHeader><CardTitle>{p?.name ?? `#${j.token_id}`}'s jar</CardTitle>
                <CardDescription>Tips plus rake from won books. Only the pet's current NFT owner can withdraw it (meme_claim_jar, on the Owner tab).</CardDescription></CardHeader>
              <CardContent className="flex flex-col gap-3">
                <span className="font-mono text-2xl font-semibold">{tok(j.amount)} <span className="text-sm text-muted-foreground">{sym}</span></span>
                <SendShitzu label={`Tipped ${p?.name ?? `#${j.token_id}`}`} button="Tip with wallet" amt={tipAmt[j.token_id] ?? "10"} setAmt={(v) => setTipAmt((t) => ({ ...t, [j.token_id]: v }))}
                  sym={sym} decimals={decimals} sh={sh} make={() => [tipTx(j.token_id, tipAmt[j.token_id] ?? "10", decimals)]} />
                <Terminal><Copy text={tipCmd(j.token_id)} label={`Copy tip command (10 ${sym})`} /></Terminal>
              </CardContent>
            </Card>
          )
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="flex flex-col gap-4">
          {m.books.length === 0 && <Alert><AlertTitle>No books yet</AlertTitle></Alert>}
          {m.books.map((b) => <BookCard key={b.id} b={b} cfg={cfg} pets={pets} now={now} sym={sym} contract={m.contract} decimals={decimals} sh={sh} />)}
        </div>
        <aside className="flex flex-col gap-4">
          <GetShitzu />
          <Lookup books={m.books} sym={sym} pets={pets} />
          {!hasOpen && (
            <Card size="sm">
              <CardHeader><CardTitle>Open a book: {pets.find((p) => p.token_id === "0")?.name ?? "#0"} vs {pets.find((p) => p.token_id === "1")?.name ?? "#1"}</CardTitle>
                <CardDescription>
                  No book is open for this pair. Anyone can open one (only NEAR needed, no {sym}). The wallet attaches {Number(BigInt(DEPOSIT.OPEN_BOOK) / 10n ** 18n) / 1e6} NEAR;
                  the contract keeps the storage cost (0.00162 NEAR for book #1) and refunds the rest in the same transaction.
                </CardDescription></CardHeader>
              <CardContent className="flex flex-wrap items-center gap-2">
                <select className="h-8 rounded-md border bg-background px-2 text-sm" value={win} onChange={(e) => setWin(Number(e.target.value))} aria-label="staking window">
                  {WINDOWS.filter((w: { secs: number }) => w.secs >= cfg.min_window_secs && w.secs <= cfg.max_window_secs).map((w: { label: string; secs: number }) =>
                    <option key={w.secs} value={w.secs}>staking window {w.label}</option>)}
                </select>
                <Button size="sm" onClick={() => account ? runTx(`Opened a book (${fmtLeft(win * 1000)} window)`, [openBookTx("0", "1", win)]) : signIn()}>
                  <BookOpenIcon data-icon="inline-start" />{account ? "Open a book" : "Connect wallet to open"}
                </Button>
              </CardContent>
              <CardFooter><Terminal><Copy text={openCmd} label="Copy open-book command" /></Terminal></CardFooter>
            </Card>
          )}
          <Card size="sm">
            <CardHeader><CardTitle>How payouts work</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-1.5 text-xs text-muted-foreground">
              <p>1. Back a pet with ft_transfer_call before the countdown ends.</p>
              <p>2. The next arena round between the two pets settles the book automatically.</p>
              <p>3. {cfg.rake_bps / 100}% of the losing side goes to the winning pet's jar; winning backers split everything else pro-rata, rounded down.</p>
              <p>4. One side empty, or no round within {fmtLeft(cfg.void_after_secs * 1000)}: everyone gets their stake back.</p>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  )
}
