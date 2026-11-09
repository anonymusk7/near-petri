// Browser wallet (NEAR Wallet Selector: Meteor Wallet, testnet), modeled on ShowUp's initWallet.
// MyNearWallet is omitted: it no longer accepts new app connections. The selector code is loaded
// on first use so the main bundle stays small. Transactions are built by lib/txs.mjs and only
// converted to wallet actions here. This page never sees a private key.
import { useSyncExternalStore } from "react"
import type { WalletSelector } from "@near-wallet-selector/core"
import type { WalletSelectorModal } from "@near-wallet-selector/modal-ui"

import { CONTRACT, type TxDesc } from "@/lib/txs"

type Api = { selector: WalletSelector; modal: WalletSelectorModal }
let ready: Promise<Api> | null = null
let account: string | null = null
const subs = new Set<() => void>()
const txSubs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())

export function initWallet(): Promise<Api> {
  ready ??= (async () => {
    const [{ setupWalletSelector }, { setupMeteorWallet }, { setupModal }, css] = await Promise.all([
      import("@near-wallet-selector/core"), import("@near-wallet-selector/meteor-wallet"),
      import("@near-wallet-selector/modal-ui"), import("@near-wallet-selector/modal-ui/styles.css?inline"),
    ])
    if (!document.getElementById("petri-wallet-css")) {
      const st = document.createElement("style"); st.id = "petri-wallet-css"; st.textContent = css.default; document.head.appendChild(st)
    }
    // Meteor first (and only): MyNearWallet no longer accepts new app connections.
    const selector = await setupWalletSelector({ network: "testnet", modules: [setupMeteorWallet()] })
    const modal = setupModal(selector, { contractId: CONTRACT,
      description: "Sign in with Meteor Wallet on NEAR testnet. Petri only asks your wallet to sign the exact tip, bet, book, revive, feed or claim call you click." })
    const sync = () => {
      const a = selector.store.getState().accounts.find((x) => x.active)?.accountId ?? null
      if (a !== account) { account = a; emit() }
    }
    selector.store.observable.subscribe(sync)
    sync()
    return { selector, modal }
  })()
  return ready
}

/** The connected testnet account (null when signed out). */
export const useAccount = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f) }, () => account)
export const signIn = async () => (await initWallet()).modal.show()
export async function signOut() {
  const { selector } = await initWallet()
  if (selector.isSignedIn()) await (await selector.wallet()).signOut()
}
/** Subscribe to "a wallet transaction finished": pages reload their chain state. */
export function onTx(f: () => void) { txSubs.add(f); return () => { txSubs.delete(f) } }
export const txDone = () => txSubs.forEach((f) => f())

type Outcome = { transaction?: { hash?: string }; transaction_outcome?: { id?: string }; status?: unknown
  receipts_outcome?: { outcome?: { status?: unknown } }[] }
export type SendResult = { hashes: string[]; failed: string | null } | null

const failureOf = (s: unknown): string | null => (s && typeof s === "object" && "Failure" in s ? JSON.stringify((s as { Failure: unknown }).Failure).slice(0, 240) : null)

/**
 * Sign + send one or more txs (several = signAndSendTransactions, e.g. storage_deposit then claim).
 * Returns hashes, or null when the wallet redirected away (the result then comes back in the URL).
 */
export async function send(txs: TxDesc[]): Promise<SendResult> {
  const { selector } = await initWallet()
  if (!selector.isSignedIn()) throw new Error("Connect a wallet first")
  const { actionCreators } = await import("@near-js/transactions")
  const wallet = await selector.wallet()
  const transactions = txs.map((t) => ({ receiverId: t.receiverId,
    actions: t.actions.map(({ params: p }) => actionCreators.functionCall(p.methodName, p.args, BigInt(p.gas), BigInt(p.deposit))) }))
  const out = (await wallet.signAndSendTransactions({ transactions, callbackUrl: location.href } as never)) as Outcome[] | void
  if (!out) return null
  const hashes = out.map((o) => o?.transaction?.hash ?? o?.transaction_outcome?.id).filter((h): h is string => Boolean(h))
  // ft_transfer_call succeeds even when Petri's ft_on_transfer panics (the token refunds): look at every receipt
  let failed: string | null = null
  for (const o of out) {
    failed ??= failureOf(o?.status)
    for (const r of o?.receipts_outcome ?? []) failed ??= failureOf(r.outcome?.status)
  }
  return { hashes, failed }
}

/** Some wallets' redirect flow comes back with ?transactionHashes=… or ?errorCode=…; read and strip them. */
export function takeRedirectResult(): { hashes: string[]; error: string | null } | null {
  const u = new URL(location.href)
  const h = u.searchParams.get("transactionHashes"), code = u.searchParams.get("errorCode")
  if (!h && !code) return null
  const msg = u.searchParams.get("errorMessage")
  for (const k of ["transactionHashes", "errorCode", "errorMessage", "account_id", "public_key", "all_keys"]) u.searchParams.delete(k)
  history.replaceState(null, "", u.pathname + u.search + u.hash)
  return { hashes: h ? h.split(",").filter(Boolean) : [], error: code ? `${code}${msg ? `: ${decodeURIComponent(msg)}` : ""}` : null }
}
