//! Authenticated single-owner retained signing. Bootstrap is a trusted local
//! fixture; Rosen votes are independently verified with the pinned real codec.
use super::*;
use crate::participant_envelope as w;
use authorized_signing::{self as signing, terminal};
use blake2::{digest::consts::U32, Blake2b};
use k256::ecdsa::{signature::hazmat::PrehashVerifier, Signature, SigningKey, VerifyingKey};
use serde_json::{json, Value};
use sha2::Digest;
use std::io::{Read, Write};
type R<T> = std::result::Result<T, ()>;
const DOMAIN: &[u8] = b"rosen-monero/local-sign-envelope/v1";
fn hash32(v: &Value, name: &str) -> R<[u8; 32]> {
    w::unhex(w::string(v, name)?)?.try_into().map_err(|_| ())
}
fn b2(bytes: &[u8]) -> [u8; 32] {
    Blake2b::<U32>::digest(bytes).into()
}
fn u32_field(v: &Value, name: &str) -> R<u32> {
    u32::try_from(v.get(name).and_then(Value::as_u64).ok_or(())?).map_err(|_| ())
}
fn verify_vote(public_key: &str, payload: &[u8], signature: &str) -> R<()> {
    let key = w::public_key(public_key)?;
    let signature = Signature::from_slice(&w::unhex(signature)?).map_err(|_| ())?;
    if signature.normalize_s().is_some() {
        return Err(());
    }
    key.verify_prehash(&b2(payload), &signature).map_err(|_| ())
}
struct VotePolicy {
    keys: Vec<String>,
    timestamp: u32,
}
impl VotePolicy {
    fn new(config: &Value) -> R<Self> {
        if w::number(config, "required")? != 3 {
            return Err(());
        }
        let values = config
            .get("rosenKeys")
            .and_then(Value::as_array)
            .ok_or(())?;
        if values.len() != 4 {
            return Err(());
        }
        let mut seen = std::collections::HashSet::new();
        let mut keys = Vec::new();
        for value in values {
            let key = value.as_str().ok_or(())?;
            w::public_key(key)?;
            if !seen.insert(key) {
                return Err(());
            }
            keys.push(key.to_owned());
        }
        Ok(Self {
            keys,
            timestamp: u32_field(config, "timestamp")?,
        })
    }
    fn check(&self, certificate: &Value, tx_json: &str, tx_id: &str) -> R<()> {
        w::fields(
            certificate,
            &[
                "txJson",
                "txId",
                "txDataHash",
                "signatures",
                "timestamp",
                "publicKeys",
                "protocolVersion",
                "requiredSign",
            ],
        )?;
        let expected_hash = w::hex(&b2(tx_json.as_bytes()));
        if w::string(certificate, "txJson")? != tx_json
            || w::string(certificate, "txId")? != tx_id
            || w::string(certificate, "txDataHash")? != expected_hash
            || u32_field(certificate, "timestamp")? != self.timestamp
            || w::string(certificate, "protocolVersion")? != "1.0.0"
            || w::number(certificate, "requiredSign")? != 3
        {
            return Err(());
        }
        let keys = certificate
            .get("publicKeys")
            .and_then(Value::as_array)
            .ok_or(())?;
        let signatures = certificate
            .get("signatures")
            .and_then(Value::as_array)
            .ok_or(())?;
        if keys.len() != 4 || signatures.len() != 4 {
            return Err(());
        }
        let payload_base =
            String::from_utf8(w::bytes(&json!({"txDataHash":expected_hash}))).map_err(|_| ())?;
        let mut count = 0;
        for (index, key) in self.keys.iter().enumerate() {
            if keys[index].as_str() != Some(key) {
                return Err(());
            }
            let signature = signatures[index].as_str().ok_or(())?;
            if signature.is_empty() {
                continue;
            }
            let payload = format!("{}{}{}1.0.0", payload_base, self.timestamp, key);
            verify_vote(key, payload.as_bytes(), signature)?;
            count += 1;
        }
        if count < 3 {
            return Err(());
        }
        Ok(())
    }
}
// Only this module's successful retained-candidate certificate gate constructs
// the capability; it has no decoder, Clone, public fields, or public constructor.
pub(super) struct VerifiedApproval {
    descriptor: [u8; 32],
    expectation: [u8; 32],
}
impl VerifiedApproval {
    pub(super) fn matches(&self, descriptor: [u8; 32], expectation: [u8; 32]) -> bool {
        self.descriptor == descriptor && self.expectation == expectation
    }
}

enum State {
    Images(AwaitingImages, Vec<ProofRow>),
    Preprocess(CollectingAttempt),
    Descriptor(ImageBoundUnapproved),
    Approval(ImageBoundUnapproved, terminal::PreparedExpectation),
    Shares(terminal::PendingSingle),
    Complete,
}
pub(crate) struct ActorSigning {
    id: u16,
    config: Value,
    binding: [u8; 32],
    directory: PathBuf,
    policy: VotePolicy,
    request: Vec<u8>,
    selection: String,
    state: State,
    tx_json: String,
    tx_id: String,
    descriptor: [u8; 32],
    trace: Arc<Trace>,
}
pub(crate) fn fund(group: [u8; 32]) -> R<Value> {
    host::node::participant_fund(group)
}
pub(crate) struct PendingDeposit(host::node::PreparedDeposit);
pub(crate) fn prepare_deposit(group: [u8; 32], directory: &Path, deposit_data: Option<Vec<u8>>) -> R<(PendingDeposit, Value)> {
    let pending = host::node::participant_prepare_deposit(group, directory, deposit_data)?;
    let frame = pending.public_frame();
    Ok((PendingDeposit(pending), frame))
}
fn deposit_submit_request(v: &Value, expected: [u8; 32]) -> R<()> {
    w::fields(v, &["type", "txId"])?;
    if w::string(v, "type")? != "submit-deposit" || hash32(v, "txId")? != expected {
        return Err(());
    }
    Ok(())
}
impl PendingDeposit {
    pub(crate) fn submit(self, request: &Value) -> R<Value> {
        deposit_submit_request(request, self.0.txid())?;
        host::node::participant_submit_deposit(self.0)
    }
}
pub(crate) fn fund_deposit(group: [u8; 32], directory: &Path, deposit_data: Option<Vec<u8>>) -> R<Value> {
    let (pending, frame) = prepare_deposit(group, directory, deposit_data)?;
    pending.submit(&json!({"type":"submit-deposit","txId":frame["deposit"]["txId"]}))
}
pub(crate) fn recover(directory: &Path, expected: [u8; 32]) -> R<Value> {
    let final_value = terminal::recover(directory, expected).map_err(|_| ())?;
    Ok(json!({"type":"recovered","result":final_value.response().map_err(|_|())?,"walletSigns":0}))
}
pub(crate) fn observe(directory: &Path, expected: [u8; 32]) -> R<Value> {
    let final_value = terminal::recover(directory, expected).map_err(|_| ())?;
    let (request, bytes) = final_value.observation_data().map_err(|_| ())?;
    // Project only the same expectation already authenticated and fully decoded
    // by recovery. A bounded second read must match the independent digest too;
    // it cannot replace the recovered context during observation.
    let mut raw = Vec::new();
    std::io::Read::take(std::fs::File::open(directory.join("expectation.private")).map_err(|_| ())?, 65_537)
        .read_to_end(&mut raw).map_err(|_| ())?;
    let anchor = observation_anchor(&raw, expected)?;
    host::node::participant_observe(anchor, request, bytes)
}
fn observation_anchor(raw: &[u8], expected: [u8; 32]) -> R<host::node::ObservationAnchor> {
    if raw.len() > 65_536 || signing::sha(raw) != expected { return Err(()); }
    let text = std::str::from_utf8(raw).map_err(|_| ())?;
    let lines = text.strip_suffix('\n').ok_or(())?.split('\n').collect::<Vec<_>>();
    if lines.len() != 42 || lines[0] != "WMEX2" { return Err(()); }
    let preparation = String::from_utf8(w::unhex(lines[1])?).map_err(|_| ())?;
    let descriptor = String::from_utf8(w::unhex(lines[2])?).map_err(|_| ())?;
    let prep = preparation.strip_suffix('\n').ok_or(())?.split('\n').collect::<Vec<_>>();
    let desc = descriptor.strip_suffix('\n').ok_or(())?.split('\n').collect::<Vec<_>>();
    if prep.len() != 11 || prep[0] != "W1PSP1" || desc.len() != 15 || desc[0] != "WMAD1" || prep[3] != desc[1] { return Err(()); }
    let hash = |s: &str| -> R<[u8;32]> { w::unhex(s)?.try_into().map_err(|_| ()) };
    Ok(host::node::ObservationAnchor { genesis: hash(prep[3])?, group: hash(desc[14])?, candidate_identity: hash(desc[6])?, candidate: w::unhex(lines[3])? })
}
impl ActorSigning {
    pub(crate) fn new(
        id: u16,
        key: ThresholdKeys<Ed25519>,
        config: Value,
        identity: &SigningKey,
    ) -> R<(Self, Vec<Value>)> {
        w::fields(
            &config,
            &[
                "type",
                "runtimeDirectory",
                "ceremony",
                "epoch",
                "rosterDigest",
                "genesis",
                "selected",
                "attempt",
                "seed",
                "request",
                "source",
                "rosenKeys",
                "required",
                "timestamp",
            ],
        )?;
        if id > 2
            || id == 0
            || u16::from(key.params().i()) != id
            || config["selected"] != json!([1, 2])
        {
            return Err(());
        }
        let policy = VotePolicy::new(&config)?;
        for name in [
            "ceremony",
            "epoch",
            "rosterDigest",
            "genesis",
            "attempt",
            "seed",
        ] {
            if hash32(&config, name)? == [0; 32] {
                return Err(());
            }
        }
        let request = w::unhex(w::string(&config, "request")?)?;
        let decoded = Request::decode(&request).map_err(|_| ())?;
        if decoded.network != Network::Testnet {
            return Err(());
        }
        let address =
            MoneroAddress::from_str(Network::Testnet, &decoded.address).map_err(|_| ())?;
        if address.to_string() != decoded.address {
            return Err(());
        }
        let directory = PathBuf::from(w::string(&config, "runtimeDirectory")?);
        if !directory.is_absolute() {
            return Err(());
        }
        std::fs::create_dir_all(&directory).map_err(|_| ())?;
        if std::fs::read_dir(&directory)
            .map_err(|_| ())?
            .next()
            .is_some()
        {
            return Err(());
        }
        let mut shared = config.clone();
        let object = shared.as_object_mut().ok_or(())?;
        object.remove("runtimeDirectory");
        object.remove("type");
        let binding = w::digest(b"rosen-monero/local-sign-config/v1", &w::bytes(&shared));
        let owner_id = w::digest(b"rosen-monero/local-sign-owner/v1", &binding);
        let marker = format!("WMPSESSION1\n{}\n{}\n", id, w::hex(&binding)).into_bytes();
        let marker_path = directory.join("session.private");
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&marker_path)
            .map_err(|_| ())?;
        file.write_all(&marker)
            .and_then(|_| file.sync_all())
            .map_err(|_| ())?;
        if std::fs::read(&marker_path).map_err(|_| ())? != marker {
            return Err(());
        }
        let (vault, inputs, fee) = host::node::participant_scan(
            key.group_key().to_bytes(),
            hash32(&config, "genesis")?,
            &config["source"],
            &directory,
        )?;
        let selection = host::participant_selection(&inputs, &vault, fee)?;
        let trace = Arc::new(Trace::default());
        let owner = CustodyOwner::create_configured(
            &directory.join("intent.private"),
            &directory.join("journal.private"),
            request.clone(),
            inputs,
            vault,
            Zeroizing::new(hash32(&config, "seed")?),
            trace.clone(),
            fee,
            owner_id,
            binding,
            hash32(&config, "epoch")?,
            hash32(&config, "genesis")?,
        )
        .map_err(|_| ())?;
        let (awaiting, rows) = owner
            .restore_guard(
                key,
                vec![Participant::new(1).unwrap(), Participant::new(2).unwrap()],
                hash32(&config, "attempt")?,
            )
            .map_err(|_| ())?;
        let payload = w::bytes(&Value::Array(
            rows.iter()
                .map(|row| json!(w::hex(&row.encode())))
                .collect(),
        ));
        let result = Self {
            id,
            config,
            binding,
            directory,
            policy,
            request,
            selection,
            state: State::Images(awaiting, rows),
            tx_json: String::new(),
            tx_id: String::new(),
            descriptor: [0; 32],
            trace,
        };
        let outbound = result.envelope(5, &payload, identity)?;
        Ok((result, vec![outbound]))
    }
    fn envelope(&self, round: u16, payload: &[u8], identity: &SigningKey) -> R<Value> {
        w::sign_domain(
            json!({"type":"sign-peer","ceremony":self.config["ceremony"],"epoch":self.config["epoch"],"rosterDigest":self.config["rosterDigest"],"genesis":self.config["genesis"],"binding":w::hex(&self.binding),"attempt":self.config["attempt"],"selected":[1,2],"from":self.id,"to":3-self.id,"round":round,"sequence":round,"payload":w::hex(payload)}),
            identity,
            DOMAIN,
        )
    }
    fn peer(&self, v: &Value, keys: &HashMap<u16, VerifyingKey>) -> R<Vec<u8>> {
        w::fields(
            v,
            &[
                "type",
                "ceremony",
                "epoch",
                "rosterDigest",
                "genesis",
                "binding",
                "attempt",
                "selected",
                "from",
                "to",
                "round",
                "sequence",
                "payload",
                "signature",
            ],
        )?;
        let round = match self.state {
            State::Images(..) => 5,
            State::Preprocess(_) => 6,
            State::Descriptor(_) => 7,
            State::Shares(_) => 8,
            _ => return Err(()),
        };
        if w::string(v, "type")? != "sign-peer"
            || w::number(v, "from")? != 3 - self.id
            || w::number(v, "to")? != self.id
            || w::number(v, "round")? != round
            || w::number(v, "sequence")? != round
            || v["selected"] != json!([1, 2])
            || w::string(v, "binding")? != w::hex(&self.binding)
        {
            return Err(());
        }
        for field in ["ceremony", "epoch", "rosterDigest", "genesis", "attempt"] {
            if v[field] != self.config[field] {
                return Err(());
            }
        }
        w::verify_domain(v, keys.get(&(3 - self.id)).ok_or(())?, DOMAIN)?;
        w::unhex(w::string(v, "payload")?)
    }
    pub(crate) fn accept(
        &mut self,
        v: &Value,
        identity: &SigningKey,
        keys: &HashMap<u16, VerifyingKey>,
    ) -> R<Vec<Value>> {
        if w::string(v, "type")? == "approve" {
            return self.approve(v, identity);
        }
        let payload = self.peer(v, keys)?;
        let state = std::mem::replace(&mut self.state, State::Complete);
        match state {
            State::Images(awaiting, own) => {
                let mut raw = payload;
                raw.push(b'\n');
                let decoded = w::parse(&raw)?;
                let values = decoded.as_array().ok_or(())?;
                if values.len() != 2 || own.len() != 2 {
                    return Err(());
                }
                let remote = values
                    .iter()
                    .map(|v| ProofRow::decode(&w::unhex(v.as_str().ok_or(())?)?).map_err(|_| ()))
                    .collect::<R<Vec<_>>>()?;
                let mut rows = Vec::new();
                for i in 0..2 {
                    if self.id == 1 {
                        rows.extend([own[i].clone(), remote[i].clone()])
                    } else {
                        rows.extend([remote[i].clone(), own[i].clone()])
                    }
                }
                let (attempt, message) = awaiting.certify(&rows).map_err(|_| ())?;
                let out = self.envelope(6, &message.wire, identity)?;
                self.state = State::Preprocess(attempt);
                Ok(vec![out])
            }
            State::Preprocess(attempt) => {
                let message = LocalModelMessage {
                    binding: attempt.model.clone(),
                    participant: Participant::new(3 - self.id).ok_or(())?,
                    wire: payload.into_boxed_slice(),
                };
                let owner = attempt.seal(vec![message]).map_err(|_| ())?;
                let descriptor = signing::describe_single(&owner).map_err(|_| ())?;
                self.descriptor = descriptor.identity();
                let out = self.envelope(7, descriptor.wire().as_bytes(), identity)?;
                self.state = State::Descriptor(owner);
                Ok(vec![out])
            }
            State::Descriptor(owner) => {
                let descriptor = signing::describe_single(&owner).map_err(|_| ())?;
                if payload != descriptor.wire().as_bytes() {
                    return Err(());
                }
                let decoded = crate::candidate::decode(&owner._candidate.bytes).map_err(|_| ())?;
                let request = Request::decode(&self.request).map_err(|_| ())?;
                self.tx_id = w::hex(&decoded.proposal);
                self.tx_json=String::from_utf8(w::bytes(&json!({"eventId":request.event_id,"network":"monero","txBytes":w::hex(&owner._candidate.bytes),"txId":self.tx_id,"txType":"payment"}))).map_err(|_|())?;
                let prep = format!(
                    "W1PSP1\n1\n{}\n{}\n{}\n{}\n2\n{}\n{}\n{}\n{}\n",
                    w::hex(&self.request),
                    w::string(&self.config, "genesis")?,
                    w::string(&self.config, "epoch")?,
                    w::hex(&self.binding),
                    request.max_miner_fee,
                    w::string(&self.config, "attempt")?,
                    w::hex(&descriptor.identity()),
                    w::hex(&self.binding)
                )
                .into_bytes();
                let expectation =
                    signing::Expectation::from_single(&owner, prep).map_err(|_| ())?;
                let prepared = terminal::prepare(&self.directory, expectation).map_err(|_| ())?;
                let (change_key, change_index) = host::node::participant_change(
                    owner._candidate.semantic.change_spend,
                    &owner._candidate,
                    &self.config["source"],
                )?;
                let out = json!({"type":"candidate","id":self.id,"request":w::hex(&self.request),"candidate":w::hex(&owner._candidate.bytes),"receipt":owner.receipt,"descriptor":descriptor.wire(),"txJson":self.tx_json,"txDataHash":w::hex(&b2(self.tx_json.as_bytes())),"expectationDigest":w::hex(&prepared.digest()),"binding":w::hex(&self.binding),"inputAtomic":owner._candidate.semantic.input_total.to_string(),"changeAtomic":owner._candidate.semantic.change.to_string(),"selection":self.selection,"changeOutputKey":w::hex(&change_key),"changeOutputIndex":change_index});
                self.state = State::Approval(owner, prepared);
                Ok(vec![out])
            }
            State::Shares(pending) => {
                let final_value =
                    terminal::finish_single(&self.directory, pending, &payload).map_err(|_| ())?;
                if self.trace.wallet_signs.load(Ordering::SeqCst) != 1 {
                    return Err(());
                }
                Ok(vec![
                    json!({"type":"final","id":self.id,"result":final_value.response().map_err(|_|())?,"walletSigns":1}),
                ])
            }
            _ => Err(()),
        }
    }
    fn approve(&mut self, v: &Value, identity: &SigningKey) -> R<Vec<Value>> {
        w::fields(v, &["type", "expectationDigest", "certificate"])?;
        let State::Approval(_, prepared) = &self.state else {
            return Err(());
        };
        if hash32(v, "expectationDigest")? != prepared.digest() {
            return Err(());
        }
        self.policy
            .check(&v["certificate"], &self.tx_json, &self.tx_id)?;
        let approval = VerifiedApproval {
            descriptor: self.descriptor,
            expectation: prepared.digest(),
        };
        let State::Approval(owner, prepared) = std::mem::replace(&mut self.state, State::Complete)
        else {
            return Err(());
        };
        let (pending, share) =
            terminal::begin_single(&self.directory, owner, prepared, approval).map_err(|_| ())?;
        let out = self.envelope(8, &share, identity)?;
        self.state = State::Shares(pending);
        Ok(vec![out])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deposit_submit_exact_command_and_cached_identity() {
        let good = json!({"type":"submit-deposit","txId":"11".repeat(32)});
        assert!(deposit_submit_request(&good, [0x11;32]).is_ok());
        let mut wrong = good.clone();wrong["txId"] = json!("22".repeat(32));
        assert!(deposit_submit_request(&wrong, [0x11;32]).is_err());
        for kind in ["configure", "inspect-source", "fund", "fund-deposit", "prepare-deposit"] {
            let mut wrong = good.clone();wrong["type"] = json!(kind);
            assert!(deposit_submit_request(&wrong, [0x11;32]).is_err());
        }
        for key in ["type", "txId"] {
            let mut wrong = good.clone();wrong.as_object_mut().unwrap().remove(key);
            assert!(deposit_submit_request(&wrong, [0x11;32]).is_err());
        }
        for extra in ["txBytes", "runtimeDirectory", "blockHeight", "chainIndex"] {
            let mut wrong = good.clone();wrong[extra] = json!(0);
            assert!(deposit_submit_request(&wrong, [0x11;32]).is_err());
        }
        for id in ["11".repeat(31), "11".repeat(33)] {
            let mut wrong = good.clone();wrong["txId"] = json!(id);
            assert!(deposit_submit_request(&wrong, [0x11;32]).is_err());
        }
        let lowercase = json!({"type":"submit-deposit","txId":"aa".repeat(32)});
        assert!(deposit_submit_request(&lowercase, [0xaa;32]).is_ok());
        let uppercase = json!({"type":"submit-deposit","txId":"AA".repeat(32)});
        assert!(deposit_submit_request(&uppercase, [0xaa;32]).is_err());
    }
    #[test]
    fn observation_projection_requires_exact_independent_anchor_and_profile() {
        // Projection-only fixture. Real observe first calls terminal::recover,
        // which independently validates the complete expectation and final.
        let mut prep = vec!["00".repeat(32); 11]; prep[0]="W1PSP1".into(); prep[3]="11".repeat(32);
        let mut desc = vec!["00".repeat(32); 15]; desc[0]="WMAD1".into();desc[1]=prep[3].clone();desc[6]="22".repeat(32);desc[14]="33".repeat(32);
        let mut rows=vec!["0".to_string();42];rows[0]="WMEX2".into();rows[1]=w::hex(format!("{}\n",prep.join("\n")).as_bytes());rows[2]=w::hex(format!("{}\n",desc.join("\n")).as_bytes());rows[3]="abcd".into();
        let raw=format!("{}\n",rows.join("\n")).into_bytes();let digest=signing::sha(&raw);
        let anchor=observation_anchor(&raw,digest).unwrap();assert_eq!(anchor.genesis,[0x11;32]);assert_eq!(anchor.group,[0x33;32]);assert_eq!(anchor.candidate_identity,[0x22;32]);
        assert!(observation_anchor(&raw,[0;32]).is_err());
        for field in [1,2,3]{let mut crossed=rows.clone();crossed[field].push_str("00");let bytes=format!("{}\n",crossed.join("\n")).into_bytes();assert!(observation_anchor(&bytes,digest).is_err());}
        let mut old=rows.clone();old[0]="WMEX1".into();let old=format!("{}\n",old.join("\n")).into_bytes();assert!(observation_anchor(&old,signing::sha(&old)).is_err());
        prep[3]="44".repeat(32);rows[1]=w::hex(format!("{}\n",prep.join("\n")).as_bytes());let crossed=format!("{}\n",rows.join("\n")).into_bytes();assert!(observation_anchor(&crossed,signing::sha(&crossed)).is_err());
        let oversized=vec![b'x';65_537];assert!(observation_anchor(&oversized,signing::sha(&oversized)).is_err());
    }
    #[test]
    fn actual_rosen_vote_differential() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("evidence/rosen-vote-vectors.json");
        let vectors: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(
            w::hex(&b2(vectors["txJson"].as_str().unwrap().as_bytes())),
            vectors["txDataHash"]
        );
        assert_eq!(
            w::hex(&b2(vectors["payload"].as_str().unwrap().as_bytes())),
            vectors["prehash"]
        );
        for case in vectors["cases"].as_array().unwrap() {
            assert_eq!(
                verify_vote(
                    case["publicKey"].as_str().unwrap(),
                    case["payload"].as_str().unwrap().as_bytes(),
                    case["signature"].as_str().unwrap()
                )
                .is_ok(),
                case["accepted"].as_bool().unwrap()
            );
        }
    }
    #[test]
    fn certificate_exact_policy_and_single_field_refusals() {
        use k256::ecdsa::signature::hazmat::PrehashSigner;
        let signers = (1u8..=4)
            .map(|i| SigningKey::from_bytes((&[i; 32]).into()).unwrap())
            .collect::<Vec<_>>();
        let keys = signers
            .iter()
            .map(|s| w::hex(s.verifying_key().to_encoded_point(true).as_bytes()))
            .collect::<Vec<_>>();
        let config = json!({"rosenKeys":keys,"required":3,"timestamp":1234});
        let policy = VotePolicy::new(&config).unwrap();
        let tx = "retained-native-tx-json";
        let tx_id = "ab".repeat(32);
        let hash = w::hex(&b2(tx.as_bytes()));
        let signatures = signers
            .iter()
            .zip(&keys)
            .map(|(s, k)| {
                let p = format!("{{\"txDataHash\":\"{}\"}}1234{}1.0.0", hash, k);
                let sig: Signature = s.sign_prehash(&b2(p.as_bytes())).unwrap();
                w::hex(&sig.to_bytes())
            })
            .collect::<Vec<_>>();
        let certificate = json!({"txJson":tx,"txId":tx_id,"txDataHash":hash,"signatures":signatures,"timestamp":1234,"publicKeys":keys,"protocolVersion":"1.0.0","requiredSign":3});
        assert!(policy.check(&certificate, tx, &tx_id).is_ok());
        for field in [
            "txJson",
            "txId",
            "txDataHash",
            "timestamp",
            "publicKeys",
            "protocolVersion",
            "requiredSign",
        ] {
            let mut bad = certificate.clone();
            bad[field] = json!("changed");
            assert!(policy.check(&bad, tx, &tx_id).is_err());
        }
        for case in 0..5 {
            let mut bad = certificate.clone();
            match case {
                0 => {
                    bad["signatures"][2] = json!("");
                    bad["signatures"][3] = json!("");
                }
                1 => bad["signatures"][1] = bad["signatures"][0].clone(),
                2 => bad["signatures"][3] = json!("00"),
                3 => bad["extra"] = json!(0),
                _ => bad["publicKeys"][1] = bad["publicKeys"][0].clone(),
            }
            assert!(policy.check(&bad, tx, &tx_id).is_err());
        }
        let mut good = certificate;
        good["signatures"][3] = json!("");
        assert!(policy.check(&good, tx, &tx_id).is_ok());
    }
}
