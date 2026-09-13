//! Private expectation/terminal custody. Recovery never constructs or signs.
use super::*;
use std::{fs::{File, OpenOptions}, io::{Read, Write}, path::Path};

const MAX_TERMINAL: usize = 32_768;
const EXPECTATION_FILE: &str = "expectation.private";
const TERMINAL_FILE: &str = "terminal.private";

fn load(file: &mut File, cap: usize) -> Result<Vec<u8>> {
    if file.metadata().map_err(|_| GateError::Custody)?.len() > cap as u64 { return Err(GateError::WireLength); }
    let mut bytes = Vec::new();
    file.take((cap+1) as u64).read_to_end(&mut bytes).map_err(|_| GateError::Custody)?;
    if bytes.len() > cap { return Err(GateError::WireLength); } Ok(bytes)
}
fn read_path(path: &Path, cap: usize) -> Result<Vec<u8>> {
    load(&mut File::open(path).map_err(|_| GateError::Custody)?, cap)
}
fn sync(file: &File) -> Result<()> { file.sync_all().map_err(|_| GateError::Custody) }

// No public constructor or Clone: only successful durable preparation produces it.
pub(in crate::common_owner) struct PreparedExpectation { expectation: Expectation, digest: [u8; 32], binding: [u8; 32] }
impl PreparedExpectation {
    #[cfg(feature="participant-host")]
    pub(in crate::common_owner) fn digest(&self)->[u8;32]{self.digest}
    pub(in crate::common_owner) fn response(&self) -> String {
        format!("W1HDE1\n{}\n{}\n", hex(&self.digest), hex(&self.binding))
    }
    pub(in crate::common_owner) fn check_ack(&self, bytes: &[u8]) -> Result<()> {
        let fields = strict_lines(bytes, 137, 3)?;
        if fields[0] != "W1HDS1" || digest_hex(fields[1])? != self.digest || digest_hex(fields[2])? != self.binding {
            return Err(GateError::ModelBinding);
        }
        Ok(())
    }
}

#[cfg(feature="participant-host")]
pub(in crate::common_owner) struct PendingSingle {
    machine:monero_wallet::send::TransactionSignatureMachine,
    prepared:PreparedExpectation, remote:Participant,
}
#[cfg(feature="participant-host")]
pub(in crate::common_owner) fn begin_single(directory:&Path,owner:ImageBoundUnapproved,prepared:PreparedExpectation,
    approval:super::super::participant_signing::VerifiedApproval)->Result<(PendingSingle,Zeroizing<Vec<u8>>)> {
    let persisted=read_path(&directory.join(EXPECTATION_FILE),MAX_EXPECTATION)?;
    if sha(&persisted)!=prepared.digest||persisted!=prepared.expectation.wire()?{return Err(GateError::Custody)}
    check_signing_single(&owner,&prepared.expectation)?;
    let remote=*owner._remote.keys().next().ok_or(GateError::Missing)?;
    // Durable create-new marker consumes the session before the irreversible
    // nonce-machine transition. No restart constructor accepts this directory.
    let marker=format!("WMCON1\n{}\n{}\n",hex(&prepared.digest),hex(&prepared.binding)).into_bytes();
    let path=directory.join("consumed.private");
    let mut file=OpenOptions::new().write(true).create_new(true).open(&path).map_err(|_|GateError::Custody)?;
    file.write_all(&marker).map_err(|_|GateError::Custody)?;sync(&file)?;
    if read_path(&path,256)?!=marker{return Err(GateError::Custody)}
    let (machine,share)=sign_single(owner,&prepared.expectation,approval)?;
    Ok((PendingSingle{machine,prepared,remote},share))
}
#[cfg(feature="participant-host")]
pub(in crate::common_owner) fn finish_single(directory:&Path,pending:PendingSingle,raw:&[u8])->Result<CommittedFinal>{
    if raw.len()!=64{return Err(GateError::WireLength)}
    let mut reader=raw;
    let share=pending.machine.read_share(&mut reader).map_err(|_|GateError::NativeDecode)?;
    if !reader.is_empty()||share.serialize()!=raw{return Err(GateError::Canonical)}
    let tx=pending.machine.complete(HashMap::from([(pending.remote,share)])).map_err(|_|GateError::NativeConstruction)?;
    let verified=pending.prepared.expectation.verify_final(tx.serialize())?;
    let record=terminal_wire(&pending.prepared,&verified)?;let path=directory.join(TERMINAL_FILE);
    let mut file=OpenOptions::new().write(true).create_new(true).open(&path).map_err(|_|GateError::Custody)?;
    file.write_all(&record).map_err(|_|GateError::Custody)?;sync(&file)?;
    let readback=read_path(&path,MAX_TERMINAL)?;
    if readback!=record{return Err(GateError::Custody)}
    let verified=decode_terminal(&readback,&pending.prepared)?;
    eprintln!("participant:terminal-committed");
    Ok(CommittedFinal{prepared:pending.prepared,verified})
}
pub(in crate::common_owner) fn prepare(directory: &Path, expectation: Expectation) -> Result<PreparedExpectation> {
    let bytes = expectation.wire()?;
    let digest = sha(&bytes); let binding = expectation.binding()?;
    let path = directory.join(EXPECTATION_FILE);
    let mut file = OpenOptions::new().write(true).create_new(true).open(&path).map_err(|_| GateError::Custody)?;
    file.write_all(&bytes).map_err(|_| GateError::Custody)?; sync(&file)?;
    let readback = read_path(&path, MAX_EXPECTATION)?;
    if readback != bytes || sha(&readback) != digest { return Err(GateError::Custody); }
    Expectation::decode(&readback)?;
    eprintln!("host:expectation-committed");
    Ok(PreparedExpectation { expectation, digest, binding })
}

// Raw verified bytes cannot reach host stdout: only this committed type exposes
// the final protocol frame, and only durable commit/recovery construct it.
pub(in crate::common_owner) struct CommittedFinal { prepared: PreparedExpectation, verified: VerifiedFinal }
impl CommittedFinal {
    #[cfg(feature="participant-host")]
    pub(in crate::common_owner) fn observation_data(&self)->Result<(Request,Vec<u8>)>{
        let fields=check_preparation(&self.prepared.expectation.preparation)?;
        let request=Request::decode(&read_hex(fields[2],MAX_REQUEST_BYTES)?).map_err(|_|GateError::Candidate)?;
        Ok((request,self.verified.bytes.clone()))
    }
    pub(in crate::common_owner) fn response(&self) -> Result<String> {
        let value = format!("W1HDF1\n{}\n{}\n{}\n{}\n{}\n", hex(&self.prepared.digest),
            hex(&self.prepared.binding), hex(&self.verified.txid), hex(&self.verified.digest), hex(&self.verified.bytes));
        if value.len() > MAX_TERMINAL { return Err(GateError::WireLength); } Ok(value)
    }
}
fn terminal_wire(prepared: &PreparedExpectation, verified: &VerifiedFinal) -> Result<Vec<u8>> {
    let wire = format!("WMTX1\n{}\n{}\n{}\n{}\n{}\nEND\n", hex(&prepared.digest),
        hex(&prepared.binding), hex(&verified.txid), hex(&verified.digest), hex(&verified.bytes)).into_bytes();
    if wire.len() > MAX_TERMINAL { return Err(GateError::WireLength); } Ok(wire)
}
fn decode_terminal(bytes: &[u8], prepared: &PreparedExpectation) -> Result<VerifiedFinal> {
    let fields = strict_lines(bytes, MAX_TERMINAL, 7)?;
    if fields[0] != "WMTX1" || fields[6] != "END" || digest_hex(fields[1])? != prepared.digest
        || digest_hex(fields[2])? != prepared.binding { return Err(GateError::Custody); }
    let verified = prepared.expectation.verify_final(read_hex(fields[5], MAX_FINAL)?)?;
    if digest_hex(fields[3])? != verified.txid || digest_hex(fields[4])? != verified.digest
        || terminal_wire(prepared, &verified)?.as_slice() != bytes { return Err(GateError::Custody); }
    Ok(verified)
}

pub(in crate::common_owner) fn sign_and_commit(directory: &Path, owners: Vec<ImageBoundUnapproved>, prepared: PreparedExpectation) -> Result<CommittedFinal> {
    sign_and_commit_with_gate(directory, owners, prepared, |_| Ok(()))
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum CommitStep { Create, Write, Sync, Readback }
// A private operation boundary permits deciding failure tests without replacing
// the actual signing machines or the filesystem's successful operations.
pub(super) fn sign_and_commit_with_gate(directory: &Path, owners: Vec<ImageBoundUnapproved>, prepared: PreparedExpectation,
    mut before: impl FnMut(CommitStep) -> Result<()>) -> Result<CommittedFinal> {
    let mut remaining = Some(owners);
    let result = (|| {
    let persisted = read_path(&directory.join(EXPECTATION_FILE), MAX_EXPECTATION)?;
    if sha(&persisted) != prepared.digest || persisted != prepared.expectation.wire()? { return Err(GateError::Custody); }
    Expectation::decode(&persisted)?;
    check_signing_pair(remaining.as_ref().ok_or(GateError::Missing)?, &prepared.expectation)?;
    // Reserve the immutable terminal filename before entering either wallet. A
    // failure cannot overwrite an existing result or consume another nonce pair.
    let path = directory.join(TERMINAL_FILE);
    before(CommitStep::Create)?;
    let mut file = OpenOptions::new().write(true).create_new(true).open(&path).map_err(|_| GateError::Custody)?;
    let verified = sign_pair(remaining.take().ok_or(GateError::Missing)?, &prepared.expectation)?;
    let record = terminal_wire(&prepared, &verified)?;
    before(CommitStep::Write)?;
    file.write_all(&record).map_err(|_| GateError::Custody)?;
    before(CommitStep::Sync)?; sync(&file)?;
    before(CommitStep::Readback)?;
    let readback = read_path(&path, MAX_TERMINAL)?;
    if readback != record { return Err(GateError::Custody); }
    let checked = decode_terminal(&readback, &prepared)?;
    if checked.bytes != verified.bytes { return Err(GateError::Custody); }
    eprintln!("host:terminal-committed");
    Ok(CommittedFinal { prepared, verified })
    })();
    if let Some(owners) = remaining { drop(owners); eprintln!("host:retired"); }
    result
}

pub(in crate::common_owner) fn recover(directory: &Path, expected: [u8; 32]) -> Result<CommittedFinal> {
    // Write-capable handles are needed for Windows FlushFileBuffers. Recovery
    // never writes or replaces either immutable record, nor accepts their own
    // echoed digests as the independent journal anchor.
    let mut expectation_file = OpenOptions::new().read(true).write(true).open(directory.join(EXPECTATION_FILE)).map_err(|_| GateError::Custody)?;
    let bytes = load(&mut expectation_file, MAX_EXPECTATION)?;
    if sha(&bytes) != expected { return Err(GateError::Custody); }
    // The independent journal digest authenticates the producer's association
    // between candidate_identity, private candidate semantics and the actual
    // sealed verification state. Recovery cannot rederive that private semantic
    // identity. It freshly checks public owner/request/context links, canonical
    // original body/message, and every CLSAG using this authenticated state.
    let expectation = Expectation::decode(&bytes)?; let binding = expectation.binding()?;
    let prepared = PreparedExpectation { expectation, digest: expected, binding };
    let mut terminal_file = OpenOptions::new().read(true).write(true).open(directory.join(TERMINAL_FILE)).map_err(|_| GateError::Custody)?;
    let bytes = load(&mut terminal_file, MAX_TERMINAL)?;
    let verified = decode_terminal(&bytes, &prepared)?;
    sync(&expectation_file)?; sync(&terminal_file)?;
    eprintln!("host:recovery-verified-durable");
    Ok(CommittedFinal { prepared, verified })
}
