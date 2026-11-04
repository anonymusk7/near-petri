import { useEffect, useState } from "react"
import { ArrowDownLeftIcon, ArrowUpRightIcon, ExternalLinkIcon, HistoryIcon, UsersIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { api, explorer, near, short, when } from "@/lib/format"

type Ev = { kind: string; method: string; tx: string; ts: string | null; ok: boolean; by: string; amount?: string; from?: string; to?: string; won?: boolean | null }
type History = {
  token_id: string; source: string; error?: string; tx_count?: number; current_owner: string | null; unrecorded_transfer: boolean
  earned: { mint: string; feeds: { count: number; total: string }; tips: { count: number; total: string }; total: string }
  paid: { replies: number; total: string; by_pet_account: number }
  holders: { account: string; since: string | null; until: string | null; via: string | null; inferred?: boolean }[]
  arena: { rounds: number; wins: number }
  timeline: Ev[]
}

const LABEL: Record<string, string> = { mint: "minted", feed: "fed", tip: "tip (revive)", charge: "paid a reply", transfer: "transferred", arena: "arena round", other: "" }

function line(e: Ev) {
  if (e.kind === "mint") return `minted to ${e.to} with ${near(e.amount ?? "0")} NEAR`
  if (e.kind === "feed" || e.kind === "tip") return `${LABEL[e.kind]} +${near(e.amount ?? "0")} NEAR by ${e.by}`
  if (e.kind === "charge") return `paid ${near(e.amount ?? "0")} NEAR for a reply (${e.method} by ${e.by})`
  if (e.kind === "transfer") return `${e.from ?? e.by} → ${e.to}`
  if (e.kind === "arena") return e.won ? "won an arena round" : "lost an arena round"
  return `${e.method} by ${e.by}`
}

export function PetHistory({ tokenId, petName }: { tokenId: string; petName: string }) {
  const [h, setH] = useState<History | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    api<History>(`/api/history?token=${tokenId}`).then((x) => live && setH(x)).catch((e) => live && setErr(e.message))
    return () => { live = false }
  }, [tokenId])

  if (err) return <p className="p-4 text-sm text-destructive">{err}</p>
  if (!h) return <div className="flex flex-col gap-3 p-4"><Skeleton className="h-20" /><Skeleton className="h-40" /></div>
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap gap-1.5 text-xs">
        <Badge variant={h.source === "snapshot" ? "destructive" : "outline"}>source: {h.source}</Badge>
        {h.tx_count != null && <Badge variant="outline">{h.tx_count} txs</Badge>}
        {h.error && <span className="text-muted-foreground">({h.error})</span>}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Card size="sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><ArrowDownLeftIcon className="size-4" />Earned {near(h.earned.total)} NEAR</CardTitle>
            <CardDescription>Everything that ever went into {petName}'s balance</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 text-sm">
            <div className="flex justify-between"><span>Mint deposit</span><span className="font-mono">{near(h.earned.mint)}</span></div>
            <div className="flex justify-between"><span>Feeds ({h.earned.feeds.count})</span><span className="font-mono">{near(h.earned.feeds.total)}</span></div>
            <div className="flex justify-between"><span>Tips / revives ({h.earned.tips.count})</span><span className="font-mono">{near(h.earned.tips.total)}</span></div>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><ArrowUpRightIcon className="size-4" />Paid {near(h.paid.total)} NEAR</CardTitle>
            <CardDescription>Charged AI replies (cost goes to the operator's treasury)</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 text-sm">
            <div className="flex justify-between"><span>Replies charged</span><span className="font-mono">{h.paid.replies}</span></div>
            <div className="flex justify-between"><span>…signed by the pet's own account</span><span className="font-mono">{h.paid.by_pet_account}</span></div>
            <div className="flex justify-between"><span>Arena rounds / wins</span><span className="font-mono">{h.arena.rounds} / {h.arena.wins}</span></div>
          </CardContent>
        </Card>
      </div>
      <Card size="sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><UsersIcon className="size-4" />Who held it</CardTitle>
          <CardDescription>From nft_mint / nft_transfer events (NEP-171)</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          {h.holders.map((x, i) => (
            <div key={i} className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono">{x.account}{x.account === h.current_owner && <Badge className="ml-2">current</Badge>}</span>
              <span className="text-xs text-muted-foreground">
                {x.inferred ? "transfer tx not in the indexed history" : `${when(x.since)} → ${x.until ? when(x.until) : "now"}`}
              </span>
            </div>
          ))}
          {h.unrecorded_transfer && <p className="text-xs text-muted-foreground">The live owner differs from the last recorded holder: a transfer happened that this history has no tx for.</p>}
        </CardContent>
      </Card>
      <Separator />
      <div className="flex flex-col gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium"><HistoryIcon className="size-4" />Timeline</h3>
        {h.timeline.map((e, i) => (
          <div key={i} className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className={e.ok ? "" : "text-muted-foreground line-through"}>{line(e)}</span>
            <span className="flex items-center gap-2 text-muted-foreground">
              {when(e.ts)}
              <a className="inline-flex items-center gap-1 underline-offset-4 hover:underline" href={explorer(e.tx)} target="_blank" rel="noreferrer">
                {short(e.tx, 4)}<ExternalLinkIcon className="size-3" />
              </a>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
