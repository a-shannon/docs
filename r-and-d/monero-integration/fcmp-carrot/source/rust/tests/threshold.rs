use ciphersuite::group::{ff::PrimeField as _, Group as _, GroupEncoding as _};
use dalek_ff_group::{Ed25519, EdwardsPoint, Scalar};
use modular_frost::tests::{algorithm_machines, recover_key, sign};
use modular_frost::{dkg::Interpolation, Participant, ThresholdKeys, ThresholdParams};
use monero_fcmp_plus_plus::{
    sal::{multisig::Ed25519T, RerandomizedOutput},
    Output,
};
use multiexp::BatchVerifier;
use rand_core::OsRng;
use rosen_monero_fcmp_sal::{ContextBinding, LegacyRequest, ModernRequest};
use std::collections::HashMap;
use zeroize::Zeroizing;

fn scalar(value: u64) -> Scalar {
    Scalar::from(value)
}

fn fixed_keys<C: modular_frost::curve::Curve>() -> HashMap<Participant, ThresholdKeys<C>> {
    let shares = (1u16..=4)
        .map(|index| {
            let participant = Participant::new(index).unwrap();
            let share = C::F::from(7) + (C::F::from(5) * C::F::from(u64::from(index)));
            (participant, share)
        })
        .collect::<HashMap<_, _>>();
    let verification = shares
        .iter()
        .map(|(participant, share)| (*participant, C::generator() * share))
        .collect::<HashMap<_, _>>();
    shares
        .into_iter()
        .map(|(participant, share)| {
            let params = ThresholdParams::new(2, 4, participant).unwrap();
            let keys = ThresholdKeys::new(
                params,
                Interpolation::Lagrange,
                Zeroizing::new(share),
                verification.clone(),
            )
            .unwrap();
            (participant, keys)
        })
        .collect()
}

#[test]
fn legacy_threshold_adapter_applies_multiplier_and_offset_and_emits_core_wire() {
    let mut keys = fixed_keys::<Ed25519>();
    assert_eq!(keys.values().next().unwrap().params().t(), 2);
    assert_eq!(keys.len(), 4);
    let original = keys.values().next().unwrap().group_key();
    let multiplier = scalar(3);
    let x_offset = scalar(5);
    let y = scalar(11);
    let output_key = (original * multiplier)
        + (EdwardsPoint::generator() * x_offset)
        + (rosen_monero_fcmp_sal::t_generator() * y);
    let image_base = EdwardsPoint::random(&mut OsRng);
    let commitment = EdwardsPoint::random(&mut OsRng);
    let rerandomized = RerandomizedOutput::new(
        &mut OsRng,
        Output::new(output_key, image_base, commitment).unwrap(),
    );
    let recovered = *recover_key(&keys.values().cloned().collect::<Vec<_>>()).unwrap();
    let expected_key_image = image_base * ((recovered * multiplier) + x_offset);
    let request = LegacyRequest::new(
        ContextBinding::from_policy_digest([9; 32]),
        [7; 32],
        rerandomized,
        output_key.to_bytes(),
        original.to_bytes(),
        multiplier.to_repr(),
        x_offset.to_repr(),
        y.to_repr(),
        expected_key_image.to_bytes(),
    )
    .unwrap();
    let image_shares = keys
        .values()
        .map(|key| request.create_image_share(key).unwrap())
        .collect::<Vec<_>>();
    let verified = request
        .verify_image_association(keys.values().next().unwrap(), &image_shares)
        .unwrap();
    let algorithm = verified.algorithm(&mut keys).unwrap();
    let signature = sign(
        &mut OsRng,
        &algorithm,
        keys.clone(),
        algorithm_machines(&mut OsRng, &algorithm, &keys),
        &[],
    );
    let proof = verified.complete(signature).unwrap();
    assert_eq!(proof.wire().unwrap().len(), 416);
    assert_eq!(&proof.wire().unwrap()[..32], &proof.key_image());
    let mut verifier = BatchVerifier::new(1);
    proof
        .sal()
        .verify(
            &mut OsRng,
            &mut verifier,
            [7; 32],
            &verified.input(),
            proof.key_image_point(),
        )
        .unwrap();
    assert!(verifier.verify_vartime());
}

#[test]
fn wrong_legacy_key_image_fails_before_sal_machine_creation() {
    let keys = fixed_keys::<Ed25519>();
    let original = keys.values().next().unwrap().group_key();
    let output_key = original;
    let image_base = EdwardsPoint::random(&mut OsRng);
    let commitment = EdwardsPoint::random(&mut OsRng);
    let rerandomized = RerandomizedOutput::new(
        &mut OsRng,
        Output::new(output_key, image_base, commitment).unwrap(),
    );
    let request = LegacyRequest::new(
        ContextBinding::from_policy_digest([9; 32]),
        [7; 32],
        rerandomized,
        output_key.to_bytes(),
        original.to_bytes(),
        Scalar::ONE.to_repr(),
        Scalar::ZERO.to_repr(),
        Scalar::ZERO.to_repr(),
        EdwardsPoint::random(&mut OsRng).to_bytes(),
    )
    .unwrap();
    let image_shares = keys
        .values()
        .map(|key| request.create_image_share(key).unwrap())
        .collect::<Vec<_>>();
    assert!(matches!(
        request.verify_image_association(keys.values().next().unwrap(), &image_shares),
        Err(rosen_monero_fcmp_sal::AdapterError::KeyImageMismatch)
    ));
}

#[test]
fn modern_threshold_adapter_offsets_t_keys_and_refuses_wrong_nominal_key() {
    let mut keys = fixed_keys::<Ed25519T>();
    assert_eq!(keys.values().next().unwrap().params().t(), 2);
    assert_eq!(keys.len(), 4);
    let y_group = keys.values().next().unwrap().group_key();
    let x = scalar(13);
    let output_key = (EdwardsPoint::generator() * x) + y_group;
    let image_base = EdwardsPoint::random(&mut OsRng);
    let commitment = EdwardsPoint::random(&mut OsRng);
    let rerandomized = RerandomizedOutput::new(
        &mut OsRng,
        Output::new(output_key, image_base, commitment).unwrap(),
    );
    let expected_key_image = image_base * x;
    assert!(ModernRequest::new(
        ContextBinding::from_policy_digest([8; 32]),
        [6; 32],
        rerandomized.clone(),
        output_key.to_bytes(),
        EdwardsPoint::random(&mut OsRng).to_bytes(),
        Scalar::ONE.to_repr(),
        x.to_repr(),
        expected_key_image.to_bytes(),
    )
    .is_err());
    let request = ModernRequest::new(
        ContextBinding::from_policy_digest([8; 32]),
        [6; 32],
        rerandomized,
        output_key.to_bytes(),
        y_group.to_bytes(),
        Scalar::ONE.to_repr(),
        x.to_repr(),
        expected_key_image.to_bytes(),
    )
    .unwrap();
    let algorithm = request.algorithm(&mut keys).unwrap();
    let signature = sign(
        &mut OsRng,
        &algorithm,
        keys.clone(),
        algorithm_machines(&mut OsRng, &algorithm, &keys),
        &[],
    );
    let proof = request.complete(signature).unwrap();
    assert_eq!(proof.wire().unwrap().len(), 416);
    let mut verifier = BatchVerifier::new(1);
    proof
        .sal()
        .verify(
            &mut OsRng,
            &mut verifier,
            [6; 32],
            &request.input(),
            proof.key_image_point(),
        )
        .unwrap();
    assert!(verifier.verify_vartime());
}
