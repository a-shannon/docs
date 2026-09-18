use super::*;
#[path = "../tests/support/funding.rs"]
mod funding;
#[path = "../tests/support/mod.rs"]
mod support;
use ciphersuite::{group::GroupEncoding, Ciphersuite};
use dalek_ff_group::Scalar;
use frost::curve::Ed25519;
use k256::ecdsa::SigningKey;
use rand_core::OsRng;
use support::{id, Keys};

struct Fixture {
    manifest: CommitteeManifest,
    value: Value,
    output: WalletOutput,
    other: WalletOutput,
    identities: Vec<SigningKey>,
}
fn frame(value: &Value) -> Vec<u8> {
    let mut bytes = wire::bytes(value);
    bytes.push(b'\n');
    bytes
}
fn sign(value: &mut Value, identities: &[SigningKey]) {
    for (slot, envelope) in value["envelopes"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .enumerate()
    {
        envelope.as_object_mut().unwrap().remove("signature");
        *envelope = wire::sign_domain(envelope.clone(), &identities[slot], SOURCE_DOMAIN).unwrap();
    }
}
fn rebind(value: &mut Value, identities: &[SigningKey]) {
    let mut shared = value["config"].clone();
    shared.as_object_mut().unwrap().remove("type");
    let binding = wire::digest(
        b"rosen-monero/local-source-config/v1",
        &wire::bytes(&shared),
    );
    for envelope in value["envelopes"].as_array_mut().unwrap() {
        envelope["binding"] = json!(wire::hex(&binding));
    }
    sign(value, identities);
}
fn fixture() -> Fixture {
    let keys = support::distributed_keys();
    let key = &keys[&id(1)];
    let identities = (0..4)
        .map(|_| SigningKey::random(&mut OsRng))
        .collect::<Vec<_>>();
    let manifest = CommitteeManifest {
        genesis: [1; 32],
        epoch: [2; 32],
        ceremony: [3; 32],
        public: PublicImageCommittee {
            group: key.original_group_key().to_bytes(),
            threshold: 2,
            roster: (1..=4)
                .map(|n| (n, key.original_verification_share(id(n)).to_bytes()))
                .collect(),
        },
        identities: identities
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
    let mut outputs = funding::fund(&keys, 2);
    let other = outputs.remove(1);
    let output = outputs.remove(0);
    // Exact SourceInspection schema/transcript; no chain validity is claimed by this replay test.
    let source = json!({"kind":"deposit","startHeight":1,"blockHashes":vec![wire::hex(&[5;32]);18],
        "ringIndices":(0..16).collect::<Vec<u32>>(),"outputIds":[
            {"transaction":wire::hex(&other.transaction()),"index":other.index_in_transaction(),"chainIndex":other.index_on_blockchain()},
            {"transaction":wire::hex(&output.transaction()),"index":output.index_in_transaction(),"chainIndex":output.index_on_blockchain()}],
        "deposit":{"txId":wire::hex(&output.transaction()),"txBytes":"01","blockHash":wire::hex(&[6;32]),"blockHeight":20,
            "outputKey":wire::hex(&output.key().compress().to_bytes()),"outputIndex":output.index_in_transaction(),
            "chainIndex":output.index_on_blockchain(),"amountAtomic":output.commitment().amount.to_string(),"feeAtomic":"10"}});
    let config = json!({"type":"inspect-source","ceremony":wire::hex(&manifest.ceremony),"epoch":wire::hex(&manifest.epoch),
        "rosterDigest":wire::hex(&manifest.roster_digest()),"genesis":wire::hex(&manifest.genesis),"inspection":wire::hex(&[7;32]),
        "snapshot":{"height":100,"hash":wire::hex(&[8;32])},"source":source,"sourcePolicy":"authenticated-backing-v1"});
    let mut shared = config.clone();
    shared.as_object_mut().unwrap().remove("type");
    let binding = wire::digest(
        b"rosen-monero/local-source-config/v1",
        &wire::bytes(&shared),
    );
    let context = LocalContext {
        network_genesis: manifest.genesis,
        epoch: manifest.epoch,
        epoch_manifest: binding,
        session: [7; 32],
        retained_intent: wire::digest(
            b"rosen-monero/local-source-intent/v1",
            &wire::bytes(&config["source"]),
        ),
    };
    // Use the existing holder-side capture/prove API as the producer.
    let session = LocalImageSession::capture(
        context,
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
    let envelopes=rows.iter().enumerate().map(|(slot,row)|wire::sign_domain(json!({"type":"inspection-peer",
        "ceremony":config["ceremony"],"epoch":config["epoch"],"rosterDigest":config["rosterDigest"],"genesis":config["genesis"],
        "inspection":config["inspection"],"binding":wire::hex(&binding),"from":slot+1,"to":2-slot,
        "round":1,"sequence":1,"payload":wire::hex(&row.encode())}),&identities[slot],SOURCE_DOMAIN).unwrap()).collect::<Vec<_>>();
    let value = json!({"version":1,"committeeDigest":wire::hex(&manifest.digest().unwrap()),"config":config,"envelopes":envelopes,"keyImage":wire::hex(&image)});
    // All ThresholdKeys/session state is dropped before any replay invocation.
    Fixture {
        manifest,
        value,
        output,
        other,
        identities,
    }
}
fn refusal(f: &Fixture, value: &Value, expected: Error) {
    assert_eq!(
        replay(&f.manifest, &frame(value), &f.output).err(),
        Some(expected)
    );
}

#[test]
fn source_certificate_replays_after_holder_keys_are_dropped() {
    let f = fixture();
    let bytes = frame(&f.value);
    for _ in 0..2 {
        let result = replay(&f.manifest, &bytes, &f.output).unwrap();
        assert_eq!(result.manifest_digest(), f.manifest.digest().unwrap());
        assert_eq!(result.image(), hash(&f.value, "keyImage").unwrap());
        assert_eq!(result.output().transaction(), f.output.transaction());
        assert_eq!(result.output().index(), f.output.index_in_transaction());
        assert_eq!(
            result.output().chain_index(),
            f.output.index_on_blockchain()
        );
        assert_eq!(
            result.output().output_key(),
            f.output.key().compress().to_bytes()
        );
        assert_eq!(result.inspection(), [7; 32]);
        assert_eq!(
            result.source_binding(),
            hash(&f.value["envelopes"][0], "binding").unwrap()
        );
    }
}
#[test]
fn source_certificate_configured_authority_cannot_be_replaced_by_certificate() {
    let f = fixture();
    for mode in 0..6 {
        let mut manifest = f.manifest.clone();
        match mode {
            0 => manifest.epoch = [22; 32],
            1 => manifest.genesis = [22; 32],
            2 => manifest.ceremony = [22; 32],
            3 => {
                manifest.identities[0].1 = SigningKey::random(&mut OsRng)
                    .verifying_key()
                    .to_encoded_point(true)
                    .as_bytes()
                    .try_into()
                    .unwrap()
            }
            4 => {
                manifest.public.roster[3].1 =
                    (Ed25519::generator() * Scalar::from(22u64)).to_bytes()
            }
            _ => manifest.source_policy = None,
        }
        let mut value = f.value.clone();
        value["committeeDigest"] = json!(wire::hex(&manifest.digest().unwrap()));
        let expected = if mode == 3 {
            Error::Envelope
        } else {
            Error::Context
        };
        assert_eq!(
            replay(&manifest, &frame(&value), &f.output).err(),
            Some(expected)
        );
    }
    for mode in 0..5 {
        let mut manifest = f.manifest.clone();
        match mode {
            0 => manifest.identities.swap(0, 1),
            1 => manifest.identities[1].1 = manifest.identities[0].1,
            2 => manifest.public.threshold = 3,
            3 => manifest.public.roster.swap(0, 1),
            _ => manifest.identities.pop().map(|_| ()).unwrap(),
        }
        assert_eq!(
            replay(&manifest, &frame(&f.value), &f.output).err(),
            Some(Error::Manifest)
        );
    }
}
#[test]
fn source_certificate_dleq_binds_context_even_with_valid_new_envelope_signatures() {
    let f = fixture();
    for mode in 0..4 {
        let mut value = f.value.clone();
        match mode {
            0 => value["config"]["snapshot"]["hash"] = json!(wire::hex(&[42; 32])),
            1 => value["config"]["source"]["deposit"]["blockHash"] = json!(wire::hex(&[42; 32])),
            2 => value["config"]["snapshot"]["height"] = json!(101),
            _ => {
                value["config"]["inspection"] = json!(wire::hex(&[42; 32]));
                for e in value["envelopes"].as_array_mut().unwrap() {
                    e["inspection"] = json!(wire::hex(&[42; 32]));
                }
            }
        }
        rebind(&mut value, &f.identities);
        refusal(&f, &value, Error::Image);
    }
}
#[test]
fn source_certificate_rejects_output_substitution_and_derived_offset_substitution() {
    let f = fixture();
    assert_eq!(
        replay(&f.manifest, &frame(&f.value), &f.other).err(),
        Some(Error::Output)
    );
    for field in [
        "txId",
        "outputKey",
        "outputIndex",
        "chainIndex",
        "amountAtomic",
    ] {
        let mut value = f.value.clone();
        let deposit = &mut value["config"]["source"]["deposit"];
        deposit[field] = match field {
            "txId" | "outputKey" => json!(wire::hex(&[42; 32])),
            "amountAtomic" => json!("1"),
            _ => json!(deposit[field].as_u64().unwrap() + 1),
        };
        rebind(&mut value, &f.identities);
        refusal(&f, &value, Error::Output);
    }
    let mut bytes = Vec::new();
    f.output.write(&mut bytes).unwrap();
    let offset = <[u8; 32]>::from(f.output.key_offset());
    let locations = bytes
        .windows(32)
        .enumerate()
        .filter_map(|(i, w)| (w == offset).then_some(i))
        .collect::<Vec<_>>();
    assert_eq!(locations.len(), 1);
    bytes[locations[0]..locations[0] + 32].copy_from_slice(&Scalar::from(42u64).to_bytes());
    let changed = WalletOutput::read(&mut bytes.as_slice()).unwrap();
    assert_eq!(
        replay(&f.manifest, &frame(&f.value), &changed).err(),
        Some(Error::Image)
    );
}
#[test]
fn source_certificate_checks_every_envelope_and_row() {
    let f = fixture();
    for slot in 0..2 {
        for field in [
            "from",
            "to",
            "round",
            "sequence",
            "binding",
            "signature",
            "epoch",
            "genesis",
            "rosterDigest",
            "ceremony",
            "inspection",
        ] {
            let mut value = f.value.clone();
            let envelope = &mut value["envelopes"][slot];
            envelope[field] = match field {
                "from" | "to" | "round" | "sequence" => json!(9),
                "signature" => json!("00".repeat(64)),
                _ => json!(wire::hex(&[42; 32])),
            };
            refusal(&f, &value, Error::Envelope);
        }
        for mode in 0..4 {
            let mut value = f.value.clone();
            let mut row =
                wire::unhex(value["envelopes"][slot]["payload"].as_str().unwrap()).unwrap();
            match mode {
                0 => row[8] = 1,
                1 => row[10] = 3,
                2 => row[12..44]
                    .copy_from_slice(&(Ed25519::generator() * Scalar::from(42u64)).to_bytes()),
                _ => row[44] ^= 1,
            }
            value["envelopes"][slot]["payload"] = json!(wire::hex(&row));
            sign(&mut value, &f.identities);
            refusal(&f, &value, Error::Image);
        }
    }
    for mode in 0..4 {
        let mut value = f.value.clone();
        match mode {
            0 => value["envelopes"].as_array_mut().unwrap().swap(0, 1),
            1 => value["envelopes"][1] = value["envelopes"][0].clone(),
            2 => {
                value["envelopes"].as_array_mut().unwrap().pop();
            }
            _ => value["envelopes"][0]["extra"] = json!(true),
        }
        refusal(&f, &value, Error::Envelope);
    }
}
#[test]
fn source_certificate_claim_and_wire_are_closed() {
    let f = fixture();
    let mut value = f.value.clone();
    value["keyImage"] = json!(wire::hex(
        &(Ed25519::generator() * Scalar::from(42u64)).to_bytes()
    ));
    refusal(&f, &value, Error::Image);
    let mut value = f.value.clone();
    value["committeeDigest"] = json!(wire::hex(&[42; 32]));
    refusal(&f, &value, Error::Manifest);
    let mut value = f.value.clone();
    value["selectedParticipants"] = json!([1, 3]);
    refusal(&f, &value, Error::Frame);
    let mut bytes = frame(&f.value);
    bytes.insert(0, b' ');
    assert_eq!(
        replay(&f.manifest, &bytes, &f.output).err(),
        Some(Error::Frame)
    );
    assert_eq!(
        replay(&f.manifest, &vec![b' '; wire::MAX_FRAME + 1], &f.output).err(),
        Some(Error::Frame)
    );
}
