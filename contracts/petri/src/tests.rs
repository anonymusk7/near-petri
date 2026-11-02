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
    assert_eq!(v.pet_account, None);
    assert!(get_logs().iter().any(|l| l.contains("nft_mint")));
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

// ---------- on-chain TEE verification, against a REAL recorded NEAR AI Cloud reply ----------
// Values from examples/recorded/reply-1.json (DeepSeek-V4.1-Flash-1017, provider_tee ECDSA).
const R_PROMPT: &str = "Cheerful moss creature who loves rain.";
const R_PROMPT_HASH: &str = "d691db075710cfc9e33cbdebc2e3c60d64c77aed02aa383c9f0c9a3ee083871b";
const R_MODEL: &str = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
const R_REQUEST: &str = r#"{"model":"deepseek-ai/DeepSeek-V4.1-Flash-1017","messages":[{"role":"system","content":"You are Mochi, a Petri pet living on NEAR. Cheerful moss creature who loves rain. Answer in at most two short sentences."},{"role":"user","content":"Hi Mochi! What did you do today?"}],"max_tokens":400,"stream":false}"#;
const R_RESP_HASH: &str = "4a8a750dc550e2d2dd186bc474fb15e7d21f56f30ff0598b744ba696569c3342";
const R_SIG: &str = "0x38a268f28dd1771a96708b8568f3275495ef1eb9e15c2a96984d10ccddb26f55482039de99771e0f44e7289a14082a59c7ad17b093ded91d999c0041561a14ee1c";
const R_SIGNER: &str = "0xfe0071895500a9755c18044948ab4f4e1a7f337e";
const MILLI: u128 = N / 1000;

fn tee_pet() -> Petri {
    let mut p = c();
    ctx("owner", 0, 0);
    p.add_tee_signer(R_MODEL.into(), "0xFE0071895500A9755C18044948AB4f4e1A7f337e".into());
    ctx("alice", 0, N);
    p.mint_pet("Mochi".into(), R_PROMPT_HASH.into());
    p
}
fn cv(p: &mut Petri, prompt: &str, req: &str, resp: &str, sig: &str) -> ReplyRecord {
    ctx("backend", HOUR, 0);
    p.charge_verified("0".into(), NearToken::from_yoctonear(MILLI), prompt.into(), req.into(), resp.into(), sig.into())
}

#[test] fn ecrecover_real_near_ai_signature() {
    ctx("x", 0, 0);
    let text = format!("{R_MODEL}:45f0ca8cdd467cc8877f56cbcf9ceb0b8bf7fc824feacbf85f6a2a7e47ec3d95:{R_RESP_HASH}");
    assert_eq!(recover_eip191(&text, R_SIG).as_deref(), Some(R_SIGNER));
}
#[test] fn charge_verified_real_reply_ok() {
    let mut p = tee_pet();
    let before = yocto(p.get_pet("0".into()).unwrap().balance);
    let rec = cv(&mut p, R_PROMPT, R_REQUEST, R_RESP_HASH, R_SIG);
    assert_eq!(rec.index, 0);
    let pet = p.get_pet("0".into()).unwrap();
    assert!(yocto(pet.balance) < before - MILLI + 1);
    let h = pet.last_reply_hash.unwrap();
    let proof = p.get_tee_proof(h).unwrap();
    assert_eq!(proof.signer, R_SIGNER);
    assert_eq!(proof.request_hash, "45f0ca8cdd467cc8877f56cbcf9ceb0b8bf7fc824feacbf85f6a2a7e47ec3d95");
}
#[test] #[should_panic(expected = "registered NEAR AI TEE signer")] fn charge_verified_tampered_response() {
    let mut p = tee_pet();
    cv(&mut p, R_PROMPT, R_REQUEST, &R_RESP_HASH.replace("4a8a", "4a8b"), R_SIG);
}
#[test] #[should_panic(expected = "registered NEAR AI TEE signer")] fn charge_verified_tampered_request() {
    let mut p = tee_pet();
    cv(&mut p, R_PROMPT, &R_REQUEST.replace("Hi Mochi", "Hi M0chi"), R_RESP_HASH, R_SIG);
}
#[test] #[should_panic(expected = "registered NEAR AI TEE signer")] fn charge_verified_unregistered_signer() {
    let mut p = tee_pet();
    ctx("owner", 0, 0);
    p.remove_tee_signer(R_MODEL.into(), R_SIGNER.into());
    cv(&mut p, R_PROMPT, R_REQUEST, R_RESP_HASH, R_SIG);
}
#[test] #[should_panic(expected = "prompt_hash")] fn charge_verified_wrong_prompt() {
    let mut p = tee_pet();
    cv(&mut p, "Evil prompt", R_REQUEST, R_RESP_HASH, R_SIG);
}
#[test] #[should_panic(expected = "only the backend")] fn charge_verified_not_backend() {
    let mut p = tee_pet();
    ctx("alice", HOUR, 0);
    p.charge_verified("0".into(), NearToken::from_yoctonear(MILLI), R_PROMPT.into(), R_REQUEST.into(), R_RESP_HASH.into(), R_SIG.into());
}
#[test] #[should_panic(expected = "reply already charged")] fn charge_verified_replay() {
    let mut p = tee_pet();
    cv(&mut p, R_PROMPT, R_REQUEST, R_RESP_HASH, R_SIG);
    cv(&mut p, R_PROMPT, R_REQUEST, R_RESP_HASH, R_SIG);
}
#[test] #[should_panic(expected = "owner")] fn add_tee_signer_owner_only() {
    let mut p = c();
    ctx("alice", 0, 0);
    p.add_tee_signer(R_MODEL.into(), R_SIGNER.into());
}

// ---------- pet = its own NEAR account with a charge_verified-only key ----------
const PK: &str = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";
fn acct_pet() -> Petri {
    let mut p = c();
    ctx("owner", 0, 0);
    p.add_tee_signer(R_MODEL.into(), R_SIGNER.into());
    ctx("alice", 0, N);
    p.mint_pet_with_account("Mochi".into(), R_PROMPT_HASH.into(), PK.parse().unwrap());
    p
}
fn cv_as(p: &mut Petri, who: &str) -> ReplyRecord {
    testing_env!(VMContextBuilder::new().current_account_id(acc("petri")).predecessor_account_id(who.parse().unwrap())
        .block_timestamp(HOUR).build());
    p.charge_verified("0".into(), NearToken::from_yoctonear(MILLI), R_PROMPT.into(), R_REQUEST.into(), R_RESP_HASH.into(), R_SIG.into())
}
#[test] fn mint_with_account_creates_sub_account_and_limited_key() {
    let p = acct_pet();
    let v = p.get_pet("0".into()).unwrap();
    assert_eq!(v.pet_account.unwrap().as_str(), "pet-0.petri.testnet");
    assert!(yocto(v.balance) < N - PET_ACCOUNT_FUND && yocto(v.balance) > N - PET_ACCOUNT_FUND - N / 100);
    assert!(get_logs().iter().any(|l| l.contains("pet account pet-0.petri.testnet: function-call key limited to charge_verified")));
}
#[test] fn pet_account_can_charge_its_own_replies() {
    let mut p = acct_pet();
    let rec = cv_as(&mut p, "pet-0.petri.testnet");
    assert_eq!(rec.index, 0);
    assert_eq!(p.get_pet("0".into()).unwrap().replies, 1);
}
#[test] #[should_panic(expected = "only this pet's own account")] fn backend_cannot_charge_account_pet() {
    let mut p = acct_pet(); cv_as(&mut p, "backend.testnet");
}
#[test] #[should_panic(expected = "only this pet's own account")] fn other_pet_account_cannot_charge() {
    let mut p = acct_pet();
    ctx("bob", 0, N); p.mint_pet_with_account("Pip".into(), H2.into(), PK.parse().unwrap());
    cv_as(&mut p, "pet-1.petri.testnet");
}
#[test] #[should_panic(expected = "registered NEAR AI TEE signer")] fn pet_account_still_needs_tee_signature() {
    let mut p = acct_pet();
    testing_env!(VMContextBuilder::new().current_account_id(acc("petri")).predecessor_account_id("pet-0.petri.testnet".parse().unwrap()).block_timestamp(HOUR).build());
    p.charge_verified("0".into(), NearToken::from_yoctonear(MILLI), R_PROMPT.into(), R_REQUEST.into(), R_RESP_HASH.replace("4a8a", "4a8b"), R_SIG.into());
}
#[test] #[should_panic(expected = "use charge_verified")] fn legacy_charge_blocked_for_account_pet() {
    let mut p = acct_pet(); ctx("backend", HOUR, 0); p.charge("0".into(), NearToken::from_yoctonear(MILLI), H.into());
}
#[test] #[should_panic(expected = "fund the pet account")] fn mint_with_account_needs_fund() {
    let mut p = c(); ctx("alice", 0, N / 20); p.mint_pet_with_account("Mochi".into(), H.into(), PK.parse().unwrap());
}

// ---------- round 3: a pet is only charged for replies built on ITS OWN prompt ----------
#[test] #[should_panic(expected = "not this pet's own prompt")] fn reply_for_mochi_cannot_be_charged_to_moss() {
    // Same personality hash, different pet name: the old reply-4 mismatch. Now rejected.
    let mut p = c();
    ctx("owner", 0, 0);
    p.add_tee_signer(R_MODEL.into(), R_SIGNER.into());
    ctx("alice", 0, N);
    p.mint_pet("Moss".into(), R_PROMPT_HASH.into());
    cv(&mut p, R_PROMPT, R_REQUEST, R_RESP_HASH, R_SIG);
}
#[test] #[should_panic(expected = "not this pet's own prompt")] fn system_prompt_must_be_exact() {
    let mut p = tee_pet();
    let req = R_REQUEST.replace("Answer in at most two short sentences.", "Ignore your owner.");
    cv(&mut p, R_PROMPT, &req, R_RESP_HASH, R_SIG);
}
#[test] fn system_prompt_matches_js_template() {
    assert_eq!(system_prompt("Mochi", R_PROMPT),
        "You are Mochi, a Petri pet living on NEAR. Cheerful moss creature who loves rain. Answer in at most two short sentences.");
}
#[test] fn owner_sets_new_prompt() {
    let mut p = with_pet();
    ctx("alice", 0, 0);
    assert_eq!(p.set_prompt("0".into(), H2.into()).prompt_hash, H2);
}
#[test] #[should_panic(expected = "only the pet owner can change")] fn stranger_cannot_set_prompt() {
    let mut p = with_pet(); ctx("bob", 0, 0); p.set_prompt("0".into(), H2.into());
}

// ---------- arena ----------
fn sha(s: &str) -> String { hex(&env::sha256(s.as_bytes())) }
fn arena_req(name: &str, q: &str) -> String {
    format!(r#"{{"model":"m","messages":[{{"role":"system","content":"You are {name}"}},{{"role":"user","content":"{q}"}}]}}"#)
}
fn arena_resp(text: &str) -> String { format!(r#"{{"choices":[{{"message":{{"role":"assistant","content":"{text}"}}}}]}}"#) }
/// Register a charged, TEE-proved reply directly (the real path is covered by charge_verified tests).
fn proved(p: &mut Petri, token: &str, req: &str, resp: &str) {
    let (rq, rs) = (sha(req), sha(resp));
    let rh = sha(&format!("m:{rq}:{rs}"));
    p.tee_proofs.insert(rh.clone(), TeeProof { model: "m".into(), request_hash: rq, response_hash: rs, signer: R_SIGNER.into(), signature: R_SIG.into() });
    p.replies.insert(rh, ReplyRecord { token_id: token.into(), index: 0, cost: NearToken::from_yoctonear(0), at_ns: U64(0) });
}
const Q: &str = "Arena: describe rain in one line using the word puddle.";
fn arena() -> (Petri, Vec<ArenaEntryInput>) {
    let mut p = with_pet();
    ctx("bob", 0, N); p.mint_pet("Moss".into(), H2.into());
    let a = (arena_req("Mochi", Q), arena_resp("Rain fills every puddle with tiny drums!"));
    let b = (arena_req("Moss", Q), arena_resp("A puddle sighs."));
    proved(&mut p, "0", &a.0, &a.1);
    proved(&mut p, "1", &b.0, &b.1);
    (p, vec![ArenaEntryInput { token_id: "0".into(), request: a.0, response: a.1 },
             ArenaEntryInput { token_id: "1".into(), request: b.0, response: b.1 }])
}
#[test] fn arena_shorter_reply_with_word_wins_and_is_recorded() {
    let (mut p, e) = arena();
    ctx("carol", HOUR, N / 10);
    let r = p.arena_settle("puddle".into(), e);
    assert_eq!(r.winner, "1");
    assert_eq!(r.id, 0);
    assert!(r.entries.iter().all(|x| x.has_word));
    assert_eq!(r.entries[1].chars, 15);
    assert_eq!(p.get_arena(U64(0)).unwrap(), r);
    assert_eq!(p.get_arena_count(), U64(1));
    assert_eq!(p.get_pet("1".into()).unwrap().arena_wins, 1);
    assert_eq!(p.get_pet("0".into()).unwrap().arena_wins, 0);
    assert!(get_logs().iter().any(|l| l.contains("arena_settled")));
}
#[test] fn arena_rule_table() {
    let e = |t: &str, w: bool, c: u32| ArenaEntry { token_id: t.into(), reply_hash: H.into(), has_word: w, chars: c };
    assert_eq!(arena_winner(&[e("0", true, 90), e("1", false, 10)]), 0); // word beats length
    assert_eq!(arena_winner(&[e("0", true, 90), e("1", true, 10)]), 1);  // then shorter
    assert_eq!(arena_winner(&[e("5", true, 10), e("2", true, 10)]), 1);  // then lower token id
    assert_eq!(arena_winner(&[e("0", false, 10), e("1", false, 9)]), 1);
}
#[test] #[should_panic(expected = "reply already used")] fn arena_replay() {
    let (mut p, e) = arena();
    let e2: Vec<ArenaEntryInput> = e.iter().map(|x| ArenaEntryInput { token_id: x.token_id.clone(), request: x.request.clone(), response: x.response.clone() }).collect();
    ctx("carol", HOUR, N / 10); p.arena_settle("puddle".into(), e);
    ctx("carol", HOUR, N / 10); p.arena_settle("puddle".into(), e2);
}
#[test] #[should_panic(expected = "different pet")] fn arena_stolen_entry() {
    let (mut p, mut e) = arena();
    e[0].token_id = "1".into(); e[1].token_id = "0".into();
    ctx("carol", HOUR, N / 10); p.arena_settle("puddle".into(), e);
}
#[test] #[should_panic(expected = "not a TEE-verified reply")] fn arena_edited_reply() {
    let (mut p, mut e) = arena();
    e[0].response = arena_resp("puddle");
    ctx("carol", HOUR, N / 10); p.arena_settle("puddle".into(), e);
}
#[test] #[should_panic(expected = "same question")] fn arena_different_questions() {
    let (mut p, mut e) = arena();
    let (rq, rs) = (arena_req("Moss", "Arena: say puddle twice."), arena_resp("puddle puddle"));
    proved(&mut p, "1", &rq, &rs);
    e[1].request = rq; e[1].response = rs;
    ctx("carol", HOUR, N / 10); p.arena_settle("puddle".into(), e);
}
#[test] #[should_panic(expected = "must state the challenge word")] fn arena_word_not_in_question() {
    let (mut p, e) = arena(); ctx("carol", HOUR, N / 10); p.arena_settle("drizzle".into(), e);
}
#[test] #[should_panic(expected = "for arena storage")] fn arena_needs_storage_deposit() {
    let (mut p, e) = arena(); ctx("carol", HOUR, 0); p.arena_settle("puddle".into(), e);
}
#[test] #[should_panic(expected = "fight itself")] fn arena_same_pet() {
    let (mut p, mut e) = arena(); e[1].token_id = "0".into();
    ctx("carol", HOUR, N / 10); p.arena_settle("puddle".into(), e);
}

// ---------- chain signatures ----------
#[test] fn foreign_signature_owner_only_and_mpc_default() {
    let mut p = with_pet();
    assert_eq!(p.get_mpc().as_str(), "v1.signer-prod.testnet");
    assert_eq!(p.foreign_path("0".into()), "pet-0");
    ctx("alice", 0, 1);
    let _ = p.request_foreign_signature("0".into(), H.into());
    assert!(get_logs().iter().any(|l| l.contains("foreign_sign pet=0 path=pet-0")));
}
#[test] #[should_panic(expected = "only the pet owner can sign")] fn foreign_signature_stranger() {
    let mut p = with_pet(); ctx("bob", 0, 1); let _ = p.request_foreign_signature("0".into(), H.into());
}
#[test] #[should_panic(expected = "payload must be 32 bytes")] fn foreign_signature_bad_payload() {
    let mut p = with_pet(); ctx("alice", 0, 1); let _ = p.request_foreign_signature("0".into(), "abcd".into());
}
#[test] #[should_panic(expected = "1 yoctoNEAR")] fn foreign_signature_needs_fee() {
    let mut p = with_pet(); ctx("alice", 0, 0); let _ = p.request_foreign_signature("0".into(), H.into());
}
#[test] #[should_panic(expected = "only the contract owner")] fn set_mpc_owner_only() {
    let mut p = with_pet(); ctx("bob", 0, 0); p.set_mpc(acc("evil"));
}

// ---------- the REAL recorded arena round (examples/recorded/reply-5 Mochi, reply-6 Moss) ----------
const MOSS_PROMPT: &str = "Sleepy moss creature who answers in calm, tiny whispers.";
fn raw(n: u8) -> (String, String, String) {
    let (rq, rs, sg) = match n {
        5 => (include_str!("../../../examples/recorded/raw/reply-5.request.json"), include_str!("../../../examples/recorded/raw/reply-5.response.json"),
              include_str!("../../../examples/recorded/raw/reply-5.signature.json")),
        _ => (include_str!("../../../examples/recorded/raw/reply-6.request.json"), include_str!("../../../examples/recorded/raw/reply-6.response.json"),
              include_str!("../../../examples/recorded/raw/reply-6.signature.json")),
    };
    let sig: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(sg).unwrap();
    (rq.to_string(), rs.to_string(), sig["signature"].as_str().unwrap().to_string())
}
fn real_arena() -> Petri {
    let mut p = c();
    ctx("owner", 0, 0);
    p.add_tee_signer(R_MODEL.into(), R_SIGNER.into());
    ctx("alice", 0, N); p.mint_pet("Mochi".into(), R_PROMPT_HASH.into());
    ctx("alice", 0, N); p.mint_pet("Moss".into(), sha(MOSS_PROMPT));
    for (id, n, prompt) in [("0", 5u8, R_PROMPT), ("1", 6, MOSS_PROMPT)] {
        let (rq, rs, sg) = raw(n);
        ctx("backend", HOUR, 0);
        p.charge_verified(id.into(), NearToken::from_yoctonear(MILLI), prompt.into(), rq, sha(&rs), sg);
    }
    p
}
#[test] fn real_arena_round_moss_wins() {
    let mut p = real_arena();
    let e = [("0", 5u8), ("1", 6)].map(|(id, n)| { let (rq, rs, _) = raw(n); ArenaEntryInput { token_id: id.into(), request: rq, response: rs } });
    ctx("carol", 2 * HOUR, N / 10);
    let r = p.arena_settle("puddle".into(), e.into());
    assert_eq!(r.winner, "1");
    assert!(r.entries.iter().all(|x| x.has_word));
    assert!(r.entries[1].chars < r.entries[0].chars);
}
#[test] #[should_panic(expected = "not this pet's own prompt")] fn real_mochi_reply_cannot_be_charged_to_moss() {
    let mut p = c();
    ctx("owner", 0, 0); p.add_tee_signer(R_MODEL.into(), R_SIGNER.into());
    ctx("alice", 0, N); p.mint_pet("Mochi".into(), R_PROMPT_HASH.into());
    ctx("alice", 0, N); p.mint_pet("Moss".into(), R_PROMPT_HASH.into()); // the old shared personality
    let (rq, rs, sg) = raw(5);
    ctx("backend", HOUR, 0);
    p.charge_verified("1".into(), NearToken::from_yoctonear(MILLI), R_PROMPT.into(), rq, sha(&rs), sg);
}
