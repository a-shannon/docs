use super::*;
#[path = "../tests/support/mod.rs"]
mod support;
use crate::key_image::{LocalContext, LocalImageSession};
use ciphersuite::group::GroupEncoding;
use curve25519_dalek::{
    constants::ED25519_BASEPOINT_POINT as G, edwards::EdwardsPoint, scalar::Scalar as CurveScalar,
};
use dkg::Participant;
use k256::ecdsa::SigningKey;
use monero_wallet::{
    block::BlockHeader,
    ed25519::{Commitment, Point},
    interface::{FeeRate, ScannableBlock},
    io::VarInt,
    ringct::{clsag::Decoys, RctType},
    send::{Change, SignableTransaction},
    transaction::{Input, Output, TransactionPrefix},
    OutputWithDecoys, Scanner, WalletOutput,
};
use rand_core::{OsRng, RngCore};
use std::{
    process::{Command, Stdio},
    sync::OnceLock,
};

fn id(n: u16) -> Participant {
    Participant::new(n).unwrap()
}
fn frame(value: &Value) -> Vec<u8> {
    let mut bytes = wire::bytes(value);
    bytes.push(b'\n');
    bytes
}
fn pair(group: Point, view: u64) -> ViewPair {
    ViewPair::new(group, Zeroizing::new(Scalar::from(CurveScalar::from(view)))).unwrap()
}
fn miner(view: &ViewPair, height: usize) -> Transaction {
    let r = Zeroizing::new(CurveScalar::random(&mut OsRng));
    let public: EdwardsPoint = view.view().into();
    let mut derivation = (public * *r)
        .mul_by_cofactor()
        .compress()
        .to_bytes()
        .to_vec();
    VarInt::write(&0usize, &mut derivation).unwrap();
    let offset = Zeroizing::<CurveScalar>::new(Scalar::hash(&derivation).into());
    let spend: EdwardsPoint = view.spend().into();
    Transaction::V2 {
        prefix: TransactionPrefix {
            additional_timelock: Timelock::Block(height + 60),
            inputs: vec![Input::Gen(height)],
            outputs: vec![Output {
                amount: Some(1_000_000_000_000),
                key: CompressedPoint::from((spend + G * *offset).compress().to_bytes()),
                view_tag: None,
            }],
            extra: ExtraField::PublicKey(CompressedPoint::from((G * *r).compress().to_bytes()))
                .serialize(),
        },
        proofs: None,
    }
}
fn block(miner: Transaction, txs: &[Transaction]) -> Block {
    Block::new(
        BlockHeader {
            hardfork_version: 16,
            hardfork_signal: 16,
            timestamp: 1_700_000_000,
            previous: [9; 32],
            nonce: 0,
        },
        miner,
        txs.iter().map(Transaction::hash).collect(),
    )
    .unwrap()
}
fn ring(output: &WalletOutput) -> OutputWithDecoys {
    let points = (0..16)
        .map(|n| {
            if n == 7 {
                [output.key(), output.commitment().commit()]
            } else {
                [
                    Point::from(G * CurveScalar::from(100 + n as u64)),
                    Commitment::new(Scalar::random(&mut OsRng), 1000 + n as u64).commit(),
                ]
            }
        })
        .collect();
    let mut offsets = vec![1; 16];
    offsets[0] = output.index_on_blockchain() - 7;
    let decoys = Decoys::new(offsets, 7, points).unwrap();
    let mut bytes = Zeroizing::new(output.key().compress().to_bytes().to_vec());
    output.key_offset().write(&mut *bytes).unwrap();
    output.commitment().write(&mut *bytes).unwrap();
    decoys.write(&mut *bytes).unwrap();
    OutputWithDecoys::read(&mut bytes.as_slice()).unwrap()
}
fn js_export(input: &Value) -> Value {
    let script="import {pathToFileURL} from 'node:url'; const {encodeParticipantDepositCertificate}=await import(pathToFileURL(process.argv[1]));let text='';for await(const c of process.stdin)text+=c;process.stdout.write(JSON.stringify(encodeParticipantDepositCertificate(JSON.parse(text))));";
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../consumer/participantSigning.mjs");
    let mut child = Command::new("node")
        .args(["--input-type=module", "-e", script])
        .arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("Node is required for producer interoperability test");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&wire::bytes(input))
        .unwrap();
    let result = child.wait_with_output().unwrap();
    assert!(
        result.status.success(),
        "public certificate producer refused fixture"
    );
    serde_json::from_slice(&result.stdout).unwrap()
}
struct Fixture {
    request: Value,
    manifest: CommitteeManifest,
    output: WalletOutput,
    anchor_variants: Vec<String>,
}

#[derive(Clone, Copy, Debug)]
enum TransactionKeyLayout {
    Standard,
    RepeatedPrimary,
    AdditionalOnly,
    AdditionalBeforePrimary,
}

fn apply_transaction_key_layout(tx: &mut Transaction, layout: TransactionKeyLayout) {
    if matches!(layout, TransactionKeyLayout::Standard) {
        return;
    }

    let output_count = tx.prefix().outputs.len();
    let original = tx.prefix().extra.clone();
    let mut remainder = original.as_slice();
    let genuine = match ExtraField::read(&mut remainder).unwrap() {
        ExtraField::PublicKey(key) => key,
        _ => panic!("fixture transaction must begin with its primary key"),
    };
    let genuine_field = ExtraField::PublicKey(genuine.clone()).serialize();
    let primary_len = original.len() - remainder.len();
    assert_eq!(primary_len, genuine_field.len());

    tx.prefix_mut().extra = match layout {
        TransactionKeyLayout::Standard => unreachable!(),
        TransactionKeyLayout::RepeatedPrimary => {
            let mut varied = original;
            varied.extend(genuine_field);
            varied
        }
        TransactionKeyLayout::AdditionalOnly | TransactionKeyLayout::AdditionalBeforePrimary => {
            let dummy = CompressedPoint::from((G * CurveScalar::from(19u64)).compress().to_bytes());
            assert_ne!(dummy, genuine);
            let mut varied = ExtraField::PublicKey(dummy).serialize();
            // Every legacy-address output was derived with the genuine primary key, so it is also
            // a valid output-indexed additional key for each output in this fixture.
            varied.extend(
                ExtraField::PublicKeys(vec![genuine.clone(); output_count]).serialize(),
            );
            varied.extend_from_slice(&original[primary_len..]);
            if matches!(layout, TransactionKeyLayout::AdditionalBeforePrimary) {
                varied.extend(genuine_field);
            }
            varied
        }
    };
}

fn fixture_with_outputs(count: usize, key_layout: TransactionKeyLayout) -> Fixture {
    let keys = support::distributed_keys();
    let key = &keys[&id(1)];
    let vault = pair(Point::from(key.group_key().0), 7);
    let donor = pair(Point::from(G * CurveScalar::from(11u64)), 13);
    let acquired = Scanner::new(donor.clone())
        .scan(ScannableBlock {
            block: block(miner(&donor, 1000), &[]),
            transactions: vec![],
            output_index_for_first_ringct_output: Some(2000),
        })
        .unwrap()
        .additional_timelock_satisfied_by(1060, 1_700_000_000)
        .remove(0);
    let mut seed = Zeroizing::new([0; 32]);
    OsRng.fill_bytes(seed.as_mut());
    let mut tx = SignableTransaction::new(
        RctType::ClsagBulletproofPlus,
        seed,
        vec![ring(&acquired)],
        (0..count)
            .map(|_| (vault.legacy_address(Network::Testnet), 10_000_000_000))
            .collect(),
        Change::new(donor.clone(), None),
        vec![vec![0xab, 0xcd]],
        FeeRate::new(1, 1).unwrap(),
    )
    .unwrap()
    .sign(
        &mut OsRng,
        &Zeroizing::new(Scalar::from(CurveScalar::from(11u64))),
    )
    .unwrap();
    // These post-signature extra variants deliberately make a synthetic transaction which a
    // daemon has not admitted. They test native byte parsing and observer admission only; they do
    // not establish Monero consensus validity or replay a historical vulnerable-wallet artifact.
    apply_transaction_key_layout(&mut tx, key_layout);
    let selected = block(miner(&donor, 4097), std::slice::from_ref(&tx));
    let scanned = deposit_block::scan(
        &vault,
        &selected.serialize(),
        &[tx.serialize()],
        Some(10_000),
        selected.hash(),
        4097,
        deposit_block::Limits {
            max_block_bytes: 1_000_000,
            max_transaction_bytes: 100_000,
            max_total_bytes: 1_000_000,
            max_transactions: 8,
            max_outputs_per_transaction: 16,
            max_outputs: 32,
            max_owned_outputs: 16,
        },
    )
    .unwrap();
    assert_eq!(scanned.outputs().len(), count);
    let output = scanned.outputs()[0].clone();
    let identity_keys = (0..4)
        .map(|_| SigningKey::random(&mut OsRng))
        .collect::<Vec<_>>();
    let identities=identity_keys.iter().enumerate().map(|(slot,k)|json!({"id":slot+1,"publicKey":wire::hex(k.verifying_key().to_encoded_point(true).as_bytes())})).collect::<Vec<_>>();
    let public = PublicImageCommittee {
        group: key.group_key().to_bytes(),
        threshold: 2,
        roster: (1..=4)
            .map(|i| (i, key.original_verification_share(id(i)).to_bytes()))
            .collect(),
    };
    let roster = json!({"groupKey":wire::hex(&public.group),"verificationShares":public.roster.iter().map(|(id,key)|json!({"id":id,"publicKey":wire::hex(key)})).collect::<Vec<_>>()});
    let roster_digest = wire::hex(&wire::digest(
        b"rosen-monero/local-dkg-roster/v1",
        &wire::bytes(&roster),
    ));
    let manifest = CommitteeManifest {
        genesis: [1; 32],
        epoch: [2; 32],
        ceremony: [3; 32],
        public,
        identities: identity_keys
            .iter()
            .enumerate()
            .map(|(slot, k)| {
                (
                    (slot + 1) as u16,
                    k.verifying_key()
                        .to_encoded_point(true)
                        .as_bytes()
                        .try_into()
                        .unwrap(),
                )
            })
            .collect(),
        source_policy: Some("authenticated-backing-v1".into()),
    };
    let config = json!({"type":"inspect-source","ceremony":wire::hex(&manifest.ceremony),"epoch":wire::hex(&manifest.epoch),"genesis":wire::hex(&manifest.genesis),
        "rosterDigest":roster_digest,"inspection":wire::hex(&[4;32]),"snapshot":{"height":4167,"hash":wire::hex(&[5;32])},"sourcePolicy":"authenticated-backing-v1",
        "source":{"kind":"deposit","startHeight":1,"blockHashes":vec![wire::hex(&[6;32]);18],"ringIndices":(0..16).collect::<Vec<u32>>(),
            "outputIds":[{"transaction":wire::hex(&acquired.transaction()),"index":acquired.index_in_transaction(),"chainIndex":acquired.index_on_blockchain()},
                {"transaction":wire::hex(&output.transaction()),"index":output.index_in_transaction(),"chainIndex":output.index_on_blockchain()}],
            "deposit":{"txId":wire::hex(&tx.hash()),"txBytes":wire::hex(&tx.serialize()),"blockHash":wire::hex(&selected.hash()),"blockHeight":4097,
                "outputKey":wire::hex(&output.key().compress().to_bytes()),"outputIndex":output.index_in_transaction(),"chainIndex":output.index_on_blockchain(),
                "amountAtomic":output.commitment().amount.to_string(),"feeAtomic":"10"}}});
    let export = |config: Value| {
        let mut shared = config.clone();
        shared.as_object_mut().unwrap().remove("type");
        let binding = wire::digest(
            b"rosen-monero/local-source-config/v1",
            &wire::bytes(&shared),
        );
        let session = LocalImageSession::capture(
            LocalContext {
                network_genesis: manifest.genesis,
                epoch: manifest.epoch,
                epoch_manifest: binding,
                session: [4; 32],
                retained_intent: wire::digest(
                    b"rosen-monero/local-source-intent/v1",
                    &wire::bytes(&config["source"]),
                ),
            },
            key,
            vec![id(1), id(2)],
            std::slice::from_ref(&output),
        )
        .unwrap();
        let rows = [1, 2]
            .iter()
            .map(|i| session.prove(&mut OsRng, &keys[&id(*i)]).unwrap().remove(0))
            .collect::<Vec<_>>();
        let verified = session.verify(&rows).unwrap();
        let image = session.consume(&verified).unwrap()[0].image();
        let envelopes=rows.iter().enumerate().map(|(slot,row)|wire::sign_domain(json!({"type":"inspection-peer","ceremony":config["ceremony"],
            "epoch":config["epoch"],"rosterDigest":config["rosterDigest"],"genesis":config["genesis"],"inspection":config["inspection"],
            "binding":wire::hex(&binding),"from":slot+1,"to":2-slot,"round":1,"sequence":1,"payload":wire::hex(&row.encode())}),
            &identity_keys[slot],b"rosen-monero/local-source-envelope/v1").unwrap()).collect::<Vec<_>>();
        let init = json!({"threshold":2,"epoch":config["epoch"],"ceremony":config["ceremony"],"roster":identities});
        let ready=(0..4).map(|slot|json!({"id":slot+1,"threshold":2,"n":4,"epoch":config["epoch"],"ceremony":config["ceremony"],
            "groupKey":roster["groupKey"],"verificationShares":roster["verificationShares"],"rosterDigest":roster_digest})).collect::<Vec<_>>();
        js_export(
            &json!({"init":init,"ready":ready,"identities":identities,"genesis":config["genesis"],"config":config,"envelopes":envelopes,"keyImage":wire::hex(&image)}),
        )
    };
    let exported = export(config.clone());
    let mut anchor_variants = vec![];
    for field in ["blockHash", "blockHeight", "txBytes"] {
        let mut changed = config.clone();
        changed["source"]["deposit"][field] = match field {
            "blockHash" => json!(wire::hex(&[42; 32])),
            "blockHeight" => json!(4098),
            _ => json!("01"),
        };
        anchor_variants.push(export(changed)["certificate"].as_str().unwrap().to_owned());
    }
    let row = |tx: &Transaction, start: u64| {
        json!({"txId":wire::hex(&tx.hash()),"transactionHex":wire::hex(&tx.serialize()),
        "outputIndices":(start..start+tx.prefix().outputs.len() as u64).collect::<Vec<_>>()})
    };
    let request = json!({"version":1,"committee":exported["committee"],"viewKey":wire::hex(&<[u8;32]>::from(Scalar::from(CurveScalar::from(7u64)))),
        "packet":{"blockHex":wire::hex(&selected.serialize()),"blockHash":wire::hex(&selected.hash()),"height":4097,
            "miner":row(selected.miner_transaction(),10_000),"transactions":[row(&tx,10_001)]},
        "certificate":exported["certificate"],"txId":wire::hex(&tx.hash()),"outputIndex":output.index_in_transaction()});
    Fixture {
        request,
        manifest,
        output,
        anchor_variants,
    }
}
fn fixture() -> &'static Fixture {
    static F: OnceLock<Fixture> = OnceLock::new();
    F.get_or_init(|| fixture_with_outputs(1, TransactionKeyLayout::Standard))
}
fn observe(request: &Value) -> R<Value> {
    let mut output = vec![];
    run(frame(request).as_slice(), &mut output)?;
    wire::parse(&output)
}
fn refused(request: &Value) {
    let mut output = vec![];
    assert!(run(frame(request).as_slice(), &mut output).is_err());
    assert!(output.is_empty());
}

#[test]
fn deposit_observer_accepts_actual_javascript_producer_export_after_holder_state_is_dropped() {
    let f = fixture();
    let result = observe(&f.request).unwrap();
    fields(
        &result,
        &[
            "version",
            "committeeDigest",
            "sourceBinding",
            "genesis",
            "vaultAddress",
            "txId",
            "blockHash",
            "blockHeight",
            "outputIndex",
            "globalIndex",
            "outputKey",
            "commitment",
            "amountAtomic",
            "keyImage",
            "depositData",
        ],
    )
    .unwrap();
    assert_eq!(result["version"], 1);
    assert_eq!(
        result["committeeDigest"],
        wire::hex(&f.manifest.digest().unwrap())
    );
    assert_eq!(result["txId"], f.request["txId"]);
    assert_eq!(result["blockHeight"], 4097);
    assert_eq!(result["blockHash"], f.request["packet"]["blockHash"]);
    assert_eq!(result["outputIndex"], f.output.index_in_transaction());
    assert_eq!(result["globalIndex"], f.output.index_on_blockchain());
    assert_eq!(
        result["outputKey"],
        wire::hex(&f.output.key().compress().to_bytes())
    );
    assert_eq!(result["amountAtomic"], "10000000000");
    assert_eq!(
        result["commitment"],
        wire::hex(&f.output.commitment().commit().compress().to_bytes())
    );
    assert_eq!(result["depositData"], json!(["abcd"]));
    assert!(result.get("viewKey").is_none());
    assert!(result.get("offset").is_none());
    assert_eq!(observe(&f.request).unwrap(), result);
}
#[test]
fn deposit_observer_crosschecks_anchor_even_for_cryptographically_valid_certificates() {
    let f = fixture();
    for certificate in &f.anchor_variants {
        source_certificate::replay(&f.manifest, certificate.as_bytes(), &f.output).unwrap();
        let mut request = f.request.clone();
        request["certificate"] = json!(certificate);
        refused(&request);
    }
}
#[test]
fn deposit_observer_rejects_each_packet_identity_index_and_configuration_fault() {
    let f = fixture();
    for mode in 0..16 {
        let mut request = f.request.clone();
        match mode {
            0 => request["packet"]["blockHash"] = json!(wire::hex(&[42; 32])),
            1 => request["packet"]["height"] = json!(4098),
            2 => request["packet"]["miner"]["txId"] = json!(wire::hex(&[42; 32])),
            3 => request["packet"]["transactions"][0]["txId"] = json!(wire::hex(&[42; 32])),
            4 => {
                request["packet"]["transactions"][0]["outputIndices"]
                    .as_array_mut()
                    .unwrap()
                    .pop();
            }
            5 => request["packet"]["transactions"][0]["outputIndices"][0] = json!(10_002),
            6 => request["packet"]["transactions"][0]["outputIndices"][1] = json!(10_999),
            7 => request["packet"]["miner"] = request["packet"]["transactions"][0].clone(),
            8 => {
                request["viewKey"] = json!(wire::hex(&<[u8; 32]>::from(Scalar::from(
                    CurveScalar::from(1u64)
                ))))
            }
            9 => request["viewKey"] = json!("ff".repeat(32)),
            10 => request["committee"]["epoch"] = json!(wire::hex(&[42; 32])),
            11 => request["txId"] = request["packet"]["miner"]["txId"].clone(),
            12 => request["outputIndex"] = json!(9),
            13 => request["packet"]["extra"] = json!(true),
            14 => request["packet"]["transactions"][0]["outputIndices"][0] = json!(MAX_SAFE + 1),
            _ => request["certificate"] = json!("{}\n"),
        }
        refused(&request);
    }
}
#[test]
fn deposit_observer_counts_one_owned_output_once_across_multiple_transaction_keys() {
    // RepeatedPrimary can only match through a primary key. AdditionalOnly has no genuine primary,
    // so its successful observation can only match through the output-indexed additional key.
    for key_layout in [
        TransactionKeyLayout::RepeatedPrimary,
        TransactionKeyLayout::AdditionalOnly,
        TransactionKeyLayout::AdditionalBeforePrimary,
    ] {
        let f = fixture_with_outputs(1, key_layout);
        let result = observe(&f.request).unwrap();
        assert_eq!(result["txId"], f.request["txId"], "{key_layout:?}");
        assert_eq!(
            result["outputIndex"],
            f.output.index_in_transaction(),
            "{key_layout:?}"
        );
        assert_eq!(
            result["globalIndex"],
            f.output.index_on_blockchain(),
            "{key_layout:?}"
        );
        assert_eq!(
            result["outputKey"],
            wire::hex(&f.output.key().compress().to_bytes()),
            "{key_layout:?}"
        );
        assert_eq!(result["amountAtomic"], "10000000000", "{key_layout:?}");
    }
}

#[test]
fn deposit_observer_refuses_multiple_owned_outputs_in_selected_transaction() {
    for key_layout in [
        TransactionKeyLayout::Standard,
        TransactionKeyLayout::RepeatedPrimary,
        TransactionKeyLayout::AdditionalOnly,
        TransactionKeyLayout::AdditionalBeforePrimary,
    ] {
        let f = fixture_with_outputs(2, key_layout);
        source_certificate::replay(
            &f.manifest,
            f.request["certificate"].as_str().unwrap().as_bytes(),
            &f.output,
        )
        .unwrap();
        refused(&f.request);
    }
}
#[test]
fn deposit_observer_wire_bounds_and_extra_framing_fail_closed() {
    let f = fixture();
    let valid = frame(&f.request);
    let text = String::from_utf8(valid.clone()).unwrap();
    for bytes in [
        valid[..valid.len() - 1].to_vec(),
        [b" ".as_slice(), &valid].concat(),
        text.replacen("\"version\":1", "\"version\":1,\"version\":1", 1)
            .into_bytes(),
        vec![b' '; MAX_FRAME_BYTES + 1],
    ] {
        let mut output = vec![];
        assert!(run(bytes.as_slice(), &mut output).is_err());
        assert!(output.is_empty());
    }
    let mut tx = Transaction::read(
        &mut bytes(
            &f.request["packet"]["transactions"][0],
            "transactionHex",
            MAX_TX_BYTES,
        )
        .unwrap()
        .as_slice(),
    )
    .unwrap();
    assert_eq!(strict_data(&tx).unwrap(), vec!["abcd"]);
    tx.prefix_mut().extra.push(0xff);
    assert!(strict_data(&tx).is_err());
    let mut huge = f.request.clone();
    huge["packet"]["transactions"] = json!(vec![
        huge["packet"]["transactions"][0].clone();
        MAX_TRANSACTIONS + 1
    ]);
    refused(&huge);
}

#[test]
#[ignore = "requires explicitly pinned MONERO_OBSERVER_TEST_BINARY and MONERO_OBSERVER_TEST_SHA256"]
fn deposit_observer_cli_replays_exported_certificate_in_fresh_process() {
    use sha2::{Digest, Sha256};
    let binary = std::env::var("MONERO_OBSERVER_TEST_BINARY").expect("explicit test binary");
    let expected = std::env::var("MONERO_OBSERVER_TEST_SHA256").expect("explicit test binary pin");
    assert_eq!(
        wire::hex(&Sha256::digest(std::fs::read(&binary).unwrap())),
        expected
    );
    let f = fixture();
    let mut child = Command::new(&binary)
        .arg("verify-deposit")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&frame(&f.request))
        .unwrap();
    let response = child.wait_with_output().unwrap();
    assert!(response.status.success());
    assert!(response.stderr.is_empty());
    assert_eq!(
        wire::parse(&response.stdout).unwrap(),
        observe(&f.request).unwrap()
    );

    let mut child = Command::new(&binary)
        .arg("verify-deposit")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"{\"viewKey\":\"fixture-secret-must-not-be-echoed\"}\n")
        .unwrap();
    let response = child.wait_with_output().unwrap();
    assert!(!response.status.success());
    assert!(response.stdout.is_empty());
    assert_eq!(
        String::from_utf8(response.stderr).unwrap().trim(),
        "participant-error"
    );
    assert_eq!(
        wire::hex(&Sha256::digest(std::fs::read(&binary).unwrap())),
        expected
    );
}
