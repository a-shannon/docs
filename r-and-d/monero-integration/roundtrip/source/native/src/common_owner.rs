//! Private local supervisor/guard model. No distributed authentication or signer API.
#[cfg(feature = "synthetic-host")]
#[path = "host.rs"]
pub(crate) mod host;
#[path = "authorized_signing.rs"]
mod authorized_signing;
#[cfg(feature = "participant-host")]
#[path = "participant_signing.rs"]
pub(crate) mod participant_signing;
#[cfg(feature = "participant-host")]
#[path = "participant_source.rs"]
pub(crate) mod participant_source;
use super::*;
use crate::key_image::{LocalContext, LocalImageSession, ProofRow, VerifiedImages, VerifiedInputImage};
use ciphersuite::{Ciphersuite, group::GroupEncoding};
use dalek_ff_group::EdwardsPoint as PrimePoint;
use dkg::{Participant, ThresholdKeys};
use frost::{curve::Ed25519, sign::{PreprocessMachine, SignMachine, Writable}};
use monero_wallet::{send::TransactionSignMachine, transaction::Transaction};
use rand_core::{OsRng, RngCore};
use std::{collections::HashMap, path::{Path, PathBuf}, sync::{Arc, atomic::{AtomicUsize, Ordering}}};

type NativePreprocess = <TransactionSignMachine as SignMachine<Transaction>>::Preprocess;
#[derive(Debug, PartialEq, Eq)]
enum GateError { Inputs, Custody, Vault, Subset, ImageProof, NativeConstruction, ModelBinding,
    Participant, Duplicate, Missing, WireLength, NativeDecode, Canonical, ImageShare, FinalImage, Candidate }
type Result<T> = std::result::Result<T, GateError>;
#[derive(Default)]
struct Trace { constructs:AtomicUsize, restores:AtomicUsize, preprocesses:AtomicUsize, decodes:AtomicUsize, wallet_signs:AtomicUsize,
    image_checks:AtomicUsize, seals:AtomicUsize }
fn bump(n:&AtomicUsize) { n.fetch_add(1,Ordering::SeqCst); }
fn fresh() -> [u8;32] { let mut value=[0;32];OsRng.fill_bytes(&mut value);value }
fn hex(bytes:&[u8]) -> String { bytes.iter().map(|b|format!("{b:02x}")).collect() }
fn copy_inputs(inputs:&[PreparedInput]) -> Vec<PreparedInput> {
    inputs.iter().map(|p|PreparedInput{scanned:p.scanned.clone(),ring:p.ring.clone()}).collect()
}
fn selection(inputs:&[PreparedInput],vault:&ViewPair) -> String {
    let mut out=format!("W1G-local-complete-selection1\n{}\n{}\n{}\n",hex(&vault.spend().compress().to_bytes()),hex(&vault.view().compress().to_bytes()),inputs.len());
    for p in inputs {
        let s=&p.scanned;let d=p.ring.decoys();
        out.push_str(&format!("{}:{}:{}:{}:{}:{}:{}\n",hex(&s.transaction()),s.index_in_transaction(),s.index_on_blockchain(),hex(&s.key().compress().to_bytes()),s.commitment().amount,hex(&s.commitment().commit().compress().to_bytes()),d.signer_index()));
        for (offset,pair) in d.offsets().iter().zip(d.ring()) {out.push_str(&format!("{}:{}:{}\n",offset,hex(&pair[0].compress().to_bytes()),hex(&pair[1].compress().to_bytes())));}
    }
    out
}

// Private supervisor custody. Contains no committee secret keys; no digest/tuple constructor.
struct CustodyOwner {
    path:PathBuf, expected_digest:[u8;32], id:[u8;32], binding:[u8;32], epoch:[u8;32],
    request:Vec<u8>, selection:String, inputs:Vec<PreparedInput>, vault:ViewPair, trace:Arc<Trace>, fee:(u64,u64), genesis:[u8;32],
}
impl CustodyOwner {
    fn create(path:&Path,journal:&Path,request:Vec<u8>,inputs:Vec<PreparedInput>,vault:ViewPair,
        seed:Zeroizing<[u8;32]>,trace:Arc<Trace>) -> Result<Self> {
        Self::create_with_fee(path,journal,request,inputs,vault,seed,trace,(1,1))
    }
    fn create_with_fee(path:&Path,journal:&Path,request:Vec<u8>,inputs:Vec<PreparedInput>,vault:ViewPair,
        seed:Zeroizing<[u8;32]>,trace:Arc<Trace>,fee:(u64,u64)) -> Result<Self> {
        Self::create_configured(path,journal,request,inputs,vault,seed,trace,fee,fresh(),fresh(),fresh(),[0x11;32])
    }
    fn create_configured(path:&Path,journal:&Path,request:Vec<u8>,inputs:Vec<PreparedInput>,vault:ViewPair,
        seed:Zeroizing<[u8;32]>,trace:Arc<Trace>,fee:(u64,u64),id:[u8;32],binding:[u8;32],epoch:[u8;32],genesis:[u8;32]) -> Result<Self> {
        FeeRate::new(fee.0,fee.1).ok_or(GateError::Custody)?;
        bound_inputs(&inputs,&vault).map_err(|_|GateError::Inputs)?;
        let selection=selection(&inputs,&vault);
        bump(&trace.constructs);
        let created=synthetic_keeper::create_pinned_fee(path,journal,&hex(&id),&hex(&binding),
            Request::decode(&request).map_err(|_|GateError::Custody)?,&selection,
            copy_inputs(&inputs),vault.clone(),seed,fee).map_err(|_|GateError::Custody)?;
        Ok(Self{path:path.into(),expected_digest:created.expected_digest,id,binding,epoch,
            request,selection,inputs,vault,trace,fee,genesis})
    }
    // The caller here is the named local supervisor harness, not an authenticated transport.
    // Each invocation receives exactly one local guard key; no collection of secret keys enters.
    fn restore_guard(&self,key:ThresholdKeys<Ed25519>,subset:Vec<Participant>,attempt:[u8;32])
        -> Result<(AwaitingImages,Vec<ProofRow>)> {
        if key.original_group_key().to_bytes()!=self.vault.spend().compress().to_bytes() {return Err(GateError::Vault);}
        let restored=synthetic_keeper::restore_owned(&self.path,&self.expected_digest,&hex(&self.id),&hex(&self.binding),
            Request::decode(&self.request).map_err(|_|GateError::Custody)?,&self.selection,
            copy_inputs(&self.inputs),self.vault.clone(),self.fee.0,self.fee.1).map_err(|_|GateError::Custody)?;
        bump(&self.trace.restores);
        let context=LocalContext{network_genesis:self.genesis,epoch:self.epoch,epoch_manifest:self.binding,
            session:attempt,retained_intent:self.id};
        let scanned=self.inputs.iter().map(|p|p.scanned.clone()).collect::<Vec<_>>();
        let session=LocalImageSession::capture(context.clone(),&key,subset.clone(),&scanned).map_err(|_|GateError::Subset)?;
        let rows=session.prove(&mut OsRng,&key).map_err(|_|GateError::ImageProof)?;
        let model=ModelBinding{context:[context.network_genesis,context.epoch,context.epoch_manifest,context.session,context.retained_intent],subset};
        let candidate_context=crate::candidate::Context{owner:self.id,request:self.request.clone(),vault:self.vault.clone(),fee:FeeRate::new(self.fee.0,self.fee.1).ok_or(GateError::Custody)?};
        let receipt=restored.receipt().to_wire();
        Ok((AwaitingImages{native:restored._native,receipt,key,session,model,inputs:copy_inputs(&self.inputs),candidate_context,trace:self.trace.clone()},rows))
    }
}
#[derive(Clone,PartialEq,Eq)]
struct ModelBinding {context:[[u8;32];5],subset:Vec<Participant>}
// Plain LOCAL MODEL data. This type makes no authentication claim.
#[derive(Clone)]
struct LocalModelMessage {binding:ModelBinding,participant:Participant,wire:Box<[u8]>}
struct AwaitingImages { native:SignableTransaction,receipt:String,key:ThresholdKeys<Ed25519>,session:LocalImageSession,
    model:ModelBinding,inputs:Vec<PreparedInput>,candidate_context:crate::candidate::Context,trace:Arc<Trace> }
struct CollectingAttempt { machine:TransactionSignMachine,receipt:String,our_generated:NativePreprocess,key:ThresholdKeys<Ed25519>,
    session:LocalImageSession,verified:VerifiedImages,model:ModelBinding,inputs:Vec<PreparedInput>,
    candidate:crate::candidate::IssuedCandidate,candidate_identity:[u8;32],trace:Arc<Trace> }
// No Clone, byte serializer, raw-machine/map getter, public constructor, or signing transition.
struct ImageBoundUnapproved { _machine:TransactionSignMachine,receipt:String,_remote:HashMap<Participant,NativePreprocess>,
    _session:LocalImageSession,_verified:VerifiedImages,_model:ModelBinding,_candidate:crate::candidate::IssuedCandidate,
    snapshot:authorized_signing::SealedSnapshot, trace:Arc<Trace> }

fn inspect(wire:&[u8],certs:&[VerifiedInputImage],id:Participant,trace:&Trace) -> Result<()> {
    let expected=certs.len().checked_mul(160).ok_or(GateError::WireLength)?;
    if certs.is_empty() || certs.len()>16 || wire.len()!=expected {return Err(GateError::WireLength);}
    for (n,cert) in certs.iter().enumerate() {
        let expected=cert.shares().iter().find(|s|s.participant()==id).ok_or(GateError::Participant)?;
        bump(&trace.image_checks);
        if wire[n*160+128..n*160+160]!=expected.image_share() {return Err(GateError::ImageShare);}
    }
    Ok(())
}
fn decode(machine:&TransactionSignMachine,wire:&[u8],certs:&[VerifiedInputImage],id:Participant,trace:&Trace) -> Result<NativePreprocess> {
    if wire.len()!=certs.len().checked_mul(160).ok_or(GateError::WireLength)? {return Err(GateError::WireLength);}
    let mut reader=wire; bump(&trace.decodes);
    let parsed=machine.read_preprocess(&mut reader).map_err(|_|GateError::NativeDecode)?;
    let canonical=parsed.serialize();
    if !reader.is_empty() || canonical.as_slice()!=wire {return Err(GateError::Canonical);}
    inspect(&canonical,certs,id,trace)?;Ok(parsed)
}
impl AwaitingImages {
    fn certify(self,rows:&[ProofRow]) -> Result<(CollectingAttempt,LocalModelMessage)> {
        let verified=self.session.verify(rows).map_err(|_|GateError::ImageProof)?;
        let certs=self.session.consume(&verified).map_err(|_|GateError::ImageProof)?;
        for (cert,input) in certs.iter().zip(&self.inputs) {
            if cert.identity().output_key()!=input.ring.key().compress().to_bytes()
                || input.ring.decoys().signer_ring_members()[0]!=input.ring.key() {return Err(GateError::Inputs);}
        }
        let candidate=crate::candidate::IssuedCandidate::issue(&self.native,&self.candidate_context,&self.inputs,certs).map_err(|_|GateError::Candidate)?;
        let candidate_identity=candidate.identity();
        let machine=self.native.multisig(self.key.clone()).map_err(|_|GateError::NativeConstruction)?;
        bump(&self.trace.preprocesses);
        let (machine,our_generated)=machine.preprocess(&mut OsRng);
        let wire=our_generated.serialize();let id=self.key.params().i();
        // Generated own row and same machine originate at the immediately preceding call.
        let parsed=decode(&machine,&wire,certs,id,&self.trace)?;
        if parsed!=our_generated {return Err(GateError::Canonical);}
        let message=LocalModelMessage{binding:self.model.clone(),participant:id,wire:wire.into_boxed_slice()};
        Ok((CollectingAttempt{machine,receipt:self.receipt,our_generated,key:self.key,session:self.session,verified,model:self.model,
            inputs:self.inputs,candidate,candidate_identity,trace:self.trace},message))
    }
}
impl CollectingAttempt {
    // Consuming whole attempt makes every rejection terminal, including partially parsed batches.
    fn seal(self,messages:Vec<LocalModelMessage>) -> Result<ImageBoundUnapproved> {
        let local=self.key.params().i();let certs=self.session.consume(&self.verified).map_err(|_|GateError::ImageProof)?;
        let mut remote=HashMap::new();
        for message in messages {
            if message.binding!=self.model {return Err(GateError::ModelBinding);}
            if message.participant==local || !self.model.subset.contains(&message.participant) {return Err(GateError::Participant);}
            if remote.contains_key(&message.participant) {return Err(GateError::Duplicate);}
            let actual=decode(&self.machine,&message.wire,certs,message.participant,&self.trace)?;
            remote.insert(message.participant,actual);
        }
        if remote.len()+1!=self.model.subset.len() {return Err(GateError::Missing);}
        let view=self.key.view(self.model.subset.clone()).map_err(|_|GateError::Subset)?;
        let own=self.our_generated.serialize();inspect(&own,certs,local,&self.trace)?;
        let remotes=remote.iter().map(|(id,p)|(*id,p.serialize())).collect::<HashMap<_,_>>();
        let public:PrimePoint=self.model.subset.iter().map(|id|self.key.original_verification_share(*id)*view.interpolation_factor(*id).unwrap()).sum();
        if public!=self.key.original_group_key() {return Err(GateError::Subset);}
        for (n,(cert,input)) in certs.iter().zip(&self.inputs).enumerate() {
            let mut js=Vec::new();
            for id in &self.model.subset {
                let bytes=if *id==local {own.as_slice()} else {remotes[id].as_slice()};
                let j=Ed25519::read_G(&mut &bytes[n*160+128..n*160+160]).map_err(|_|GateError::ImageShare)?;
                js.push(j*view.interpolation_factor(*id).ok_or(GateError::Subset)?);
            }
            let aggregate:PrimePoint=js.into_iter().sum();
            let h=Ed25519::read_G(&mut monero_ed25519::Point::biased_hash(cert.identity().output_key()).compress().to_bytes().as_slice()).map_err(|_|GateError::FinalImage)?;
            let bytes=Zeroizing::new(<[u8;32]>::from(input.scanned.key_offset()));
            let d=Zeroizing::new(Ed25519::read_F(&mut bytes.as_slice()).map_err(|_|GateError::FinalImage)?);
            if (aggregate+h * *d).to_bytes()!=cert.image() {return Err(GateError::FinalImage);}
        }
        self.candidate.check(&self.candidate_identity).map_err(|_|GateError::Candidate)?;
        let snapshot=authorized_signing::SealedSnapshot::capture(&self.key,&self.model,
            &self.candidate,&self.candidate_identity,&self.inputs,certs)?;
        bump(&self.trace.seals);
        Ok(ImageBoundUnapproved{_machine:self.machine,receipt:self.receipt,_remote:remote,_session:self.session,_verified:self.verified,_model:self.model,_candidate:self.candidate,snapshot,trace:self.trace})
    }
}

#[cfg(test)]
#[path="common_owner_tests.rs"]
mod tests;
