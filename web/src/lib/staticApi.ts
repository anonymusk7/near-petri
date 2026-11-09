// The hosted demo's /api/*, in the browser (no Petri server). Ports web/server.mjs:
//   /api/state, /api/meme, /api/meme/account  read LIVE from testnet RPC; on RPC failure the bundled
//                                             snapshots (web/snapshot.json, web/meme-snapshot.json)
//   /api/replies, /api/history                JSON written at build time by scripts/export-static.mjs
//                                             (TEE checks + on-chain proof checks ran then)
//   /api/sim                                  the sleep simulation, in this tab only
//   /api/chat                                 off: live chat needs the local app and a NEAR AI key
import { rpc, view, viewAt } from "@/lib/rpc"
import { CONTRACT } from "@/lib/txs"

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any

const cache = new Map<string, Promise<Json>>()
/** Build-time JSON next to index.html (data/*.json), relative so any subpath works. */
function data(name: string): Promise<Json> {
  if (!cache.has(name)) {
    cache.set(name, fetch(new URL(`data/${name}`, document.baseURI)).then((r) => {
      if (!r.ok) throw new Error(`${name}: ${r.status} ${r.statusText}`)
      return r.json()
    }).catch((e) => { cache.delete(name); throw e }))
  }
  return cache.get(name)!
}
const badRequest = (m: string) => new Error(m)
const tokenParam = (u: URL) => {
  const t = u.searchParams.get("token") ?? "0"
  if (!/^\d{1,6}$/.test(t)) throw badRequest("token must be a pet id (digits)")
  return t
}

// ---------- pets ----------
async function chainState(): Promise<Json> {
  const built = await data("state.json").catch(() => null)
  const [signers, p0, p1, config, n] = await Promise.all([view("get_tee_signers"), view("get_pet", { token_id: "0" }), view("get_pet", { token_id: "1" }),
    view("get_config").catch(() => null), view("get_arena_count")])
  const pets = [p0, p1]
  await Promise.all(pets.filter((p) => p.pet_account).map(async (p) => {
    const [keys, acct] = await Promise.all([
      rpc({ request_type: "view_access_key_list", finality: "final", account_id: p.pet_account }),
      rpc({ request_type: "view_account", finality: "final", account_id: p.pet_account })])
    p.account_balance = acct.amount
    p.keys = keys.keys.map((k: Json) => ({ public_key: k.public_key, permission: k.access_key.permission }))
  }))
  // Arena rounds are immutable once settled: reuse the build-time ones (they carry the recorded reply
  // text), and read any newer round live.
  const arena: Json[] = [...(built?.arena ?? [])].slice(0, Number(n))
  for (let i = arena.length; i < Number(n); i++) {
    const r = await view("get_arena", { id: String(i) })
    for (const e of r.entries) e.response ??= "(reply not in the recorded set)"
    arena.push({ ...r, id: i, tx: null })
  }
  // Chain Signatures EVM tip addresses are derived at build time (deterministic from contract + path).
  for (const p of pets) p.tip = built?.pets?.find((x: Json) => x.token_id === p.token_id)?.tip
  return { contract: CONTRACT, network: "testnet", signers, pets, arena, tip_quote: built?.tip_quote ?? null,
    sleep_threshold: String(config?.sleep_threshold ?? built?.sleep_threshold), hunger_ns: String(config?.hunger_ns ?? built?.hunger_ns ?? DEFAULT_HUNGER_NS),
    fetched_at: new Date().toISOString() }
}

// Sleep simulation (same rules as web/server.mjs), in this tab only.
const DEFAULT_HUNGER_NS = 24n * 3600n * 10n ** 9n
type Sim = { balance: bigint; forcedSleep: boolean; woke: boolean }
const sim = new Map<string, Sim>()
const simOf = (token: string, chainBalance: string) => {
  if (!sim.has(token)) sim.set(token, { balance: BigInt(chainBalance ?? 0), forcedSleep: false, woke: false })
  return sim.get(token)!
}
let lastChain: Json = null
function withSim(st: Json) {
  const threshold = BigInt(st.sleep_threshold ?? 10n ** 22n)
  const out = structuredClone(st)
  for (const p of out.pets) {
    const s = simOf(p.token_id, p.balance)
    const asleep = (p.asleep && !s.woke) || s.forcedSleep || s.balance < threshold
    p.sim_balance = s.balance.toString()
    p.sim_asleep = asleep
    p.sim_woke = s.woke && p.asleep
    p.chain_sleep_reason = !p.asleep ? null : BigInt(p.balance ?? 0) < threshold ? "balance" : "hunger"
    p.sleep_reason = !asleep ? null : p.asleep && !s.woke && !s.forcedSleep ? p.chain_sleep_reason : "sim"
  }
  return out
}
async function state() {
  try { lastChain = { ...(await chainState()), source: "testnet" } } catch (e) {
    lastChain = { ...(await data("snapshot.json")), source: "snapshot", error: String((e as Error).message).slice(0, 120) }
  }
  return withSim(lastChain)
}
async function simAction({ token_id = "0", action }: Json) {
  const st = lastChain ?? (await state(), lastChain)
  const p = st.pets.find((x: Json) => x.token_id === token_id)
  if (!p) throw new Error("no such pet")
  const threshold = BigInt(st.sleep_threshold ?? 10n ** 22n)
  const s = simOf(token_id, p.balance)
  if (action === "drain") { s.balance = threshold - 1n; s.forcedSleep = true }
  else if (action === "revive") { s.balance += threshold * 5n; s.forcedSleep = false; s.woke = true }
  else if (action === "reset") sim.delete(token_id)
  else throw badRequest("action must be drain|revive|reset")
  return withSim(st)
}

// ---------- memecoin pots ----------
async function memeChain() {
  const config = await view("meme_get_config")
  if (!config) return { config: null, books: [], jars: [] }
  const built = await data("meme.json").catch(() => null)
  const [count, meta] = await Promise.all([view("meme_get_book_count"), viewAt(config.token, "ft_metadata").catch(() => null)])
  const ids = [...Array(Number(count)).keys()].reverse().slice(0, 20)
  const books = await Promise.all(ids.map(async (id) => {
    const b = await view("meme_get_book", { book_id: String(id) })
    b.txs = built?.books?.find((x: Json) => x.id === String(id))?.txs ?? []
    return b
  }))
  const jars = await Promise.all(["0", "1"].map(async (t) => ({ token_id: t, amount: await view("meme_get_jar", { token_id: t }) })))
  return { config, token: meta ? { symbol: meta.symbol, decimals: meta.decimals, icon: meta.icon ?? null } : { symbol: "SHITZU", decimals: 18, icon: null }, books, jars }
}
async function meme() {
  try { return { ...(await memeChain()), contract: CONTRACT, now_ms: Date.now(), source: "testnet" } } catch (e) {
    return { ...(await data("meme-snapshot.json")), now_ms: Date.now(), source: "snapshot", error: String((e as Error).message).slice(0, 120) }
  }
}
async function memeAccount(book: string | null, account: string | null) {
  if (!/^[a-z0-9._-]{2,64}$/.test(account ?? "") || !/^\d{1,10}$/.test(book ?? "")) throw badRequest("bad account or book id")
  const [stake, claimable] = await Promise.all([view("meme_get_stake", { book_id: book, account_id: account }), view("meme_get_claimable", { book_id: book, account_id: account })])
  return { book, account, stake, claimable }
}

export const CHAT_OFF = "Live chat runs locally with your own NEAR AI key — clone the repo and run `pnpm web`. This hosted demo shows the real recorded TEE-verified conversations."

export async function staticApi<T>(path: string, body?: unknown): Promise<T> {
  const u = new URL(path, "http://x")
  const r: Json = await (async () => {
    switch (u.pathname) {
      case "/api/state": return state()
      case "/api/sim": return simAction(body ?? {})
      case "/api/meme": return meme()
      case "/api/meme/account": return memeAccount(u.searchParams.get("book"), u.searchParams.get("account"))
      case "/api/replies": { const t = tokenParam(u); return data(`replies-${t}.json`).catch(() => []) }
      case "/api/history": return data(`history-${tokenParam(u)}.json`)
      case "/api/chat": return { static: true, reply: CHAT_OFF, cost: "0", mock: false }
      case "/api/owner/challenge": case "/api/owner/verify":
        throw new Error("the NEP-413 owner check runs on the local server (pnpm web); the hosted demo gates the Owner tab on your connected wallet")
      default: throw new Error(`no such API endpoint: ${path}`)
    }
  })()
  return r as T
}
