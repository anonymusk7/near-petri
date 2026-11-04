// Per-pet history from on-chain transactions: what the pet earned (mint deposit,
// feeds, tips), what it paid (charged replies) and who held it over time.
// Pure functions only (no network): the web server feeds them tx outcomes from
// nearblocks or archival RPC (`EXPERIMENTAL_tx_status`), or a recorded snapshot.

const b64json = (s) => { try { return JSON.parse(Buffer.from(s, 'base64').toString('utf8')); } catch { return {}; } };

/** NEP-297 events (`EVENT_JSON:{...}`) in a list of log lines. */
export function parseEvents(logs) {
  const out = [];
  for (const l of logs ?? []) {
    if (!l.startsWith('EVENT_JSON:')) continue;
    try { out.push(JSON.parse(l.slice('EVENT_JSON:'.length))); } catch { /* not an event */ }
  }
  return out;
}

const succeeded = (status) => status && typeof status === 'object' && !('Failure' in status);

/**
 * Normalize one `EXPERIMENTAL_tx_status` result into pet events.
 * @param {object} tx RPC result ({transaction, transaction_outcome, receipts_outcome, status})
 * @param {{contract: string, ts?: string}} opts ts = block timestamp (ns, string) of the tx
 * @returns {Array<{kind: string, token_id: string|null, tx: string, ts: string|null, ok: boolean, by: string, amount?: string, from?: string, to?: string, method: string}>}
 */
export function eventsFromTx(tx, { contract, ts = null }) {
  const t = tx.transaction;
  const ok = succeeded(tx.status);
  const base = { tx: t.hash, ts, ok, by: t.signer_id };
  if (t.receiver_id !== contract) return [];
  const logs = (tx.receipts_outcome ?? []).flatMap((r) => r.outcome.logs ?? []);
  const nep = parseEvents(logs);
  const out = [];
  for (const a of t.actions ?? []) {
    const fc = a.FunctionCall;
    if (!fc) continue;
    const args = b64json(fc.args);
    const m = fc.method_name;
    const deposit = String(fc.deposit ?? '0');
    if (m === 'mint_pet' || m === 'mint_pet_with_account') {
      const ev = nep.find((e) => e.event === 'nft_mint');
      const token_id = ev?.data?.[0]?.token_ids?.[0] ?? null;
      out.push({ ...base, kind: 'mint', method: m, token_id, to: ev?.data?.[0]?.owner_id ?? t.signer_id, amount: deposit });
    } else if (m === 'feed') {
      out.push({ ...base, kind: 'feed', method: m, token_id: args.token_id ?? null, amount: deposit });
    } else if (m === 'revive') {
      out.push({ ...base, kind: 'tip', method: m, token_id: args.token_id ?? null, amount: deposit });
    } else if (m === 'charge' || m === 'charge_verified') {
      out.push({ ...base, kind: 'charge', method: m, token_id: args.token_id ?? null, amount: String(args.cost ?? '0') });
    } else if (m === 'nft_transfer' || m === 'nft_transfer_call') {
      // The NEP-171 event is the truth (a rejected transfer_call emits a second, reverse event).
      const evs = nep.filter((e) => e.event === 'nft_transfer').flatMap((e) => e.data ?? []);
      if (!evs.length) out.push({ ...base, ok: false, kind: 'transfer', method: m, token_id: args.token_id ?? null, to: args.receiver_id });
      for (const d of evs) for (const id of d.token_ids ?? []) {
        out.push({ ...base, kind: 'transfer', method: m, token_id: id, from: d.old_owner_id, to: d.new_owner_id });
      }
    } else if (m === 'arena_settle') {
      const ev = nep.find((e) => e.event === 'arena_settled');
      for (const e of args.entries ?? []) {
        out.push({ ...base, kind: 'arena', method: m, token_id: e.token_id, won: ev ? String(ev.data?.winner) === e.token_id : null });
      }
    } else if (args.token_id !== undefined) {
      out.push({ ...base, kind: 'other', method: m, token_id: String(args.token_id), amount: deposit });
    }
  }
  return out;
}

const sum = (xs) => xs.reduce((s, e) => s + BigInt(e.amount ?? '0'), 0n);
const cmpTs = (a, b) => (a.ts == null || b.ts == null ? 0 : BigInt(a.ts) < BigInt(b.ts) ? -1 : BigInt(a.ts) > BigInt(b.ts) ? 1 : 0);

/**
 * Aggregate one pet's history. Failed txs are listed in the timeline but never counted.
 * @param {Array} events output of eventsFromTx (any pets; filtered here)
 * @param {{token_id: string, currentOwner?: string}} opts currentOwner = live nft_token owner, used to
 *   flag a transfer we have no tx for (e.g. made after the snapshot)
 */
export function aggregateHistory(events, { token_id, currentOwner } = {}) {
  const seen = new Set();
  const mine = events
    .filter((e) => e.token_id === token_id)
    .filter((e) => { const k = `${e.tx}:${e.kind}:${e.from ?? ''}:${e.to ?? ''}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .map((e, i) => ({ ...e, i }))
    .sort((a, b) => cmpTs(a, b) || a.i - b.i)
    .map(({ i: _i, ...e }) => e);
  const ok = mine.filter((e) => e.ok);
  const of = (k) => ok.filter((e) => e.kind === k);
  const mint = of('mint'), feeds = of('feed'), tips = of('tip'), charges = of('charge');

  const holders = [];
  for (const e of ok) {
    if (e.kind === 'mint') holders.push({ account: e.to, since: e.ts, until: null, via: e.tx });
    if (e.kind === 'transfer') {
      const last = holders.at(-1);
      if (last && last.account === e.to) continue;
      if (last) last.until = e.ts;
      holders.push({ account: e.to, since: e.ts, until: null, via: e.tx });
    }
  }
  const unrecorded = Boolean(currentOwner && holders.length && holders.at(-1).account !== currentOwner);
  if (unrecorded) holders.push({ account: currentOwner, since: null, until: null, via: null, inferred: true });

  const earned = { mint: sum(mint), feeds: { count: feeds.length, total: sum(feeds) }, tips: { count: tips.length, total: sum(tips) } };
  earned.total = earned.mint + earned.feeds.total + earned.tips.total;
  const paid = { replies: charges.length, total: sum(charges), by_pet_account: charges.filter((e) => e.method === 'charge_verified' && e.by.startsWith('pet-')).length };
  return {
    token_id,
    earned, paid, holders, unrecorded_transfer: unrecorded,
    arena: { rounds: of('arena').length, wins: of('arena').filter((e) => e.won).length },
    timeline: mine,
  };
}

/** JSON-safe copy (BigInt -> decimal string). */
export function toJSONSafe(v) {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
}
