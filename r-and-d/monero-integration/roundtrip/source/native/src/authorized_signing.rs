//! Private retained signing boundary and bounded original verification expectation.
//! The owning issuer supplies local approval; no public capability constructor exists.
use super::*;
use monero_wallet::transaction::Input;
use sha2::{Digest, Sha256};
use frost::sign::SignatureMachine;
use monero_wallet::ringct::{RctPrunable, RctProofs, bulletproofs::Bulletproof};
#[path = "terminal_custody.rs"]
pub(super) mod terminal;

pub(super) const MAX_DESCRIPTOR_BYTES: usize = 4096;
const MAX_ROSTER: usize = 16;
const DESCRIPTOR_DOMAIN: &[u8] = b"W1hd/native-approval-descriptor/v1\0";
const MAX_EXPECTATION: usize = 65_536;
const MAX_FINAL: usize = 9_408;
#[cfg(test)]
#[path = "../tests/support/mod.rs"]
mod key_fixture;

#[derive(PartialEq, Eq)]
struct VerificationInput {
    image: CompressedPoint,
    offsets: Vec<u64>,
    ring: Vec<[CompressedPoint; 2]>,
}
#[derive(PartialEq, Eq)]
struct OriginalRoster { threshold: u16, members: Vec<(Participant, [u8; 32])>, group: [u8; 32] }
impl OriginalRoster {
    fn capture(key: &ThresholdKeys<Ed25519>) -> Result<Self> {
        let params = key.params();
        if params.n() == 0 || usize::from(params.n()) > MAX_ROSTER || params.t() == 0
            || params.t() > params.n() { return Err(GateError::Subset); }
        let members = params.all_participant_indexes()
            .map(|id| (id, key.original_verification_share(id).to_bytes())).collect();
        Ok(Self { threshold: params.t(), members, group: key.original_group_key().to_bytes() })
    }
}

// This snapshot contains no scalar, key offset, amount or real-ring index. It is
// captured from the typed inputs/certificates at seal, never decoded from WMNS2.
pub(super) struct SealedSnapshot {
    local: Participant,
    candidate_identity: [u8; 32],
    roster: OriginalRoster,
    inputs: Vec<VerificationInput>,
}
impl SealedSnapshot {
    pub(super) fn capture(key: &ThresholdKeys<Ed25519>, model: &ModelBinding,
        candidate: &crate::candidate::IssuedCandidate, candidate_identity: &[u8; 32],
        inputs: &[PreparedInput], certs: &[VerifiedInputImage]) -> Result<Self> {
        candidate.check(candidate_identity).map_err(|_| GateError::Candidate)?;
        if inputs.is_empty() || inputs.len() > MAX_INPUTS || certs.len() != inputs.len() {
            return Err(GateError::Inputs);
        }
        let mut verification = Vec::with_capacity(inputs.len());
        for (input, cert) in inputs.iter().zip(certs) {
            let decoys = input.ring.decoys();
            if cert.identity().output_key() != input.ring.key().compress().to_bytes()
                || decoys.len() != 16 || decoys.offsets().len() != 16 {
                return Err(GateError::Inputs);
            }
            verification.push(VerificationInput { image: CompressedPoint::from(cert.image()),
                offsets: decoys.offsets().to_vec(), ring: decoys.ring().iter()
                    .map(|pair| [pair[0].compress(), pair[1].compress()]).collect() });
        }
        // monero-wallet sorts by descending compressed key image. Preserve each
        // exact ring's association while following the admitted transaction order.
        verification.sort_by(|a, b| b.image.cmp(&a.image));
        let decoded = crate::candidate::decode(&candidate.bytes).map_err(|_| GateError::Candidate)?;
        if decoded.owner != model.context[4] || decoded.tx.prefix().inputs.len() != verification.len() {
            return Err(GateError::Candidate);
        }
        for (input, expected) in decoded.tx.prefix().inputs.iter().zip(&verification) {
            if !matches!(input, Input::ToKey { amount: None, key_image, key_offsets }
                if *key_image == expected.image && *key_offsets == expected.offsets) {
                return Err(GateError::Inputs);
            }
        }
        let result = Self { local: key.params().i(), candidate_identity: *candidate_identity,
            roster: OriginalRoster::capture(key)?, inputs: verification };
        validate_members(model, &result)?;
        Ok(result)
    }
}
fn selected_ids(model: &ModelBinding) -> Vec<Participant> {
    let mut selected = model.subset.clone();
    selected.sort_unstable();
    selected
}
fn validate_members(model: &ModelBinding, snapshot: &SealedSnapshot) -> Result<()> {
    let roster = &snapshot.roster;
    let selected = selected_ids(model);
    if roster.members.is_empty() || roster.members.len() > MAX_ROSTER || roster.threshold == 0
        || usize::from(roster.threshold) > roster.members.len()
        || selected.len() < usize::from(roster.threshold) || selected.len() > roster.members.len()
        || !selected.contains(&snapshot.local) { return Err(GateError::Subset); }
    if roster.members.iter().enumerate().any(|(index, (id, _))| usize::from(u16::from(*id)) != index + 1)
        || selected.windows(2).any(|ids| ids[0] == ids[1])
        || selected.iter().any(|id| !roster.members.iter().any(|(member, _)| member == id)) {
        return Err(GateError::Subset);
    }
    Ok(())
}
fn compare_snapshots(model: &ModelBinding, first: &SealedSnapshot, second: &SealedSnapshot) -> Result<()> {
    validate_members(model, first)?;
    validate_members(model, second)?;
    let selected = selected_ids(model);
    let mut locals = vec![first.local, second.local];
    locals.sort_unstable();
    if selected != locals || first.local == second.local || first.candidate_identity != second.candidate_identity
        || first.roster != second.roster || first.inputs != second.inputs {
        return Err(GateError::ModelBinding);
    }
    Ok(())
}

pub(super) struct Descriptor { wire: String, identity: [u8; 32] }
impl Descriptor {
    fn from_snapshot(model: &ModelBinding, snapshot: &SealedSnapshot) -> Result<Self> {
        validate_members(model, snapshot)?;
        let mut wire = String::from("WMAD1\n");
        for context in &model.context { wire.push_str(&hex(context)); wire.push('\n'); }
        wire.push_str(&format!("{}\n{}\n{}\n{}\n", hex(&snapshot.candidate_identity),
            snapshot.roster.threshold,
            snapshot.roster.members.iter().map(|(id, _)| u16::from(*id).to_string()).collect::<Vec<_>>().join(","),
            selected_ids(model).iter().map(|id| u16::from(*id).to_string()).collect::<Vec<_>>().join(",")));
        for (id, share) in &snapshot.roster.members {
            wire.push_str(&format!("{}:{}\n", u16::from(*id), hex(share)));
        }
        wire.push_str(&hex(&snapshot.roster.group)); wire.push('\n');
        if wire.len() > MAX_DESCRIPTOR_BYTES { return Err(GateError::WireLength); }
        let mut digest = Sha256::new(); digest.update(DESCRIPTOR_DOMAIN); digest.update(wire.as_bytes());
        Ok(Self { wire, identity: digest.finalize().into() })
    }
    pub(super) fn wire(&self) -> &str { &self.wire }
    pub(super) fn identity(&self) -> [u8; 32] { self.identity }
}

// Only an existing pair of actual sealed owners can produce the exported descriptor.
pub(super) fn describe_pair(owners: &[ImageBoundUnapproved]) -> Result<Descriptor> {
    if owners.len() != 2 { return Err(GateError::Missing); }
    let (first, second) = (&owners[0], &owners[1]);
    if first._model != second._model || first._candidate.bytes != second._candidate.bytes {
        return Err(GateError::ModelBinding);
    }
    for owner in owners {
        owner._candidate.check(&owner.snapshot.candidate_identity).map_err(|_| GateError::Candidate)?;
        let selected = selected_ids(&owner._model);
        if owner._remote.len() + 1 != selected.len() || owner._remote.contains_key(&owner.snapshot.local)
            || owner._remote.keys().any(|id| !selected.contains(id)) { return Err(GateError::Participant); }
    }
    compare_snapshots(&first._model, &first.snapshot, &second.snapshot)?;
    let descriptor = Descriptor::from_snapshot(&first._model, &first.snapshot)?;
    let other = Descriptor::from_snapshot(&second._model, &second.snapshot)?;
    if descriptor.wire != other.wire || descriptor.identity != other.identity { return Err(GateError::ModelBinding); }
    Ok(descriptor)
}

fn strict_lines(raw: &[u8], cap: usize, count: usize) -> Result<Vec<&str>> {
    if raw.is_empty() || raw.len() > cap || !raw.ends_with(b"\n")
        || !raw.iter().all(|b| *b == b'\n' || b.is_ascii_graphic()) { return Err(GateError::WireLength); }
    let text = std::str::from_utf8(raw).map_err(|_| GateError::Canonical)?;
    let lines = text[..text.len()-1].split('\n').collect::<Vec<_>>();
    if lines.len() != count || lines.iter().any(|line| line.is_empty()) { return Err(GateError::Canonical); }
    Ok(lines)
}
fn read_hex(value: &str, cap: usize) -> Result<Vec<u8>> {
    if value.is_empty() || value.len() % 2 != 0 || value.len()/2 > cap
        || !value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { return Err(GateError::Canonical); }
    value.as_bytes().chunks_exact(2).map(|pair| u8::from_str_radix(std::str::from_utf8(pair)
        .map_err(|_| GateError::Canonical)?, 16).map_err(|_| GateError::Canonical)).collect()
}
pub(super) fn digest_hex(value: &str) -> Result<[u8; 32]> {
    read_hex(value, 32)?.try_into().map_err(|_| GateError::Canonical)
}
fn uint(value: &str, positive: bool) -> Result<u64> {
    let n = decimal(value).map_err(|_| GateError::Canonical)?;
    if positive && n == 0 { return Err(GateError::Canonical); } Ok(n)
}
pub(super) fn sha(bytes: &[u8]) -> [u8; 32] { Sha256::digest(bytes).into() }
fn descriptor_digest(bytes: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new(); h.update(DESCRIPTOR_DOMAIN); h.update(bytes); h.finalize().into()
}
fn check_preparation(raw: &[u8]) -> Result<Vec<&str>> {
    let fields = strict_lines(raw, 8192, 11)?;
    if fields[0] != "W1HDP1" && fields[0] != "W1PSP1" { return Err(GateError::Canonical); }
    for index in [1, 6, 7] { uint(fields[index], true)?; }
    for index in [3, 4, 5, 8, 9, 10] { digest_hex(fields[index])?; }
    let request = Request::decode(&read_hex(fields[2], MAX_REQUEST_BYTES)?).map_err(|_| GateError::Candidate)?;
    if request.network != Network::Testnet || MoneroAddress::from_str(Network::Testnet, &request.address)
        .map_err(|_| GateError::Candidate)?.to_string() != request.address { return Err(GateError::Candidate); }
    Ok(fields)
}

// Only typed sealed owners create an expectation. Decoding it is recovery data,
// never a means to restore native machines or issue new signing authority.
pub(super) struct Expectation { preparation: Vec<u8>, descriptor: Vec<u8>, candidate: Vec<u8>, inputs: Vec<VerificationInput> }
impl Expectation {
    pub(super) fn from_owners(owners: &[ImageBoundUnapproved], preparation: Vec<u8>) -> Result<Self> {
        let descriptor = describe_pair(owners)?;
        let fields = check_preparation(&preparation)?;
        if fields[0] != "W1HDP1" { return Err(GateError::Canonical); }
        if digest_hex(fields[9])? != descriptor.identity() { return Err(GateError::ModelBinding); }
        let inputs = owners[0].snapshot.inputs.iter().map(|input| VerificationInput {
            image: input.image, offsets: input.offsets.clone(), ring: input.ring.clone() }).collect();
        let result = Self { preparation, descriptor: descriptor.wire().as_bytes().to_vec(),
            candidate: owners[0]._candidate.bytes.to_vec(), inputs };
        result.check()?;
        Ok(result)
    }
    fn binding(&self) -> Result<[u8; 32]> { digest_hex(check_preparation(&self.preparation)?[10]) }
    fn check(&self) -> Result<()> {
        let prep = check_preparation(&self.preparation)?;
        let d = strict_lines(&self.descriptor, MAX_DESCRIPTOR_BYTES, 15)?;
        if d[0] != "WMAD1" || d[7] != "2" || d[8] != "1,2,3,4" || d[9] != "1,2"
            || descriptor_digest(&self.descriptor) != digest_hex(prep[9])? { return Err(GateError::ModelBinding); }
        for value in &d[1..7] { digest_hex(value)?; }
        for (i, row) in d[10..14].iter().enumerate() {
            let (id, point) = row.split_once(':').ok_or(GateError::Canonical)?;
            if uint(id, true)? != i as u64 + 1 { return Err(GateError::Subset); }
            let raw = digest_hex(point)?;
            Ed25519::read_G(&mut raw.as_slice()).map_err(|_| GateError::Canonical)?;
        }
        let group = digest_hex(d[14])?;
        Ed25519::read_G(&mut group.as_slice()).map_err(|_| GateError::Canonical)?;
        let decoded = crate::candidate::decode(&self.candidate).map_err(|_| GateError::Candidate)?;
        let request = Request::decode(&read_hex(prep[2], MAX_REQUEST_BYTES)?).map_err(|_| GateError::Candidate)?;
        if prep[0] == "W1PSP1" {
            if digest_hex(d[1])? != digest_hex(prep[3])? || digest_hex(d[2])? != digest_hex(prep[4])?
                || digest_hex(d[3])? != digest_hex(prep[5])? || digest_hex(d[4])? != digest_hex(prep[8])?
                || digest_hex(prep[5])? != digest_hex(prep[10])? { return Err(GateError::ModelBinding); }
        } else if digest_hex(d[1])? != [0x11;32] { return Err(GateError::ModelBinding); }
        if decoded.owner != digest_hex(d[5])?
            || self.candidate[39..71] != digest_hex(&request.event_id)?
            || self.candidate[71..103] != digest_hex(&request.instruction_digest)?
            || self.candidate[103..135] != digest_hex(&request.request_digest)?
            || self.inputs.len() != 2 || decoded.tx.prefix().inputs.len() != 2 { return Err(GateError::Candidate); }
        for (actual, expected) in decoded.tx.prefix().inputs.iter().zip(&self.inputs) {
            if expected.offsets.len() != 16 || expected.ring.len() != 16
                || !matches!(actual, Input::ToKey { amount: None, key_image, key_offsets }
                    if *key_image == expected.image && *key_offsets == expected.offsets) { return Err(GateError::Inputs); }
            let mut position = 0u64;
            for (i, offset) in expected.offsets.iter().enumerate() {
                if i > 0 && *offset == 0 { return Err(GateError::Inputs); }
                position = position.checked_add(*offset).ok_or(GateError::Inputs)?;
            }
            if expected.image.decompress().and_then(|p| p.key_image()).is_none() { return Err(GateError::FinalImage); }
            for pair in &expected.ring { for point in pair { if point.decompress().is_none() { return Err(GateError::Inputs); } } }
        }
        if self.inputs[0].image <= self.inputs[1].image { return Err(GateError::Inputs); }
        Ok(())
    }
    fn wire(&self) -> Result<Vec<u8>> {
        self.check()?;
        let tag = if check_preparation(&self.preparation)?[0] == "W1PSP1" { "WMEX2" } else { "WMEX1" };
        let mut wire = format!("{}\n{}\n{}\n{}\n2\n", tag, hex(&self.preparation), hex(&self.descriptor), hex(&self.candidate));
        for input in &self.inputs {
            wire.push_str(&format!("{}\n{}\n", hex(&input.image.to_bytes()), input.offsets.iter().map(u64::to_string).collect::<Vec<_>>().join(",")));
            for pair in &input.ring { wire.push_str(&format!("{}:{}\n", hex(&pair[0].to_bytes()), hex(&pair[1].to_bytes()))); }
        }
        wire.push_str("END\n");
        if wire.len() > MAX_EXPECTATION { return Err(GateError::WireLength); } Ok(wire.into_bytes())
    }
    fn decode(raw: &[u8]) -> Result<Self> {
        let lines = strict_lines(raw, MAX_EXPECTATION, 42)?;
        if !matches!(lines[0],"WMEX1"|"WMEX2") || lines[4] != "2" || lines[41] != "END" { return Err(GateError::Canonical); }
        let mut inputs = Vec::with_capacity(2);
        for start in [5, 23] {
            let offsets = lines[start+1].split(',').collect::<Vec<_>>();
            if offsets.len() != 16 { return Err(GateError::Inputs); }
            let offsets = offsets.into_iter().map(|value| uint(value, false)).collect::<Result<Vec<_>>>()?;
            let mut ring = Vec::with_capacity(16);
            for row in &lines[start+2..start+18] {
                let (key, commitment) = row.split_once(':').ok_or(GateError::Canonical)?;
                ring.push([CompressedPoint::from(digest_hex(key)?), CompressedPoint::from(digest_hex(commitment)?)]);
            }
            inputs.push(VerificationInput { image: CompressedPoint::from(digest_hex(lines[start])?), offsets, ring });
        }
        let result = Self { preparation: read_hex(lines[1], 8192)?, descriptor: read_hex(lines[2], MAX_DESCRIPTOR_BYTES)?,
            candidate: read_hex(lines[3], crate::candidate::MAX_FRAME)?, inputs };
        if result.wire()?.as_slice() != raw { return Err(GateError::Canonical); } Ok(result)
    }
    fn verify_final(&self, bytes: Vec<u8>) -> Result<VerifiedFinal> {
        self.check()?;
        let original = crate::candidate::decode(&self.candidate).map_err(|_| GateError::Candidate)?;
        // Current-profile signatures are appended after the already bounded original
        // body: two ring16 CLSAGs (576 each) and two pseudo-outs (32 each).
        if bytes.len() > MAX_FINAL || bytes.len() != original.body.len() + 2*608
            || !bytes.starts_with(&original.body) { return Err(GateError::Candidate); }
        let mut reader = bytes.as_slice();
        let tx = Transaction::read(&mut reader).map_err(|_| GateError::NativeDecode)?;
        if !reader.is_empty() || tx.serialize() != bytes || tx.signature_hash() != Some(original.message) {
            return Err(GateError::Canonical);
        }
        verify_clsags(&tx, &self.inputs, &original.message)?;
        let mut stripped = tx.clone();
        if let Transaction::V2 { proofs: Some(RctProofs { prunable: RctPrunable::Clsag { clsags, pseudo_outs, .. }, .. }), .. } = &mut stripped {
            clsags.clear(); pseudo_outs.clear();
        } else { return Err(GateError::Candidate); }
        if stripped.serialize() != original.body { return Err(GateError::Candidate); }
        Ok(VerifiedFinal { txid: tx.hash(), digest: sha(&bytes), bytes })
    }
}
struct VerifiedFinal { bytes: Vec<u8>, txid: [u8; 32], digest: [u8; 32] }

#[cfg(feature="participant-host")]
pub(super) fn describe_single(owner:&ImageBoundUnapproved)->Result<Descriptor>{
    owner._candidate.check(&owner.snapshot.candidate_identity).map_err(|_|GateError::Candidate)?;
    validate_members(&owner._model,&owner.snapshot)?;
    let selected=selected_ids(&owner._model);
    if selected!=vec![Participant::new(1).unwrap(),Participant::new(2).unwrap()]
        || owner._remote.len()!=1 || owner._remote.contains_key(&owner.snapshot.local)
        || owner._remote.keys().any(|id|!selected.contains(id)) {return Err(GateError::Participant)}
    if owner.snapshot.roster.threshold!=2||owner.snapshot.roster.members.len()!=4
        || owner.trace.constructs.load(Ordering::SeqCst)!=1||owner.trace.restores.load(Ordering::SeqCst)!=1
        || owner.trace.preprocesses.load(Ordering::SeqCst)!=1||owner.trace.seals.load(Ordering::SeqCst)!=1
        || owner.trace.wallet_signs.load(Ordering::SeqCst)!=0{return Err(GateError::ModelBinding)}
    Descriptor::from_snapshot(&owner._model,&owner.snapshot)
}
#[cfg(feature="participant-host")]
impl Expectation {
    pub(super) fn from_single(owner:&ImageBoundUnapproved,preparation:Vec<u8>)->Result<Self>{
        let descriptor=describe_single(owner)?;let fields=check_preparation(&preparation)?;
        if fields[0]!="W1PSP1"||digest_hex(fields[9])?!=descriptor.identity(){return Err(GateError::ModelBinding)}
        let result=Self{preparation,descriptor:descriptor.wire().as_bytes().to_vec(),candidate:owner._candidate.bytes.to_vec(),
            inputs:owner.snapshot.inputs.iter().map(|i|VerificationInput{image:i.image,offsets:i.offsets.clone(),ring:i.ring.clone()}).collect()};
        result.check()?;Ok(result)
    }
}
#[cfg(feature="participant-host")]
fn check_signing_single(owner:&ImageBoundUnapproved,expectation:&Expectation)->Result<()> {
    let descriptor=describe_single(owner)?;expectation.check()?;
    if descriptor.wire().as_bytes()!=expectation.descriptor||owner._candidate.bytes.as_ref()!=expectation.candidate||owner.snapshot.inputs!=expectation.inputs{return Err(GateError::ModelBinding)}Ok(())
}
#[cfg(feature="participant-host")]
fn sign_single(owner:ImageBoundUnapproved,expectation:&Expectation,approval:super::participant_signing::VerifiedApproval)
    ->Result<(monero_wallet::send::TransactionSignatureMachine,Zeroizing<Vec<u8>>)> {
    check_signing_single(&owner,expectation)?;
    if !approval.matches(describe_single(&owner)?.identity(),sha(&expectation.wire()?)){return Err(GateError::ModelBinding)}
    bump(&owner.trace.wallet_signs);eprintln!("participant:wallet-sign-entry");
    let (machine,share)=owner._machine.sign(owner._remote,&[]).map_err(|_|GateError::NativeConstruction)?;
    let wire=Zeroizing::new(share.serialize());if wire.len()!=64{return Err(GateError::WireLength)}
    Ok((machine,wire))
}

fn verify_clsags(tx: &Transaction, inputs: &[VerificationInput], original_message: &[u8; 32]) -> Result<()> {
    let Transaction::V2 { prefix, proofs: Some(proofs) } = tx else { return Err(GateError::Candidate); };
    let RctPrunable::Clsag { bulletproof: Bulletproof::Plus(_), clsags, pseudo_outs } = &proofs.prunable else { return Err(GateError::Candidate); };
    if inputs.len() != 2 || prefix.inputs.len() != 2 || clsags.len() != 2 || pseudo_outs.len() != 2
        || !proofs.base.pseudo_outs.is_empty() { return Err(GateError::Inputs); }
    for (n, expected) in inputs.iter().enumerate() {
        if !matches!(&prefix.inputs[n], Input::ToKey { amount: None, key_image, key_offsets }
            if *key_image == expected.image && *key_offsets == expected.offsets) { return Err(GateError::Inputs); }
        clsags[n].verify(expected.ring.clone(), &expected.image, &pseudo_outs[n], original_message).map_err(|_| GateError::FinalImage)?;
    }
    Ok(())
}

fn check_signing_pair(owners: &[ImageBoundUnapproved], expectation: &Expectation) -> Result<()> {
    let descriptor = describe_pair(owners)?;
    expectation.check()?;
    if descriptor.wire().as_bytes() != expectation.descriptor || owners[0]._candidate.bytes.as_ref() != expectation.candidate
        || owners[0].snapshot.inputs != expectation.inputs { return Err(GateError::ModelBinding); }
    for owner in owners {
        if owner.snapshot.roster.threshold != 2 || owner.snapshot.roster.members.len() != 4
            || owner.trace.constructs.load(Ordering::SeqCst) != 1 || owner.trace.restores.load(Ordering::SeqCst) != 2
            || owner.trace.preprocesses.load(Ordering::SeqCst) != 2 || owner.trace.seals.load(Ordering::SeqCst) != 2
            || owner.trace.wallet_signs.load(Ordering::SeqCst) != 0 { return Err(GateError::ModelBinding); }
    }
    Ok(())
}
fn sign_pair(owners: Vec<ImageBoundUnapproved>, expectation: &Expectation) -> Result<VerifiedFinal> {
    // This consuming closure drops all original holders and all intermediate
    // signature machines on every outcome before reporting retirement.
    let result = (move || {
        check_signing_pair(&owners, expectation)?;
        let trace = owners[0].trace.clone();
        let mut finals = Vec::with_capacity(2); let mut shares = HashMap::new();
        for owner in owners {
            let id = owner.snapshot.local;
            bump(&trace.wallet_signs); eprintln!("host:wallet-sign-entry");
            let (machine, share) = owner._machine.sign(owner._remote, &[]).map_err(|_| GateError::NativeConstruction)?;
            let wire = Zeroizing::new(share.serialize());
            if wire.len() != 64 { return Err(GateError::WireLength); }
            shares.insert(id, wire); finals.push((id, machine));
        }
        if trace.wallet_signs.load(Ordering::SeqCst) != 2 { return Err(GateError::ModelBinding); }
        eprintln!("host:wallet-sign-two");
        let mut completed: Option<Vec<u8>> = None;
        for (local, machine) in finals {
            let mut received = HashMap::new();
            for (id, wire) in &shares {
                if *id == local { continue; }
                let mut reader = wire.as_slice();
                let share = machine.read_share(&mut reader).map_err(|_| GateError::NativeDecode)?;
                if !reader.is_empty() || share.serialize() != **wire { return Err(GateError::Canonical); }
                received.insert(*id, share);
            }
            let tx = machine.complete(received).map_err(|_| GateError::NativeConstruction)?;
            let bytes = tx.serialize();
            if completed.as_ref().is_some_and(|prior| *prior != bytes) { return Err(GateError::Candidate); }
            completed = Some(bytes);
        }
        let verified = expectation.verify_final(completed.ok_or(GateError::Missing)?)?;
        eprintln!("host:final-verified"); Ok(verified)
    })();
    eprintln!("host:retired"); result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn id(n: u16) -> Participant { Participant::new(n).unwrap() }
    fn model() -> ModelBinding { ModelBinding { context: [[1; 32], [2; 32], [3; 32], [4; 32], [5; 32]], subset: vec![id(1), id(2)] } }
    fn snapshot(local: u16) -> SealedSnapshot {
        SealedSnapshot { local: id(local), candidate_identity: [6; 32],
            roster: OriginalRoster { threshold: 2, members: (1..=4).map(|i| (id(i), [i as u8 + 10; 32])).collect(), group: [7; 32] },
            inputs: vec![VerificationInput { image: CompressedPoint::from([8; 32]), offsets: vec![1; 16],
                ring: vec![[CompressedPoint::from([9; 32]), CompressedPoint::from([10; 32])]; 16] }] }
    }
    #[test]
    fn descriptor_schema_and_domain_bind_every_public_field() {
        let model = model();
        let original = Descriptor::from_snapshot(&model, &snapshot(1)).unwrap();
        let lines = original.wire().lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 15); assert_eq!(lines[0], "WMAD1");
        for i in 0..5 { assert_eq!(lines[i+1], hex(&model.context[i])); }
        assert_eq!(lines[6], hex(&[6; 32])); assert_eq!(lines[7], "2");
        assert_eq!(lines[8], "1,2,3,4"); assert_eq!(lines[9], "1,2");
        for i in 1..=4 { assert_eq!(lines[9+i], format!("{}:{}", i, hex(&[i as u8+10; 32]))); }
        assert_eq!(lines[14], hex(&[7; 32]));
        assert!(original.wire().ends_with('\n')); assert!(original.wire().len() <= MAX_DESCRIPTOR_BYTES);
        let mut digest = Sha256::new(); digest.update(DESCRIPTOR_DOMAIN); digest.update(original.wire());
        assert!(original.identity() == <[u8; 32]>::from(digest.finalize()));
        for field in 0..11 {
            let mut changed_model = model.clone(); let mut changed = snapshot(1);
            match field {
                0..=4 => changed_model.context[field][0] ^= 1,
                5 => changed.candidate_identity[0] ^= 1,
                6 => changed.roster.threshold = 1,
                7 => { changed.roster.members.pop(); },
                8 => changed_model.subset = vec![id(1), id(3)],
                9 => changed.roster.members[0].1[0] ^= 1,
                _ => changed.roster.group[0] ^= 1,
            }
            assert!(Descriptor::from_snapshot(&changed_model, &changed).unwrap().identity() != original.identity());
        }
    }
    #[test]
    fn descriptor_pair_rejects_foreign_local_candidate_roster_and_ring() {
        let model = model(); let first = snapshot(1);
        assert!(compare_snapshots(&model, &first, &snapshot(2)).is_ok());
        for field in 0..8 {
            let mut other = snapshot(2);
            match field {
                0 => other.local = id(1),
                1 => other.candidate_identity[0] ^= 1,
                2 => other.roster.threshold = 1,
                3 => other.roster.members[0].1[0] ^= 1,
                4 => other.roster.group[0] ^= 1,
                5 => other.inputs[0].image = CompressedPoint::from([20; 32]),
                6 => other.inputs[0].offsets[0] += 1,
                _ => other.inputs[0].ring[0][0] = CompressedPoint::from([21; 32]),
            }
            assert!(compare_snapshots(&model, &first, &other).is_err());
        }
        for selected in [vec![id(1)], vec![id(1), id(1)], vec![id(1), id(5)], vec![id(2), id(3)]] {
            let invalid = ModelBinding { subset: selected, ..model.clone() };
            assert!(Descriptor::from_snapshot(&invalid, &first).is_err());
        }
        let mut invalid = snapshot(1); invalid.roster.members.swap(0, 1);
        assert!(Descriptor::from_snapshot(&model, &invalid).is_err());
    }
    #[test]
    fn descriptor_roster_comes_from_both_actual_threshold_keys() {
        let keys = key_fixture::distributed_keys();
        let first = OriginalRoster::capture(&keys[&id(1)]).unwrap();
        let second = OriginalRoster::capture(&keys[&id(2)]).unwrap();
        assert!(first == second);
        assert_eq!(first.threshold, 2);
        assert_eq!(first.members.len(), 4);
        for (participant, share) in &first.members {
            assert!(*share == keys[participant].original_verification_share(*participant).to_bytes());
            assert!(first.group == keys[participant].original_group_key().to_bytes());
        }
        let mut a = snapshot(1); a.roster = first;
        let mut b = snapshot(2); b.roster = second;
        assert!(compare_snapshots(&model(), &a, &b).is_ok());
        assert!(Descriptor::from_snapshot(&model(), &a).unwrap().wire()
            == Descriptor::from_snapshot(&model(), &b).unwrap().wire());
    }
    fn private_test_dir(label: &str) -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("runtime/native-signing-unit");
        let path = root.join(format!("{}-{}", label, hex(&fresh())));
        std::fs::create_dir_all(&path).unwrap(); path
    }
    fn preparation_for(owners: &[ImageBoundUnapproved]) -> Vec<u8> {
        let receipt = owners[0].receipt.lines().collect::<Vec<_>>();
        let request = format!("WMNI1\n{}\n", receipt[1..9].join("\n"));
        let descriptor = describe_pair(owners).unwrap();
        format!("W1HDP1\n1\n{}\n{}\n{}\n{}\n2\n100000\n{}\n{}\n{}\n", hex(request.as_bytes()),
            hex(&[21; 32]), hex(&[22; 32]), hex(&[23; 32]), hex(&[24; 32]), hex(&descriptor.identity()), hex(&[25; 32])).into_bytes()
    }
    #[cfg(feature = "synthetic-host")]
    #[test]
    fn original_pair_signs_and_durable_recovery_reuses_exact_verified_bytes() {
        let directory = private_test_dir("positive");
        let owners = super::super::host::signing_test_fixture(&directory).unwrap();
        let trace = owners[0].trace.clone();
        let expectation = Expectation::from_owners(&owners, preparation_for(&owners)).unwrap();
        let original_wire = expectation.wire().unwrap();
        assert_eq!(strict_lines(&original_wire, MAX_EXPECTATION, 42).unwrap()[4], "2");
        let restored = Expectation::decode(&original_wire).unwrap();
        assert!(restored.wire().unwrap() == original_wire);
        // The exact common preflight used by sign_pair refuses M-1 while the
        // observed actual wallet boundary remains untouched.
        assert!(check_signing_pair(&owners[..1], &restored).is_err());
        let mut wrong_message = Expectation::decode(&original_wire).unwrap();
        let message_start = wrong_message.candidate.len()-64;
        wrong_message.candidate[message_start] ^= 1;
        assert!(check_signing_pair(&owners, &wrong_message).is_err());
        let mut wrong_rings = Expectation::decode(&original_wire).unwrap();
        let (first, second) = wrong_rings.inputs.split_at_mut(1);
        std::mem::swap(&mut first[0].ring, &mut second[0].ring);
        assert!(wrong_rings.check().is_ok());
        assert!(check_signing_pair(&owners, &wrong_rings).is_err());
        assert_eq!(trace.wallet_signs.load(Ordering::SeqCst), 0);
        let prepared = terminal::prepare(&directory, expectation).unwrap();
        let anchor = sha(&original_wire);
        let binding = restored.binding().unwrap();
        let ack = format!("W1HDS1\n{}\n{}\n", hex(&anchor), hex(&binding));
        assert_eq!(ack.len(), 137); assert_eq!(prepared.response().len(), 137);
        assert!(prepared.check_ack(ack.as_bytes()).is_ok());
        for bad in [ack.replace("W1HDS1", "W1HDP1"), ack.replace(&hex(&anchor), &hex(&[26; 32])),
            ack.replace(&hex(&binding), &hex(&[27; 32])), format!("{ack}X"), ack.replace('\n', "\r\n")] {
            assert!(prepared.check_ack(bad.as_bytes()).is_err());
        }
        assert_eq!(trace.wallet_signs.load(Ordering::SeqCst), 0);
        assert!(terminal::prepare(&directory, Expectation::decode(&original_wire).unwrap()).is_err());
        let committed = terminal::sign_and_commit(&directory, owners, prepared).unwrap();
        let response = committed.response().unwrap();
        let fields = strict_lines(response.as_bytes(), 32_768, 6).unwrap();
        assert_eq!(fields[0], "W1HDF1");
        let bytes = read_hex(fields[5], MAX_FINAL).unwrap();
        let tx = Transaction::read(&mut bytes.as_slice()).unwrap();
        let original = crate::candidate::decode(&restored.candidate).unwrap();
        let mut wrong = original.message; wrong[0] ^= 1;
        assert!(matches!(verify_clsags(&tx, &restored.inputs, &wrong), Err(GateError::FinalImage)));
        let mut swapped = Expectation::decode(&original_wire).unwrap();
        let (a, b) = swapped.inputs.split_at_mut(1);
        std::mem::swap(&mut a[0].ring, &mut b[0].ring);
        assert!(swapped.check().is_ok());
        assert!(matches!(swapped.verify_final(bytes.clone()), Err(GateError::FinalImage)));
        let mut trailing = bytes.clone(); trailing.push(0);
        assert!(restored.verify_final(trailing).is_err());
        let mut changed = bytes; changed[0] ^= 1;
        assert!(restored.verify_final(changed).is_err());
        assert_eq!(trace.constructs.load(Ordering::SeqCst), 1);
        assert_eq!(trace.restores.load(Ordering::SeqCst), 2);
        assert_eq!(trace.preprocesses.load(Ordering::SeqCst), 2);
        assert_eq!(trace.seals.load(Ordering::SeqCst), 2);
        assert_eq!(trace.wallet_signs.load(Ordering::SeqCst), 2);
        assert!(terminal::recover(&directory, anchor).unwrap().response().unwrap() == response);
        assert!(terminal::recover(&directory, [28; 32]).is_err());
        assert_eq!(trace.wallet_signs.load(Ordering::SeqCst), 2);
        // Partial/trailing/cross-binding terminal records never deliver. These
        // test-owned copies contain only bounded private runtime records.
        let terminal_bytes = std::fs::read(directory.join("terminal.private")).unwrap();
        // Alter a structurally valid producer-only association and recompute all
        // local record hashes. The original independent journal anchor still
        // refuses it, even though it is internally consistent and verifies the
        // same final transaction under a different supplied anchor.
        let altered_dir = private_test_dir("altered-anchor");
        let mut altered = Expectation::decode(&original_wire).unwrap();
        let mut descriptor_rows = strict_lines(&altered.descriptor, MAX_DESCRIPTOR_BYTES, 15).unwrap()
            .into_iter().map(str::to_owned).collect::<Vec<_>>();
        descriptor_rows[6] = hex(&[29; 32]);
        altered.descriptor = format!("{}\n", descriptor_rows.join("\n")).into_bytes();
        let mut preparation_rows = check_preparation(&altered.preparation).unwrap()
            .into_iter().map(str::to_owned).collect::<Vec<_>>();
        preparation_rows[9] = hex(&descriptor_digest(&altered.descriptor));
        altered.preparation = format!("{}\n", preparation_rows.join("\n")).into_bytes();
        let altered_wire = altered.wire().unwrap();
        let altered_anchor = sha(&altered_wire);
        assert!(altered_anchor != anchor);
        let mut terminal_rows = strict_lines(&terminal_bytes, 32_768, 7).unwrap()
            .into_iter().map(str::to_owned).collect::<Vec<_>>();
        terminal_rows[1] = hex(&altered_anchor);
        std::fs::write(altered_dir.join("expectation.private"), altered_wire).unwrap();
        std::fs::write(altered_dir.join("terminal.private"), format!("{}\n", terminal_rows.join("\n"))).unwrap();
        assert!(terminal::recover(&altered_dir, altered_anchor).is_ok());
        assert!(terminal::recover(&altered_dir, anchor).is_err());
        for case in 0..4 {
            let failure = private_test_dir("terminal-reject");
            std::fs::write(failure.join("expectation.private"), &original_wire).unwrap();
            let mut record = terminal_bytes.clone();
            match case {
                0 => record.truncate(record.len()/2),
                1 => { record.pop(); },
                2 => record.extend(b"X\n"),
                _ => record[6] = if record[6] == b'a' { b'b' } else { b'a' },
            }
            std::fs::write(failure.join("terminal.private"), record).unwrap();
            assert!(terminal::recover(&failure, anchor).is_err());
        }
        for cut in [0, 1, original_wire.len()-1] { assert!(Expectation::decode(&original_wire[..cut]).is_err()); }
        let mut oversized = original_wire; oversized.resize(MAX_EXPECTATION+1, b'a');
        assert!(Expectation::decode(&oversized).is_err());
    }
    #[cfg(feature = "synthetic-host")]
    #[test]
    fn terminal_operation_failures_cannot_produce_committed_final_or_reuse_owners() {
        use terminal::CommitStep;
        for failure in [CommitStep::Create, CommitStep::Write, CommitStep::Sync, CommitStep::Readback] {
            let directory = private_test_dir("terminal-io-failure");
            let owners = super::super::host::signing_test_fixture(&directory).unwrap();
            let trace = owners[0].trace.clone();
            let expectation = Expectation::from_owners(&owners, preparation_for(&owners)).unwrap();
            let original = expectation.wire().unwrap();
            let prepared = terminal::prepare(&directory, expectation).unwrap();
            let mut reached = false;
            // The owned actual pair and prepared capability are consumed even
            // when this operation refuses. Err exposes no CommittedFinal/F1.
            let result = terminal::sign_and_commit_with_gate(&directory, owners, prepared, |step| {
                if step == failure { reached = true; Err(GateError::Custody) } else { Ok(()) }
            });
            assert!(reached); assert!(result.is_err());
            assert_eq!(trace.wallet_signs.load(Ordering::SeqCst), if failure == CommitStep::Create { 0 } else { 2 });
            assert_eq!(trace.constructs.load(Ordering::SeqCst), 1);
            assert_eq!(trace.preprocesses.load(Ordering::SeqCst), 2);
            assert_eq!(trace.seals.load(Ordering::SeqCst), 2);
            assert!(terminal::prepare(&directory, Expectation::decode(&original).unwrap()).is_err());
            let recover = terminal::recover(&directory, sha(&original));
            // Before write no complete terminal exists. After write recovery may
            // freshly validate and sync it, but the failed live call never emits.
            if matches!(failure, CommitStep::Create | CommitStep::Write) { assert!(recover.is_err()); }
            else { assert!(recover.is_ok()); }
            assert_eq!(trace.wallet_signs.load(Ordering::SeqCst), if failure == CommitStep::Create { 0 } else { 2 });
        }
    }
}
