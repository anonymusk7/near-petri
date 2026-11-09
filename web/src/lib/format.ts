import { STATIC } from "@/lib/mode"

export const near = (y: string | bigint) => (Number(BigInt(y) / 10n ** 18n) / 1e6).toFixed(4)
export const explorer = (tx: string) => `https://testnet.near.rocks/tx/${tx}`
export const explorerAccount = (id: string) => `https://testnet.near.rocks/account/${id}`
export const short = (s: string, n = 6) => (s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s)
export const when = (ns: string | null | undefined) => (ns ? new Date(Number(BigInt(ns) / 1_000_000n)).toLocaleString() : "unknown time")

export async function api<T>(path: string, body?: unknown): Promise<T> {
  // hosted demo: no server; live reads go to testnet RPC from the browser, the rest is build-time JSON
  if (STATIC) return (await import("@/lib/staticApi")).staticApi<T>(path, body)
  let r: Response
  try {
    r = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined)
  } catch {
    throw new Error("Petri server unreachable")
  }
  // A proxy error page (HTML 502) or an empty reply is not JSON.
  const j = await r.json().catch(() => null)
  const status = `${r.status} ${r.statusText}`.trim()
  // no JSON from a dev proxy / gateway error: the Petri server itself is down
  if (!r.ok && j === null && r.status >= 500) throw new Error(`Petri server unreachable (${status})`)
  if (!r.ok) throw new Error(j?.error ?? status)
  if (j === null) throw new Error(`${status}: not a JSON reply`)
  return j
}
