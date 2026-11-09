//! Memecoin mechanics ("Pet Pots", Memecoins With Mechanics track).
//!
//! Fans send a NEP-141 memecoin (on testnet: SHITZU, `shitzu-0.factory.v10.meme-cooking.testnet`)
//! to this contract with `ft_transfer_call`. The `msg` decides what the coins do:
//! * `{"action":"tip","token_id":"1"}`: the coins go into that pet's jar; only the
//!   pet's current NFT owner can `meme_claim_jar`.
//! * `{"action":"back","book_id":"0","token_id":"1"}`: the coins are staked on that pet
//!   in an open arena book. Books are opened by anyone with `meme_open_book` for a pair
//!   of pets and close for staking at `closes_at_ns`.
//!
//! When `arena_settle` settles a round between the same two pets, and BOTH replies were
//! charged on-chain after the book closed (so nobody could stake knowing the answers),
//! the book is settled with the arena's on-chain winner. Backers of the winner split the
//! whole pot pro rata; `rake_bps` of the losing side goes into the winning pet's jar.
//! If nobody backed the winner, or nobody backed the loser, everyone gets their own
//! stake back. A book that is not settled within `void_after_ns` of closing can be voided
//! by anyone and then refunds every stake.
//!
//! All parameters are fixed once by `meme_init` and can never change (no admin setter).
//! State lives under raw storage prefixes outside the root struct, so the upgrade needs
//! no migration and the existing pets are untouched.
use crate::*;
use near_sdk::store::LookupMap as Map;

const CFG_KEY: &[u8] = b"mm:cfg";
const BOOK_COUNT_KEY: &[u8] = b"mm:bc";
pub const MAX_RAKE_BPS: u16 = 1000;
const GAS_FT: Gas = Gas::from_tgas(10);
const GAS_CB: Gas = Gas::from_tgas(10);

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct MemeConfig {
    /// The NEP-141 memecoin this contract accepts.
    pub token: AccountId,
    /// Share of the losing side's stakes paid into the winning pet's jar (basis points, <= 1000).
    pub rake_bps: u16,
    /// Minimum and maximum staking window of a book, in seconds.
    pub min_window_secs: u64,
    pub max_window_secs: u64,
    /// After a book closes, how long settlement may take before anyone can void it.
    pub void_after_secs: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum BookState { Open, Settled, Void }

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Book {
    pub id: U64,
    pub pets: [TokenId; 2],
    pub opened_by: AccountId,
    pub closes_at_ns: U64,
    /// Total staked on pets[0] and pets[1].
    pub totals: [U128; 2],
    pub backers: u32,
    pub state: BookState,
    pub winner: Option<TokenId>,
    pub arena_id: Option<U64>,
    /// Paid from the losing side into the winner's jar at settlement.
    pub rake: U128,
}

fn books() -> Map<u64, Book> { Map::new(b"mm:b".to_vec()) }
/// "<book>:<account>" -> stake on [pets[0], pets[1]]
fn stakes() -> Map<String, [u128; 2]> { Map::new(b"mm:s".to_vec()) }
fn jars() -> Map<TokenId, u128> { Map::new(b"mm:j".to_vec()) }
/// "<pet a>|<pet b>" (sorted) -> id of the open book for that pair
fn open_pairs() -> Map<String, u64> { Map::new(b"mm:p".to_vec()) }
fn pair_key(a: &str, b: &str) -> String { if a < b { format!("{a}|{b}") } else { format!("{b}|{a}") } }
fn stake_key(book: u64, who: &AccountId) -> String { format!("{book}:{who}") }

pub fn meme_config() -> Option<MemeConfig> {
    env::storage_read(CFG_KEY).map(|b| near_sdk::borsh::from_slice(&b).unwrap())
}
fn cfg() -> MemeConfig { meme_config().unwrap_or_else(|| env::panic_str("memecoin pots are not initialised")) }

/// Pure payout rule (also used by the tests and the web page).
/// Returns (payout to this backer, rake to the winner jar for the whole book).
pub fn payout(state: &BookState, winner_idx: Option<usize>, totals: [u128; 2], mine: [u128; 2], rake_bps: u16) -> (u128, u128) {
    let own = mine[0] + mine[1];
    let refund = (own, 0);
    match (state, winner_idx) {
        (BookState::Settled, Some(w)) => {
            let (win, lose) = (totals[w], totals[1 - w]);
            if win == 0 || lose == 0 { return refund; }
            let rake = mul_div(rake_bps as u128, lose, 10_000);
            let pot = win + lose - rake;
            // mine[w] * pot / win without overflow for realistic 18-decimal supplies
            let share = mul_div(mine[w], pot, win);
            (share, rake)
        }
        _ => refund,
    }
}

/// floor(a * b / d) exactly, for a <= d (a backer's stake never exceeds its side's total).
pub fn mul_div(a: u128, b: u128, d: u128) -> u128 {
    if let Some(x) = a.checked_mul(b) { return x / d; }
    // shift-and-add with a running remainder: result = sum over bits of b of a*2^i / d
    let (mut q, mut r) = (0u128, 0u128);
    for i in (0..128).rev() {
        // (q, r) = 2 * (q, r) + bit_i(b) * (a / d, a % d) ; with a <= d, a / d is 0 or 1
        // r < d throughout, so compare against d - r instead of forming 2r or r + m (no overflow for d > 2^127)
        if r >= d - r { q = 2 * q + 1; r -= d - r; } else { q *= 2; r += r; }
        if (b >> i) & 1 == 1 {
            let m = a % d;
            q += a / d;
            if r >= d - m { q += 1; r -= d - m; } else { r += m; }
        }
    }
    q
}

#[near(serializers = [json])]
pub struct FtMsg { pub action: String, pub token_id: TokenId, pub book_id: Option<U64> }

#[near]
impl Petri {
    /// Owner-only, ONE time: choose the memecoin and the fixed pot rules. There is no
    /// setter afterwards, so the rules a fan reads with `meme_get_config` are final.
    pub fn meme_init(&mut self, token: AccountId, rake_bps: u16, min_window_secs: u64, max_window_secs: u64, void_after_secs: u64) -> MemeConfig {
        require!(env::predecessor_account_id() == self.owner_id, "only the owner");
        require!(meme_config().is_none(), "memecoin pots are already initialised; rules are immutable");
        require!(rake_bps <= MAX_RAKE_BPS, "rake_bps must be <= 1000 (10%)");
        require!(min_window_secs >= 1 && min_window_secs <= max_window_secs, "bad staking window");
        require!(void_after_secs >= 60, "void_after_secs must be >= 60");
        let c = MemeConfig { token, rake_bps, min_window_secs, max_window_secs, void_after_secs };
        env::storage_write(CFG_KEY, &near_sdk::borsh::to_vec(&c).unwrap());
        env::log_str(&format!("EVENT_JSON:{{\"standard\":\"petri\",\"version\":\"1.0.0\",\"event\":\"meme_init\",\"data\":{}}}",
            near_sdk::serde_json::to_string(&c).unwrap()));
        c
    }

    pub fn meme_get_config(&self) -> Option<MemeConfig> { meme_config() }

    /// Anyone: open a staking book for the next arena round between two pets.
    #[payable]
    pub fn meme_open_book(&mut self, pet_a: TokenId, pet_b: TokenId, window_secs: u64) -> Book {
        let c = cfg();
        require!(pet_a != pet_b, "a pet cannot fight itself");
        require!(self.pets.get(&pet_a).is_some() && self.pets.get(&pet_b).is_some(), "no such pet");
        require!(window_secs >= c.min_window_secs && window_secs <= c.max_window_secs, "window_secs outside the fixed limits");
        let pk = pair_key(&pet_a, &pet_b);
        let mut pairs = open_pairs();
        if let Some(old) = pairs.get(&pk) {
            let b = books().get(old).cloned().unwrap();
            require!(b.state != BookState::Open, "this pair already has an open book");
        }
        let before = env::storage_usage();
        let id = env::storage_read(BOOK_COUNT_KEY).map(|b| u64::from_le_bytes(b.try_into().unwrap())).unwrap_or(0);
        env::storage_write(BOOK_COUNT_KEY, &(id + 1).to_le_bytes());
        let book = Book { id: U64(id), pets: [pet_a, pet_b], opened_by: env::predecessor_account_id(),
            closes_at_ns: U64(env::block_timestamp() + window_secs * 1_000_000_000), totals: [U128(0), U128(0)],
            backers: 0, state: BookState::Open, winner: None, arena_id: None, rake: U128(0) };
        let mut bs = books(); bs.insert(id, book.clone()); bs.flush();
        pairs.insert(pk, id); pairs.flush();
        self.take_storage(before);
        env::log_str(&format!("EVENT_JSON:{{\"standard\":\"petri\",\"version\":\"1.0.0\",\"event\":\"meme_book_opened\",\"data\":{{\"id\":{id},\"pets\":[\"{}\",\"{}\"],\"closes_at_ns\":\"{}\"}}}}",
            book.pets[0], book.pets[1], book.closes_at_ns.0));
        book
    }

    /// NEP-141 receiver. Unknown token or a bad `msg` is refused (all coins returned).
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let c = cfg();
        require!(env::predecessor_account_id() == c.token, "this contract only accepts its configured memecoin");
        require!(amount.0 > 0, "amount must be positive");
        let m: FtMsg = near_sdk::serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("msg must be {\"action\":\"tip\"|\"back\",...}"));
        match m.action.as_str() {
            "tip" => {
                require!(self.pets.get(&m.token_id).is_some(), "no such pet");
                let mut j = jars();
                let v = j.get(&m.token_id).copied().unwrap_or(0) + amount.0;
                j.insert(m.token_id.clone(), v); j.flush();
                env::log_str(&format!("EVENT_JSON:{{\"standard\":\"petri\",\"version\":\"1.0.0\",\"event\":\"meme_tip\",\"data\":{{\"token_id\":\"{}\",\"from\":\"{sender_id}\",\"amount\":\"{}\",\"jar\":\"{v}\"}}}}", m.token_id, amount.0));
            }
            "back" => {
                let id = m.book_id.unwrap_or_else(|| env::panic_str("back needs book_id")).0;
                let mut bs = books();
                let b = bs.get_mut(&id).unwrap_or_else(|| env::panic_str("no such book"));
                require!(b.state == BookState::Open && env::block_timestamp() < b.closes_at_ns.0, "book is closed for staking");
                let i = b.pets.iter().position(|p| *p == m.token_id).unwrap_or_else(|| env::panic_str("pet is not in this book"));
                b.totals[i] = U128(b.totals[i].0 + amount.0);
                let mut st = stakes();
                let k = stake_key(id, &sender_id);
                let mut mine = st.get(&k).copied().unwrap_or([0, 0]);
                if mine == [0, 0] { b.backers += 1; }
                mine[i] += amount.0;
                st.insert(k, mine); st.flush(); bs.flush();
                env::log_str(&format!("EVENT_JSON:{{\"standard\":\"petri\",\"version\":\"1.0.0\",\"event\":\"meme_back\",\"data\":{{\"book_id\":{id},\"token_id\":\"{}\",\"from\":\"{sender_id}\",\"amount\":\"{}\"}}}}", m.token_id, amount.0));
            }
            _ => env::panic_str("unknown action"),
        }
        PromiseOrValue::Value(U128(0))
    }

    /// Anyone, once the book has been closed for `void_after_secs` without a qualifying
    /// arena round: void it so every backer can take their stake back.
    pub fn meme_void_book(&mut self, book_id: U64) -> Book {
        let c = cfg();
        let mut bs = books();
        let b = bs.get_mut(&book_id.0).unwrap_or_else(|| env::panic_str("no such book"));
        require!(b.state == BookState::Open, "book is not open");
        require!(env::block_timestamp() >= b.closes_at_ns.0 + c.void_after_secs * 1_000_000_000, "too early to void");
        b.state = BookState::Void;
        let out = b.clone(); bs.flush();
        env::log_str(&format!("EVENT_JSON:{{\"standard\":\"petri\",\"version\":\"1.0.0\",\"event\":\"meme_book_void\",\"data\":{{\"id\":{}}}}}", book_id.0));
        out
    }

    /// Backer: take your payout (settled) or refund (void / one-sided book).
    /// A backer of the losing side (payout 0) just has their stake entry cleared: Value(false).
    pub fn meme_claim(&mut self, book_id: U64) -> PromiseOrValue<bool> {
        let c = cfg();
        let b = books().get(&book_id.0).cloned().unwrap_or_else(|| env::panic_str("no such book"));
        require!(b.state != BookState::Open, "book is not settled or void yet");
        let who = env::predecessor_account_id();
        let mut st = stakes();
        let k = stake_key(book_id.0, &who);
        let mine = st.get(&k).copied().unwrap_or_else(|| env::panic_str("nothing to claim"));
        let w = b.winner.as_ref().and_then(|w| b.pets.iter().position(|p| p == w));
        let (amt, _) = payout(&b.state, w, [b.totals[0].0, b.totals[1].0], mine, c.rake_bps);
        st.remove(&k); st.flush();
        if amt == 0 {
            env::log_str("stake cleared: nothing to pay");
            return PromiseOrValue::Value(false);
        }
        PromiseOrValue::Promise(self.ft_out(c.token, who, amt, format!("s:{}", k), Some([U128(mine[0]), U128(mine[1])])))
    }

    /// Current NFT owner of a pet: withdraw the pet's tip jar.
    pub fn meme_claim_jar(&mut self, token_id: TokenId) -> Promise {
        let c = cfg();
        let who = env::predecessor_account_id();
        require!(self.owner_of(&token_id) == who, "only the pet owner can claim its jar");
        let mut j = jars();
        let amt = j.get(&token_id).copied().unwrap_or(0);
        require!(amt > 0, "jar is empty");
        j.remove(&token_id); j.flush();
        self.ft_out(c.token, who, amt, format!("j:{token_id}"), None)
    }

    /// Restore a claim whose ft_transfer failed (e.g. receiver not registered on the token).
    #[private]
    pub fn meme_on_payout(&mut self, key: String, amount: U128, stake: Option<[U128; 2]>) -> bool {
        if matches!(env::promise_result(0), PromiseResult::Successful(_)) { return true; }
        if let Some(t) = key.strip_prefix("j:") {
            let mut j = jars(); let v = j.get(t).copied().unwrap_or(0) + amount.0; j.insert(t.to_string(), v); j.flush();
        } else if let (Some(s), Some(m)) = (key.strip_prefix("s:"), stake) {
            let mut st = stakes(); st.insert(s.to_string(), [m[0].0, m[1].0]); st.flush();
        }
        env::log_str(&format!("payout {key} failed; restored"));
        false
    }

    pub fn meme_get_book(&self, book_id: U64) -> Option<Book> { books().get(&book_id.0).cloned() }
    pub fn meme_get_book_count(&self) -> U64 {
        U64(env::storage_read(BOOK_COUNT_KEY).map(|b| u64::from_le_bytes(b.try_into().unwrap())).unwrap_or(0))
    }
    pub fn meme_get_open_book(&self, pet_a: TokenId, pet_b: TokenId) -> Option<Book> {
        open_pairs().get(&pair_key(&pet_a, &pet_b)).and_then(|id| books().get(id).cloned()).filter(|b| b.state == BookState::Open)
    }
    pub fn meme_get_stake(&self, book_id: U64, account_id: AccountId) -> [U128; 2] {
        let m = stakes().get(&stake_key(book_id.0, &account_id)).copied().unwrap_or([0, 0]);
        [U128(m[0]), U128(m[1])]
    }
    /// What `account_id` would receive from `meme_claim` right now.
    pub fn meme_get_claimable(&self, book_id: U64, account_id: AccountId) -> U128 {
        let (Some(c), Some(b)) = (meme_config(), books().get(&book_id.0).cloned()) else { return U128(0) };
        if b.state == BookState::Open { return U128(0); }
        let m = stakes().get(&stake_key(book_id.0, &account_id)).copied().unwrap_or([0, 0]);
        let w = b.winner.as_ref().and_then(|w| b.pets.iter().position(|p| p == w));
        U128(payout(&b.state, w, [b.totals[0].0, b.totals[1].0], m, c.rake_bps).0)
    }
    pub fn meme_get_jar(&self, token_id: TokenId) -> U128 { U128(jars().get(&token_id).copied().unwrap_or(0)) }
}

impl Petri {
    fn take_storage(&self, before: u64) {
        let cost = env::storage_byte_cost().as_yoctonear() * env::storage_usage().saturating_sub(before) as u128;
        let dep = env::attached_deposit().as_yoctonear();
        require!(dep >= cost, format!("attach at least {cost} yocto for storage"));
        if dep > cost { Promise::new(env::predecessor_account_id()).transfer(NearToken::from_yoctonear(dep - cost)); }
    }

    fn ft_out(&self, token: AccountId, to: AccountId, amount: u128, key: String, stake: Option<[U128; 2]>) -> Promise {
        require!(amount > 0, "nothing to pay");
        Promise::new(token)
            .function_call("ft_transfer".into(),
                near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({"receiver_id": to, "amount": U128(amount)})).unwrap(),
                NearToken::from_yoctonear(1), GAS_FT)
            .then(Promise::new(env::current_account_id()).function_call("meme_on_payout".into(),
                near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({"key": key, "amount": U128(amount), "stake": stake})).unwrap(),
                NearToken::from_yoctonear(0), GAS_CB))
    }

    /// Called from `arena_settle`: settle the open book for this pair, if the two
    /// replies were charged after it closed. Returns the book id when settled.
    pub(crate) fn meme_settle_for(&mut self, pets: [&TokenId; 2], first_charge_ns: u64, winner: &TokenId, arena_id: u64) -> Option<u64> {
        let c = meme_config()?;
        let id = *open_pairs().get(&pair_key(pets[0], pets[1]))?;
        let mut bs = books();
        let b = bs.get_mut(&id)?;
        if b.state != BookState::Open { return None; }
        if first_charge_ns <= b.closes_at_ns.0 {
            env::log_str(&format!("meme book {id} not settled: a reply was charged before the book closed"));
            return None;
        }
        b.state = BookState::Settled;
        b.winner = Some(winner.clone());
        b.arena_id = Some(U64(arena_id));
        let w = b.pets.iter().position(|p| p == winner).unwrap();
        let (_, rake) = payout(&b.state, Some(w), [b.totals[0].0, b.totals[1].0], [0, 0], c.rake_bps);
        b.rake = U128(rake);
        bs.flush();
        if rake > 0 {
            let mut j = jars(); let v = j.get(winner).copied().unwrap_or(0) + rake; j.insert(winner.clone(), v); j.flush();
        }
        env::log_str(&format!("EVENT_JSON:{{\"standard\":\"petri\",\"version\":\"1.0.0\",\"event\":\"meme_book_settled\",\"data\":{{\"id\":{id},\"winner\":\"{winner}\",\"arena_id\":{arena_id},\"rake\":\"{rake}\"}}}}"));
        Some(id)
    }
}
