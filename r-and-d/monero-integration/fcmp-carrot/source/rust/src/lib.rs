//! Low-level bridge to the beta3 monero-oxide FCMP++ threshold SAL machines.
//!
//! `ContextBinding` is an opaque session binding supplied by the caller. It
//! does not establish approval, quorum, or signer admission; those remain the
//! responsibility of the wallet's policy layer.

use ciphersuite::{
    group::{ff::PrimeField, Group, GroupEncoding},
    Ciphersuite,
};
use dalek_ff_group::{Ed25519, EdwardsPoint, Scalar};
use dleq::DLEqProof;
use modular_frost::{Participant, ThresholdKeys};
use monero_fcmp_plus_plus::{
    sal::{
        legacy_multisig::SalLegacyAlgorithm,
        multisig::{Ed25519T, SalAlgorithm},
        RerandomizedOutput, SpendAuthAndLinkability,
    },
    Input,
};
use monero_fcmp_plus_plus_generators::FCMP_PLUS_PLUS_U;
use multiexp::BatchVerifier;
use rand_core::OsRng;
use std::{collections::HashMap, ops::Deref};
use thiserror::Error;
use transcript::{RecommendedTranscript, Transcript};

pub const REQUEST_BYTES: usize = 481;
pub const RERANDOMIZED_OUTPUT_BYTES: usize = 256;
pub const SAL_BYTES: usize = 384;
pub const PROOF_BYTES: usize = 416;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ContextBinding([u8; 32]);

impl ContextBinding {
    pub fn from_policy_digest(digest: [u8; 32]) -> Self {
        Self(digest)
    }
    pub fn digest(&self) -> [u8; 32] {
        self.0
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AdapterError {
    #[error("non-canonical scalar")]
    NonCanonicalScalar,
    #[error("invalid compressed Edwards point")]
    InvalidPoint,
    #[error("output opening does not match the nominal account key")]
    OpeningMismatch,
    #[error("threshold share belongs to a different nominal account key")]
    ThresholdKeyMismatch,
    #[error("zero key multiplier")]
    ZeroMultiplier,
    #[error("completed proof has an unexpected key image")]
    KeyImageMismatch,
    #[error("completed SAL proof failed verification")]
    ProofVerification,
    #[error("key-image share association failed")]
    ImageAssociation,
    #[error("failed to serialize SAL proof")]
    Serialization,
    #[error("invalid signing mode")]
    InvalidMode,
    #[error("invalid rerandomized-output encoding")]
    InvalidRerandomizedOutput,
}

fn scalar(bytes: [u8; 32]) -> Result<Scalar, AdapterError> {
    Option::<Scalar>::from(Scalar::from_repr(bytes)).ok_or(AdapterError::NonCanonicalScalar)
}

fn point(bytes: [u8; 32]) -> Result<EdwardsPoint, AdapterError> {
    Option::<EdwardsPoint>::from(EdwardsPoint::from_bytes(&bytes)).ok_or(AdapterError::InvalidPoint)
}

pub fn t_generator() -> EdwardsPoint {
    Ed25519T::generator()
}

fn bound_transcript(context: ContextBinding) -> RecommendedTranscript {
    let mut transcript = RecommendedTranscript::new(b"Rosen FCMP++ SAL threshold adapter v1");
    transcript.append_message(b"policy_context", context.digest());
    transcript
}

fn original_output_key(output: &RerandomizedOutput) -> Result<EdwardsPoint, AdapterError> {
    Ok(point(output.input().O_tilde())? + (t_generator() * output.o_blind()))
}

fn original_image_base(output: &RerandomizedOutput) -> Result<EdwardsPoint, AdapterError> {
    Ok(point(output.input().I_tilde())?
        + (EdwardsPoint((*FCMP_PLUS_PLUS_U).into()) * output.i_blind()))
}

#[derive(Clone)]
pub struct CompletedProof {
    key_image: EdwardsPoint,
    sal: SpendAuthAndLinkability,
}

impl CompletedProof {
    pub fn key_image(&self) -> [u8; 32] {
        self.key_image.to_bytes()
    }
    pub fn key_image_point(&self) -> EdwardsPoint {
        self.key_image
    }
    pub fn sal(&self) -> &SpendAuthAndLinkability {
        &self.sal
    }
    pub fn wire(&self) -> Result<[u8; PROOF_BYTES], AdapterError> {
        let mut wire = [0u8; PROOF_BYTES];
        wire[..32].copy_from_slice(&self.key_image());
        let mut encoded = Vec::with_capacity(SAL_BYTES);
        self.sal
            .write(&mut encoded)
            .map_err(|_| AdapterError::Serialization)?;
        if encoded.len() != SAL_BYTES {
            return Err(AdapterError::Serialization);
        }
        wire[32..].copy_from_slice(&encoded);
        Ok(wire)
    }
}

#[derive(Clone)]
pub struct LegacyRequest {
    context: ContextBinding,
    message: [u8; 32],
    output: RerandomizedOutput,
    nominal: EdwardsPoint,
    multiplier: Scalar,
    x_offset: Scalar,
    y: Scalar,
    expected_key_image: EdwardsPoint,
}

#[derive(Clone, Debug)]
pub struct LegacyImageShare {
    participant: Participant,
    image_share: EdwardsPoint,
    proof: DLEqProof<EdwardsPoint>,
}

#[derive(Clone)]
pub struct VerifiedLegacyRequest(LegacyRequest);

impl LegacyRequest {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        context: ContextBinding,
        message: [u8; 32],
        output: RerandomizedOutput,
        ota: [u8; 32],
        nominal: [u8; 32],
        multiplier: [u8; 32],
        x_offset: [u8; 32],
        y: [u8; 32],
        expected_key_image: [u8; 32],
    ) -> Result<Self, AdapterError> {
        let nominal = point(nominal)?;
        let multiplier = scalar(multiplier)?;
        if multiplier == Scalar::ZERO {
            return Err(AdapterError::ZeroMultiplier);
        }
        let x_offset = scalar(x_offset)?;
        let y = scalar(y)?;
        let original = original_output_key(&output)?;
        if original != point(ota)?
            || original
                != ((nominal * multiplier)
                    + (Ed25519::generator() * x_offset)
                    + (t_generator() * y))
        {
            return Err(AdapterError::OpeningMismatch);
        }
        let expected_key_image = point(expected_key_image)?;
        Ok(Self {
            context,
            message,
            output,
            nominal,
            multiplier,
            x_offset,
            y,
            expected_key_image,
        })
    }

    pub fn from_wire(
        context: ContextBinding,
        wire: &[u8; REQUEST_BYTES],
    ) -> Result<Self, AdapterError> {
        if wire[0] != 0 {
            return Err(AdapterError::InvalidMode);
        }
        let mut reader = &wire[33..289];
        let output = RerandomizedOutput::read(&mut reader)
            .map_err(|_| AdapterError::InvalidRerandomizedOutput)?;
        Self::new(
            context,
            wire[1..33].try_into().unwrap(),
            output,
            wire[289..321].try_into().unwrap(),
            wire[321..353].try_into().unwrap(),
            wire[353..385].try_into().unwrap(),
            wire[385..417].try_into().unwrap(),
            wire[417..449].try_into().unwrap(),
            wire[449..481].try_into().unwrap(),
        )
    }

    pub fn input(&self) -> Input {
        self.output.input()
    }

    pub fn nominal_account_key(&self) -> EdwardsPoint {
        self.nominal
    }

    fn image_transcript(&self, participant: Participant) -> RecommendedTranscript {
        let mut transcript = bound_transcript(self.context);
        transcript.domain_separate(b"legacy key-image share association v1");
        transcript.append_message(b"participant", participant.to_bytes());
        transcript.append_message(b"message", self.message);
        transcript.append_message(b"O_tilde", self.input().O_tilde());
        transcript.append_message(b"I_tilde", self.input().I_tilde());
        transcript.append_message(b"nominal", self.nominal.to_bytes());
        transcript.append_message(b"multiplier", self.multiplier.to_repr());
        transcript.append_message(b"x_offset", self.x_offset.to_repr());
        transcript.append_message(b"y", self.y.to_repr());
        transcript.append_message(b"expected_key_image", self.expected_key_image.to_bytes());
        transcript
    }

    pub fn create_image_share(
        &self,
        keys: &ThresholdKeys<Ed25519>,
    ) -> Result<LegacyImageShare, AdapterError> {
        if keys.original_group_key() != self.nominal {
            return Err(AdapterError::ThresholdKeyMismatch);
        }
        let participant = keys.params().i();
        let image_base = original_image_base(&self.output)?;
        let image_share = image_base * keys.original_secret_share().deref();
        let proof = DLEqProof::prove(
            &mut OsRng,
            &mut self.image_transcript(participant),
            &[Ed25519::generator(), image_base],
            keys.original_secret_share(),
        );
        Ok(LegacyImageShare {
            participant,
            image_share,
            proof,
        })
    }

    pub fn verify_image_association(
        self,
        reference_keys: &ThresholdKeys<Ed25519>,
        shares: &[LegacyImageShare],
    ) -> Result<VerifiedLegacyRequest, AdapterError> {
        if reference_keys.original_group_key() != self.nominal
            || shares.len() < usize::from(reference_keys.params().t())
            || shares.len() > usize::from(reference_keys.params().n())
        {
            return Err(AdapterError::ImageAssociation);
        }
        let mut included = shares
            .iter()
            .map(|share| share.participant)
            .collect::<Vec<_>>();
        included.sort();
        included.dedup();
        if included.len() != shares.len() {
            return Err(AdapterError::ImageAssociation);
        }
        let view = reference_keys
            .view(included)
            .map_err(|_| AdapterError::ImageAssociation)?;
        let image_base = original_image_base(&self.output)?;
        let mut aggregate = EdwardsPoint::identity();
        for share in shares {
            share
                .proof
                .verify(
                    &mut self.image_transcript(share.participant),
                    &[Ed25519::generator(), image_base],
                    &[
                        reference_keys.original_verification_share(share.participant),
                        share.image_share,
                    ],
                )
                .map_err(|_| AdapterError::ImageAssociation)?;
            let factor = view
                .interpolation_factor(share.participant)
                .ok_or(AdapterError::ImageAssociation)?;
            aggregate += share.image_share * factor;
        }
        let associated = (aggregate * self.multiplier) + (image_base * self.x_offset);
        if associated != self.expected_key_image {
            return Err(AdapterError::KeyImageMismatch);
        }
        Ok(VerifiedLegacyRequest(self))
    }
}

impl VerifiedLegacyRequest {
    pub fn input(&self) -> Input {
        self.0.input()
    }

    pub fn algorithm(
        &self,
        keys: &mut HashMap<Participant, ThresholdKeys<Ed25519>>,
    ) -> Result<SalLegacyAlgorithm<OsRng, RecommendedTranscript>, AdapterError> {
        for key in keys.values_mut() {
            if key.original_group_key() != self.0.nominal {
                return Err(AdapterError::ThresholdKeyMismatch);
            }
            *key = key
                .clone()
                .scale(self.0.multiplier)
                .ok_or(AdapterError::ZeroMultiplier)?
                .offset(self.0.x_offset);
        }
        Ok(SalLegacyAlgorithm::new(
            OsRng,
            bound_transcript(self.0.context),
            self.0.message,
            self.0.output.clone(),
            self.0.y,
        ))
    }

    pub fn complete(
        &self,
        (key_image, sal): (EdwardsPoint, SpendAuthAndLinkability),
    ) -> Result<CompletedProof, AdapterError> {
        if key_image != self.0.expected_key_image {
            return Err(AdapterError::KeyImageMismatch);
        }
        let mut verifier = BatchVerifier::new(1);
        sal.verify(
            &mut OsRng,
            &mut verifier,
            self.0.message,
            &self.input(),
            key_image,
        )
        .map_err(|_| AdapterError::ProofVerification)?;
        if !verifier.verify_vartime() {
            return Err(AdapterError::ProofVerification);
        }
        Ok(CompletedProof { key_image, sal })
    }
}

#[derive(Clone)]
pub struct ModernRequest {
    context: ContextBinding,
    message: [u8; 32],
    output: RerandomizedOutput,
    nominal: EdwardsPoint,
    multiplier: Scalar,
    x: Scalar,
    expected_key_image: EdwardsPoint,
}

impl ModernRequest {
    pub fn new(
        context: ContextBinding,
        message: [u8; 32],
        output: RerandomizedOutput,
        ota: [u8; 32],
        nominal: [u8; 32],
        multiplier: [u8; 32],
        x: [u8; 32],
        expected_key_image: [u8; 32],
    ) -> Result<Self, AdapterError> {
        let nominal = point(nominal)?;
        let multiplier = scalar(multiplier)?;
        if multiplier == Scalar::ZERO {
            return Err(AdapterError::ZeroMultiplier);
        }
        let x = scalar(x)?;
        let original = original_output_key(&output)?;
        if original != point(ota)?
            || original != ((Ed25519::generator() * x) + (nominal * multiplier))
        {
            return Err(AdapterError::OpeningMismatch);
        }
        let expected_key_image = point(expected_key_image)?;
        if (original_image_base(&output)? * x) != expected_key_image {
            return Err(AdapterError::KeyImageMismatch);
        }
        Ok(Self {
            context,
            message,
            output,
            nominal,
            multiplier,
            x,
            expected_key_image,
        })
    }

    pub fn input(&self) -> Input {
        self.output.input()
    }

    pub fn algorithm(
        &self,
        keys: &mut HashMap<Participant, ThresholdKeys<Ed25519T>>,
    ) -> Result<SalAlgorithm<OsRng, RecommendedTranscript>, AdapterError> {
        for key in keys.values_mut() {
            if key.group_key() != self.nominal {
                return Err(AdapterError::ThresholdKeyMismatch);
            }
            *key = key
                .clone()
                .scale(self.multiplier)
                .ok_or(AdapterError::ZeroMultiplier)?
                .offset(-self.output.o_blind());
        }
        let transcript = bound_transcript(self.context);
        Ok(SalAlgorithm::new(
            OsRng,
            transcript,
            self.message,
            self.output.clone(),
            self.x,
        ))
    }

    pub fn complete(&self, sal: SpendAuthAndLinkability) -> Result<CompletedProof, AdapterError> {
        let mut verifier = BatchVerifier::new(1);
        sal.verify(
            &mut OsRng,
            &mut verifier,
            self.message,
            &self.input(),
            self.expected_key_image,
        )
        .map_err(|_| AdapterError::ProofVerification)?;
        if !verifier.verify_vartime() {
            return Err(AdapterError::ProofVerification);
        }
        Ok(CompletedProof {
            key_image: self.expected_key_image,
            sal,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinct_contexts_produce_distinct_round_transcripts() {
        let mut first = bound_transcript(ContextBinding::from_policy_digest([1; 32]));
        let mut second = bound_transcript(ContextBinding::from_policy_digest([2; 32]));
        assert_ne!(
            first.challenge(b"round-binding"),
            second.challenge(b"round-binding")
        );
    }
}
