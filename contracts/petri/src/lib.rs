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
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise, PromiseOrValue};
use std::collections::HashMap;

pub const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
/// Default: a pet with < 0.01 NEAR can't afford a reply and sleeps.
pub const DEFAULT_SLEEP_THRESHOLD: u128 = ONE_NEAR / 100;
/// Default: a pet unfed for 24h sleeps.
pub const DEFAULT_HUNGER_NS: u64 = 24 * 60 * 60 * 1_000_000_000;
pub const MAX_NAME_LEN: usize = 32;

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
    /// Planned per-pet sub-account; creation is a stub (see `pet_account_id`).
    pub pet_account: String,
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
        }
    }

    // ---------- pet lifecycle ----------

    /// Mint a pet to the caller. The attached deposit first covers storage;
    /// everything beyond that becomes the pet's balance.
    #[payable]
    pub fn mint_pet(&mut self, name: String, prompt_hash: String) -> PetView {
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
        self.create_pet_account(&token_id);
        self.get_pet(token_id).unwrap()
    }

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
        require!(env::predecessor_account_id() == self.backend_id, "only the backend can charge");
        require!(is_valid_hash(&response_hash), "response_hash must be 64 lowercase hex chars (sha256)");
        let pet = self.pets.get(&token_id).unwrap_or_else(|| env::panic_str("no such pet"));
        require!(hex(&env::sha256(prompt.as_bytes())) == pet.prompt_hash, "prompt does not match the pet's on-chain prompt_hash");
        let req: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(&request)
            .unwrap_or_else(|_| env::panic_str("request is not JSON"));
        let model = req["model"].as_str().unwrap_or_else(|| env::panic_str("request has no model")).to_string();
        let sys = req["messages"][0]["content"].as_str().unwrap_or("");
        require!(req["messages"][0]["role"] == "system" && sys.contains(prompt.as_str()),
                 "request system prompt does not contain the pet's prompt");
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

    // ---------- admin ----------

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
            pet_account: self.pet_account_id(&token_id),
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

    /// `pet-<id>.<this contract>`: the pet's planned own account.
    fn pet_account_id(&self, token_id: &TokenId) -> String {
        format!("pet-{token_id}.{}", env::current_account_id())
    }

    /// STUB (SPEC step 1): the factory should create `pet-<id>.<contract>` as a
    /// sub-account and move the pet balance there, e.g.
    /// `Promise::new(id).create_account().transfer(balance).add_full_access_key(..)`.
    /// For now balances are held and accounted for inside this contract; we only
    /// log the planned account so indexers/UI can show it.
    fn create_pet_account(&self, token_id: &TokenId) {
        env::log_str(&format!("STUB pet sub-account planned: {}", self.pet_account_id(token_id)));
    }
}

// ---------- NEP-171 plumbing ----------

#[near]
impl NonFungibleTokenCore for Petri {
    #[payable]
    fn nft_transfer(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>) {
        self.tokens.nft_transfer(receiver_id, token_id, approval_id, memo)
    }

    #[payable]
    fn nft_transfer_call(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>,
                         memo: Option<String>, msg: String) -> PromiseOrValue<bool> {
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

#[cfg(test)]
mod tests;

/// Lowercase hex encoding.
pub fn hex(b: &[u8]) -> String {
    const D: &[u8; 16] = b"0123456789abcdef";
    b.iter().flat_map(|x| [D[(x >> 4) as usize] as char, D[(x & 15) as usize] as char]).collect()
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    if s.len() % 2 != 0 { return None; }
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
