//! Petri: AI pets as NEP-171 NFTs that pay for their own brain.
//!
//! Each pet carries an on-chain NEAR balance. Owners `feed` it (top-up), the
//! authorized backend `charge`s it per AI reply (recording the reply hash), and
//! when the balance drops under the threshold or the pet goes unfed for too
//! long it falls asleep. Anyone can `revive` a sleeping pet with a tip.
use near_contract_standards::non_fungible_token::core::{NonFungibleTokenCore, NonFungibleTokenResolver};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::events::NftMint;
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::{NonFungibleToken, Token, TokenId};
use near_sdk::collections::LazyOption;
use near_sdk::json_types::{U128, U64};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, Allowance, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue, PromiseResult, PublicKey};
use std::collections::HashMap;

pub const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
/// Default: a pet with < 0.01 NEAR can't afford a reply and sleeps.
pub const DEFAULT_SLEEP_THRESHOLD: u128 = ONE_NEAR / 100;
/// Default: a pet unfed for 24h sleeps.
pub const DEFAULT_HUNGER_NS: u64 = 24 * 60 * 60 * 1_000_000_000;
pub const MAX_NAME_LEN: usize = 32;
/// NEAR moved from the mint deposit into the pet's own account (pays its own gas + account storage).
pub const PET_ACCOUNT_FUND: u128 = ONE_NEAR / 10;
/// Gas allowance on the pet's function-call key (it can never spend more than this on fees).
pub const PET_KEY_ALLOWANCE: u128 = ONE_NEAR / 4;
/// The only method the pet's key may call.
pub const PET_KEY_METHOD: &str = "charge_verified";
/// Raw storage prefixes (outside the root state struct, so no migration is needed):
/// `kh:<id>` = the NFT owner who set the pet account's current key,
/// `kg:<id>` = how many times the pet has been re-keyed.
const KEY_HOLDER_PREFIX: &str = "kh:";
const KEY_GEN_PREFIX: &str = "kg:";

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    NftOwners,
    NftMetadata,
    NftEnumeration,
    ContractMetadata,
    Pets,
    Replies,
    TeeProofs,
    PetAccounts,
    ArenaRounds,
    ArenaUsed,
    ArenaWins,
}

#[near(serializers = [borsh])]
pub struct Pet {
    pub name: String,
    pub prompt_hash: String,
    pub balance: NearToken,
    pub last_fed_ns: u64,
    pub replies: u64,
    pub last_reply_hash: Option<String>,
    pub revives: u32,
}

/// On-chain receipt for one charged AI reply (looked up by reply hash).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ReplyRecord {
    pub token_id: TokenId,
    pub index: u64,
    pub cost: NearToken,
    pub at_ns: U64,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct PetView {
    pub token_id: TokenId,
    pub owner_id: AccountId,
    pub name: String,
    pub prompt_hash: String,
    pub balance: NearToken,
    pub last_fed_ns: U64,
    pub replies: u64,
    pub last_reply_hash: Option<String>,
    pub revives: u32,
    pub asleep: bool,
    /// The pet's own NEAR account `pet-<id>.<contract>` (None for legacy pets).
    /// It holds a function-call key that can only call `charge_verified` on this
    /// contract, and the contract only accepts charges for this pet from it.
    pub pet_account: Option<AccountId>,
    /// Arena rounds this pet has won.
    pub arena_wins: u32,
    /// True if `pet_account` may charge right now: its key was set by the current
    /// NFT owner. False after a transfer until the new owner calls `rekey_pet`.
    pub pet_key_active: bool,
}

#[near(serializers = [json])]
pub struct Config {
    pub owner_id: AccountId,
    pub backend_id: AccountId,
    pub sleep_threshold: NearToken,
    pub hunger_ns: U64,
    pub treasury: NearToken,
    pub total_pets: u64,
}

pub fn is_valid_hash(h: &str) -> bool {
    h.len() == 64 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Pure sleep rule, shared by contract and tests.
pub fn asleep_rule(balance: u128, threshold: u128, last_fed_ns: u64, now_ns: u64, hunger_ns: u64) -> bool {
    balance < threshold || now_ns.saturating_sub(last_fed_ns) > hunger_ns
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Petri {
    tokens: NonFungibleToken,
    metadata: LazyOption<NFTContractMetadata>,
    owner_id: AccountId,
    backend_id: AccountId,
    sleep_threshold: NearToken,
    hunger_ns: u64,
    pets: LookupMap<TokenId, Pet>,
    replies: LookupMap<String, ReplyRecord>,
    next_id: u64,
    /// Charged AI fees accumulated for the operator (pays NEAR AI Cloud off-chain).
    treasury: NearToken,
    /// Owner-registered NEAR AI Cloud TEE signers: (model id, lowercase 0x address)
    /// taken from a verified model attestation report.
    tee_signers: Vec<TeeSigner>,
    /// Proof of the TEE signature checked on-chain for each `charge_verified` reply.
    tee_proofs: LookupMap<String, TeeProof>,
    /// token_id -> the pet's own sub-account (see `mint_pet_with_account`).
    pet_accounts: LookupMap<TokenId, AccountId>,
    /// Settled arena rounds by id, the reply hashes already used in one, and wins per pet.
    arena_rounds: LookupMap<u64, ArenaRound>,
    arena_count: u64,
    arena_used: LookupMap<String, u64>,
    arena_wins: LookupMap<TokenId, u32>,
    /// NEAR Chain Signatures MPC contract (v1.signer-prod.testnet / v1.signer).
    mpc_id: AccountId,
}

/// The exact system prompt every Petri reply must be built on. The contract
/// rebuilds it from the pet's on-chain name + personality and requires the TEE-
/// signed request to use it verbatim, so a reply made for one pet can never be
/// charged to (or entered into the arena for) another.
pub fn system_prompt(name: &str, prompt: &str) -> String {
    format!("You are {name}, a Petri pet living on NEAR. {prompt} Answer in at most two short sentences.")
}

/// The arena's published winner rule, stored with every round.
pub const ARENA_RULE: &str = "1) reply contains the challenge word (case-insensitive) 2) fewer characters 3) lower token id";

/// One pet's entry as submitted to `arena_settle`: the exact TEE-signed bytes.
#[near(serializers = [json])]
pub struct ArenaEntryInput {
    pub token_id: TokenId,
    pub request: String,
    pub response: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ArenaEntry {
    pub token_id: TokenId,
    pub reply_hash: String,
    pub has_word: bool,
    pub chars: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ArenaRound {
    pub id: u64,
    pub question_hash: String,
    pub challenge: String,
    pub rule: String,
    pub entries: Vec<ArenaEntry>,
    pub winner: TokenId,
    pub settled_by: AccountId,
    pub at_ns: U64,
}

/// Pure winner rule: index of the winning entry. Higher is better on
/// (has_word, -chars, -token_id). Deterministic and reproducible by anyone.
pub fn arena_winner(entries: &[ArenaEntry]) -> usize {
    let key = |e: &ArenaEntry| (e.has_word, std::cmp::Reverse(e.chars), std::cmp::Reverse(e.token_id.parse::<u64>().unwrap_or(u64::MAX)));
    (0..entries.len()).max_by_key(|&i| key(&entries[i])).unwrap()
}

/// Last user message of a chat-completions request.
pub fn user_question(req: &near_sdk::serde_json::Value) -> Option<String> {
    req["messages"].as_array()?.iter().rev().find(|m| m["role"] == "user")?["content"].as_str().map(str::to_string)
}

/// The reply text of a chat-completions response.
pub fn reply_text(resp: &near_sdk::serde_json::Value) -> Option<String> {
    resp["choices"][0]["message"]["content"].as_str().map(str::to_string)
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct TeeSigner {
    pub model: String,
    pub address: String,
}

/// What the contract itself checked for a reply: the NEAR AI `provider_tee` ECDSA
/// signature over `model:sha256(request):sha256(response)`, recovered on-chain.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct TeeProof {
    pub model: String,
    pub request_hash: String,
    pub response_hash: String,
    pub signer: String,
    pub signature: String,
}

#[near]
impl Petri {
    #[init]
    pub fn new(owner_id: AccountId, backend_id: AccountId) -> Self {
        let meta = NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "Petri pets".to_string(),
            symbol: "PETRI".to_string(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        };
        Self {
            tokens: NonFungibleToken::new(
                StorageKey::NftOwners,
                owner_id.clone(),
                Some(StorageKey::NftMetadata),
                Some(StorageKey::NftEnumeration),
                None::<StorageKey>,
            ),
            metadata: LazyOption::new(StorageKey::ContractMetadata, Some(&meta)),
            owner_id,
            backend_id,
            sleep_threshold: NearToken::from_yoctonear(DEFAULT_SLEEP_THRESHOLD),
            hunger_ns: DEFAULT_HUNGER_NS,
            pets: LookupMap::new(StorageKey::Pets),
            replies: LookupMap::new(StorageKey::Replies),
            next_id: 0,
            treasury: NearToken::from_yoctonear(0),
            tee_signers: Vec::new(),
            tee_proofs: LookupMap::new(StorageKey::TeeProofs),
            pet_accounts: LookupMap::new(StorageKey::PetAccounts),
            arena_rounds: LookupMap::new(StorageKey::ArenaRounds), arena_count: 0,
            arena_used: LookupMap::new(StorageKey::ArenaUsed), arena_wins: LookupMap::new(StorageKey::ArenaWins),
            mpc_id: default_mpc(),
        }
    }

    /// State upgrade from round 3 (arena + chain signatures) to round 4 (pet key
    /// frozen on transfer + `rekey_pet`). The root layout is unchanged, so this
    /// re-reads the current state (the deploy+migrate batch reverts if it does not
    /// decode) and pins the key holder of every existing pet account to its current
    /// NFT owner, so the transfer rule applies to legacy pets from now on.
    /// Idempotent: pets that already have a key holder are left alone.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let mut s: Petri = env::state_read().unwrap_or_else(|| env::panic_str("no previous state"));
        for id in 0..s.next_id {
            let token_id = id.to_string();
            if s.tokens.owner_by_id.get(&token_id).is_some() {
                s.pin_key_holder(&token_id);
            }
        }
        s
    }

    // ---------- pet lifecycle ----------

    /// Mint a pet to the caller. The attached deposit first covers storage;
    /// everything beyond that becomes the pet's balance.
    #[payable]
    pub fn mint_pet(&mut self, name: String, prompt_hash: String) -> PetView {
        self.mint_inner(name, prompt_hash)
    }

    /// Mint a pet that is its own NEAR account. The contract creates
    /// `pet-<id>.<contract>`, funds it with `PET_ACCOUNT_FUND` from the deposit, and
    /// adds `pet_key` as a function-call key that can ONLY call `charge_verified` on
    /// this contract with at most `PET_KEY_ALLOWANCE` of gas. No full-access key
    /// exists, so the key holder (the chat backend) can do nothing except submit
    /// this pet's TEE-signed replies, which the contract still verifies on-chain.
    #[payable]
    pub fn mint_pet_with_account(&mut self, name: String, prompt_hash: String, pet_key: PublicKey) -> PetView {
        let view = self.mint_inner(name, prompt_hash);
        let token_id = view.token_id.clone();
        let fund = NearToken::from_yoctonear(PET_ACCOUNT_FUND);
        let pet = self.pet_mut(&token_id);
        require!(pet.balance.as_yoctonear() > PET_ACCOUNT_FUND, "attach enough to also fund the pet account (0.1 NEAR)");
        pet.balance = pet.balance.saturating_sub(fund);
        let account: AccountId = self.pet_account_id(&token_id).parse().unwrap();
        self.pet_accounts.insert(token_id.clone(), account.clone());
        self.set_key_holder(&token_id, &env::predecessor_account_id());
        Promise::new(account.clone())
            .create_account()
            .transfer(fund)
            .add_access_key_allowance(pet_key, Allowance::limited(NearToken::from_yoctonear(PET_KEY_ALLOWANCE)).unwrap(),
                                      env::current_account_id(), PET_KEY_METHOD.to_string())
            .then(Promise::new(env::current_account_id()).function_call(
                "on_pet_account".to_string(),
                near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({"token_id": token_id})).unwrap(),
                NearToken::from_yoctonear(0), Gas::from_tgas(5)));
        env::log_str(&format!("pet account {account}: function-call key limited to {PET_KEY_METHOD}"));
        self.get_pet(token_id).unwrap()
    }

    /// Callback: if creating the pet account failed, the fund was refunded to this
    /// contract; credit it back to the pet and fall back to a legacy (backend) pet.
    #[private]
    pub fn on_pet_account(&mut self, token_id: TokenId) -> bool {
        if matches!(env::promise_result(0), PromiseResult::Successful(_)) { return true; }
        self.pet_accounts.remove(&token_id);
        env::storage_remove(format!("{KEY_HOLDER_PREFIX}{token_id}").as_bytes());
        let pet = self.pet_mut(&token_id);
        pet.balance = pet.balance.saturating_add(NearToken::from_yoctonear(PET_ACCOUNT_FUND));
        env::log_str(&format!("pet account creation failed for {token_id}; refunded to pet balance"));
        false
    }

    /// After buying a pet, the new NFT owner gives it a fresh account with a key
    /// only they know. The old account's key was chosen by a previous owner, so
    /// charges from it are refused as soon as the NFT changes hands (see
    /// `charge_verified`). The contract cannot delete keys on an account it does
    /// not control, so it creates `pet-<id>-<gen>.<contract>` instead and, once
    /// that succeeds, points the pet at it. Attach >= 0.1 NEAR: all of it funds
    /// the new account (the pet's gas).
    #[payable]
    pub fn rekey_pet(&mut self, token_id: TokenId, pet_key: PublicKey) -> Promise {
        let by = env::predecessor_account_id();
        require!(self.owner_of(&token_id) == by, "only the pet owner can rekey it");
        require!(self.pet_accounts.contains_key(&token_id), "this pet has no own account");
        let fund = env::attached_deposit();
        require!(fund.as_yoctonear() >= PET_ACCOUNT_FUND, "attach at least 0.1 NEAR to fund the new pet account");
        let gen = self.key_gen(&token_id) + 1;
        env::storage_write(format!("{KEY_GEN_PREFIX}{token_id}").as_bytes(), &gen.to_le_bytes());
        let account: AccountId = format!("pet-{token_id}-{gen}.{}", env::current_account_id()).parse().unwrap();
        env::log_str(&format!("rekey pet {token_id}: creating {account} for {by}"));
        Promise::new(account.clone())
            .create_account()
            .transfer(fund)
            .add_access_key_allowance(pet_key, Allowance::limited(NearToken::from_yoctonear(PET_KEY_ALLOWANCE)).unwrap(),
                                      env::current_account_id(), PET_KEY_METHOD.to_string())
            .then(Promise::new(env::current_account_id()).function_call(
                "on_pet_rekey".to_string(),
                near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({"token_id": token_id, "account": account, "by": by, "fund": U128(fund.as_yoctonear())})).unwrap(),
                NearToken::from_yoctonear(0), Gas::from_tgas(5)))
    }

    /// Callback of `rekey_pet`. The new account is bound only if `by` still owns
    /// the NFT now: a rekey started by a seller who transferred the pet while the
    /// promise was in flight must not hand the seller the pet's key again.
    #[private]
    pub fn on_pet_rekey(&mut self, token_id: TokenId, account: AccountId, by: AccountId, fund: U128) -> bool {
        if !matches!(env::promise_result(0), PromiseResult::Successful(_)) {
            env::log_str(&format!("rekey of pet {token_id} failed; refunding {by}"));
            Promise::new(by).transfer(NearToken::from_yoctonear(fund.0));
            return false;
        }
        if self.owner_of(&token_id) != by {
            env::log_str(&format!("rekey of pet {token_id} ignored: {by} no longer owns it; {account} is not linked"));
            return false;
        }
        self.pet_accounts.insert(token_id.clone(), account.clone());
        self.set_key_holder(&token_id, &by);
        env::log_str(&format!("pet {token_id} now charges from {account} (key set by {by})"));
        true
    }
}

impl Petri {
    fn mint_inner(&mut self, name: String, prompt_hash: String) -> PetView {
        require!(!name.is_empty() && name.len() <= MAX_NAME_LEN, "name must be 1-32 bytes");
        require!(is_valid_hash(&prompt_hash), "prompt_hash must be 64 lowercase hex chars (sha256)");
        let owner = env::predecessor_account_id();
        let attached = env::attached_deposit().as_yoctonear();
        let before = env::storage_usage();

        let token_id = self.next_id.to_string();
        self.next_id += 1;
        let meta = TokenMetadata {
            title: Some(name.clone()),
            description: Some("A Petri pet that pays for its own brain.".to_string()),
            extra: Some(format!("{{\"prompt_hash\":\"{prompt_hash}\"}}")),
            ..Default::default()
        };
        self.tokens.internal_mint_with_refund(token_id.clone(), owner.clone(), Some(meta), None);
        let now = env::block_timestamp();
        self.pets.insert(token_id.clone(), Pet {
            name, prompt_hash, balance: NearToken::from_yoctonear(0), last_fed_ns: now,
            replies: 0, last_reply_hash: None, revives: 0,
        });
        self.pets.flush();

        let storage_cost = env::storage_byte_cost().as_yoctonear() * (env::storage_usage() - before) as u128;
        require!(attached > storage_cost, format!("attach more than storage cost of {storage_cost} yocto"));
        self.pets.get_mut(&token_id).unwrap().balance = NearToken::from_yoctonear(attached - storage_cost);
        NftMint { owner_id: &owner, token_ids: &[&token_id], memo: None }.emit();
        self.get_pet(token_id).unwrap()
    }
}

#[near]
impl Petri {

    /// Owner tops up the pet's balance and resets its hunger clock.
    #[payable]
    pub fn feed(&mut self, token_id: TokenId) -> PetView {
        let amount = env::attached_deposit();
        require!(amount.as_yoctonear() > 0, "attach NEAR to feed");
        require!(self.owner_of(&token_id) == env::predecessor_account_id(), "only the pet owner can feed");
        require!(!self.asleep(&token_id), "pet is asleep: revive it first");
        let pet = self.pet_mut(&token_id);
        pet.balance = pet.balance.saturating_add(amount);
        pet.last_fed_ns = env::block_timestamp();
        self.get_pet(token_id).unwrap()
    }

    /// Anyone can wake a sleeping pet with a tip that lifts it above the threshold.
    #[payable]
    pub fn revive(&mut self, token_id: TokenId) -> PetView {
        let tip = env::attached_deposit();
        require!(self.asleep(&token_id), "pet is awake");
        let threshold = self.sleep_threshold;
        let pet = self.pet_mut(&token_id);
        let new_balance = pet.balance.saturating_add(tip);
        require!(new_balance >= threshold, "tip too small to revive");
        pet.balance = new_balance;
        pet.last_fed_ns = env::block_timestamp();
        pet.revives += 1;
        env::log_str(&format!("revived pet {token_id} by {}", env::predecessor_account_id()));
        self.get_pet(token_id).unwrap()
    }

    /// Backend-only: debit one AI reply from the pet and record its hash.
    /// The storage for the receipt is paid from the pet's balance too.
    pub fn charge(&mut self, token_id: TokenId, cost: NearToken, reply_hash: String) -> ReplyRecord {
        require!(env::predecessor_account_id() == self.backend_id, "only the backend can charge");
        require!(!self.pet_accounts.contains_key(&token_id), "this pet has its own account: use charge_verified from it");
        require!(is_valid_hash(&reply_hash), "reply_hash must be 64 lowercase hex chars (sha256)");
        self.charge_inner(token_id, cost, reply_hash)
    }
}

impl Petri {
    fn charge_inner(&mut self, token_id: TokenId, cost: NearToken, reply_hash: String) -> ReplyRecord {
        require!(!self.replies.contains_key(&reply_hash), "reply already charged");
        require!(!self.asleep(&token_id), "pet is asleep");

        let before = env::storage_usage();
        let pet = self.pets.get_mut(&token_id).unwrap();
        let rec = ReplyRecord { token_id: token_id.clone(), index: pet.replies, cost, at_ns: U64(env::block_timestamp()) };
        pet.replies += 1;
        pet.last_reply_hash = Some(reply_hash.clone());
        self.replies.insert(reply_hash, rec.clone());
        self.replies.flush();
        self.pets.flush();
        let storage = NearToken::from_yoctonear(
            env::storage_byte_cost().as_yoctonear() * env::storage_usage().saturating_sub(before) as u128);

        let pet = self.pets.get_mut(&token_id).unwrap();
        let total = cost.saturating_add(storage);
        require!(pet.balance >= total, "insufficient pet balance");
        pet.balance = pet.balance.saturating_sub(total);
        self.treasury = self.treasury.saturating_add(cost);
        rec
    }
}

#[near]
impl Petri {

    /// Backend-only, trust-minimized charge: the contract itself verifies that
    /// 1. the request bytes hash to the signed request hash and contain this pet's
    ///    on-chain personality prompt (sha256 == pet.prompt_hash), and
    /// 2. the NEAR AI Cloud TEE signature over `model:sha256(request):response_hash`
    ///    recovers (EIP-191 + ecrecover) to a registered TEE signer for that model.
    /// Only then is the reply debited from the pet's own balance.
    pub fn charge_verified(&mut self, token_id: TokenId, cost: NearToken, prompt: String,
                           request: String, response_hash: String, signature: String) -> ReplyRecord {
        match self.pet_accounts.get(&token_id) {
            Some(a) => {
                require!(&env::predecessor_account_id() == a, "only this pet's own account can charge it");
                require!(self.pet_key_active(&token_id), "pet key was set by a previous owner: the new owner must call rekey_pet");
            }
            None => require!(env::predecessor_account_id() == self.backend_id, "only the backend can charge"),
        }
        require!(is_valid_hash(&response_hash), "response_hash must be 64 lowercase hex chars (sha256)");
        let pet = self.pets.get(&token_id).unwrap_or_else(|| env::panic_str("no such pet"));
        require!(hex(&env::sha256(prompt.as_bytes())) == pet.prompt_hash, "prompt does not match the pet's on-chain prompt_hash");
        let req: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(&request)
            .unwrap_or_else(|_| env::panic_str("request is not JSON"));
        let model = req["model"].as_str().unwrap_or_else(|| env::panic_str("request has no model")).to_string();
        let sys = req["messages"][0]["content"].as_str().unwrap_or("");
        require!(req["messages"][0]["role"] == "system" && sys == system_prompt(&pet.name, &prompt),
                 "request system prompt is not this pet's own prompt (name + personality)");
        let request_hash = hex(&env::sha256(request.as_bytes()));
        let text = format!("{model}:{request_hash}:{response_hash}");
        let signer = recover_eip191(&text, &signature).unwrap_or_else(|| env::panic_str("bad TEE signature"));
        require!(self.tee_signers.iter().any(|t| t.model == model && t.address == signer),
                 "signature does not recover to a registered NEAR AI TEE signer for this model");
        let reply_hash = hex(&env::sha256(text.as_bytes()));
        let rec = self.charge_inner(token_id, cost, reply_hash.clone());
        self.tee_proofs.insert(reply_hash, TeeProof { model, request_hash, response_hash, signer, signature });
        rec
    }

    /// Pet owner gives the pet a new personality (sha256 of the prompt text).
    /// Future replies must be built on it; past receipts stay as they were.
    pub fn set_prompt(&mut self, token_id: TokenId, prompt_hash: String) -> PetView {
        require!(self.owner_of(&token_id) == env::predecessor_account_id(), "only the pet owner can change its prompt");
        require!(is_valid_hash(&prompt_hash), "prompt_hash must be 64 lowercase hex chars (sha256)");
        self.pet_mut(&token_id).prompt_hash = prompt_hash.clone();
        env::log_str(&format!("pet {token_id} prompt_hash -> {prompt_hash}"));
        self.get_pet(token_id).unwrap()
    }

    // ---------- arena ----------

    /// Permissionless: settle an arena round between two pets that answered the
    /// SAME question. For each entry the contract re-hashes the exact request and
    /// response bytes and requires that this reply was already charged to that pet
    /// via `charge_verified` (i.e. its NEAR AI TEE signature was ecrecovered on-chain
    /// and its system prompt is that pet's own). The winner follows `ARENA_RULE`,
    /// computed here from the signed reply text, and the round is stored on-chain.
    /// Attach a little NEAR for storage; the rest is refunded.
    #[payable]
    pub fn arena_settle(&mut self, challenge: String, entries: Vec<ArenaEntryInput>) -> ArenaRound {
        require!(entries.len() == 2, "an arena round has exactly two entries");
        require!(entries[0].token_id != entries[1].token_id, "a pet cannot fight itself");
        require!(!challenge.is_empty() && challenge.len() <= 32 && challenge.chars().all(|c| c.is_alphanumeric()),
                 "challenge must be one word (1-32 alphanumeric chars)");
        let word = challenge.to_lowercase();
        let before = env::storage_usage();
        let mut question: Option<String> = None;
        let mut out = Vec::new();
        let mut first_ns = u64::MAX;
        for e in &entries {
            let req: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(&e.request)
                .unwrap_or_else(|_| env::panic_str("request is not JSON"));
            let resp: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(&e.response)
                .unwrap_or_else(|_| env::panic_str("response is not JSON"));
            let model = req["model"].as_str().unwrap_or_else(|| env::panic_str("request has no model"));
            let request_hash = hex(&env::sha256(e.request.as_bytes()));
            let response_hash = hex(&env::sha256(e.response.as_bytes()));
            let reply_hash = hex(&env::sha256(format!("{model}:{request_hash}:{response_hash}").as_bytes()));
            let proof = self.tee_proofs.get(&reply_hash).unwrap_or_else(|| env::panic_str("entry is not a TEE-verified reply"));
            require!(proof.request_hash == request_hash && proof.response_hash == response_hash, "entry bytes do not match the TEE proof");
            let rec = self.replies.get(&reply_hash).unwrap_or_else(|| env::panic_str("entry was never charged"));
            require!(rec.token_id == e.token_id, "entry reply belongs to a different pet");
            require!(!self.arena_used.contains_key(&reply_hash), "reply already used in an arena round");
            let q = user_question(&req).unwrap_or_else(|| env::panic_str("request has no user question"));
            match &question { None => question = Some(q), Some(q0) => require!(*q0 == q, "both pets must answer the same question") }
            let text = reply_text(&resp).unwrap_or_else(|| env::panic_str("response has no reply text"));
            first_ns = first_ns.min(rec.at_ns.0);
            out.push(ArenaEntry { token_id: e.token_id.clone(), reply_hash, has_word: text.to_lowercase().contains(&word),
                                  chars: text.trim().chars().count() as u32 });
        }
        let question = question.unwrap();
        require!(question.to_lowercase().contains(&word), "the question must state the challenge word");
        let winner = out[arena_winner(&out)].token_id.clone();
        let id = self.arena_count;
        self.arena_count += 1;
        for e in &out { self.arena_used.insert(e.reply_hash.clone(), id); }
        let wins = self.arena_wins.get(&winner).copied().unwrap_or(0) + 1;
        self.arena_wins.insert(winner.clone(), wins);
        let round = ArenaRound { id, question_hash: hex(&env::sha256(question.as_bytes())), challenge, rule: ARENA_RULE.to_string(),
                                 entries: out, winner: winner.clone(), settled_by: env::predecessor_account_id(),
                                 at_ns: U64(env::block_timestamp()) };
        self.arena_rounds.insert(id, round.clone());
        self.arena_rounds.flush(); self.arena_used.flush(); self.arena_wins.flush();
        self.meme_settle_for([&entries[0].token_id, &entries[1].token_id], first_ns, &winner, id);
        let cost = env::storage_byte_cost().as_yoctonear() * env::storage_usage().saturating_sub(before) as u128;
        let dep = env::attached_deposit().as_yoctonear();
        require!(dep >= cost, format!("attach at least {cost} yocto for arena storage"));
        if dep > cost { Promise::new(env::predecessor_account_id()).transfer(NearToken::from_yoctonear(dep - cost)); }
        env::log_str(&format!("EVENT_JSON:{{\"standard\":\"petri\",\"version\":\"1.0.0\",\"event\":\"arena_settled\",\"data\":{{\"id\":{id},\"winner\":\"{winner}\"}}}}"));
        round
    }

    pub fn get_arena(&self, id: U64) -> Option<ArenaRound> { self.arena_rounds.get(&id.0).cloned() }
    pub fn get_arena_count(&self) -> U64 { U64(self.arena_count) }

    // ---------- chain signatures: every pet has addresses on other chains ----------

    /// Derivation path of the pet's foreign (EVM/BTC/...) addresses under this
    /// contract: derived by the NEAR MPC network from (this contract, path).
    pub fn foreign_path(&self, token_id: TokenId) -> String { format!("pet-{token_id}") }
    pub fn get_mpc(&self) -> AccountId { self.mpc_id.clone() }

    /// The pet's NFT owner asks the MPC network to sign a 32-byte payload (e.g. an
    /// EIP-1559 tx hash sweeping tips from the pet's derived address to a 1Click
    /// deposit address). Whoever owns the pet NFT controls its foreign addresses,
    /// so they move with the NFT. Attach >= 1 yocto (forwarded to the MPC); use 300 Tgas.
    #[payable]
    pub fn request_foreign_signature(&mut self, token_id: TokenId, payload_hex: String) -> Promise {
        require!(self.owner_of(&token_id) == env::predecessor_account_id(), "only the pet owner can sign for its foreign addresses");
        require!(payload_hex.len() == 64 && is_valid_hash(&payload_hex), "payload must be 32 bytes lowercase hex");
        let dep = env::attached_deposit();
        require!(dep.as_yoctonear() >= 1, "attach at least 1 yoctoNEAR for the MPC fee");
        let path = self.foreign_path(token_id.clone());
        env::log_str(&format!("foreign_sign pet={token_id} path={path} payload={payload_hex}"));
        Promise::new(self.mpc_id.clone()).function_call(
            "sign".to_string(),
            near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({"request": {"path": path, "payload_v2": {"Ecdsa": payload_hex}, "domain_id": 0}})).unwrap(),
            dep, Gas::from_tgas(250))
    }

    // ---------- admin ----------

    pub fn set_mpc(&mut self, mpc_id: AccountId) { self.assert_owner(); self.mpc_id = mpc_id; }

    /// Owner registers a TEE signer address after verifying the model's attestation
    /// report off-chain (`pnpm preflight`: TDX quote, report_data binding, NVIDIA NRAS).
    pub fn add_tee_signer(&mut self, model: String, address: String) {
        self.assert_owner();
        let a = address.to_lowercase();
        require!(a.len() == 42 && a.starts_with("0x"), "address must be 0x + 40 hex");
        if !self.tee_signers.iter().any(|t| t.model == model && t.address == a) {
            self.tee_signers.push(TeeSigner { model, address: a });
        }
    }

    pub fn remove_tee_signer(&mut self, model: String, address: String) {
        self.assert_owner();
        let a = address.to_lowercase();
        self.tee_signers.retain(|t| !(t.model == model && t.address == a));
    }

    pub fn get_tee_signers(&self) -> Vec<TeeSigner> { self.tee_signers.clone() }

    pub fn get_tee_proof(&self, reply_hash: String) -> Option<TeeProof> { self.tee_proofs.get(&reply_hash).cloned() }

    pub fn set_backend(&mut self, backend_id: AccountId) {
        self.assert_owner();
        self.backend_id = backend_id;
    }

    pub fn set_params(&mut self, sleep_threshold: NearToken, hunger_ns: U64) {
        self.assert_owner();
        require!(hunger_ns.0 > 0, "hunger_ns must be > 0");
        self.sleep_threshold = sleep_threshold;
        self.hunger_ns = hunger_ns.0;
    }

    /// Pay accumulated AI fees out to the operator, who settles NEAR AI Cloud bills.
    pub fn withdraw_treasury(&mut self) -> Promise {
        self.assert_owner();
        let amount = self.treasury;
        require!(amount.as_yoctonear() > 0, "treasury empty");
        self.treasury = NearToken::from_yoctonear(0);
        Promise::new(self.owner_id.clone()).transfer(amount)
    }

    // ---------- views ----------

    pub fn get_pet(&self, token_id: TokenId) -> Option<PetView> {
        let pet = self.pets.get(&token_id)?;
        Some(PetView {
            owner_id: self.owner_of(&token_id),
            name: pet.name.clone(),
            prompt_hash: pet.prompt_hash.clone(),
            balance: pet.balance,
            last_fed_ns: U64(pet.last_fed_ns),
            replies: pet.replies,
            last_reply_hash: pet.last_reply_hash.clone(),
            revives: pet.revives,
            asleep: self.asleep(&token_id),
            arena_wins: self.arena_wins.get(&token_id).copied().unwrap_or(0),
            pet_account: self.pet_accounts.get(&token_id).cloned(),
            pet_key_active: self.pet_accounts.contains_key(&token_id) && self.pet_key_active(&token_id),
            token_id,
        })
    }

    pub fn is_asleep(&self, token_id: TokenId) -> bool {
        require!(self.pets.contains_key(&token_id), "pet not found");
        self.asleep(&token_id)
    }

    pub fn get_reply(&self, reply_hash: String) -> Option<ReplyRecord> {
        self.replies.get(&reply_hash).cloned()
    }

    pub fn get_config(&self) -> Config {
        Config {
            owner_id: self.owner_id.clone(),
            backend_id: self.backend_id.clone(),
            sleep_threshold: self.sleep_threshold,
            hunger_ns: U64(self.hunger_ns),
            treasury: self.treasury,
            total_pets: self.next_id,
        }
    }
}

impl Petri {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "only the contract owner");
    }

    fn owner_of(&self, token_id: &TokenId) -> AccountId {
        self.tokens.owner_by_id.get(token_id).unwrap_or_else(|| env::panic_str("pet not found"))
    }

    fn pet_mut(&mut self, token_id: &TokenId) -> &mut Pet {
        self.pets.get_mut(token_id).unwrap_or_else(|| env::panic_str("pet not found"))
    }

    fn asleep(&self, token_id: &TokenId) -> bool {
        let pet = self.pets.get(token_id).unwrap_or_else(|| env::panic_str("pet not found"));
        asleep_rule(pet.balance.as_yoctonear(), self.sleep_threshold.as_yoctonear(),
                    pet.last_fed_ns, env::block_timestamp(), self.hunger_ns)
    }

    /// Who set the pet account's current key (None for pets minted before this was tracked).
    fn key_holder(&self, token_id: &TokenId) -> Option<AccountId> {
        env::storage_read(format!("{KEY_HOLDER_PREFIX}{token_id}").as_bytes())
            .and_then(|v| String::from_utf8(v).ok()).and_then(|s| s.parse().ok())
    }

    fn set_key_holder(&mut self, token_id: &TokenId, holder: &AccountId) {
        env::storage_write(format!("{KEY_HOLDER_PREFIX}{token_id}").as_bytes(), holder.as_bytes());
    }

    fn key_gen(&self, token_id: &TokenId) -> u64 {
        env::storage_read(format!("{KEY_GEN_PREFIX}{token_id}").as_bytes())
            .and_then(|v| v.try_into().ok()).map(u64::from_le_bytes).unwrap_or(0)
    }

    /// The pet account may charge only while its key holder is the current NFT owner.
    /// Untracked legacy pets count as active until their first transfer pins the holder.
    fn pet_key_active(&self, token_id: &TokenId) -> bool {
        self.key_holder(token_id).map_or(true, |h| h == self.owner_of(token_id))
    }

    /// Called before every transfer: remember who holds the pet key, so the key
    /// stops working the moment the NFT has a new owner.
    fn pin_key_holder(&mut self, token_id: &TokenId) {
        if self.pet_accounts.contains_key(token_id) && self.key_holder(token_id).is_none() {
            let owner = self.owner_of(token_id);
            self.set_key_holder(token_id, &owner);
        }
    }

    /// `pet-<id>.<this contract>`: the pet's own account id.
    fn pet_account_id(&self, token_id: &TokenId) -> String {
        format!("pet-{token_id}.{}", env::current_account_id())
    }

}

// ---------- NEP-171 plumbing ----------

#[near]
impl NonFungibleTokenCore for Petri {
    #[payable]
    fn nft_transfer(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>) {
        self.pin_key_holder(&token_id);
        self.tokens.nft_transfer(receiver_id, token_id, approval_id, memo)
    }

    #[payable]
    fn nft_transfer_call(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>,
                         memo: Option<String>, msg: String) -> PromiseOrValue<bool> {
        self.pin_key_holder(&token_id);
        self.tokens.nft_transfer_call(receiver_id, token_id, approval_id, memo, msg)
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.nft_token(token_id)
    }
}

#[near]
impl NonFungibleTokenResolver for Petri {
    #[private]
    fn nft_resolve_transfer(&mut self, previous_owner_id: AccountId, receiver_id: AccountId, token_id: TokenId,
                            approved_account_ids: Option<HashMap<AccountId, u64>>) -> bool {
        self.tokens.nft_resolve_transfer(previous_owner_id, receiver_id, token_id, approved_account_ids)
    }
}

#[near]
impl NonFungibleTokenEnumeration for Petri {
    fn nft_total_supply(&self) -> U128 { self.tokens.nft_total_supply() }
    fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens(from_index, limit)
    }
    fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 { self.tokens.nft_supply_for_owner(account_id) }
    fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens_for_owner(account_id, from_index, limit)
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Petri {
    fn nft_metadata(&self) -> NFTContractMetadata { self.metadata.get().unwrap() }
}

fn default_mpc() -> AccountId {
    let testnet = env::current_account_id().as_str().ends_with(".testnet");
    (if testnet { "v1.signer-prod.testnet" } else { "v1.signer" }).parse().unwrap()
}

pub mod meme;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_attack;

/// Lowercase hex encoding.
pub fn hex(b: &[u8]) -> String {
    const D: &[u8; 16] = b"0123456789abcdef";
    b.iter().flat_map(|x| [D[(x >> 4) as usize] as char, D[(x & 15) as usize] as char]).collect()
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    if !s.is_ascii() || s.len() % 2 != 0 { return None; }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}

/// EIP-191 personal_sign recovery, as used by NEAR AI Cloud `signing_algo=ecdsa`.
/// Returns the lowercase 0x address of the signer, or None for a malformed signature.
pub fn recover_eip191(text: &str, sig_hex: &str) -> Option<String> {
    let sig = unhex(sig_hex)?;
    if sig.len() != 65 { return None; }
    let mut msg = format!("\x19Ethereum Signed Message:\n{}", text.len()).into_bytes();
    msg.extend_from_slice(text.as_bytes());
    let hash = env::keccak256_array(&msg);
    let v = match sig[64] { 27 | 28 => sig[64] - 27, 0 | 1 => sig[64], _ => return None };
    let mut rs = [0u8; 64];
    rs.copy_from_slice(&sig[..64]);
    let pk = env::ecrecover(&hash, &rs, v, true)?;
    let addr = env::keccak256_array(&pk);
    Some(format!("0x{}", hex(&addr[12..])))
}
