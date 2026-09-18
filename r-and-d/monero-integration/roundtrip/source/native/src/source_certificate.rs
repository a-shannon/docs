//! Replay holder image proofs against configured public epoch authority and a scanned output.
//! This verifies association only: no inclusion, unspent, credit or signing authority.
pub use crate::key_image::{InputIdentity, PublicImageCommittee};
use crate::{
    key_image::{LocalContext, LocalImageSession, ProofRow},
    participant_envelope as wire,
};
use dkg::Participant;
use k256::ecdsa::VerifyingKey;
use monero_wallet::WalletOutput;
use serde_json::{json, Value};
use std::collections::HashSet;

const SOURCE_DOMAIN: &[u8] = b"rosen-monero/local-source-envelope/v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Manifest,
    Frame,
    Context,
    Output,
    Envelope,
    Image,
}
type Result<T> = std::result::Result<T, Error>;

/// Trusted caller configuration. Neither the certificate nor its digest enrolls a committee.
/// Envelope keys may be epoch-scoped, but their authorization must survive reader restart.
#[derive(Clone)]
pub struct CommitteeManifest {
    pub genesis: [u8; 32],
    pub epoch: [u8; 32],
    pub ceremony: [u8; 32],
    pub public: PublicImageCommittee,
    pub identities: Vec<(u16, [u8; 33])>,
    pub source_policy: Option<String>,
}

impl CommitteeManifest {
    fn validate(&self) -> Result<Vec<VerifyingKey>> {
        if [self.genesis, self.epoch, self.ceremony].contains(&[0; 32])
            || self.public.threshold != 2
            || self.public.roster.len() != 4
            || self.identities.len() != 4
            || self
                .public
                .roster
                .iter()
                .enumerate()
                .any(|(slot, (id, _))| usize::from(*id) != slot + 1)
            || self
                .identities
                .iter()
                .enumerate()
                .any(|(slot, (id, _))| usize::from(*id) != slot + 1)
            || self
                .source_policy
                .as_deref()
                .is_some_and(|p| p != "authenticated-backing-v1")
        {
            return Err(Error::Manifest);
        }
        let mut unique = HashSet::new();
        self.identities
            .iter()
            .map(|(_, key)| {
                if !unique.insert(*key) {
                    return Err(Error::Manifest);
                }
                wire::public_key(&wire::hex(key)).map_err(|_| Error::Manifest)
            })
            .collect()
    }
    fn roster(&self) -> Value {
        json!({"groupKey":wire::hex(&self.public.group),"verificationShares":self.public.roster.iter()
            .map(|(id,key)|json!({"id":id,"publicKey":wire::hex(key)})).collect::<Vec<_>>()})
    }
    fn roster_digest(&self) -> [u8; 32] {
        wire::digest(
            b"rosen-monero/local-dkg-roster/v1",
            &wire::bytes(&self.roster()),
        )
    }
    /// Stable reference to all configured authority fields, not an authentication mechanism.
    pub fn digest(&self) -> Result<[u8; 32]> {
        self.validate()?;
        Ok(wire::digest(
            b"rosen-monero/source-certificate-committee/v1",
            &wire::bytes(&json!({
                "genesis":wire::hex(&self.genesis),"epoch":wire::hex(&self.epoch),
                "ceremony":wire::hex(&self.ceremony),"threshold":self.public.threshold,
                "profile":"ed25519-shamir-untweaked-standard","roster":self.roster(),
                "identities":self.identities.iter().map(|(id,key)|json!({"id":id,"publicKey":wire::hex(key)})).collect::<Vec<_>>(),
                "sourcePolicy":self.source_policy,
            })),
        ))
    }
}

/// Only successful replay constructs this result. Retain the exact context for downstream checks.
pub struct VerifiedSourceAssociation {
    manifest: [u8; 32],
    binding: [u8; 32],
    inspection: [u8; 32],
    output: InputIdentity,
    image: [u8; 32],
}
impl VerifiedSourceAssociation {
    pub fn manifest_digest(&self) -> [u8; 32] {
        self.manifest
    }
    pub fn source_binding(&self) -> [u8; 32] {
        self.binding
    }
    pub fn inspection(&self) -> [u8; 32] {
        self.inspection
    }
    pub fn output(&self) -> &InputIdentity {
        &self.output
    }
    pub fn image(&self) -> [u8; 32] {
        self.image
    }
}

fn hash(value: &Value, name: &str) -> Result<[u8; 32]> {
    wire::unhex(wire::string(value, name).map_err(|_| Error::Context)?)
        .map_err(|_| Error::Context)?
        .try_into()
        .map_err(|_| Error::Context)
}
fn number(value: &Value, name: &str) -> Result<u64> {
    value
        .get(name)
        .and_then(Value::as_u64)
        .ok_or(Error::Context)
}

/// Canonical frame: {version:1,committeeDigest,config,envelopes:[from1,from2],keyImage} + LF.
/// `output` must come from the caller's independently configured scanner/view authority.
/// Replaying a past certificate does not establish current canonicality or unspent state.
pub fn replay(
    manifest: &CommitteeManifest,
    frame: &[u8],
    output: &WalletOutput,
) -> Result<VerifiedSourceAssociation> {
    let identity_keys = manifest.validate()?;
    let manifest_digest = manifest.digest()?;
    let value = wire::parse(frame).map_err(|_| Error::Frame)?;
    wire::fields(
        &value,
        &[
            "version",
            "committeeDigest",
            "config",
            "envelopes",
            "keyImage",
        ],
    )
    .map_err(|_| Error::Frame)?;
    if number(&value, "version")? != 1 || hash(&value, "committeeDigest")? != manifest_digest {
        return Err(Error::Manifest);
    }
    let config = &value["config"];
    let mut fields = vec![
        "type",
        "ceremony",
        "epoch",
        "rosterDigest",
        "genesis",
        "inspection",
        "snapshot",
        "source",
    ];
    if manifest.source_policy.is_some() {
        fields.push("sourcePolicy");
    }
    wire::fields(config, &fields).map_err(|_| Error::Context)?;
    if wire::string(config, "type").map_err(|_| Error::Context)? != "inspect-source"
        || hash(config, "genesis")? != manifest.genesis
        || hash(config, "epoch")? != manifest.epoch
        || hash(config, "ceremony")? != manifest.ceremony
        || hash(config, "rosterDigest")? != manifest.roster_digest()
        || config.get("sourcePolicy").and_then(Value::as_str) != manifest.source_policy.as_deref()
    {
        return Err(Error::Context);
    }
    let inspection = hash(config, "inspection")?;
    if inspection == [0; 32] {
        return Err(Error::Context);
    }
    wire::fields(&config["snapshot"], &["height", "hash"]).map_err(|_| Error::Context)?;
    if number(&config["snapshot"], "height")? == 0 || hash(&config["snapshot"], "hash")? == [0; 32]
    {
        return Err(Error::Context);
    }
    let source = &config["source"];
    wire::fields(
        source,
        &[
            "kind",
            "startHeight",
            "blockHashes",
            "ringIndices",
            "outputIds",
            "deposit",
        ],
    )
    .map_err(|_| Error::Context)?;
    if wire::string(source, "kind").map_err(|_| Error::Context)? != "deposit" {
        return Err(Error::Context);
    }
    let deposit = &source["deposit"];
    wire::fields(
        deposit,
        &[
            "txId",
            "txBytes",
            "blockHash",
            "blockHeight",
            "outputKey",
            "outputIndex",
            "chainIndex",
            "amountAtomic",
            "feeAtomic",
        ],
    )
    .map_err(|_| Error::Context)?;
    if hash(deposit, "txId")? != output.transaction()
        || hash(deposit, "outputKey")? != output.key().compress().to_bytes()
        || number(deposit, "outputIndex")? != output.index_in_transaction()
        || number(deposit, "chainIndex")? != output.index_on_blockchain()
        || wire::string(deposit, "amountAtomic").map_err(|_| Error::Output)?
            != output.commitment().amount.to_string()
    {
        return Err(Error::Output);
    }
    let mut shared = config.clone();
    shared.as_object_mut().ok_or(Error::Context)?.remove("type");
    let binding = wire::digest(
        b"rosen-monero/local-source-config/v1",
        &wire::bytes(&shared),
    );
    let context = LocalContext {
        network_genesis: manifest.genesis,
        epoch: manifest.epoch,
        epoch_manifest: binding,
        session: inspection,
        retained_intent: wire::digest(b"rosen-monero/local-source-intent/v1", &wire::bytes(source)),
    };
    let selected = vec![Participant::new(1).unwrap(), Participant::new(2).unwrap()];
    let session = LocalImageSession::capture_public(
        context,
        &manifest.public,
        selected,
        std::slice::from_ref(output),
    )
    .map_err(|_| Error::Image)?;
    let envelopes = value["envelopes"].as_array().ok_or(Error::Envelope)?;
    if envelopes.len() != 2 {
        return Err(Error::Envelope);
    }
    let mut rows = Vec::with_capacity(2);
    for (slot, envelope) in envelopes.iter().enumerate() {
        wire::fields(
            envelope,
            &[
                "type",
                "ceremony",
                "epoch",
                "rosterDigest",
                "genesis",
                "inspection",
                "binding",
                "from",
                "to",
                "round",
                "sequence",
                "payload",
                "signature",
            ],
        )
        .map_err(|_| Error::Envelope)?;
        if wire::string(envelope, "type").map_err(|_| Error::Envelope)? != "inspection-peer"
            || number(envelope, "from")? != slot as u64 + 1
            || number(envelope, "to")? != 2 - slot as u64
            || number(envelope, "round")? != 1
            || number(envelope, "sequence")? != 1
            || hash(envelope, "binding")? != binding
        {
            return Err(Error::Envelope);
        }
        for name in ["ceremony", "epoch", "rosterDigest", "genesis", "inspection"] {
            if envelope[name] != config[name] {
                return Err(Error::Envelope);
            }
        }
        wire::verify_domain(envelope, &identity_keys[slot], SOURCE_DOMAIN)
            .map_err(|_| Error::Envelope)?;
        let bytes = wire::unhex(wire::string(envelope, "payload").map_err(|_| Error::Envelope)?)
            .map_err(|_| Error::Envelope)?;
        rows.push(ProofRow::decode(&bytes).map_err(|_| Error::Image)?);
    }
    let verified = session.verify(&rows).map_err(|_| Error::Image)?;
    let results = session.consume(&verified).map_err(|_| Error::Image)?;
    if results.len() != 1 || results[0].image() != hash(&value, "keyImage")? {
        return Err(Error::Image);
    }
    Ok(VerifiedSourceAssociation {
        manifest: manifest_digest,
        binding,
        inspection,
        output: *results[0].identity(),
        image: results[0].image(),
    })
}

#[cfg(test)]
#[path = "source_certificate_tests.rs"]
mod tests;
