// Read-only NEAR testnet RPC from the browser (views, accounts, keys). Same RPC order and
// fail-fast circuit breaker as web/server.mjs.
import { CONTRACT } from "@/lib/txs"

const RPCS = ["https://rpc.testnet.fastnear.com", "https://rpc.testnet.near.org"]
const TIMEOUT_MS = 6000
let downUntil = 0

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)))
const unb64 = (bytes: number[]) => new TextDecoder().decode(new Uint8Array(bytes))

export async function rpc<T = any>(params: Record<string, unknown>, method = "query"): Promise<T> {
  if (Date.now() < downUntil) throw new Error("testnet RPC unreachable")
  let err: unknown, reachable = false
  for (const url of RPCS) {
    let j: any
    try {
      const r = await fetch(url, { method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
      j = await r.json()
    } catch (e) { err = e; continue }
    reachable = true
    // a contract panic comes back as result.error on view calls
    const e = j.error ?? j.result?.error
    if (e) { err = new Error(typeof e === "string" ? e : JSON.stringify(e).slice(0, 200)); continue }
    downUntil = 0
    return j.result
  }
  if (reachable) throw err
  downUntil = Date.now() + 30_000
  throw new Error("testnet RPC unreachable")
}

export async function viewAt<T = any>(account: string, method: string, args: object = {}): Promise<T> {
  const r = await rpc<{ result: number[] }>({ request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: b64(JSON.stringify(args)) })
  return JSON.parse(unb64(r.result))
}
export const view = <T = any>(method: string, args: object = {}) => viewAt<T>(CONTRACT, method, args)
