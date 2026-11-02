use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;

const N: u128 = ONE_NEAR;
const H: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const H2: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HOUR: u64 = 3_600_000_000_000;

fn acc(s: &str) -> AccountId { format!("{s}.testnet").parse().unwrap() }
fn ctx(who: &str, t: u64, dep: u128) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc("petri"))
        .predecessor_account_id(acc(who))
        .block_timestamp(t)
        .attached_deposit(NearToken::from_yoctonear(dep))
        .build());
}
fn yocto(t: NearToken) -> u128 { t.as_yoctonear() }
fn c() -> Petri { ctx("owner", 0, 0); Petri::new(acc("owner"), acc("backend")) }
/// Contract with alice's pet "0" minted with 1 NEAR at t=0.
fn with_pet() -> Petri { let mut p = c(); ctx("alice", 0, N); p.mint_pet("Mochi".into(), H.into()); p }

#[test] fn mint_sets_balance_minus_storage() {
    let mut p = c();
    ctx("alice", 0, N);
    let v = p.mint_pet("Mochi".into(), H.into());
    assert_eq!(v.token_id, "0");
    assert_eq!(v.owner_id, acc("alice"));
    assert_eq!(v.prompt_hash, H);
    assert!(!v.asleep);
    let b = yocto(v.balance);
    assert!(b < N && b > N - N / 100, "storage should cost a small slice, got {b}");
    assert_eq!(v.pet_account, "pet-0.petri.testnet");
    assert!(get_logs().iter().any(|l| l.contains("nft_mint")));
    assert!(get_logs().iter().any(|l| l.contains("STUB pet sub-account planned: pet-0.petri.testnet")));
}

#[test] fn mint_is_nep171_token() {
    let mut p = with_pet();
    ctx("bob", 0, N); p.mint_pet("Pip".into(), H2.into());
    let t = p.nft_token("0".into()).unwrap();
    assert_eq!(t.owner_id, acc("alice"));
    let m = t.metadata.unwrap();
    assert_eq!(m.title.as_deref(), Some("Mochi"));
    assert!(m.extra.unwrap().contains(H));
    assert_eq!(p.nft_total_supply(), U128(2));
    assert_eq!(p.nft_supply_for_owner(acc("bob")), U128(1));
    assert_eq!(p.nft_tokens_for_owner(acc("bob"), None, None)[0].token_id, "1");
    assert_eq!(p.nft_metadata().symbol, "PETRI");
    assert_eq!(p.get_config().total_pets, 2);
}

#[test] #[should_panic(expected = "attach more than storage cost")] fn mint_without_deposit() {
    let mut p = c(); ctx("alice", 0, 0); p.mint_pet("Mochi".into(), H.into());
}
#[test] #[should_panic(expected = "attach more than storage cost")] fn mint_dust_deposit() {
    let mut p = c(); ctx("alice", 0, 1000); p.mint_pet("Mochi".into(), H.into());
}
#[test] #[should_panic(expected = "prompt_hash must be")] fn mint_bad_hash() {
    let mut p = c(); ctx("alice", 0, N); p.mint_pet("Mochi".into(), "XYZ".into());
}
#[test] #[should_panic(expected = "prompt_hash must be")] fn mint_uppercase_hash() {
    let mut p = c(); ctx("alice", 0, N); p.mint_pet("Mochi".into(), H.to_uppercase());
}
#[test] #[should_panic(expected = "name must be")] fn mint_empty_name() {
    let mut p = c(); ctx("alice", 0, N); p.mint_pet("".into(), H.into());
}
#[test] #[should_panic(expected = "name must be")] fn mint_long_name() {
    let mut p = c(); ctx("alice", 0, N); p.mint_pet("x".repeat(33), H.into());
}

#[test] fn feed_adds_balance_and_resets_hunger() {
    let mut p = with_pet();
    let b0 = yocto(p.get_pet("0".into()).unwrap().balance);
    ctx("alice", 20 * HOUR, N / 2);
    let v = p.feed("0".into());
    assert_eq!(yocto(v.balance), b0 + N / 2);
    assert_eq!(v.last_fed_ns, U64(20 * HOUR));
    // 30h after mint but only 10h after feeding: still awake
    ctx("x", 30 * HOUR, 0);
    assert!(!p.is_asleep("0".into()));
}
#[test] #[should_panic(expected = "only the pet owner")] fn feed_by_stranger() {
    let mut p = with_pet(); ctx("bob", 1, N); p.feed("0".into());
}
#[test] #[should_panic(expected = "attach NEAR")] fn feed_zero() {
    let mut p = with_pet(); ctx("alice", 1, 0); p.feed("0".into());
}
#[test] #[should_panic(expected = "pet not found")] fn feed_missing_pet() {
    let mut p = with_pet(); ctx("alice", 1, N); p.feed("9".into());
}
#[test] #[should_panic(expected = "revive it first")] fn feed_sleeping_pet() {
    let mut p = with_pet(); ctx("alice", 25 * HOUR, N); p.feed("0".into());
}

#[test] fn charge_debits_and_records_reply() {
    let mut p = with_pet();
    let b0 = yocto(p.get_pet("0".into()).unwrap().balance);
    let cost = N / 1000;
    ctx("backend", HOUR, 0);
    let r = p.charge("0".into(), NearToken::from_yoctonear(cost), H2.into());
    assert_eq!(r, ReplyRecord { token_id: "0".into(), index: 0, cost: NearToken::from_yoctonear(cost), at_ns: U64(HOUR) });
    let v = p.get_pet("0".into()).unwrap();
    assert_eq!(v.replies, 1);
    assert_eq!(v.last_reply_hash.as_deref(), Some(H2));
    let spent = b0 - yocto(v.balance);
    assert!(spent > cost && spent < cost + N / 100, "cost + receipt storage, got {spent}");
    assert_eq!(p.get_reply(H2.into()), Some(r));
    assert_eq!(p.get_reply(H.into()), None);
    assert_eq!(yocto(p.get_config().treasury), cost);

    let h3 = "c".repeat(64);
    let r2 = p.charge("0".into(), NearToken::from_yoctonear(cost), h3.clone());
    assert_eq!(r2.index, 1);
    assert_eq!(p.get_pet("0".into()).unwrap().replies, 2);
    assert_eq!(yocto(p.get_config().treasury), 2 * cost);
}
#[test] #[should_panic(expected = "only the backend")] fn charge_by_owner() {
    let mut p = with_pet(); ctx("alice", 1, 0); p.charge("0".into(), NearToken::from_yoctonear(1), H2.into());
}
#[test] #[should_panic(expected = "only the backend")] fn charge_by_contract_owner() {
    let mut p = with_pet(); ctx("owner", 1, 0); p.charge("0".into(), NearToken::from_yoctonear(1), H2.into());
}
#[test] #[should_panic(expected = "reply already charged")] fn charge_duplicate_hash() {
    let mut p = with_pet(); ctx("backend", 1, 0);
    p.charge("0".into(), NearToken::from_yoctonear(1), H2.into());
    p.charge("0".into(), NearToken::from_yoctonear(1), H2.into());
}
#[test] #[should_panic(expected = "reply_hash must be")] fn charge_bad_hash() {
    let mut p = with_pet(); ctx("backend", 1, 0); p.charge("0".into(), NearToken::from_yoctonear(1), "nope".into());
}
#[test] #[should_panic(expected = "insufficient pet balance")] fn charge_more_than_balance() {
    let mut p = with_pet(); ctx("backend", 1, 0); p.charge("0".into(), NearToken::from_yoctonear(2 * N), H2.into());
}
#[test] #[should_panic(expected = "pet is asleep")] fn charge_hungry_pet() {
    let mut p = with_pet(); ctx("backend", 25 * HOUR, 0); p.charge("0".into(), NearToken::from_yoctonear(1), H2.into());
}
#[test] #[should_panic(expected = "pet not found")] fn charge_missing_pet() {
    let mut p = with_pet(); ctx("backend", 1, 0); p.charge("7".into(), NearToken::from_yoctonear(1), H2.into());
}
#[test] fn charge_guard_fails_before_state_change() {
    // Unit tests don't roll back on panic, so check validation runs before any write.
    let mut p = with_pet(); ctx("backend", 1, 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        p.charge("0".into(), NearToken::from_yoctonear(1), "bad".into());
    }));
    assert!(r.is_err());
    assert_eq!(p.get_pet("0".into()).unwrap().replies, 0);
}

#[test] fn sleeps_when_balance_below_threshold() {
    let mut p = with_pet();
    let b = yocto(p.get_pet("0".into()).unwrap().balance);
    ctx("backend", 1, 0);
    // drain to just under the 0.01 NEAR threshold (leave room for receipt storage)
    p.charge("0".into(), NearToken::from_yoctonear(b - DEFAULT_SLEEP_THRESHOLD), H2.into());
    let v = p.get_pet("0".into()).unwrap();
    assert!(yocto(v.balance) < DEFAULT_SLEEP_THRESHOLD);
    assert!(v.asleep);
    assert!(p.is_asleep("0".into()));
}
#[test] fn sleeps_when_hunger_elapsed() {
    let p = with_pet();
    ctx("x", 24 * HOUR, 0); assert!(!p.is_asleep("0".into()));
    ctx("x", 24 * HOUR + 1, 0); assert!(p.is_asleep("0".into()));
}
#[test] #[should_panic(expected = "pet not found")] fn is_asleep_missing() { let p = with_pet(); p.is_asleep("5".into()); }
#[test] fn asleep_rule_table() {
    assert!(!asleep_rule(10, 10, 0, 5, 5));
    assert!(asleep_rule(9, 10, 0, 5, 5));
    assert!(asleep_rule(10, 10, 0, 6, 5));
    assert!(!asleep_rule(10, 10, 100, 0, 5)); // clock before last_fed: saturates, awake
}

#[test] fn revive_by_stranger_tip() {
    let mut p = with_pet();
    let b0 = yocto(p.get_pet("0".into()).unwrap().balance);
    ctx("bob", 30 * HOUR, N / 10);
    let v = p.revive("0".into());
    assert!(!v.asleep);
    assert_eq!(v.revives, 1);
    assert_eq!(yocto(v.balance), b0 + N / 10);
    assert_eq!(v.last_fed_ns, U64(30 * HOUR));
    assert!(get_logs().iter().any(|l| l.contains("revived pet 0 by bob.testnet")));
    // owner can feed again once awake
    ctx("alice", 31 * HOUR, 1); p.feed("0".into());
}
#[test] fn revive_broke_pet_needs_threshold() {
    let mut p = with_pet();
    let b = yocto(p.get_pet("0".into()).unwrap().balance);
    ctx("backend", 1, 0);
    p.charge("0".into(), NearToken::from_yoctonear(b - DEFAULT_SLEEP_THRESHOLD), H2.into());
    let left = yocto(p.get_pet("0".into()).unwrap().balance);
    ctx("bob", 2, 1);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { p.revive("0".into()); })).is_err());
    ctx("bob", 2, DEFAULT_SLEEP_THRESHOLD - left);
    let v = p.revive("0".into());
    assert_eq!(yocto(v.balance), DEFAULT_SLEEP_THRESHOLD);
    assert!(!v.asleep);
}
#[test] #[should_panic(expected = "pet is awake")] fn revive_awake_pet() {
    let mut p = with_pet(); ctx("bob", 1, N); p.revive("0".into());
}
#[test] #[should_panic(expected = "tip too small")] fn revive_zero_tip() {
    let mut p = with_pet();
    let b = yocto(p.get_pet("0".into()).unwrap().balance);
    ctx("backend", 1, 0);
    p.charge("0".into(), NearToken::from_yoctonear(b - DEFAULT_SLEEP_THRESHOLD), H2.into());
    ctx("bob", 2, 0); p.revive("0".into());
}

#[test] fn balance_follows_nft_transfer() {
    let mut p = with_pet();
    let b = p.get_pet("0".into()).unwrap().balance;
    ctx("alice", 1, 1);
    p.nft_transfer(acc("bob"), "0".into(), None, None);
    let v = p.get_pet("0".into()).unwrap();
    assert_eq!(v.owner_id, acc("bob"));
    assert_eq!(v.balance, b);
    ctx("bob", 2, N); p.feed("0".into());
}
#[test] #[should_panic(expected = "only the pet owner")] fn old_owner_cannot_feed_after_transfer() {
    let mut p = with_pet();
    ctx("alice", 1, 1); p.nft_transfer(acc("bob"), "0".into(), None, None);
    ctx("alice", 2, N); p.feed("0".into());
}
#[test] #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")] fn transfer_needs_one_yocto() {
    let mut p = with_pet(); ctx("alice", 1, 0); p.nft_transfer(acc("bob"), "0".into(), None, None);
}

#[test] fn admin_set_backend_and_params() {
    let mut p = with_pet();
    ctx("owner", 1, 0);
    p.set_backend(acc("newbackend"));
    p.set_params(NearToken::from_yoctonear(5 * N), U64(HOUR));
    let cfg = p.get_config();
    assert_eq!(cfg.backend_id, acc("newbackend"));
    assert_eq!(cfg.hunger_ns, U64(HOUR));
    assert!(p.is_asleep("0".into()), "1 NEAR pet is under the new 5 NEAR threshold");
    ctx("owner", 1, 0); p.set_params(NearToken::from_yoctonear(0), U64(HOUR));
    ctx("newbackend", 2, 0); p.charge("0".into(), NearToken::from_yoctonear(1), H2.into());
}
#[test] #[should_panic(expected = "only the contract owner")] fn set_backend_by_stranger() {
    let mut p = c(); ctx("alice", 0, 0); p.set_backend(acc("alice"));
}
#[test] #[should_panic(expected = "only the contract owner")] fn set_params_by_stranger() {
    let mut p = c(); ctx("alice", 0, 0); p.set_params(NearToken::from_yoctonear(0), U64(1));
}
#[test] #[should_panic(expected = "hunger_ns must be > 0")] fn set_params_zero_hunger() {
    let mut p = c(); ctx("owner", 0, 0); p.set_params(NearToken::from_yoctonear(0), U64(0));
}

#[test] fn withdraw_treasury_resets() {
    let mut p = with_pet();
    ctx("backend", 1, 0); p.charge("0".into(), NearToken::from_yoctonear(N / 1000), H2.into());
    ctx("owner", 2, 0); let _ = p.withdraw_treasury();
    assert_eq!(yocto(p.get_config().treasury), 0);
}
#[test] #[should_panic(expected = "treasury empty")] fn withdraw_empty() { let mut p = c(); ctx("owner", 0, 0); p.withdraw_treasury(); }
#[test] #[should_panic(expected = "only the contract owner")] fn withdraw_by_stranger() { let mut p = c(); ctx("bob", 0, 0); p.withdraw_treasury(); }

#[test] fn hash_validation() {
    assert!(is_valid_hash(H));
    assert!(is_valid_hash(&"0123456789abcdef".repeat(4)));
    assert!(!is_valid_hash(&"g".repeat(64)));
    assert!(!is_valid_hash(&"a".repeat(63)));
    assert!(!is_valid_hash(""));
}

#[test] fn conservation_property() {
    // deterministic sweep: attached deposits == pet balances + treasury + storage paid.
    // The mocked storage_usage resets with every testing_env!, so measure per call.
    let mut p = c();
    let mut x: u64 = 0x9E3779B97F4A7C15;
    let mut next = || { x ^= x << 13; x ^= x >> 7; x ^= x << 17; x };
    let (mut attached, mut bytes) = (0u128, 0u64);
    for i in 0..20u64 {
        let dep = N / 10 + (next() % 1000) as u128 * N / 1000;
        ctx(if i % 2 == 0 { "alice" } else { "bob" }, i, dep); attached += dep;
        let s = env::storage_usage();
        p.mint_pet(format!("p{i}"), format!("{:064x}", i));
        bytes += env::storage_usage() - s;
        ctx(if i % 2 == 0 { "alice" } else { "bob" }, i, dep / 2); attached += dep / 2;
        p.feed(i.to_string());
        for j in 0..3u64 {
            ctx("backend", i, 0);
            let cost = (next() % 1000) as u128 * N / 1_000_000;
            let s = env::storage_usage();
            p.charge(i.to_string(), NearToken::from_yoctonear(cost), format!("{:064x}", 1_000_000 + i * 10 + j));
            bytes += env::storage_usage() - s;
        }
    }
    let storage = bytes as u128 * env::storage_byte_cost().as_yoctonear();
    let balances: u128 = (0..20u64).map(|i| yocto(p.get_pet(i.to_string()).unwrap().balance)).sum();
    assert_eq!(balances + yocto(p.get_config().treasury) + storage, attached);
}
