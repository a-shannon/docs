//! Real PedPoP helpers adapted from Q1a, retaining its modeled completion barrier.
use std::collections::{HashMap, HashSet};
use ciphersuite::Ciphersuite;
use dkg::{Participant, ThresholdKeys, ThresholdParams};
use dkg_pedpop::{KeyGenMachine, EncryptionKeyMessage, Commitments, EncryptedMessage, SecretShare};
use frost::curve::Ed25519;
use rand_core::OsRng;

pub type Keys = HashMap<Participant, ThresholdKeys<Ed25519>>;
pub fn id(n: u16) -> Participant { Participant::new(n).unwrap() }

pub fn distributed_keys() -> Keys {
    let roster = (1..=4).map(id).collect::<Vec<_>>();
    let params = |i| ThresholdParams::new(2, 4, i).unwrap();
    let mut first = HashMap::new();
    let mut commitments = HashMap::new();
    for i in &roster {
        let (machine, message) = KeyGenMachine::<Ed25519>::new(params(*i), [0x51; 32])
            .generate_coefficients(&mut OsRng);
        first.insert(*i, machine);
        commitments.insert(*i, message.serialize());
    }
    let mut second = HashMap::new();
    let mut shares = HashMap::new();
    for (i, machine) in first {
        let received = commitments.iter().filter(|(j, _)| **j != i).map(|(j, bytes)| {
            let mut input = bytes.as_slice();
            let message = EncryptionKeyMessage::<Ed25519, Commitments<Ed25519>>::read(&mut input, params(i)).unwrap();
            assert!(input.is_empty());
            (*j, message)
        }).collect();
        let (machine, outbound) = machine.generate_secret_shares(&mut OsRng, received).unwrap();
        assert_eq!(outbound.len(), 3);
        shares.insert(i, outbound.into_iter().map(|(j, message)| (j, message.serialize())).collect::<HashMap<_, _>>());
        second.insert(i, machine);
    }
    let mut local = HashMap::new();
    for (i, machine) in second {
        let received = shares.iter().filter(|(j, _)| **j != i).map(|(j, outbound)| {
            let mut input = outbound[&i].as_slice();
            let message = EncryptedMessage::<Ed25519, SecretShare<<Ed25519 as Ciphersuite>::F>>::read(&mut input, params(i)).unwrap();
            assert!(input.is_empty());
            (*j, message)
        }).collect();
        local.insert(i, machine.calculate_share(&mut OsRng, received).unwrap());
    }
    // Modeled all-sender/all-recipient reports, not authenticated distributed consensus.
    let expected = roster.iter().copied().collect::<HashSet<_>>();
    let reports = roster.iter().map(|i| (*i, expected.clone())).collect::<HashMap<_, _>>();
    assert_eq!(local.keys().copied().collect::<HashSet<_>>(), expected);
    assert!(roster.iter().all(|i| reports.get(i) == Some(&expected)));
    let keys = local.into_iter().map(|(i, machine)| (i, machine.complete())).collect::<Keys>();
    for (i, key) in &keys {
        assert_eq!(key.params(), params(*i));
        assert_eq!(key.group_key(), keys[&id(1)].group_key());
        for j in &roster {
            assert_eq!(key.original_verification_share(*j), keys[&id(1)].original_verification_share(*j));
        }
    }
    keys
}
