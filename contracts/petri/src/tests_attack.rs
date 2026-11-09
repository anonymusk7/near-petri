//! Adversarial unit tests: unauthorized calls, replay, overflow, failed
//! callbacks, bad input, storage griefing and pet sales.
//!
//! FINDINGS (current behaviour, encoded by the tests below):
//! BUGS (all FIXED; the tests named below used to be #[ignore]d and now pass):
//! 1. meme::payout computes `lose * rake_bps` with plain u128 math. If the losing side
//!    holds more than u128::MAX / 1000 (~3.4e35 base units) it overflows and panics
//!    (overflow-checks = true), so meme_settle_for, and with it the whole arena_settle
//!    for that pair, reverts until the book is voided. It is only reachable with a huge
//!    token supply, but mul_div was added to avoid exactly this kind of overflow and the
//!    rake skips it. (payout_huge_totals_do_not_overflow)
//! 2. meme::mul_div fallback: `r * 2` (and `r += a % d`) overflow when d > 2^127, so the
//!    "exact" helper panics instead of returning floor(a*b/d). Same huge-supply
//!    precondition. (mul_div_with_divisor_above_2_pow_127)
//! 3. recover_eip191 -> unhex slices by byte index; a non-ASCII signature panics with
//!    "byte index N is not a char boundary" instead of returning None / "bad TEE
//!    signature". Only the backend or a pet key can send it, so the impact is a confusing
//!    error, not lost funds. (recover_eip191_non_ascii_signature_returns_none)
//!    FIXED: payout takes the rake with mul_div; mul_div's fallback compares against
//!    d - r instead of forming 2r / r + m; unhex rejects non-ASCII input up front.
//!
//! RISKS / DESIGN NOTES (current behaviour, tests pass):
//! * Unpaid storage: every distinct backer adds 96 bytes (~0.00096 NEAR) that the CONTRACT
//!   pays, because ft_on_transfer cannot take a NEAR deposit. 1-yocto stakes from many
//!   accounts grow the contract's locked storage with no limit per book
//!   (storage_per_one_yocto_backer_is_bounded_and_unpaid). mint_pet_with_account also
//!   leaves ~57 bytes (pet_accounts + kh:) unpaid, and so does rekey (kg:, kh:).
//! * FIXED: a losing backer used to be unable to clear their stake (payout 0, ft_out
//!   requires > 0, so meme_claim panicked "nothing to pay" and the revert kept the entry).
//!   meme_claim now removes the entry, logs "stake cleared: nothing to pay" and returns
//!   Value(false) without a promise (losing_backer_claim_clears_stake). A winning backer can never round down to 0 (pot >= winning side), so 1-yocto
//!   winners do get paid.
//! * Rounding dust from pro-rata payouts (at most 1 unit per winning backer) stays in
//!   the contract with no sweep.
//! * arena_settle is permissionless and settles the open book with the first qualifying
//!   round. The caller picks WHICH charged replies (charged after close) go in, so a pet
//!   owner who charges several replies to the same question can choose the book's winner.
//! * Replies are bound to (pet name, personality), not to the token id: a clone pet with
//!   the same name and prompt can be charged another pet's reply first, after which the
//!   original can never use it.
//! * If the mint's pet-account creation fails AFTER the owner already rekeyed,
//!   on_pet_account unlinks the rekeyed account too. The rekey's 0.1 NEAR is stranded on
//!   an account that can no longer charge.
//! * A jar payout that fails after a sale is restored to the pet's jar, so the buyer
//!   gets it, not the seller who claimed it.
//! * add_tee_signer only checks "0x" + 42 chars, not that the rest is hex (harmless).
//! * `#[private]` lives in the wasm entry point, which unit tests bypass. It is checked
//!   statically here. A direct call to a callback also fails because there is no promise
//!   result (InvalidPromiseResultIndex), so no state changes.
//!
//! Verified OK: double/replayed claims pay once, a failed payout is restored exactly once
//! (jar restore adds to new tips instead of overwriting them), the stake entry is removed
//! before the promise, overflowing tips/backs panic without changing state, every admin
//! call and every post-sale seller action is refused.
use super::*;
use crate::meme::{mul_div, payout, BookState};
use crate::tests::*;
use near_sdk::mock::MockAction;
use near_sdk::serde_json;
use near_sdk::test_utils::{get_created_receipts, get_logs};

const T: u128 = 1_000_000_000_000_000_000;
const TIP0: &str = r#"{"action":"tip","token_id":"0"}"#;

/// Run `f`, require it to panic, return the panic message.
fn err<R>(f: impl FnOnce() -> R) -> String {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(_) => panic!("expected a panic"),
        Err(e) => e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default(),
    }
}
/// (receiver, amount) of every ft_transfer scheduled in the current testing_env.
fn ft_paid() -> Vec<(String, u128)> {
    get_created_receipts().iter().flat_map(|r| r.actions.clone()).filter_map(|a| match a {
        MockAction::FunctionCallWeight { method_name, args, .. } if method_name == b"ft_transfer" => {
            let v: serde_json::Value = serde_json::from_slice(&args).unwrap();
            Some((v["receiver_id"].as_str().unwrap().to_string(), v["amount"].as_str().unwrap().parse().unwrap()))
        }
        _ => None,
    }).collect()
}
fn jar(p: &Petri, pet: &str) -> u128 { p.meme_get_jar(pet.into()).0 }
fn totals(p: &Petri, id: u64) -> [u128; 2] { let b = p.meme_get_book(U64(id)).unwrap(); [b.totals[0].0, b.totals[1].0] }
/// meme_arena + bob 100 on Moss ("1", the winner) + frank 50 on Mochi, settled. Moss wins.
fn settled_book() -> Petri {
    let mut p = meme_arena();
    ft(&mut p, SEC, "bob", 100, &back(0, "1"));
    ft(&mut p, SEC, "frank", 50, &back(0, "0"));
    assert_eq!(charge_and_settle(&mut p).winner, "1");
    p
}
/// Insert a charged, TEE-proved reply at a chosen charge time (like tests::proved).
fn proved_at(p: &mut Petri, token: &str, req: &str, resp: &str, at: u64) {
    let (rq, rs) = (sha(req), sha(resp));
    let rh = sha(&format!("m:{rq}:{rs}"));
    p.tee_proofs.insert(rh.clone(), TeeProof { model: "m".into(), request_hash: rq, response_hash: rs, signer: R_SIGNER.into(), signature: R_SIG.into() });
    p.replies.insert(rh, ReplyRecord { token_id: token.into(), index: 0, cost: NearToken::from_yoctonear(0), at_ns: U64(at) });
}
fn entry(token: &str, req: &str, resp: &str) -> ArenaEntryInput { ArenaEntryInput { token_id: token.into(), request: req.into(), response: resp.into() } }
fn dummy(token: &str) -> ArenaEntryInput { entry(token, "{}", "{}") }

// ======================= onboarding =======================

#[test] fn onboarding_new_user_mints_feeds_and_lists() {
    let mut p = with_pet();
    ctx("carol", HOUR, N / 2);
    let v = p.mint_pet("Pebble".into(), H2.into());
    assert_eq!((v.token_id.as_str(), v.owner_id.clone(), v.asleep, v.replies), ("1", acc("carol"), false, 0));
    ctx("carol", 2 * HOUR, N);
    let fed = p.feed("1".into());
    assert_eq!(yocto(fed.balance), yocto(v.balance) + N);
    assert_eq!(fed.last_fed_ns, U64(2 * HOUR));
    let mine = p.nft_tokens_for_owner(acc("carol"), None, None);
    assert_eq!(mine.iter().map(|t| t.token_id.as_str()).collect::<Vec<_>>(), vec!["1"]);
    assert_eq!(p.nft_supply_for_owner(acc("carol")), U128(1));
    assert_eq!(p.nft_tokens_for_owner(acc("alice"), None, None)[0].token_id, "0", "other users' pets untouched");
}
#[test] fn mint_name_emoji_exactly_32_bytes() {
    let name = "🐶".repeat(8);
    assert_eq!(name.len(), 32);
    let mut p = c(); ctx("alice", 0, N);
    let v = p.mint_pet(name.clone(), H.into());
    assert_eq!(v.name, name);
    assert_eq!(p.nft_token("0".into()).unwrap().metadata.unwrap().title, Some(name.clone()));
    assert_eq!(system_prompt(&v.name, "x"), format!("You are {name}, a Petri pet living on NEAR. x Answer in at most two short sentences."));
}
#[test] #[should_panic(expected = "name must be 1-32 bytes")] fn mint_name_33_bytes_multibyte_rejected() {
    let name = format!("{}x", "🐶".repeat(8)); // 8 chars of emoji + 1 = 9 chars but 33 BYTES
    assert_eq!(name.len(), 33);
    let mut p = c(); ctx("alice", 0, N); p.mint_pet(name, H.into());
}
/// Exactly storage + PET_ACCOUNT_FUND is refused (strict >); one yocto more mints a
/// pet whose whole balance is 1 yocto, i.e. it is born asleep.
#[test] fn mint_with_account_fund_boundary() {
    // each scenario on a fresh contract (the mocked chain is thread-local), so every
    // mint stores exactly the same bytes
    fn fresh<R: Send + 'static>(f: impl FnOnce() -> R + Send + 'static) -> R { std::thread::spawn(f).join().unwrap() }
    let storage = fresh(|| { let mut p = c(); ctx("alice", 0, N); N - yocto(p.mint_pet("Mochi".into(), H.into()).balance) });
    let with = move |dep: u128| fresh(move || {
        let mut p = c(); ctx("alice", 0, dep);
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| p.mint_pet_with_account("Mochi".into(), H.into(), PK.parse().unwrap())))
            .map(|v| (yocto(v.balance), v.asleep)).map_err(|_| ())
    });
    assert!(with(storage + PET_ACCOUNT_FUND).is_err(), "exactly storage + fund is refused");
    assert_eq!(with(storage + PET_ACCOUNT_FUND + 1), Ok((1, true)), "1 yocto more: a pet born asleep with 1 yocto");
}
/// The pet-account bookkeeping written by mint_pet_with_account (pet_accounts entry +
/// raw `kh:` key) happens after mint_inner measured storage, so the contract pays it.
#[test] fn mint_with_account_extra_storage_is_paid_by_contract() {
    let mut p = c(); ctx("alice", 0, N);
    let before = env::storage_usage();
    let v = p.mint_pet_with_account("Mochi".into(), H.into(), PK.parse().unwrap());
    let used = env::storage_usage() - before;
    let charged = (N - PET_ACCOUNT_FUND - yocto(v.balance)) / env::storage_byte_cost().as_yoctonear();
    println!("mint_pet_with_account: {used} bytes used, {charged} bytes charged to the minter, {} unpaid", used as u128 - charged);
    assert!(used as u128 > charged && (used as u128 - charged) < 300, "unpaid bytes are small and bounded");
}

// ======================= unauthorized calls =======================

/// `#[private]` is enforced by the generated wasm entry point, which unit tests never go
/// through, so the attribute itself is checked statically here. The dynamic tests below
/// show the second line of defence: a stranger's direct call carries no promise result.
#[test] fn private_callbacks_are_marked_private() {
    let lib = include_str!("lib.rs");
    let meme = include_str!("meme.rs");
    for (src, f) in [(lib, "fn on_pet_account("), (lib, "fn on_pet_rekey("), (lib, "fn migrate("),
                     (lib, "fn nft_resolve_transfer("), (meme, "fn meme_on_payout(")] {
        let at = src.find(f).unwrap_or_else(|| panic!("{f} not found"));
        let head: Vec<&str> = src[..at].lines().rev().take(4).collect();
        assert!(head.iter().any(|l| l.trim() == "#[private]"), "{f} is not #[private]: {head:?}");
    }
}
#[test] fn stranger_on_pet_account_direct_call_panics() {
    let mut p = acct_pet();
    ctx("eve", 5, 0); // a direct tx: no promise results
    assert!(err(|| p.on_pet_account("0".into())).contains("InvalidPromiseResultIndex"));
    let v = p.get_pet("0".into()).unwrap();
    assert_eq!(v.pet_account.unwrap().as_str(), PET0, "pet account not unlinked");
    assert!(yocto(v.balance) < N - PET_ACCOUNT_FUND, "no free 0.1 NEAR credited");
}
#[test] fn stranger_on_pet_rekey_direct_call_panics() {
    let mut p = acct_pet();
    give(&mut p, "alice", "eve");
    ctx("eve", 5, 0);
    assert!(err(|| p.on_pet_rekey("0".into(), acc("evil-pet"), acc("eve"), U128(0))).contains("InvalidPromiseResultIndex"));
    assert_eq!(p.get_pet("0".into()).unwrap().pet_account.unwrap().as_str(), PET0);
}
#[test] fn stranger_meme_on_payout_direct_call_cannot_mint_jar_or_stake() {
    let mut p = settled_book();
    ctx("eve", 5, 0);
    assert!(err(|| p.meme_on_payout("j:0".into(), U128(u128::MAX / 2), None)).contains("InvalidPromiseResultIndex"));
    ctx("eve", 5, 0);
    assert!(err(|| p.meme_on_payout("s:0:eve.testnet".into(), U128(0), Some([U128(0), U128(10_000)]))).contains("InvalidPromiseResultIndex"));
    assert_eq!(jar(&p, "0"), 0);
    assert_eq!(p.meme_get_stake(U64(0), acc("eve")), [U128(0), U128(0)]);
}
#[test] fn stranger_admin_calls_all_rejected_and_config_unchanged() {
    let mut p = tee_pet();
    ctx("backend", 1, 0); p.charge("0".into(), NearToken::from_yoctonear(MILLI), H2.into());
    for who in ["eve", "backend", "alice"] {
        ctx(who, 2, 0); assert!(err(|| p.set_backend(acc(who))).contains("only the contract owner"));
        ctx(who, 2, 0); assert!(err(|| p.set_params(NearToken::from_yoctonear(0), U64(1))).contains("only the contract owner"));
        ctx(who, 2, 0); assert!(err(|| p.add_tee_signer("m".into(), format!("0x{}", "1".repeat(40)))).contains("only the contract owner"));
        ctx(who, 2, 0); assert!(err(|| p.remove_tee_signer(R_MODEL.into(), R_SIGNER.into())).contains("only the contract owner"));
        ctx(who, 2, 0); assert!(err(|| p.set_mpc(acc("evil"))).contains("only the contract owner"));
        ctx(who, 2, 0); assert!(err(|| p.withdraw_treasury()).contains("only the contract owner"));
        ctx(who, 2, 0); assert!(err(|| p.meme_init(acc("evil-token"), 1000, 1, 1, 60)).contains("only the owner"));
    }
    let cfg = p.get_config();
    assert_eq!((cfg.backend_id, cfg.sleep_threshold, cfg.hunger_ns, yocto(cfg.treasury)),
               (acc("backend"), NearToken::from_yoctonear(DEFAULT_SLEEP_THRESHOLD), U64(DEFAULT_HUNGER_NS), MILLI));
    assert_eq!(p.get_tee_signers(), vec![TeeSigner { model: R_MODEL.into(), address: R_SIGNER.into() }]);
    assert_eq!(p.get_mpc().as_str(), "v1.signer-prod.testnet");
    assert_eq!(p.meme_get_config(), None);
}
#[test] fn jar_claim_by_tipper_or_contract_owner_rejected() {
    let mut p = with_pet(); meme_on(&mut p); ft(&mut p, 1, "bob", 7, TIP0);
    for who in ["bob", "owner", "backend", SHZ] {
        ctx(who, 2, 0); assert!(err(|| p.meme_claim_jar("0".into())).contains("only the pet owner"));
    }
    assert_eq!(jar(&p, "0"), 7);
}
#[test] #[should_panic(expected = "only accepts its configured memecoin")] fn user_calls_ft_on_transfer_tip_directly() {
    let mut p = with_pet(); meme_on(&mut p);
    ctx("bob", 1, 0); p.ft_on_transfer(acc("bob"), U128(10u128.pow(30)), TIP0.into());
}
#[test] #[should_panic(expected = "only accepts its configured memecoin")] fn user_calls_ft_on_transfer_back_directly() {
    let mut p = meme_arena();
    ctx("bob", SEC, 0); p.ft_on_transfer(acc("bob"), U128(10u128.pow(30)), back(0, "1"));
}

// ======================= double claims / replay =======================

#[test] fn claim_jar_twice_pays_once() {
    let mut p = with_pet(); meme_on(&mut p); ft(&mut p, 1, "bob", 7, TIP0);
    ctx("alice", 2, 0); let _ = p.meme_claim_jar("0".into());
    assert_eq!(ft_paid(), vec![("alice.testnet".to_string(), 7)]);
    ctx("alice", 3, 0); assert!(err(|| p.meme_claim_jar("0".into())).contains("jar is empty"));
    assert!(ft_paid().is_empty());
}
#[test] fn claim_failed_restore_then_claim_again_pays_exactly_once_more() {
    let mut p = settled_book();
    let owed = p.meme_get_claimable(U64(0), acc("bob")).0;
    assert_eq!(owed, 148);
    ctx("bob", 3 * HOUR, 0); let _ = p.meme_claim(U64(0));
    assert_eq!(ft_paid(), vec![("bob.testnet".to_string(), owed)]);
    cb(3 * HOUR, vec![PromiseResult::Failed]);
    assert!(!p.meme_on_payout("s:0:bob.testnet".into(), U128(owed), Some([U128(0), U128(100)])));
    assert_eq!(p.meme_get_claimable(U64(0), acc("bob")).0, owed);
    ctx("bob", 4 * HOUR, 0); let _ = p.meme_claim(U64(0));
    assert_eq!(ft_paid(), vec![("bob.testnet".to_string(), owed)], "the retry pays the same amount once");
    cb(4 * HOUR, vec![PromiseResult::Successful(vec![])]);
    assert!(p.meme_on_payout("s:0:bob.testnet".into(), U128(owed), Some([U128(0), U128(100)])));
    assert_eq!(p.meme_get_stake(U64(0), acc("bob")), [U128(0), U128(0)], "success does not restore");
    ctx("bob", 5 * HOUR, 0); assert!(err(|| p.meme_claim(U64(0))).contains("nothing to claim"));
}
#[test] #[should_panic(expected = "book is not open")] fn void_book_twice() {
    let mut p = meme_arena(); ft(&mut p, SEC, "bob", 5, &back(0, "1"));
    ctx("x", 660 * SEC, 0); p.meme_void_book(U64(0));
    ctx("x", 661 * SEC, 0); p.meme_void_book(U64(0));
}
#[test] #[should_panic(expected = "book is not open")] fn void_settled_book() {
    let mut p = settled_book(); ctx("x", 100 * HOUR, 0); p.meme_void_book(U64(0));
}
/// A second arena round between the same pets (fresh replies 8/9) must not settle
/// the already-settled book again, change its winner or add a second rake.
#[test] fn second_arena_round_does_not_resettle_book() {
    let mut p = settled_book();
    let (b0, jar1) = (p.meme_get_book(U64(0)).unwrap(), jar(&p, "1"));
    for (id, n, prompt) in [("0", 8u8, R_PROMPT), ("1", 9, MOSS_PROMPT)] {
        let (rq, rs, sg) = raw(n); ctx("backend", HOUR + 1, 0);
        p.charge_verified(id.into(), NearToken::from_yoctonear(MILLI), prompt.into(), rq, sha(&rs), sg);
    }
    let e = [("0", 8u8), ("1", 9)].map(|(id, n)| { let (rq, rs, _) = raw(n); ArenaEntryInput { token_id: id.into(), request: rq, response: rs } });
    ctx("carol", 3 * HOUR, N / 10);
    let r = p.arena_settle("bone".into(), e.into());
    assert_eq!((r.id, r.winner.as_str()), (1, "0"), "Mochi wins round 2");
    assert_eq!(p.meme_get_book(U64(0)).unwrap(), b0, "book 0 keeps round 1's winner and rake");
    assert_eq!(jar(&p, "1"), jar1);
    assert_eq!(jar(&p, "0"), 0);
}
#[test] #[should_panic(expected = "closed for staking")] fn back_after_settle() {
    let mut p = settled_book(); ft(&mut p, 3 * HOUR, "eve", 1_000, &back(0, "1"));
}
#[test] #[should_panic(expected = "reply already charged")] fn same_reply_cannot_be_charged_to_two_pets() {
    let mut p = tee_pet();
    ctx("bob", 0, N); p.mint_pet("Mochi".into(), R_PROMPT_HASH.into()); // clone: same name + personality
    cv(&mut p, R_PROMPT, R_REQUEST, R_RESP_HASH, R_SIG);
    ctx("backend", HOUR, 0);
    p.charge_verified("1".into(), NearToken::from_yoctonear(MILLI), R_PROMPT.into(), R_REQUEST.into(), R_RESP_HASH.into(), R_SIG.into());
}
/// RISK: the reply is bound to (name, personality), not to the token id. A clone pet with
/// the same name + prompt can be charged a reply generated for the original first, and
/// then the original can never be charged (or enter the arena with) that reply.
#[test] fn clone_pet_can_take_anothers_reply_first() {
    let mut p = tee_pet();
    ctx("bob", 0, N); p.mint_pet("Mochi".into(), R_PROMPT_HASH.into());
    ctx("backend", HOUR, 0);
    let rec = p.charge_verified("1".into(), NearToken::from_yoctonear(MILLI), R_PROMPT.into(), R_REQUEST.into(), R_RESP_HASH.into(), R_SIG.into());
    assert_eq!(rec.token_id, "1");
    ctx("backend", HOUR, 0);
    assert!(err(|| p.charge_verified("0".into(), NearToken::from_yoctonear(MILLI), R_PROMPT.into(), R_REQUEST.into(), R_RESP_HASH.into(), R_SIG.into()))
        .contains("reply already charged"));
}

// ======================= overflow =======================

#[test] fn back_overflow_panics_and_leaves_book_unchanged() {
    let mut p = meme_arena();
    ft(&mut p, SEC, "bob", u128::MAX - 10, &back(0, "1"));
    let msg = err(|| ft(&mut p, SEC, "erin", 11, &back(0, "1")));
    assert!(msg.contains("overflow"), "{msg}");
    assert_eq!(totals(&p, 0), [0, u128::MAX - 10]);
    assert_eq!(p.meme_get_book(U64(0)).unwrap().backers, 1);
    assert_eq!(p.meme_get_stake(U64(0), acc("erin")), [U128(0), U128(0)]);
    // the same backer topping up past u128::MAX is refused too
    assert!(err(|| ft(&mut p, SEC, "bob", 11, &back(0, "1"))).contains("overflow"));
    assert_eq!(p.meme_get_stake(U64(0), acc("bob")), [U128(0), U128(u128::MAX - 10)]);
}
#[test] fn tip_overflow_panics_and_leaves_jar_unchanged() {
    let mut p = with_pet(); meme_on(&mut p);
    ft(&mut p, 1, "bob", u128::MAX, TIP0);
    assert!(err(|| ft(&mut p, 2, "carol", 1, TIP0)).contains("overflow"));
    assert_eq!(jar(&p, "0"), u128::MAX);
}
/// Within any realistic supply (here up to u128::MAX / 2000 per side) the payout rule
/// never overflows, pays winners at least their stake, and loses at most 1 unit of
/// dust per backer: sum(payouts) + rake <= pot.
#[test] fn payout_sweep_conserves_pot_large_values() {
    let mut x: u64 = 0xDEADBEEFCAFEF00D;
    let mut next = || { x ^= x << 13; x ^= x >> 7; x ^= x << 17; x };
    let cap = u128::MAX / 2000;
    for round in 0..400 {
        let k = 1 + (next() % 6) as usize;
        let scale = [1u128, 1_000, T, 1_000_000 * T, cap / 8][round % 5];
        let mut backers: Vec<[u128; 2]> = (0..k).map(|_| {
            let mut draw = || { let r = next() as u128; if scale > u64::MAX as u128 { scale / u64::MAX as u128 * r } else { r % (scale + 1) } };
            [draw(), draw()]
        }).collect();
        backers[0][0] = backers[0][0].max(1);
        let t = [backers.iter().map(|m| m[0]).sum::<u128>(), backers.iter().map(|m| m[1]).sum::<u128>()];
        for w in 0..2 {
            for rake_bps in [0u16, 1, 500, 1000] {
                let (_, rake) = payout(&BookState::Settled, Some(w), t, [0, 0], rake_bps);
                let paid: u128 = backers.iter().map(|m| {
                    let (amt, _) = payout(&BookState::Settled, Some(w), t, *m, rake_bps);
                    if t[0] > 0 && t[1] > 0 { assert!(amt >= m[w], "a winner never gets less than its stake"); }
                    amt
                }).sum();
                let pot = t[0] + t[1];
                assert!(paid + rake <= pot, "overpaid: {paid} + {rake} > {pot}");
                assert!(pot - paid - rake <= k as u128, "more than rounding dust lost");
            }
        }
    }
}
#[test]
fn payout_huge_totals_do_not_overflow() {
    let totals = [u128::MAX / 4, u128::MAX / 4];
    let mine = [[0, u128::MAX / 8], [0, u128::MAX / 8], [u128::MAX / 4, 0]];
    let (_, rake) = payout(&BookState::Settled, Some(1), totals, [0, 0], 500);
    let paid: u128 = mine.iter().map(|m| payout(&BookState::Settled, Some(1), totals, *m, 500).0).sum();
    assert!(paid + rake <= totals[0] + totals[1]);
}
#[test]
fn mul_div_with_divisor_above_2_pow_127() {
    let d = u128::MAX - 1;
    assert_eq!(mul_div(d - 1, d, d), d - 1);
}
#[test] fn mul_div_fallback_matches_exact_math_below_2_pow_127() {
    // checked_mul overflows, so the shift-and-add path runs; cross-check against a
    // 256-bit reference computed by hand: floor(a*b/d) with a <= d.
    let cases = [(u128::MAX / 3, u128::MAX / 5, u128::MAX / 3), (1u128 << 120, 1u128 << 126, 1u128 << 126), ((1u128 << 126) - 7, u128::MAX, (1u128 << 126) + 3)];
    for (a, b, d) in cases {
        let r = mul_div(a, b, d);
        // a <= d  =>  r <= b, and r*d <= a*b < (r+1)*d  checked via u128 limbs
        assert!(r <= b);
        let (hi, lo) = mul_wide(r, d);
        let (hi2, lo2) = mul_wide(a, b);
        assert!((hi, lo) <= (hi2, lo2), "r*d > a*b for {a} {b} {d}");
        let (hi3, lo3) = add_wide(hi, lo, d);
        assert!((hi3, lo3) > (hi2, lo2), "(r+1)*d <= a*b for {a} {b} {d}");
    }
}
fn mul_wide(a: u128, b: u128) -> (u128, u128) {
    let (a1, a0, b1, b0) = (a >> 64, a & u64::MAX as u128, b >> 64, b & u64::MAX as u128);
    let (p00, p01, p10, p11) = (a0 * b0, a0 * b1, a1 * b0, a1 * b1);
    let mid = (p00 >> 64) + (p01 & u64::MAX as u128) + (p10 & u64::MAX as u128);
    let lo = (p00 & u64::MAX as u128) | (mid << 64);
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    (hi, lo)
}
fn add_wide(hi: u128, lo: u128, x: u128) -> (u128, u128) { let (l, c) = lo.overflowing_add(x); (hi + c as u128, l) }

// ======================= failed callbacks / in-flight claims =======================

/// Jar claim in flight -> new tips arrive -> payout fails: the failed amount is added
/// back on top of the new tips (not overwritten), and only once.
#[test] fn failed_jar_payout_restores_once_and_keeps_new_tips() {
    let mut p = with_pet(); meme_on(&mut p);
    ft(&mut p, 1, "bob", 10, TIP0);
    ctx("alice", 2, 0); let _ = p.meme_claim_jar("0".into());
    assert_eq!(jar(&p, "0"), 0);
    ctx("alice", 2, 0); assert!(err(|| p.meme_claim_jar("0".into())).contains("jar is empty"), "nothing to claim while in flight");
    ft(&mut p, 3, "carol", 5, TIP0);
    cb(4, vec![PromiseResult::Failed]);
    assert!(!p.meme_on_payout("j:0".into(), U128(10), None));
    assert_eq!(jar(&p, "0"), 15);
    ctx("alice", 5, 0); let _ = p.meme_claim_jar("0".into());
    assert_eq!(ft_paid(), vec![("alice.testnet".to_string(), 15)]);
}
#[test] fn stake_claim_in_flight_then_fails_restores_exactly_once() {
    let mut p = settled_book();
    ctx("bob", 3 * HOUR, 0); let _ = p.meme_claim(U64(0));
    assert_eq!(p.meme_get_stake(U64(0), acc("bob")), [U128(0), U128(0)], "entry removed before the promise");
    assert_eq!(p.meme_get_claimable(U64(0), acc("bob")).0, 0);
    ctx("bob", 3 * HOUR, 0); assert!(err(|| p.meme_claim(U64(0))).contains("nothing to claim"));
    cb(3 * HOUR + 1, vec![PromiseResult::Failed]);
    p.meme_on_payout("s:0:bob.testnet".into(), U128(148), Some([U128(0), U128(100)]));
    assert_eq!(p.meme_get_stake(U64(0), acc("bob")), [U128(0), U128(100)], "restored to the original stake, not doubled");
    assert_eq!(p.meme_get_claimable(U64(0), acc("bob")).0, 148);
    // book totals and other backers never moved
    assert_eq!(totals(&p, 0), [50, 100]);
    assert_eq!(p.meme_get_stake(U64(0), acc("frank")), [U128(50), U128(0)]);
}
/// A jar payout to the seller that fails AFTER the sale is restored to the pet,
/// i.e. it now belongs to the buyer.
#[test] fn failed_jar_payout_after_sale_goes_to_new_owner() {
    let mut p = with_pet(); meme_on(&mut p); ft(&mut p, 1, "bob", 10, TIP0);
    ctx("alice", 2, 0); let _ = p.meme_claim_jar("0".into());
    give(&mut p, "alice", "carol");
    cb(4, vec![PromiseResult::Failed]);
    p.meme_on_payout("j:0".into(), U128(10), None);
    ctx("alice", 5, 0); assert!(err(|| p.meme_claim_jar("0".into())).contains("only the pet owner"));
    ctx("carol", 5, 0); let _ = p.meme_claim_jar("0".into());
    assert_eq!(ft_paid(), vec![("carol.testnet".to_string(), 10)]);
}
/// RISK: rekey while the mint's account creation is still in flight. If the mint's
/// create_account then fails, on_pet_account unlinks whatever account is current
/// (the freshly rekeyed one) and credits the 0.1 NEAR to the pet; the rekey
/// account's own 0.1 NEAR stays on an account whose key can no longer charge.
#[test] fn mint_account_failure_after_rekey_unlinks_rekeyed_account() {
    let mut p = acct_pet();
    let bal = yocto(p.get_pet("0".into()).unwrap().balance);
    rekey_ok(&mut p, "alice");
    assert_eq!(p.get_pet("0".into()).unwrap().pet_account.unwrap().as_str(), "pet-0-1.petri.testnet");
    cb(4, vec![PromiseResult::Failed]);
    assert!(!p.on_pet_account("0".into()));
    let v = p.get_pet("0".into()).unwrap();
    assert_eq!(v.pet_account, None, "rekeyed account unlinked");
    assert_eq!(yocto(v.balance), bal + PET_ACCOUNT_FUND);
}

// ======================= bad input =======================

#[test] #[should_panic(expected = "msg must be")] fn ft_msg_not_json() { let mut p = with_pet(); meme_on(&mut p); ft(&mut p, 1, "bob", 1, "tip 0"); }
#[test] #[should_panic(expected = "msg must be")] fn ft_msg_empty() { let mut p = with_pet(); meme_on(&mut p); ft(&mut p, 1, "bob", 1, ""); }
#[test] #[should_panic(expected = "msg must be")] fn ft_msg_missing_token_id() {
    let mut p = meme_arena(); ft(&mut p, SEC, "bob", 1, r#"{"action":"back","book_id":"0"}"#);
}
#[test] #[should_panic(expected = "msg must be")] fn ft_msg_numeric_book_id() {
    let mut p = meme_arena(); ft(&mut p, SEC, "bob", 1, r#"{"action":"back","book_id":0,"token_id":"1"}"#);
}
#[test] #[should_panic(expected = "msg must be")] fn ft_msg_numeric_token_id() {
    let mut p = with_pet(); meme_on(&mut p); ft(&mut p, 1, "bob", 1, r#"{"action":"tip","token_id":0}"#);
}
#[test] #[should_panic(expected = "back needs book_id")] fn ft_back_missing_book_id() {
    let mut p = meme_arena(); ft(&mut p, SEC, "bob", 1, r#"{"action":"back","token_id":"1"}"#);
}
#[test] #[should_panic(expected = "no such book")] fn ft_back_unknown_book() { let mut p = meme_arena(); ft(&mut p, SEC, "bob", 1, &back(7, "1")); }
#[test] #[should_panic(expected = "amount must be positive")] fn ft_zero_amount() { let mut p = with_pet(); meme_on(&mut p); ft(&mut p, 1, "bob", 0, TIP0); }
#[test] fn ft_tip_ignores_extra_fields_and_book_id() {
    let mut p = with_pet(); meme_on(&mut p);
    ft(&mut p, 1, "bob", 3, r#"{"action":"tip","token_id":"0","book_id":"99","evil":true}"#);
    assert_eq!(jar(&p, "0"), 3);
}
#[test] fn arena_challenge_validation() {
    let (mut p, _) = arena();
    for bad in ["", "two words", "puddle ", " puddle", "pud-dle", "puddle\n", &"a".repeat(33), "雨雨雨雨雨雨雨雨雨雨雨"] { // last: 11 chars, 33 bytes
        ctx("carol", HOUR, N / 10);
        let msg = err(|| p.arena_settle(bad.into(), vec![dummy("0"), dummy("1")]));
        assert!(msg.contains("challenge must be one word"), "{bad:?}: {msg}");
    }
}
/// Current behaviour: any Unicode alphanumeric word is a valid challenge, compared
/// case-insensitively against the question and the signed reply text.
#[test] fn arena_unicode_challenge_accepted() {
    let mut p = with_pet();
    ctx("bob", 0, N); p.mint_pet("Moss".into(), H2.into());
    let q = "Say the word PÛDDLE.";
    let (a, b) = ((arena_req("Mochi", q), arena_resp("pûddle!")), (arena_req("Moss", q), arena_resp("No.")));
    proved_at(&mut p, "0", &a.0, &a.1, 0); proved_at(&mut p, "1", &b.0, &b.1, 0);
    ctx("carol", HOUR, N / 10);
    let r = p.arena_settle("Pûddle".into(), vec![entry("0", &a.0, &a.1), entry("1", &b.0, &b.1)]);
    assert_eq!(r.winner, "0");
    assert_eq!(r.entries.iter().map(|e| e.has_word).collect::<Vec<_>>(), vec![true, false]);
}
#[test] fn arena_entry_count_must_be_two() {
    let (mut p, _) = arena();
    for n in [0usize, 1, 3] {
        ctx("carol", HOUR, N / 10);
        let es = (0..n).map(|i| dummy(&i.to_string())).collect();
        assert!(err(|| p.arena_settle("puddle".into(), es)).contains("exactly two entries"), "{n} entries");
    }
    assert_eq!(p.get_arena_count(), U64(0));
}
#[test] #[should_panic(expected = "request is not JSON")] fn arena_request_not_json() {
    let (mut p, e) = arena(); ctx("carol", HOUR, N / 10);
    p.arena_settle("puddle".into(), vec![entry("0", "not json", &e[0].response), entry("1", &e[1].request, &e[1].response)]);
}
#[test] #[should_panic(expected = "response is not JSON")] fn arena_response_not_json() {
    let (mut p, e) = arena(); ctx("carol", HOUR, N / 10);
    p.arena_settle("puddle".into(), vec![entry("0", &e[0].request, "<html>"), entry("1", &e[1].request, &e[1].response)]);
}
#[test] #[should_panic(expected = "request has no model")] fn arena_request_without_model() {
    let (mut p, e) = arena(); ctx("carol", HOUR, N / 10);
    p.arena_settle("puddle".into(), vec![entry("0", r#"{"messages":[]}"#, &e[0].response), entry("1", &e[1].request, &e[1].response)]);
}
#[test] #[should_panic(expected = "request is not JSON")] fn charge_verified_request_not_json() {
    let mut p = tee_pet(); cv(&mut p, R_PROMPT, "{not json", R_RESP_HASH, R_SIG);
}
#[test] #[should_panic(expected = "response_hash must be")] fn charge_verified_uppercase_response_hash() {
    let mut p = tee_pet(); cv(&mut p, R_PROMPT, R_REQUEST, &R_RESP_HASH.to_uppercase(), R_SIG);
}
#[test] #[should_panic(expected = "response_hash must be")] fn charge_verified_0x_response_hash() {
    let mut p = tee_pet(); cv(&mut p, R_PROMPT, R_REQUEST, &format!("0x{}", &R_RESP_HASH[2..]), R_SIG);
}
#[test] fn charge_verified_malformed_signatures_are_clean_errors() {
    let mut p = tee_pet();
    let flip_v = format!("{}1f", &R_SIG[..R_SIG.len() - 2]);
    for sig in ["", "0x", "0x1234", &R_SIG[..R_SIG.len() - 2], "zz".repeat(65).as_str(), flip_v.as_str()] {
        let msg = err(|| cv(&mut p, R_PROMPT, R_REQUEST, R_RESP_HASH, sig));
        assert!(msg.contains("bad TEE signature"), "{sig:?}: {msg}");
    }
    assert_eq!(p.get_pet("0".into()).unwrap().replies, 0);
}
#[test]
fn recover_eip191_non_ascii_signature_returns_none() {
    ctx("x", 0, 0);
    let sig = format!("a{}", "é".repeat(64)) + "a"; // even byte length, multibyte chars
    assert_eq!(recover_eip191("x", &sig), None);
}
#[test] fn set_prompt_and_tee_signer_hash_formats() {
    let mut p = with_pet();
    for bad in ["", "0x", &H[..63], &format!("{H}a"), &H.to_uppercase(), &format!("0x{}", &H[2..]), &"é".repeat(32)] {
        ctx("alice", 1, 0);
        assert!(err(|| p.set_prompt("0".into(), bad.to_string())).contains("prompt_hash must be"), "{bad:?}");
    }
    assert_eq!(p.get_pet("0".into()).unwrap().prompt_hash, H);
    for bad in ["0x123", "fe0071895500a9755c18044948ab4f4e1a7f337e00", &format!("1x{}", "a".repeat(40))] {
        ctx("owner", 1, 0);
        assert!(err(|| p.add_tee_signer("m".into(), bad.into())).contains("address must be"), "{bad:?}");
    }
    // current behaviour: non-hex chars pass the length check (harmless: can never be recovered)
    ctx("owner", 1, 0); p.add_tee_signer("m".into(), format!("0x{}", "z".repeat(40)));
    assert_eq!(p.get_tee_signers().len(), 1);
}
#[test] #[should_panic(expected = "only the pet owner can rekey")] fn rekey_by_stranger_who_never_owned() {
    let mut p = acct_pet(); ctx("eve", 2, PET_ACCOUNT_FUND); let _ = p.rekey_pet("0".into(), PK2.parse().unwrap());
}
#[test] #[should_panic(expected = "pet not found")] fn rekey_nonexistent_pet() {
    let mut p = acct_pet(); ctx("alice", 2, PET_ACCOUNT_FUND); let _ = p.rekey_pet("9".into(), PK2.parse().unwrap());
}

// ======================= storage griefing =======================

/// Every distinct backer adds one stake entry that NOBODY pays storage for
/// (ft_on_transfer cannot take a NEAR deposit): growth is constant per backer.
#[test] fn storage_per_one_yocto_backer_is_bounded_and_unpaid() {
    let mut p = meme_arena();
    let mut per = Vec::new();
    for i in 0..200 {
        let who = format!("b{i:05}"); // same length ids
        ctx(SHZ, SEC, 0);
        let before = env::storage_usage();
        let _ = p.ft_on_transfer(acc(&who), U128(1), back(0, if i % 2 == 0 { "0" } else { "1" }));
        per.push(env::storage_usage() - before);
    }
    let (min, max) = (*per.iter().min().unwrap(), *per.iter().max().unwrap());
    let yocto_per = max as u128 * env::storage_byte_cost().as_yoctonear();
    println!("storage per 1-yocto backer: {min}..{max} bytes = {yocto_per} yocto; 10k backers lock {} milliNEAR of the contract's balance",
             yocto_per * 10_000 / MILLI);
    assert_eq!(min, max, "constant per backer");
    assert!(max < 200, "bounded: {max} bytes/backer");
    assert_eq!(p.meme_get_book(U64(0)).unwrap().backers, 200);
    assert_eq!(totals(&p, 0), [100, 100]);
    // a repeat backer adds nothing
    ctx(SHZ, SEC, 0); let before = env::storage_usage();
    let _ = p.ft_on_transfer(acc("b00000"), U128(1), back(0, "1"));
    assert_eq!(env::storage_usage(), before);
}
#[test] #[should_panic(expected = "for storage")] fn open_book_without_deposit() {
    let mut p = c(); meme_on(&mut p);
    ctx("alice", 0, N); p.mint_pet("Mochi".into(), H.into());
    ctx("alice", 0, N); p.mint_pet("Moss".into(), H2.into());
    ctx("dave", 0, 0); p.meme_open_book("0".into(), "1".into(), 60);
}
#[test] #[should_panic(expected = "for storage")] fn open_book_one_yocto_short() {
    let mut p = c(); meme_on(&mut p);
    ctx("alice", 0, N); p.mint_pet("Mochi".into(), H.into());
    ctx("alice", 0, N); p.mint_pet("Moss".into(), H2.into());
    for name in ["Pip", "Pop", "Ann", "Bea"] { ctx("alice", 0, N); p.mint_pet(name.into(), H.into()); }
    ctx("dave", 0, N / 100); p.meme_open_book("0".into(), "1".into(), 60); // book 0 also creates the counter key
    ctx("dave", 0, N / 100);
    let before = env::storage_usage();
    p.meme_open_book("2".into(), "3".into(), 60);
    let cost = (env::storage_usage() - before) as u128 * env::storage_byte_cost().as_yoctonear();
    // same-shaped book for another pair, one yocto short
    ctx("dave", 0, cost - 1); p.meme_open_book("4".into(), "5".into(), 60);
}
/// FIXED: a losing backer's payout is 0; meme_claim now clears the stake entry (freeing
/// its storage) and returns Value(false) without an ft_transfer, instead of panicking
/// "nothing to pay" and leaving the entry stored forever.
#[test] fn losing_backer_claim_clears_stake() {
    let mut p = settled_book(); // frank backed the loser
    assert_eq!(p.meme_get_claimable(U64(0), acc("frank")).0, 0);
    assert_ne!(p.meme_get_stake(U64(0), acc("frank")), [U128(0), U128(0)]);
    ctx("frank", 3 * HOUR, 0);
    let before = env::storage_usage();
    assert!(matches!(p.meme_claim(U64(0)), PromiseOrValue::Value(false)));
    assert!(env::storage_usage() < before, "stake entry storage freed");
    assert!(get_logs().iter().any(|l| l.contains("stake cleared: nothing to pay")));
    assert_eq!(p.meme_get_stake(U64(0), acc("frank")), [U128(0), U128(0)]);
    assert!(ft_paid().is_empty());
    ctx("frank", 3 * HOUR, 0);
    assert!(err(|| p.meme_claim(U64(0))).contains("nothing to claim"));
}
/// A winning backer can never round down to 0: pot >= winning total (rake <= 10% of
/// the losing side), so payout >= stake >= 1.
#[test] fn one_yocto_winning_backer_is_paid() {
    let mut p = meme_arena();
    ft(&mut p, SEC, "bob", 1, &back(0, "1"));
    ft(&mut p, SEC, "erin", 1_000_000 * T, &back(0, "1"));
    ft(&mut p, SEC, "frank", 3, &back(0, "0"));
    charge_and_settle(&mut p);
    assert_eq!(p.meme_get_claimable(U64(0), acc("bob")).0, 1);
    ctx("bob", 3 * HOUR, 0); let _ = p.meme_claim(U64(0));
    assert_eq!(ft_paid(), vec![("bob.testnet".to_string(), 1)]);
}
/// FINDING: rounding dust from pro-rata payouts stays in the contract with no sweep.
#[test] fn rounding_dust_is_locked_forever() {
    let mut p = meme_arena();
    for who in ["bob", "erin", "gus"] { ft(&mut p, SEC, who, 1, &back(0, "1")); }
    ft(&mut p, SEC, "frank", 1, &back(0, "0"));
    charge_and_settle(&mut p);
    let b = p.meme_get_book(U64(0)).unwrap();
    assert_eq!(b.rake.0, 0, "5% of 1 rounds to 0");
    let paid: u128 = ["bob", "erin", "gus"].iter().map(|w| p.meme_get_claimable(U64(0), acc(w)).0).sum();
    assert_eq!(paid, 3, "each gets floor(4/3) = 1");
    assert_eq!(4 - paid - b.rake.0, 1, "1 unit of the pot is unclaimable");
}

// ======================= arena settlement choice =======================

/// RISK: arena_settle is permissionless and settles the open book with the FIRST
/// qualifying round between the pair. Whoever settles picks WHICH charged replies
/// (charged after close) enter, so a pet owner who charged several replies to the
/// same question can choose the outcome of the book.
#[test] fn settler_picks_which_replies_decide_the_book() {
    let mut p = c(); meme_on(&mut p);
    ctx("alice", 0, N); p.mint_pet("Mochi".into(), H.into());
    ctx("bob", 0, N); p.mint_pet("Moss".into(), H2.into());
    ctx("dave", 0, N / 100); p.meme_open_book("0".into(), "1".into(), 60);
    ft(&mut p, SEC, "alice", 1_000, &back(0, "0"));
    ft(&mut p, SEC, "bob", 1_000, &back(0, "1"));
    let q = Q;
    let long0 = (arena_req("Mochi", q), arena_resp("Rain fills every puddle with tiny drums!"));
    let short0 = (arena_req("Mochi", &format!("{q} ")), arena_resp("Puddle!")); // a second, distinct charged reply
    let mid1 = (arena_req("Moss", q), arena_resp("A puddle sighs."));
    let short1 = (arena_req("Moss", &format!("{q} ")), arena_resp("A puddle sighs."));
    for (t, r) in [("0", &long0), ("0", &short0), ("1", &mid1), ("1", &short1)] { proved_at(&mut p, t, &r.0, &r.1, HOUR); }
    // both pairings are valid; with the long Mochi reply Moss would win:
    let honest = [ArenaEntry { token_id: "0".into(), reply_hash: H.into(), has_word: true, chars: 40 },
                  ArenaEntry { token_id: "1".into(), reply_hash: H.into(), has_word: true, chars: 15 }];
    assert_eq!(arena_winner(&honest), 1);
    // ...but alice settles first with the pair where her short reply wins
    ctx("alice", 2 * HOUR, N / 10);
    let r = p.arena_settle("puddle".into(), vec![entry("0", &short0.0, &short0.1), entry("1", &short1.0, &short1.1)]);
    assert_eq!(r.winner, "0");
    let b = p.meme_get_book(U64(0)).unwrap();
    assert_eq!((b.state, b.winner.as_deref()), (BookState::Settled, Some("0")));
    assert_eq!(p.meme_get_claimable(U64(0), acc("alice")).0, 1_950);
}

// ======================= pet sale =======================

#[test] fn seller_locked_out_of_everything_after_sale() {
    let mut p = acct_pet(); meme_on(&mut p);
    ft(&mut p, 1, "fan", 42, TIP0);
    give(&mut p, "alice", "bob");
    let tries: Vec<(&str, String)> = vec![
        ("only the pet owner can feed", { ctx("alice", 2, N); err(|| p.feed("0".into())) }),
        ("only the pet owner can change", { ctx("alice", 2, 0); err(|| p.set_prompt("0".into(), H2.into())) }),
        ("only the pet owner can rekey", { ctx("alice", 2, PET_ACCOUNT_FUND); err(|| p.rekey_pet("0".into(), PK2.parse().unwrap())) }),
        ("only the pet owner can claim its jar", { ctx("alice", 2, 0); err(|| p.meme_claim_jar("0".into())) }),
        ("only the pet owner can sign", { ctx("alice", 2, 1); err(|| p.request_foreign_signature("0".into(), H.into())) }),
        ("set by a previous owner", err(|| cv_as(&mut p, PET0))),
    ];
    for (want, got) in tries { assert!(got.contains(want), "want {want:?}, got {got:?}"); }
    assert_eq!(jar(&p, "0"), 42);
    let new_acc = rekey_ok(&mut p, "bob");
    assert!(p.get_pet("0".into()).unwrap().pet_key_active);
    assert_eq!(cv_as(&mut p, new_acc.as_str()).index, 0);
    ctx("bob", 5, 0); let _ = p.meme_claim_jar("0".into());
    assert_eq!(ft_paid(), vec![("bob.testnet".to_string(), 42)]);
}
#[test] #[should_panic(expected = "Current and next owner must differ")] fn nft_transfer_to_self() {
    let mut p = acct_pet(); ctx("alice", 1, 1); p.nft_transfer(acc("alice"), "0".into(), None, None);
}
#[test] #[should_panic(expected = "Token not found")] fn nft_transfer_nonexistent_token() {
    let mut p = acct_pet(); ctx("alice", 1, 1); p.nft_transfer(acc("bob"), "42".into(), None, None);
}
#[test] fn failed_self_transfer_does_not_freeze_key() {
    // Unit tests don't roll back, so this checks the pin itself is harmless: the key
    // holder pinned before the panic is still the current owner.
    let mut p = acct_pet();
    ctx("alice", 1, 1); err(|| p.nft_transfer(acc("alice"), "0".into(), None, None));
    assert!(p.get_pet("0".into()).unwrap().pet_key_active);
    let _ = get_logs();
}
