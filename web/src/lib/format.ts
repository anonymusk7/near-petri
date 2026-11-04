export const near = (y: string | bigint) => (Number(BigInt(y) / 10n ** 18n) / 1e6).toFixed(4)
export const explorer = (tx: string) => `https://testnet.nearblocks.io/txns/${tx}`
export const short = (s: string, n = 6) => (s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s)
export const when = (ns: string | null | undefined) => (ns ? new Date(Number(BigInt(ns) / 1_000_000n)).toLocaleString() : "unknown time")

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined)
  const j = await r.json()
  if (!r.ok) throw new Error(j.error ?? r.statusText)
  return j
}
