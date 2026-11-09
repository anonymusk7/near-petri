import { useCallback, useEffect, useRef, useState } from "react"
import {
  BadgeCheckIcon, BatteryLowIcon, ExternalLinkIcon, KeyRoundIcon, MoonIcon, SendIcon,
  ShieldCheckIcon, SparklesIcon, SunIcon, WalletIcon, TrophyIcon, CoinsIcon, TriangleAlertIcon } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Toaster } from "@/components/ui/sonner"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { api, explorer, near, short, when } from "@/lib/format"
import { PetHistory } from "@/PetHistory"
import { OwnerPage } from "@/OwnerPage"
import { MemePage } from "@/MemePage"

type Perm = { FunctionCall?: { allowance: string | null; receiver_id: string; method_names: string[] } } | string
type Pet = {
  token_id: string; name: string; owner_id: string; balance: string; replies: number; asleep: boolean
  prompt_hash: string; pet_account: string | null; account_balance?: string
  keys?: { public_key: string; permission: Perm }[]; sim_balance: string; sim_asleep: boolean
  // sim_woke: asleep on testnet, woken by the local Revive. sleep_reason explains sim_asleep.
  sim_woke?: boolean; sleep_reason?: SleepReason | null; chain_sleep_reason?: SleepReason | null; last_fed_ns?: string
  arena_wins?: number; tip?: { chain: string; address: string; signed_tx?: string }
}
type SleepReason = "hunger" | "balance" | "sim"
type Arena = { id: number; challenge: string; question: string; rule: string; winner: string; tx: string | null
  entries: { token_id: string; response: string; chars: number; has_word: boolean }[] }
type State = { contract: string; network: string; source: string; signers: { model: string; address: string }[]; pets: Pet[]; sleep_threshold: string
  hunger_ns?: string
  arena?: Arena[]; tip_quote?: { amountIn: string; amountOut: string; recipient: string } | null }
type Verified = {
  id: string; msg: string; reply: string; cost: string; chat_id: string; model: string; signer: string; tx: string
  local: { ok: boolean; passed: number; total: number; checks: { name: string; ok: boolean }[] }
  onchain: { ok: boolean; signer?: string; error?: string }; legacy?: string | null
}
type Msg =
  | { kind: "user"; text: string }
  | { kind: "verified"; r: Verified }
  | { kind: "mock"; text: string; cost: string }

const FULL = 5n * 10n ** 23n // 0.5 NEAR = a full belly in the UI
const hours = (ns?: string) => String(Number(BigInt(ns ?? 86_400_000_000_000n) / 3_600_000_000_000n))

function PetFace({ pet, className }: { pet: Pet; className?: string }) {
  const sleeping = pet.sim_asleep
  return (
    <Avatar className={cn("size-14", sleeping && "grayscale", className)}>
      <AvatarFallback className="text-2xl">{sleeping ? "💤" : pet.token_id === "0" ? "🌿" : "🍀"}</AvatarFallback>
    </Avatar>
  )
}

function PetCard({ pet, selected, onSelect, contract }: { pet: Pet; selected: boolean; onSelect: () => void; contract: string }) {
  const bal = BigInt(pet.sim_balance)
  const pct = Number((bal * 100n) / FULL)
  const fc = pet.keys?.[0]?.permission
  const onlyCharge = pet.keys?.length === 1 && typeof fc === "object" && fc.FunctionCall?.receiver_id === contract
    && fc.FunctionCall.method_names.join() === "charge_verified"
  return (
    <Card size="sm" className={cn("cursor-pointer transition", selected && "ring-2 ring-primary")} onClick={onSelect}>
      <CardHeader>
        <div className="flex items-center gap-3">
          <PetFace pet={pet} />
          <div className="flex min-w-0 flex-col gap-1">
            <CardTitle>{pet.name} <span className="text-muted-foreground">#{pet.token_id}</span></CardTitle>
            <CardDescription className="truncate">owner {pet.owner_id}</CardDescription>
            <div>
          <div className="flex flex-wrap gap-1">
          {pet.sim_asleep
            ? <Badge variant="secondary"><MoonIcon data-icon="inline-start" />Asleep</Badge>
            : <Badge><SunIcon data-icon="inline-start" />{pet.sim_woke ? "Awake (local sim)" : "Awake"}</Badge>}
          {pet.asleep && <Badge variant="outline"><MoonIcon data-icon="inline-start" />asleep on testnet</Badge>}
          </div>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Brain balance</span>
            <span className="font-mono">{near(bal)} NEAR</span>
          </div>
          <Progress value={Math.min(100, pct)} />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline"><BadgeCheckIcon data-icon="inline-start" />{pet.replies} verified replies</Badge>
          {pet.pet_account
            ? (
              <Tooltip>
                <TooltipTrigger render={<Badge variant="outline" />}>
                  <WalletIcon data-icon="inline-start" />own account
                </TooltipTrigger>
                <TooltipContent>
                  {pet.pet_account} holds {near(pet.account_balance ?? "0")} NEAR and pays its own gas.
                  {onlyCharge ? " Its only key can call nothing but charge_verified." : ""}
                </TooltipContent>
              </Tooltip>
            )
            : <Badge variant="ghost">backend-charged (v1 pet)</Badge>}
          {onlyCharge && <Badge variant="outline"><KeyRoundIcon data-icon="inline-start" />key: charge_verified only</Badge>}
          {(pet.arena_wins ?? 0) > 0 && <Badge variant="outline"><TrophyIcon data-icon="inline-start" />{pet.arena_wins} arena win{pet.arena_wins === 1 ? "" : "s"}</Badge>}
        </div>
        {pet.tip && (
          <div className="flex items-center justify-between gap-2 text-xs">
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex items-center gap-1 text-muted-foreground" />}>
                <CoinsIcon className="size-3" />tip from any chain
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                {pet.tip.chain} address derived by NEAR Chain Signatures from the Petri contract + path pet-{pet.token_id}. Only the pet NFT owner can ask the MPC network to sign for it.
                {pet.tip.signed_tx ? ` Real MPC signature: tx ${short(pet.tip.signed_tx, 5)}.` : ""}
              </TooltipContent>
            </Tooltip>
            <span className="font-mono">{short(pet.tip.address, 6)}</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function VerifiedReply({ r, petName }: { r: Verified; petName: string }) {
  const both = r.local.ok && r.onchain.ok
  return (
    <div className="flex max-w-[85%] flex-col gap-1.5 self-start">
      <div className="rounded-2xl rounded-bl-sm bg-muted px-4 py-2.5 text-sm">{r.reply}</div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <Tooltip>
          <TooltipTrigger render={<Badge variant={both ? "default" : "destructive"} />}>
            <ShieldCheckIcon data-icon="inline-start" />{both ? "TEE-verified" : "verification failed"}
          </TooltipTrigger>
          <TooltipContent className="max-w-sm">
            <div className="flex flex-col gap-1">
              <span>Local: {r.local.passed}/{r.local.total} checks (Intel TDX quote, NVIDIA GPU attestation, ECDSA signature, exact bytes)</span>
              <span>On-chain: {r.onchain.ok ? `contract ecrecovered ${short(r.signer)} and stored the proof` : r.onchain.error}</span>
              <span>Model {r.model}</span>
            </div>
          </TooltipContent>
        </Tooltip>
        {r.legacy && (
          <Tooltip>
            <TooltipTrigger render={<Badge variant="secondary" />}><TriangleAlertIcon data-icon="inline-start" />legacy v2 receipt</TooltipTrigger>
            <TooltipContent className="max-w-xs">{r.legacy}</TooltipContent>
          </Tooltip>
        )}
        <span>{petName} paid {near(r.cost)} NEAR</span>
        <a className="inline-flex items-center gap-1 underline-offset-4 hover:underline" href={explorer(r.tx)} target="_blank" rel="noreferrer">
          tx {short(r.tx, 5)}<ExternalLinkIcon className="size-3" />
        </a>
      </div>
    </div>
  )
}

export function App() {
  const [st, setSt] = useState<State | null>(null)
  const [sel, setSel] = useState("1")
  const [page, setPage] = useState<"pets" | "meme">(() => (location.hash === "#pots" ? "meme" : "pets"))
  const go = (p: "pets" | "meme") => { setPage(p); history.replaceState(null, "", p === "meme" ? "#pots" : "#") }
  const [msgs, setMsgs] = useState<Record<string, Msg[]>>({})
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<"chat" | "history" | "owner">("chat")
  const bottom = useRef<HTMLDivElement>(null)

  const refresh = useCallback(() => api<State>("/api/state").then(setSt).catch((e) => toast.error(e.message)), [])
  useEffect(() => { refresh() }, [refresh])
  useEffect(() => {
    if (msgs[sel]) return
    api<Verified[]>(`/api/replies?token=${sel}`).then((rs) => setMsgs((m) => ({
      ...m, [sel]: rs.flatMap((r): Msg[] => [{ kind: "user", text: r.msg }, { kind: "verified", r }]),
    }))).catch((e) => toast.error(e.message))
  }, [sel, msgs])
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }) }, [msgs, sel])

  const pet = st?.pets.find((p) => p.token_id === sel)
  const thread = msgs[sel]

  async function send() {
    if (!pet || !text.trim()) return
    const t = text.trim()
    setText(""); setBusy(true)
    setMsgs((m) => ({ ...m, [sel]: [...(m[sel] ?? []), { kind: "user", text: t }] }))
    try {
      const r = await api<{ reply: string; cost: string }>("/api/chat", { token_id: sel, msg: t })
      setMsgs((m) => ({ ...m, [sel]: [...(m[sel] ?? []), { kind: "mock", text: r.reply, cost: r.cost }] }))
      await refresh()
    } catch (e) { toast.error((e as Error).message) } finally { setBusy(false) }
  }
  async function sim(action: "drain" | "revive" | "reset") {
    try { setSt(await api<State>("/api/sim", { token_id: sel, action })) } catch (e) { toast.error((e as Error).message) }
  }

  return (
    <TooltipProvider>
      <div className="mx-auto flex min-h-svh max-w-6xl flex-col gap-6 p-4 md:p-8">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="text-3xl">🧫</span>
            <div>
              <h1 className="font-heading text-xl font-semibold">Petri</h1>
              <p className="text-sm text-muted-foreground">AI pets that pay for their own brain. Every thought is TEE-signed and checked on-chain.</p>
            </div>
          </div>
          <nav className="flex gap-1 rounded-lg border p-1" aria-label="section">
            <Button size="sm" variant={page === "pets" ? "default" : "ghost"} onClick={() => go("pets")}>Pets</Button>
            <Button size="sm" variant={page === "meme" ? "default" : "ghost"} onClick={() => go("meme")}><CoinsIcon data-icon="inline-start" />Memecoin pots</Button>
          </nav>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="outline">NEAR {st?.network ?? "…"}</Badge>
            {st && <Badge variant="outline" className="font-mono">{st.contract}</Badge>}
            {st?.source === "snapshot" && <Badge variant="destructive">offline snapshot</Badge>}
            {st?.signers[0] && (
              <Tooltip>
                <TooltipTrigger render={<Badge variant="secondary" />}><ShieldCheckIcon data-icon="inline-start" />TEE signer {short(st.signers[0].address)}</TooltipTrigger>
                <TooltipContent>Registered for {st.signers[0].model} after verifying its Intel TDX + NVIDIA attestation (`pnpm preflight`).</TooltipContent>
              </Tooltip>
            )}
          </div>
        </header>

        {page === "meme" && <MemePage pets={st?.pets ?? []} />}
        <div className={cn("grid gap-6 md:grid-cols-[340px_1fr]", page !== "pets" && "hidden")}>
          <aside className="flex flex-col gap-4">
            {!st && <><Skeleton className="h-48" /><Skeleton className="h-48" /></>}
            {st?.pets.map((p) => <PetCard key={p.token_id} pet={p} contract={st.contract} selected={p.token_id === sel} onSelect={() => setSel(p.token_id)} />)}
            {st?.arena?.map((a) => (
              <Card size="sm" key={a.id}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><TrophyIcon className="size-4" />Arena #{a.id}: “{a.challenge}”</CardTitle>
                  <CardDescription>{a.question}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-2 text-xs">
                  {a.entries.map((e) => {
                    const p = st.pets.find((x) => x.token_id === e.token_id)
                    return (
                      <div key={e.token_id} className={cn("rounded-lg border p-2", e.token_id === a.winner && "border-primary")}>
                        <div className="mb-1 flex justify-between font-medium"><span>{p?.name ?? `#${e.token_id}`}{e.token_id === a.winner ? " 🏆" : ""}</span>
                          <span className="font-mono text-muted-foreground">{e.has_word ? "word ✓" : "word ✗"} · {e.chars} chars</span></div>
                        <div className="text-muted-foreground">{e.response}</div>
                      </div>
                    )
                  })}
                  <div className="text-muted-foreground">Rule (enforced by the contract on TEE-signed bytes): {a.rule}</div>
                  {a.tx && <a className="inline-flex items-center gap-1 underline-offset-4 hover:underline" href={explorer(a.tx)} target="_blank" rel="noreferrer">settled tx {short(a.tx, 5)}<ExternalLinkIcon className="size-3" /></a>}
                </CardContent>
              </Card>
            ))}
            <Card size="sm">
              <CardHeader>
                <CardTitle>Demo the sleep state</CardTitle>
                <CardDescription>Local simulation only. Nothing is sent on-chain, and no NEAR moves.</CardDescription>
              </CardHeader>
              <CardFooter className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => sim("drain")}><BatteryLowIcon data-icon="inline-start" />Starve</Button>
                <Button size="sm" variant="outline" onClick={() => sim("revive")}><SparklesIcon data-icon="inline-start" />Revive</Button>
                <Button size="sm" variant="ghost" onClick={() => sim("reset")}>Reset</Button>
              </CardFooter>
            </Card>
          </aside>

          <Card className="flex min-h-[70svh] flex-col">
            <CardHeader>
              <div className="flex flex-wrap items-center gap-3">
                {pet ? <PetFace pet={pet} className="size-10 shrink-0" /> : <Skeleton className="size-10 shrink-0 rounded-full" />}
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <CardTitle>{pet ? (view === "chat" ? `Chat with ${pet.name}` : view === "history" ? `${pet.name}'s history` : `${pet.name}: owner page`) : "Loading…"}</CardTitle>
                  <CardDescription>
                    {pet?.pet_account ? <>Replies are paid by <span className="break-all">{pet.pet_account}</span></> : "Replies are charged by the Petri backend"}
                  </CardDescription>
                </div>
                {/* below sm the switcher gets its own row so Owner is never clipped */}
                <div className="flex basis-full gap-1 sm:ml-auto sm:basis-auto">
                  {(["chat", "history", "owner"] as const).map((v) => (
                    <Button key={v} size="sm" variant={view === v ? "default" : "ghost"} onClick={() => setView(v)}>
                      {v === "chat" ? "Chat" : v === "history" ? "History" : "Owner"}
                    </Button>
                  ))}
                </div>
              </div>
            </CardHeader>
            <Separator />
            {view === "history" && pet && <ScrollArea className="h-[64svh]"><PetHistory key={pet.token_id} tokenId={pet.token_id} petName={pet.name} /></ScrollArea>}
            {view === "owner" && pet && <OwnerPage key={pet.token_id} tokenId={pet.token_id} />}
            {view === "chat" && <>
            <CardContent className="flex-1 p-0">
              <ScrollArea className="h-[52svh]">
                <div className="flex flex-col gap-3 p-4">
                  {!thread && <><Skeleton className="h-10 w-2/3" /><Skeleton className="ml-auto h-10 w-1/2" /></>}
                  {thread?.map((m, i) =>
                    m.kind === "user"
                      ? <div key={i} className="max-w-[80%] self-end rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-sm text-primary-foreground">{m.text}</div>
                      : m.kind === "verified"
                        ? <VerifiedReply key={i} r={m.r} petName={pet?.name ?? "pet"} />
                        : (
                          <div key={i} className="flex max-w-[85%] flex-col gap-1.5 self-start">
                            <div className="rounded-2xl rounded-bl-sm border border-dashed px-4 py-2.5 text-sm">{m.text}</div>
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              <Badge variant="outline">mock brain · unsigned</Badge>
                              <span>simulated cost {near(m.cost)} NEAR, not charged on-chain</span>
                            </div>
                          </div>
                        ))}
                  {busy && <div className="flex items-center gap-2 self-start text-sm text-muted-foreground"><Spinner />{pet?.name} is thinking…</div>}
                  <div ref={bottom} />
                </div>
              </ScrollArea>
            </CardContent>
            <Separator />
            <CardFooter className="flex flex-col items-stretch gap-3">
              {pet?.sim_asleep && (
                <Alert>
                  <MoonIcon />
                  <AlertTitle>{pet.name} is asleep{pet.sleep_reason === "sim" ? " (local simulation)" : " on testnet"}</AlertTitle>
                  <AlertDescription>
                    {pet.sleep_reason === "sim"
                      ? "It was starved in the local simulation only; nothing changed on-chain. Click Revive or Reset."
                      : pet.sleep_reason === "hunger"
                        ? `Nobody has fed it for over ${hours(st?.hunger_ns)} hours${pet.last_fed_ns ? ` (last fed ${when(pet.last_fed_ns)})` : ""}, so the contract won't charge for its thoughts even though it holds ${near(pet.balance)} NEAR. Anyone can wake it with a tip (\`revive\`). Revive below wakes it in the local simulation only.`
                        : `Its brain balance is under ${near(st?.sleep_threshold ?? "0")} NEAR, so it can't afford a thought. Anyone can wake it with a tip (\`revive\`). Revive below wakes it in the local simulation only.`}
                  </AlertDescription>
                </Alert>
              )}
              {pet?.sim_woke && !pet.sim_asleep && (
                <p className="text-xs text-muted-foreground">
                  {pet.name} is still asleep on testnet; it is awake in the local simulation only (mock brain, nothing charged). Reset to go back to the chain state.
                </p>
              )}
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); send() }}>
                <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={500}
                  placeholder={pet?.sim_asleep ? "Zzz…" : `Say something to ${pet?.name ?? "your pet"}`} disabled={!pet || pet.sim_asleep || busy} />
                <Button type="submit" disabled={!pet || pet.sim_asleep || busy || !text.trim()}>
                  {busy ? <Spinner data-icon="inline-start" /> : <SendIcon data-icon="inline-start" />}Send
                </Button>
              </form>
            </CardFooter>
            </>}
          </Card>
        </div>
        <footer className="text-xs text-muted-foreground">
          The checkmarks above are recorded replies from the real NEAR AI Cloud TEE (DeepSeek on Intel TDX + NVIDIA H100/H200), re-verified locally and charged on testnet.
          New messages use the mock brain by default (no credits).
        </footer>
      </div>
      <Toaster />
    </TooltipProvider>
  )
}

export default App
