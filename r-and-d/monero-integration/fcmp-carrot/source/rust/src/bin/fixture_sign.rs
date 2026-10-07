//! Disposable cross-language fixture signer for the synthetic account scalar 7.
//! This is not a production signer or an authorization boundary.

use std::{collections::HashMap, env, fs, process::ExitCode};

use ciphersuite::{group::Group as _, Ciphersuite};
use dalek_ff_group::{Ed25519, EdwardsPoint, Scalar};
use modular_frost::{
    dkg::Interpolation,
    tests::{algorithm_machines, sign},
    Participant, ThresholdKeys, ThresholdParams,
};
use rand_core::OsRng;
use rosen_monero_fcmp_sal::{ContextBinding, LegacyRequest, REQUEST_BYTES};
use zeroize::Zeroizing;

fn fixed_keys(secret: u64) -> HashMap<Participant, ThresholdKeys<Ed25519>> {
    let mut shares = HashMap::new();
    for index in 1u16..=4 {
        let participant = Participant::new(index).unwrap();
        let share = Scalar::from(secret) + (Scalar::from(5u64) * Scalar::from(u64::from(index)));
        shares.insert(participant, share);
    }
    let verification = shares
        .iter()
        .map(|(participant, share)| (*participant, Ed25519::generator() * share))
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

fn hex32(value: &str) -> Result<[u8; 32], String> {
    if value.len() != 64 {
        return Err("context digest must be exactly 64 hex characters".into());
    }
    let mut out = [0u8; 32];
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[(index * 2)..(index * 2 + 2)], 16)
            .map_err(|_| "context digest contains non-hex characters")?;
    }
    Ok(out)
}

fn run() -> Result<(), String> {
    let args = env::args().collect::<Vec<_>>();
    if !(args.len() == 3 || args.len() == 4) {
        return Err("usage: fixture-sign REQUEST RESPONSE [CONTEXT_HEX32]".into());
    }
    let raw = fs::read(&args[1]).map_err(|error| format!("read request: {error}"))?;
    let wire: [u8; REQUEST_BYTES] = raw
        .try_into()
        .map_err(|_| format!("request must be exactly {REQUEST_BYTES} bytes"))?;
    let context = if args.len() == 4 {
        hex32(&args[3])?
    } else {
        [0x46; 32]
    };
    let request = LegacyRequest::from_wire(ContextBinding::from_policy_digest(context), &wire)
        .map_err(|error| format!("validate request: {error}"))?;

    let nominal = request.nominal_account_key();
    let fixture_secret = if nominal == EdwardsPoint::generator() * Scalar::from(7u64) {
        7
    } else if nominal == EdwardsPoint::generator() * Scalar::from(17u64) {
        17
    } else {
        return Err("request nominal key is not an allowed fixture account (7 or 17)".into());
    };
    let mut keys = fixed_keys(fixture_secret);
    if keys.values().next().unwrap().group_key()
        != EdwardsPoint::generator() * Scalar::from(fixture_secret)
    {
        return Err("internal fixture key construction failed".into());
    }
    let image_shares = keys
        .values()
        .map(|key| request.create_image_share(key))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let verified = request
        .verify_image_association(keys.values().next().unwrap(), &image_shares)
        .map_err(|error| error.to_string())?;
    let algorithm = verified
        .algorithm(&mut keys)
        .map_err(|error| error.to_string())?;
    let signature = sign(
        &mut OsRng,
        &algorithm,
        keys.clone(),
        algorithm_machines(&mut OsRng, &algorithm, &keys),
        &[],
    );
    let response = verified
        .complete(signature)
        .map_err(|error| error.to_string())?
        .wire()
        .map_err(|error| error.to_string())?;
    fs::write(&args[2], response).map_err(|error| format!("write response: {error}"))?;
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("fixture-sign: {error}");
            ExitCode::FAILURE
        }
    }
}
