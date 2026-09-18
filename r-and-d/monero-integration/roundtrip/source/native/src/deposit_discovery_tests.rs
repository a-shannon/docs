use super::*;
use crate::participant_envelope as wire;
use monero_wallet::{
    ed25519::CompressedPoint,
    extra::{ExtraField, MAX_EXTRA_SIZE_BY_RELAY_RULE},
    transaction::{Input, Timelock, Transaction, TransactionPrefix},
};
use serde_json::{json, Value};

fn transaction(extra: Vec<u8>) -> Transaction {
    Transaction::V2 {
        prefix: TransactionPrefix {
            additional_timelock: Timelock::None,
            inputs: vec![Input::Gen(1)],
            outputs: vec![],
            extra,
        },
        proofs: None,
    }
}
fn frame(value: &Value) -> Vec<u8> {
    let mut bytes = wire::bytes(value);
    bytes.push(b'\n');
    bytes
}
fn request(tx: &Transaction) -> Value {
    json!({"txId":wire::hex(&tx.hash()),"txBytes":wire::hex(&tx.serialize())})
}
fn discover(extra: Vec<u8>) -> Value {
    let tx = transaction(extra);
    let mut output = Vec::new();
    run(frame(&request(&tx)).as_slice(), &mut output).unwrap();
    assert!(output.len() <= 8192);
    let value = wire::parse(&output).unwrap();
    assert_eq!(value["txId"], wire::hex(&tx.hash()));
    value["data"].clone()
}
fn nonce(data: &[u8]) -> Vec<u8> {
    let mut nonce = vec![127];
    nonce.extend_from_slice(data);
    ExtraField::Nonce(nonce).serialize()
}

#[test]
fn ordinary_and_unrelated_data_do_not_discover_deposits() {
    for extra in [
        vec![],
        ExtraField::Nonce(vec![1, 2, 3]).serialize(),
        nonce(b"unrelated"),
        nonce(b"rmd"),
        nonce(b"RM"),
    ] {
        assert_eq!(discover(extra), json!([]));
    }
}

#[test]
fn recognized_prefix_preserves_all_arbitrary_data_for_ambiguity_rejection() {
    assert_eq!(
        discover(nonce(b"RMD\x02memo")),
        json!([wire::hex(b"RMD\x02memo")])
    );
    let mut multiple = nonce(b"RMD\x02memo");
    multiple.extend(nonce(b"unrelated"));
    multiple.extend(nonce(b"RMD\x02second"));
    assert_eq!(
        discover(multiple),
        json!([
            wire::hex(b"RMD\x02memo"),
            wire::hex(b"unrelated"),
            wire::hex(b"RMD\x02second")
        ])
    );
    // Prefix recognition does not claim the remainder is a valid deposit envelope.
    assert_eq!(discover(nonce(b"RMD")), json!([wire::hex(b"RMD")]));
    let mut largest = b"RMD".to_vec();
    largest.extend([0xab; 251]);
    assert_eq!(discover(nonce(&largest)), json!([wire::hex(&largest)]));
    largest.push(0xab);
    assert_eq!(discover(nonce(&largest)), json!([]));
}

#[test]
fn unsupported_extra_is_classified_without_failing_transaction_discovery() {
    for bad in [
        vec![255],
        vec![2, 2, 127],
        vec![2, 1, 127],
        vec![2, 0x82, 0, 127, 1],
        vec![0; MAX_EXTRA_SIZE_BY_RELAY_RULE + 1],
        ExtraField::Nonce(vec![127; 256]).serialize(),
    ] {
        assert_eq!(discover(bad.clone()), json!([]));
        let mut recognized = nonce(b"RMD\x02memo");
        recognized.extend(bad);
        assert_eq!(discover(recognized), json!([]));
    }
    // MergeMining decoding drops surplus field bytes; discovery must reject that lossy profile.
    let mut lossy = vec![3, 34, 0];
    lossy.extend([0; 33]);
    let mut recognized = nonce(b"RMD\x02memo");
    recognized.extend(lossy);
    assert_eq!(discover(recognized), json!([]));
}

#[test]
fn transaction_hash_and_complete_canonical_bytes_remain_mandatory() {
    let tx = transaction(nonce(b"RMD\x02memo"));
    for change in 0..5 {
        let mut value = request(&tx);
        match change {
            0 => value["txId"] = json!("11".repeat(32)),
            1 => value["txBytes"] = json!(format!("{}00", value["txBytes"].as_str().unwrap())),
            2 => value["txBytes"] = json!(""),
            3 => value["txBytes"] = json!("020001"),
            _ => {
                let mut bytes = tx.serialize();
                bytes.splice(..1, [0x82, 0]);
                value["txBytes"] = json!(wire::hex(&bytes));
            }
        }
        let mut output = Vec::new();
        assert!(run(frame(&value).as_slice(), &mut output).is_err());
        assert!(output.is_empty());
    }
}

#[test]
fn full_transactions_larger_than_old_envelope_limit_are_decoded() {
    let mut tx = transaction(vec![255; 40000]);
    // A non-miner transaction exercises the native parser's separate prefix limits.
    // Discovery checks full serialization and hash, not consensus validity/signatures.
    tx.prefix_mut().inputs = vec![Input::ToKey {
        amount: None,
        key_offsets: vec![1],
        key_image: CompressedPoint::from([9; 32]),
    }];
    let input = frame(&request(&tx));
    assert!(tx.serialize().len() > 30000);
    assert!(input.len() > wire::MAX_FRAME);
    let mut output = Vec::new();
    run(input.as_slice(), &mut output).unwrap();
    assert_eq!(wire::parse(&output).unwrap()["data"], json!([]));
    assert!(crate::participant::deposit_data(input.as_slice(), Vec::new()).is_err());
}

#[test]
fn transaction_and_input_caps_apply_before_any_output() {
    let mut tx = transaction(vec![255; MAX_TRANSACTION_BYTES]);
    let overhead = tx.serialize().len() - MAX_TRANSACTION_BYTES;
    tx.prefix_mut()
        .extra
        .truncate(MAX_TRANSACTION_BYTES - overhead);
    assert_eq!(tx.serialize().len(), MAX_TRANSACTION_BYTES);
    let mut output = Vec::new();
    run(frame(&request(&tx)).as_slice(), &mut output).unwrap();
    assert_eq!(wire::parse(&output).unwrap()["data"], json!([]));
    tx.prefix_mut().extra.push(255);
    let mut output = Vec::new();
    assert!(run(frame(&request(&tx)).as_slice(), &mut output).is_err());
    assert!(output.is_empty());
    assert!(run(vec![b'x'; MAX_FRAME_BYTES + 1].as_slice(), Vec::new()).is_err());
}

#[test]
fn closed_canonical_json_lf_rejects_aliases_duplicates_and_extra_fields() {
    let value = request(&transaction(vec![]));
    let valid = frame(&value);
    let raw = String::from_utf8(valid.clone()).unwrap();
    let duplicate = raw.replacen(
        '{',
        &format!("{{\"txId\":\"{}\",", value["txId"].as_str().unwrap()),
        1,
    );
    let escaped = raw.replace("txId", "tx\\u0049d");
    let mut extra = value.clone();
    extra["unknown"] = json!(0);
    let mut uppercase = value.clone();
    uppercase["txId"] = json!(value["txId"].as_str().unwrap().to_uppercase());
    let mut nonhex = value.clone();
    nonhex["txBytes"] = json!("0G");
    let reversed = format!(
        "{{\"txId\":{},\"txBytes\":{}}}\n",
        value["txId"], value["txBytes"]
    );
    for input in [
        duplicate.into_bytes(),
        escaped.into_bytes(),
        format!(" {raw}").into_bytes(),
        raw.replace('\n', "\r\n").into_bytes(),
        valid[..valid.len() - 1].to_vec(),
        [valid.clone(), valid].concat(),
        frame(&extra),
        frame(&uppercase),
        frame(&nonhex),
        reversed.into_bytes(),
    ] {
        let mut output = Vec::new();
        assert!(run(input.as_slice(), &mut output).is_err());
        assert!(output.is_empty());
    }
}
