//! Local synthetic committee key-image preparation. No payout-signing authority.
use std::collections::HashSet;
use ciphersuite::{Ciphersuite, group::{Group, GroupEncoding}};
use dalek_ff_group::{EdwardsPoint, Scalar};
use dkg::{Interpolation, Participant, ThresholdKeys};
use dleq::DLEqProof;
use frost::curve::Ed25519;
use monero_wallet::WalletOutput;
use rand_core::{CryptoRng, RngCore};
use transcript::{RecommendedTranscript, Transcript};
use zeroize::Zeroizing;

const DOMAIN: &[u8] = b"rosen-monero-local-key-image/v1";
const PROFILE: &[u8] = b"ed25519-shamir-untweaked-standard/monero-wallet=0.2.0/dkg=0.6.1/dleq=0.4.1";
const PURPOSE: &[u8] = b"pre-signing-input-image";
const ROW_LEN: usize = 8 + 2 + 2 + 32 + 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error { Context, Unsupported, Epoch, Subset, InputCount, Input, Point, Row, Proof, Association }
type Result<T> = std::result::Result<T, Error>;

/// Caller-supplied local model identifiers, NOT distributed authentication.
/// The retained-intent owner must bind handle to its captured input objects.
#[derive(Clone)]
pub struct LocalContext {
    pub network_genesis: [u8;32], pub epoch: [u8;32], pub epoch_manifest: [u8;32],
    pub session: [u8;32], pub retained_intent: [u8;32],
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct InputIdentity { transaction: [u8;32], index: u64, chain_index: u64, p: [u8;32] }
impl InputIdentity {
    fn from_output(o: &WalletOutput) -> Self { Self { transaction: o.transaction(), index: o.index_in_transaction(), chain_index: o.index_on_blockchain(), p: o.key().compress().to_bytes() } }
    fn bytes(&self) -> Vec<u8> { let mut b=self.transaction.to_vec(); b.extend(self.index.to_le_bytes()); b.extend(self.chain_index.to_le_bytes()); b.extend(self.p); b }
    pub fn output_key(&self) -> [u8;32] { self.p }
    pub fn transaction(&self) -> [u8;32] { self.transaction }
    pub fn index(&self) -> u64 { self.index }
}

#[cfg(test)]
#[path="key_image_tests.rs"]
mod tests;
struct InputState { identity: InputIdentity, h: EdwardsPoint, offset: Zeroizing<Scalar> }

/// Frozen verifier state captured from one selected guard's local DKG object.
/// Stores no DKG secret; a library view is used and dropped during construction.
pub struct LocalImageSession {
    context: LocalContext, group: EdwardsPoint, threshold: u16,
    roster: Vec<(Participant, EdwardsPoint)>, subset: Vec<(Participant, Scalar)>,
    inputs: Vec<InputState>, binding: Vec<u8>,
}

/// Untrusted network row. No authority is obtained by decoding it.
#[derive(Clone)]
pub struct ProofRow { ordinal: u16, participant: Participant, image_share: [u8;32], proof: [u8;64] }
impl ProofRow {
    pub fn encode(&self) -> Vec<u8> {
        let mut b=b"W1E-ROW1".to_vec(); b.extend(self.ordinal.to_le_bytes());
        b.extend(u16::from(self.participant).to_le_bytes()); b.extend(self.image_share); b.extend(self.proof); b
    }
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len()!=ROW_LEN || &bytes[..8]!=b"W1E-ROW1" { return Err(Error::Row); }
        let ordinal=u16::from_le_bytes(bytes[8..10].try_into().unwrap());
        let participant=Participant::new(u16::from_le_bytes(bytes[10..12].try_into().unwrap())).ok_or(Error::Row)?;
        let image_share=bytes[12..44].try_into().unwrap(); point(image_share)?;
        let proof: [u8;64]=bytes[44..].try_into().unwrap(); read_proof(&proof)?;
        Ok(Self { ordinal, participant, image_share, proof })
    }
}

/// Guard-confidential original-share certificate for a later preprocess gate.
pub struct CertifiedShare { participant: Participant, image_share: [u8;32] }
impl CertifiedShare {
    pub fn participant(&self) -> Participant { self.participant }
    pub fn image_share(&self) -> [u8;32] { self.image_share }
}
pub struct VerifiedInputImage { identity: InputIdentity, image: [u8;32], shares: Vec<CertifiedShare> }
impl VerifiedInputImage {
    pub fn identity(&self) -> &InputIdentity { &self.identity }
    pub fn image(&self) -> [u8;32] { self.image }
    pub fn shares(&self) -> &[CertifiedShare] { &self.shares }
}
/// Only session verification constructs this type; no deserialize/raw constructor.
pub struct VerifiedImages { binding: Vec<u8>, inputs: Vec<VerifiedInputImage> }

fn point(bytes: [u8;32]) -> Result<EdwardsPoint> {
    let mut r=bytes.as_slice(); let p=Ed25519::read_G(&mut r).map_err(|_|Error::Point)?;
    if !r.is_empty() || p.to_bytes()!=bytes || bool::from(p.is_identity()) { return Err(Error::Point); } Ok(p)
}
fn read_proof(bytes: &[u8]) -> Result<DLEqProof<EdwardsPoint>> {
    if bytes.len()!=64 { return Err(Error::Proof); }
    let mut r=bytes; let p=DLEqProof::read(&mut r).map_err(|_|Error::Proof)?;
    if !r.is_empty() || p.serialize()!=bytes { return Err(Error::Proof); } Ok(p)
}
fn frame(out: &mut Vec<u8>, label: &[u8], bytes: &[u8]) {
    out.extend((label.len() as u32).to_le_bytes()); out.extend(label);
    out.extend((bytes.len() as u32).to_le_bytes()); out.extend(bytes);
}
fn untweaked(keys: &ThresholdKeys<Ed25519>) -> Result<()> {
    if !matches!(keys.interpolation(), Interpolation::Lagrange) || keys.current_scalar()!=Scalar::ONE || keys.current_offset()!=Scalar::ZERO || keys.group_key()!=keys.original_group_key() { return Err(Error::Unsupported); } Ok(())
}

impl LocalImageSession {
    pub fn capture(context: LocalContext, keys: &ThresholdKeys<Ed25519>, selected: Vec<Participant>, outputs: &[WalletOutput]) -> Result<Self> {
        untweaked(keys)?;
        if [context.network_genesis,context.epoch,context.epoch_manifest,context.session,context.retained_intent].contains(&[0;32]) { return Err(Error::Context); }
        if outputs.is_empty() || outputs.len()>16 { return Err(Error::InputCount); }
        // Require canonical subset order instead of silently normalizing caller data.
        if selected.windows(2).any(|s|s[0]>=s[1]) { return Err(Error::Subset); }
        let view=keys.view(selected.clone()).map_err(|_|Error::Subset)?;
        let group=point(keys.original_group_key().to_bytes())?;
        let roster=(1..=keys.params().n()).map(|n| {
            let id=Participant::new(n).ok_or(Error::Epoch)?;
            Ok((id,point(keys.original_verification_share(id).to_bytes())?))
        }).collect::<Result<Vec<_>>>()?;
        let subset=selected.iter().map(|i|Ok((*i,view.interpolation_factor(*i).ok_or(Error::Subset)?))).collect::<Result<Vec<_>>>()?;
        let public_sum: EdwardsPoint=subset.iter().map(|(i,l)|keys.original_verification_share(*i) * l).sum();
        if public_sum!=group { return Err(Error::Epoch); }
        drop(view);
        let mut identities=HashSet::new(); let mut points=HashSet::new(); let mut chain_indices=HashSet::new();
        let mut inputs=Vec::new();
        for o in outputs {
            if o.subaddress().is_some() { return Err(Error::Unsupported); }
            let identity=InputIdentity::from_output(o);
            if !identities.insert((identity.transaction,identity.index)) || !points.insert(identity.p) || !chain_indices.insert(identity.chain_index) { return Err(Error::Input); }
            let p=point(identity.p)?;
            let bytes=Zeroizing::new(<[u8;32]>::from(o.key_offset()));
            let mut r=bytes.as_slice(); let offset=Zeroizing::new(Ed25519::read_F(&mut r).map_err(|_|Error::Input)?);
            if !r.is_empty() || p!=group + Ed25519::generator() * *offset { return Err(Error::Input); }
            let h=point(monero_ed25519::Point::biased_hash(identity.p).compress().to_bytes())?;
            inputs.push(InputState { identity,h,offset });
        }
        let mut session=Self { context,group,threshold:keys.params().t(),roster,subset,inputs,binding:Vec::new() };
        session.binding=session.encode_binding(); Ok(session)
    }
    fn encode_binding(&self) -> Vec<u8> {
        let mut out=Vec::new();
        for (label,value) in [(b"domain".as_slice(),DOMAIN),(b"profile",PROFILE),(b"purpose",PURPOSE),
            (b"network-genesis",self.context.network_genesis.as_slice()),(b"epoch",self.context.epoch.as_slice()),
            (b"epoch-manifest-id",self.context.epoch_manifest.as_slice()),(b"session",self.context.session.as_slice()),
            (b"retained-intent",self.context.retained_intent.as_slice())] { frame(&mut out,label,value); }
        frame(&mut out,b"group",&self.group.to_bytes()); frame(&mut out,b"threshold",&self.threshold.to_le_bytes());
        frame(&mut out,b"interpolation",b"lagrange");
        let mut roster=(self.roster.len() as u16).to_le_bytes().to_vec();
        for (i,v) in &self.roster { roster.extend(u16::from(*i).to_le_bytes()); roster.extend(v.to_bytes()); }
        frame(&mut out,b"original-roster",&roster);
        let mut subset=(self.subset.len() as u16).to_le_bytes().to_vec();
        for (i,_) in &self.subset { subset.extend(u16::from(*i).to_le_bytes()); }
        frame(&mut out,b"selected-subset",&subset);
        let mut inputs=(self.inputs.len() as u16).to_le_bytes().to_vec();
        for input in &self.inputs { inputs.extend(input.identity.bytes()); }
        frame(&mut out,b"ordered-inputs",&inputs); out
    }
    fn transcript(&self, ordinal: usize, participant: Participant) -> RecommendedTranscript {
        let mut t=RecommendedTranscript::new(DOMAIN);
        t.append_message(b"framed-local-binding",&self.binding);
        t.append_message(b"input-ordinal",(ordinal as u16).to_le_bytes());
        t.append_message(b"scanner-output",self.inputs[ordinal].identity.bytes());
        t.append_message(b"P",self.inputs[ordinal].identity.p);
        t.append_message(b"participant",u16::from(participant).to_le_bytes()); t
    }
    fn check_key(&self, key: &ThresholdKeys<Ed25519>) -> Result<Participant> {
        untweaked(key)?; let id=key.params().i();
        if key.params().t()!=self.threshold || usize::from(key.params().n())!=self.roster.len() || key.group_key()!=self.group || !self.subset.iter().any(|(i,_)|*i==id) { return Err(Error::Epoch); }
        for (i,v) in &self.roster { if key.original_verification_share(*i)!=*v { return Err(Error::Epoch); } }
        if Ed25519::generator() * **key.original_secret_share()!=self.roster[usize::from(u16::from(id)-1)].1 { return Err(Error::Epoch); } Ok(id)
    }
    pub fn prove<R: RngCore+CryptoRng>(&self, rng: &mut R, key: &ThresholdKeys<Ed25519>) -> Result<Vec<ProofRow>> {
        let id=self.check_key(key)?;
        self.inputs.iter().enumerate().map(|(ordinal,input)| {
            let j=point((input.h * **key.original_secret_share()).to_bytes())?;
            let proof=DLEqProof::<EdwardsPoint>::prove(rng,&mut self.transcript(ordinal,id),
                &[Ed25519::generator(),input.h],key.original_secret_share());
            Ok(ProofRow { ordinal:ordinal as u16,participant:id,image_share:j.to_bytes(),proof:proof.serialize().try_into().unwrap() })
        }).collect()
    }
    /// Rows must be input-major then selected-participant order; every row verified.
    pub fn verify(&self, rows: &[ProofRow]) -> Result<VerifiedImages> {
        if rows.len()!=self.inputs.len()*self.subset.len() { return Err(Error::Row); }
        let mut images=HashSet::new(); let mut inputs=Vec::new();
        for (ordinal,input) in self.inputs.iter().enumerate() {
            let mut aggregate=EdwardsPoint::identity(); let mut shares=Vec::new();
            for (slot,(id,lambda)) in self.subset.iter().enumerate() {
                let row=&rows[ordinal*self.subset.len()+slot];
                if row.ordinal as usize!=ordinal || row.participant!=*id { return Err(Error::Association); }
                let j=point(row.image_share)?; let proof=read_proof(&row.proof)?;
                let v=self.roster[usize::from(u16::from(*id)-1)].1;
                proof.verify(&mut self.transcript(ordinal,*id),&[Ed25519::generator(),input.h],&[v,j]).map_err(|_|Error::Proof)?;
                aggregate+=j * lambda;
                shares.push(CertifiedShare { participant:*id,image_share:row.image_share });
            }
            let image=point((aggregate + input.h * *input.offset).to_bytes())?.to_bytes();
            if !images.insert(image) { return Err(Error::Input); }
            inputs.push(VerifiedInputImage { identity:input.identity,image,shares });
        }
        Ok(VerifiedImages { binding:self.binding.clone(),inputs })
    }
    /// Exact consumer association check. This confers no signing capability.
    pub fn consume<'a>(&self, images: &'a VerifiedImages) -> Result<&'a [VerifiedInputImage]> {
        if images.binding!=self.binding || images.inputs.len()!=self.inputs.len() || images.inputs.iter().zip(&self.inputs).any(|(a,b)|a.identity!=b.identity) { return Err(Error::Association); }
        Ok(&images.inputs)
    }
}
