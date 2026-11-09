// Transaction descriptions for the browser wallet (and anything else that signs).
// Pure ESM, no dependencies: imported by node tests and bundled by the web app.
// Each builder returns { receiverId, actions: [{ type: 'FunctionCall', params: { methodName, args, gas, deposit } }] }
// with gas and deposit as decimal strings (gas units / yoctoNEAR). The web app turns these into
// wallet-selector actions in web/src/lib/wallet.ts.

/** The Petri contract on testnet (pets "0" Mochi and "1" Moss). */
export const CONTRACT = 'v2.petri-1793597952.testnet';
/** The memecoin the contract accepts (meme_get_config.token): Shitzu's testnet SHITZU, NEP-141, 18 decimals. */
export const TOKEN = 'shitzu-0.factory.v10.meme-cooking.testnet';
export const TOKEN_DECIMALS = 18;
export const NEAR_DECIMALS = 24;

const TGAS = 10n ** 12n;
export const GAS = {
  // ft_transfer_call on the token: the token's own work + ft_on_transfer on Petri + ft_resolve_transfer.
  // Same 100 Tgas as the CLI commands on the pots page; the unused part is refunded.
  FT_TRANSFER_CALL: String(100n * TGAS),
  STORAGE_DEPOSIT: String(30n * TGAS),
  // a few storage writes + the refund transfer of the unused deposit
  OPEN_BOOK: String(30n * TGAS),
  // meme_claim / meme_claim_jar: own work + ft_transfer (10 Tgas) + meme_on_payout callback (10 Tgas)
  CLAIM: String(50n * TGAS),
  VOID: String(30n * TGAS),
  PET: String(30n * TGAS), // feed / revive
};
export const DEPOSIT = {
  ONE_YOCTO: '1', // NEP-141 ft_transfer_call requires exactly 1 yoctoNEAR
  // storage_balance_bounds on the token: min = max = 0.00125 NEAR
  STORAGE: '1250000000000000000000',
  // meme_open_book takes its storage cost (a few hundred bytes, ~0.003 NEAR) and refunds the rest (take_storage)
  OPEN_BOOK: '10000000000000000000000', // 0.01 NEAR
};
/** Staking windows offered by the UI (inside meme_get_config min 60 s / max 86400 s). */
export const WINDOWS = [{ label: '10 min', secs: 600 }, { label: '1 h', secs: 3600 }, { label: '24 h', secs: 86400 }];

/**
 * Human decimal string -> base units (BigInt), e.g. ("1.5", 18) -> 1500000000000000000n.
 * Rejects empty, negative, zero, non-decimal input and more fraction digits than `decimals`.
 * @param {string} human
 * @param {number} decimals
 * @returns {bigint}
 */
export function parseAmount(human, decimals) {
  const s = String(human ?? '').trim();
  if (s.startsWith('-')) throw new Error('amount must be positive');
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!s || !m || (m[1] === '' && !m[2])) throw new Error('amount must be a decimal number like 10 or 0.5');
  const frac = m[2] ?? '';
  if (frac.length > decimals) throw new Error(`at most ${decimals} decimal places`);
  const v = BigInt(m[1] || '0') * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
  if (v <= 0n) throw new Error('amount must be greater than zero');
  return v;
}
/** @param {string} human NEAR amount, e.g. "0.01" @returns {string} yoctoNEAR */
export const parseNear = (human) => parseAmount(human, NEAR_DECIMALS).toString();

/** Base units -> human decimal string without trailing zeros. @param {bigint|string} v @param {number} decimals */
export function formatAmount(v, decimals) {
  const b = BigInt(v), d = 10n ** BigInt(decimals);
  const frac = (b % d).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${b / d}${frac ? '.' + frac : ''}`;
}

/** @param {unknown} t */
const tokenId = (t) => {
  if (!/^\d{1,6}$/.test(String(t))) throw new Error('token_id must be a pet id (digits)');
  return String(t);
};
/** @param {unknown} b */
const bookId = (b) => {
  if (!/^\d{1,10}$/.test(String(b))) throw new Error('book_id must be digits');
  return String(b);
};
/**
 * @typedef {{ type: 'FunctionCall', params: { methodName: string, args: Record<string, unknown>, gas: string, deposit: string } }} FunctionCallAction
 * @typedef {{ receiverId: string, actions: FunctionCallAction[] }} TxDesc
 */
/** @returns {TxDesc} */
const call = (receiverId, methodName, args, gas, deposit) =>
  ({ receiverId, actions: [{ type: 'FunctionCall', params: { methodName, args, gas, deposit } }] });

/** Tip a pet's SHITZU jar: ft_transfer_call on the token with msg {"action":"tip","token_id":...}. */
/** @param {string} token_id @param {string} amountHuman @param {number} [decimals] */
export function tipTx(token_id, amountHuman, decimals = TOKEN_DECIMALS) {
  const msg = JSON.stringify({ action: 'tip', token_id: tokenId(token_id) });
  return call(TOKEN, 'ft_transfer_call', { receiver_id: CONTRACT, amount: parseAmount(amountHuman, decimals).toString(), msg },
    GAS.FT_TRANSFER_CALL, DEPOSIT.ONE_YOCTO);
}
/** Back a pet in an open book: msg {"action":"back","token_id":...,"book_id":...} (book_id is a U64 string). */
/** @param {string} book_id @param {string} token_id @param {string} amountHuman @param {number} [decimals] */
export function backTx(book_id, token_id, amountHuman, decimals = TOKEN_DECIMALS) {
  const msg = JSON.stringify({ action: 'back', token_id: tokenId(token_id), book_id: bookId(book_id) });
  return call(TOKEN, 'ft_transfer_call', { receiver_id: CONTRACT, amount: parseAmount(amountHuman, decimals).toString(), msg },
    GAS.FT_TRANSFER_CALL, DEPOSIT.ONE_YOCTO);
}
/** Register `account` on the token (NEP-145), needed once before ft_transfer_call. */
/** @param {string} account */
export function storageDepositTx(account) {
  if (!/^[a-z0-9._-]{2,64}$/.test(account ?? '')) throw new Error('bad account id');
  return call(TOKEN, 'storage_deposit', { account_id: account, registration_only: true }, GAS.STORAGE_DEPOSIT, DEPOSIT.STORAGE);
}
/** Open a staking book for the next arena round between two pets (anyone, payable). */
/** @param {string} petA @param {string} petB @param {number} windowSecs */
export function openBookTx(petA, petB, windowSecs) {
  const w = Number(windowSecs);
  if (!Number.isInteger(w) || w < 60 || w > 86400) throw new Error('window must be 60..86400 seconds');
  if (tokenId(petA) === tokenId(petB)) throw new Error('a pet cannot fight itself');
  return call(CONTRACT, 'meme_open_book', { pet_a: String(petA), pet_b: String(petB), window_secs: w }, GAS.OPEN_BOOK, DEPOSIT.OPEN_BOOK);
}
/** Backer: take a payout or refund from a settled / void book. meme_claim is not payable: deposit 0. */
export const claimTx = (book_id) => call(CONTRACT, 'meme_claim', { book_id: bookId(book_id) }, GAS.CLAIM, '0');
/** Anyone, after closes_at + void_after_secs: void an unsettled book. Not payable. */
export const voidTx = (book_id) => call(CONTRACT, 'meme_void_book', { book_id: bookId(book_id) }, GAS.VOID, '0');
/** NFT owner: withdraw the pet's SHITZU tip jar. Not payable. */
export const claimJarTx = (token_id) => call(CONTRACT, 'meme_claim_jar', { token_id: tokenId(token_id) }, GAS.CLAIM, '0');
/** Anyone: wake an asleep pet with a NEAR tip (must lift its balance to >= sleep_threshold). */
export const reviveTx = (token_id, nearHuman) => call(CONTRACT, 'revive', { token_id: tokenId(token_id) }, GAS.PET, parseNear(nearHuman));
/** NFT owner: top up an awake pet's brain balance and reset its hunger clock. */
export const feedTx = (token_id, nearHuman) => call(CONTRACT, 'feed', { token_id: tokenId(token_id) }, GAS.PET, parseNear(nearHuman));
