//! Offline deposit association replay. The caller supplies trusted committee/view configuration.
//! No enrollment, consensus, unspent, confirmation, payment-proof or credit authority is inferred.
use crate::{
    deposit_block, participant_envelope as wire,
    source_certificate::{self, CommitteeManifest, PublicImageCommittee},
};
use monero_wallet::{
    address::Network,
    block::Block,
    ed25519::{CompressedPoint, Scalar},
    extra::{ExtraField, MAX_EXTRA_SIZE_BY_RELAY_RULE},
    transaction::{Timelock, Transaction},
    ViewPair,
};
use serde_json::{json, Value};
use std::io::{Read, Write};
use zeroize::Zeroizing;

pub const MAX_PACKET_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_FRAME_BYTES: usize = MAX_PACKET_BYTES + 128 * 1024;
const MAX_SAFE: u64 = 9_007_199_254_740_991;
const MAX_TRANSACTIONS: usize = 1024;
const MAX_TX_BYTES: usize = 1024 * 1024;
const MAX_OUTPUTS_PER_TX: usize = 256;
type R<T> = Result<T, ()>;

fn fields(value: &Value, names: &[&str]) -> R<()> {
    wire::fields(value, names)
}
fn number(value: &Value, name: &str) -> R<u64> {
    value
        .get(name)
        .and_then(Value::as_u64)
        .filter(|n| *n <= MAX_SAFE)
        .ok_or(())
}
fn bytes(value: &Value, name: &str, limit: usize) -> R<Vec<u8>> {
    let text = wire::string(value, name)?;
    if text.len() > limit.checked_mul(2).ok_or(())? {
        return Err(());
    }
    wire::unhex(text)
}
fn hash(value: &Value, name: &str) -> R<[u8; 32]> {
    bytes(value, name, 32)?.try_into().map_err(|_| ())
}
fn bounded(value: &Value, depth: usize) -> bool {
    if depth > 24 {
        return false;
    }
    match value {
        Value::Number(n) => n.as_u64().is_some_and(|n| n <= MAX_SAFE),
        Value::Array(a) => a.iter().all(|v| bounded(v, depth + 1)),
        Value::Object(o) => o.iter().all(|(k, v)| k.is_ascii() && bounded(v, depth + 1)),
        Value::String(s) => s.is_ascii(),
        _ => true,
    }
}
fn parse(frame: &[u8]) -> R<Value> {
    if frame.is_empty()
        || frame.len() > MAX_FRAME_BYTES
        || !frame.is_ascii()
        || frame.last() != Some(&b'\n')
    {
        return Err(());
    }
    let raw = &frame[..frame.len() - 1];
    let value: Value = serde_json::from_slice(raw).map_err(|_| ())?;
    let canonical = Zeroizing::new(wire::bytes(&value));
    if !bounded(&value, 0) || canonical.as_slice() != raw {
        return Err(());
    }
    Ok(value)
}
fn committee(value: &Value) -> R<CommitteeManifest> {
    fields(
        value,
        &[
            "genesis",
            "epoch",
            "ceremony",
            "threshold",
            "profile",
            "roster",
            "identities",
            "sourcePolicy",
        ],
    )?;
    if number(value, "threshold")? != 2
        || wire::string(value, "profile")? != "ed25519-shamir-untweaked-standard"
    {
        return Err(());
    }
    let roster = &value["roster"];
    fields(roster, &["groupKey", "verificationShares"])?;
    let shares = roster["verificationShares"].as_array().ok_or(())?;
    let identities = value["identities"].as_array().ok_or(())?;
    if shares.len() != 4 || identities.len() != 4 {
        return Err(());
    }
    let shares = shares
        .iter()
        .map(|row| {
            fields(row, &["id", "publicKey"])?;
            Ok((
                u16::try_from(number(row, "id")?).map_err(|_| ())?,
                hash(row, "publicKey")?,
            ))
        })
        .collect::<R<Vec<_>>>()?;
    let identities = identities
        .iter()
        .map(|row| {
            fields(row, &["id", "publicKey"])?;
            Ok((
                u16::try_from(number(row, "id")?).map_err(|_| ())?,
                bytes(row, "publicKey", 33)?.try_into().map_err(|_| ())?,
            ))
        })
        .collect::<R<Vec<_>>>()?;
    let source_policy = match &value["sourcePolicy"] {
        Value::Null => None,
        Value::String(s) if s == "authenticated-backing-v1" => Some(s.clone()),
        _ => return Err(()),
    };
    let manifest = CommitteeManifest {
        genesis: hash(value, "genesis")?,
        epoch: hash(value, "epoch")?,
        ceremony: hash(value, "ceremony")?,
        public: PublicImageCommittee {
            group: hash(roster, "groupKey")?,
            threshold: 2,
            roster: shares,
        },
        identities,
        source_policy,
    };
    // Exact projection of every digest field. The manifest is still caller authority.
    if manifest.digest().map_err(|_| ())?
        != wire::digest(
            b"rosen-monero/source-certificate-committee/v1",
            &wire::bytes(value),
        )
    {
        return Err(());
    }
    Ok(manifest)
}
struct PacketTransaction {
    txid: [u8; 32],
    raw: Vec<u8>,
    tx: Transaction,
    indices: Vec<u64>,
}
fn transaction(value: &Value) -> R<PacketTransaction> {
    fields(value, &["txId", "transactionHex", "outputIndices"])?;
    let txid = hash(value, "txId")?;
    let raw = bytes(value, "transactionHex", MAX_TX_BYTES)?;
    let indices = value["outputIndices"].as_array().ok_or(())?;
    if raw.is_empty() || indices.len() > MAX_OUTPUTS_PER_TX {
        return Err(());
    }
    let indices = indices
        .iter()
        .map(|v| v.as_u64().filter(|i| *i <= MAX_SAFE).ok_or(()))
        .collect::<R<Vec<_>>>()?;
    let mut reader = raw.as_slice();
    let tx = Transaction::read(&mut reader).map_err(|_| ())?;
    if !reader.is_empty()
        || tx.serialize() != raw
        || tx.hash() != txid
        || tx.prefix().outputs.len() != indices.len()
    {
        return Err(());
    }
    Ok(PacketTransaction {
        txid,
        raw,
        tx,
        indices,
    })
}
fn strict_data(tx: &Transaction) -> R<Vec<String>> {
    let extra = tx.prefix().extra.as_slice();
    if extra.len() > MAX_EXTRA_SIZE_BY_RELAY_RULE {
        return Err(());
    }
    let mut reader = extra;
    let mut data = vec![];
    while !reader.is_empty() {
        let before = reader;
        let field = ExtraField::read(&mut reader).map_err(|_| ())?;
        let consumed = before.len().checked_sub(reader.len()).ok_or(())?;
        if consumed == 0 || field.serialize() != before[..consumed] {
            return Err(());
        }
        if let ExtraField::Nonce(nonce) = field {
            if nonce.first() == Some(&127) {
                if nonce.len() < 2 || nonce.len() > 255 {
                    return Err(());
                }
                data.push(wire::hex(&nonce[1..]));
            }
        }
    }
    Ok(data)
}
fn verify(mut value: Value) -> R<Value> {
    fields(
        &value,
        &[
            "version",
            "committee",
            "viewKey",
            "packet",
            "certificate",
            "txId",
            "outputIndex",
        ],
    )?;
    if number(&value, "version")? != 1 {
        return Err(());
    }
    let manifest = committee(&value["committee"])?;
    // Move sensitive text out of JSON ownership immediately and zeroize both encodings.
    let view_text = match value.as_object_mut().ok_or(())?.remove("viewKey") {
        Some(Value::String(s)) => Zeroizing::new(s),
        _ => return Err(()),
    };
    if view_text.len() != 64 {
        return Err(());
    }
    let view_bytes = Zeroizing::new(wire::unhex(&view_text)?);
    if view_bytes.iter().all(|b| *b == 0) {
        return Err(());
    }
    let mut reader = view_bytes.as_slice();
    let view_scalar = Zeroizing::new(Scalar::read(&mut reader).map_err(|_| ())?);
    if !reader.is_empty() {
        return Err(());
    }
    let group = CompressedPoint::from(manifest.public.group)
        .decompress()
        .ok_or(())?;
    let view = ViewPair::new(group, view_scalar).map_err(|_| ())?;
    let txid = hash(&value, "txId")?;
    let output_index = number(&value, "outputIndex")?;
    let certificate = wire::string(&value, "certificate")?;
    let cert = wire::parse(certificate.as_bytes())?;
    let packet = &value["packet"];
    fields(
        packet,
        &["blockHex", "blockHash", "height", "miner", "transactions"],
    )?;
    if wire::bytes(packet).len() > MAX_PACKET_BYTES {
        return Err(());
    }
    let block_bytes = bytes(packet, "blockHex", 2 * 1024 * 1024)?;
    let block_hash = hash(packet, "blockHash")?;
    let height = number(packet, "height")?;
    let rows = packet["transactions"].as_array().ok_or(())?;
    if rows.len() > MAX_TRANSACTIONS {
        return Err(());
    }
    let miner = transaction(&packet["miner"])?;
    let transactions = rows.iter().map(transaction).collect::<R<Vec<_>>>()?;
    let mut reader = block_bytes.as_slice();
    let block = Block::read(&mut reader).map_err(|_| ())?;
    if !reader.is_empty()
        || block.serialize() != block_bytes
        || block.miner_transaction().serialize() != miner.raw
        || block.miner_transaction().hash() != miner.txid
    {
        return Err(());
    }
    let (mut first, mut next) = (None, None);
    for row in std::iter::once(&miner).chain(transactions.iter()) {
        if row.tx.version() == 2 {
            for index in &row.indices {
                if let Some(expected) = next {
                    if *index != expected {
                        return Err(());
                    }
                } else {
                    first = Some(*index);
                }
                next = Some(index.checked_add(1).ok_or(())?);
            }
        }
    }
    let blobs = transactions
        .iter()
        .map(|row| row.raw.clone())
        .collect::<Vec<_>>();
    let scanned = deposit_block::scan(
        &view,
        &block_bytes,
        &blobs,
        first,
        block_hash,
        height,
        deposit_block::Limits {
            max_block_bytes: 2 * 1024 * 1024,
            max_transaction_bytes: MAX_TX_BYTES,
            max_total_bytes: MAX_PACKET_BYTES / 2,
            max_transactions: MAX_TRANSACTIONS,
            max_outputs_per_transaction: MAX_OUTPUTS_PER_TX,
            max_outputs: 65_536,
            max_owned_outputs: 4096,
        },
    )
    .map_err(|_| ())?;
    let selected = transactions
        .iter()
        .filter(|row| row.txid == txid)
        .collect::<Vec<_>>();
    if selected.len() != 1 {
        return Err(());
    }
    let selected = selected[0];
    let owned = scanned
        .outputs()
        .iter()
        .filter(|o| o.transaction() == txid)
        .collect::<Vec<_>>();
    if owned.len() != 1
        || owned[0].index_in_transaction() != output_index
        || owned[0].additional_timelock() != Timelock::None
    {
        return Err(());
    }
    let owned = owned[0];
    let source = &cert["config"]["source"]["deposit"];
    if hash(source, "txId")? != txid
        || bytes(source, "txBytes", MAX_TX_BYTES)? != selected.raw
        || hash(source, "blockHash")? != block_hash
        || number(source, "blockHeight")? != height
    {
        return Err(());
    }
    let verified =
        source_certificate::replay(&manifest, certificate.as_bytes(), owned).map_err(|_| ())?;
    let data = strict_data(&selected.tx)?;
    if data
        != owned
            .arbitrary_data()
            .iter()
            .map(|v| wire::hex(v))
            .collect::<Vec<_>>()
    {
        return Err(());
    }
    Ok(
        json!({"version":1,"committeeDigest":wire::hex(&verified.manifest_digest()),"sourceBinding":wire::hex(&verified.source_binding()),
        "genesis":wire::hex(&manifest.genesis),"vaultAddress":view.legacy_address(Network::Mainnet).to_string(),
        "txId":wire::hex(&txid),"blockHash":wire::hex(&block_hash),"blockHeight":height,
        "outputIndex":owned.index_in_transaction(),"globalIndex":owned.index_on_blockchain(),"outputKey":wire::hex(&owned.key().compress().to_bytes()),
        "commitment":wire::hex(&owned.commitment().commit().compress().to_bytes()),"amountAtomic":owned.commitment().amount.to_string(),
        "keyImage":wire::hex(&verified.image()),"depositData":data}),
    )
}

/// One canonical bounded frame; failures return no output and callers emit a generic error.
pub fn run(mut input: impl Read, mut output: impl Write) -> R<()> {
    let mut frame = Zeroizing::new(Vec::new());
    input
        .by_ref()
        .take((MAX_FRAME_BYTES + 1) as u64)
        .read_to_end(&mut frame)
        .map_err(|_| ())?;
    let result = verify(parse(&frame)?)?;
    let mut encoded = wire::bytes(&result);
    encoded.push(b'\n');
    output.write_all(&encoded).map_err(|_| ())?;
    output.flush().map_err(|_| ())
}

#[cfg(test)]
#[path = "deposit_observer_tests.rs"]
mod tests;
