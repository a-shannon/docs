//! Bounded offline discovery of the deposit memo profile in a complete transaction.
use crate::participant_envelope as wire;
use monero_wallet::{
    extra::{ExtraField, MAX_EXTRA_SIZE_BY_RELAY_RULE},
    transaction::Transaction,
};
use serde_json::{json, Value};
use std::io::{Read, Write};

pub const MAX_TRANSACTION_BYTES: usize = 1024 * 1024;
pub const MAX_FRAME_BYTES: usize = 2 * MAX_TRANSACTION_BYTES + 128;
const MAX_OUTPUT_BYTES: usize = 8192;

// Extra is an opaque consensus byte vector. Failure to match the supported memo
// profile is not failure to decode the complete transaction that contains it.
fn memo_profile(extra: &[u8]) -> Option<Vec<String>> {
    if extra.len() > MAX_EXTRA_SIZE_BY_RELAY_RULE {
        return None;
    }
    let mut reader = extra;
    let mut data = Vec::new();
    let mut recognized = false;
    while !reader.is_empty() {
        let before = reader;
        let field = ExtraField::read(&mut reader).ok()?;
        let consumed = before.len().checked_sub(reader.len())?;
        if consumed == 0 || field.serialize() != before[..consumed] {
            return None;
        }
        if let ExtraField::Nonce(nonce) = field {
            if nonce.first() == Some(&127) {
                if nonce.len() < 2 || nonce.len() > 255 {
                    return None;
                }
                recognized |= nonce[1..].starts_with(b"RMD");
                data.push(wire::hex(&nonce[1..]));
            }
        }
    }
    Some(if recognized { data } else { Vec::new() })
}

fn discover(frame: &[u8]) -> Result<Value, ()> {
    if frame.is_empty()
        || frame.len() > MAX_FRAME_BYTES
        || !frame.is_ascii()
        || frame.last() != Some(&b'\n')
    {
        return Err(());
    }
    let raw = &frame[..frame.len() - 1];
    let value: Value = serde_json::from_slice(raw).map_err(|_| ())?;
    wire::fields(&value, &["txId", "txBytes"])?;
    if wire::bytes(&value) != raw {
        return Err(());
    }
    let id = wire::string(&value, "txId")?;
    let encoded = wire::string(&value, "txBytes")?;
    if id.len() != 64 || encoded.is_empty() || encoded.len() > 2 * MAX_TRANSACTION_BYTES {
        return Err(());
    }
    let expected: [u8; 32] = wire::unhex(id)?.try_into().map_err(|_| ())?;
    let bytes = wire::unhex(encoded)?;
    let mut reader = bytes.as_slice();
    let tx: Transaction = Transaction::read(&mut reader).map_err(|_| ())?;
    if !reader.is_empty() || tx.serialize() != bytes || tx.hash() != expected {
        return Err(());
    }
    Ok(
        json!({"txId":wire::hex(&expected),"data":memo_profile(&tx.prefix().extra).unwrap_or_default()}),
    )
}

/// One closed canonical JSONLF request and response; no node or signing calls.
pub fn run(mut input: impl Read, mut output: impl Write) -> Result<(), ()> {
    let mut frame = Vec::new();
    input
        .by_ref()
        .take((MAX_FRAME_BYTES + 1) as u64)
        .read_to_end(&mut frame)
        .map_err(|_| ())?;
    let result = wire::bytes(&discover(&frame)?);
    if result.len() >= MAX_OUTPUT_BYTES {
        return Err(());
    }
    output
        .write_all(&result)
        .and_then(|_| output.write_all(b"\n"))
        .and_then(|_| output.flush())
        .map_err(|_| ())
}

#[cfg(test)]
#[path = "deposit_discovery_tests.rs"]
mod tests;
