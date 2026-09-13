//! LOCAL SYNTHETIC PLAINTEXT TEST keeper. No production custody or signing API.
use super::*;
use sha2::{Digest, Sha256};
use std::{fs::{File, OpenOptions}, io::{Read, Write}, path::Path};

const MAX: usize = 1_048_576;
fn field(out: &mut Vec<u8>, bytes: &[u8]) { out.extend_from_slice(&(bytes.len() as u32).to_le_bytes()); out.extend_from_slice(bytes); }
fn take<'a>(r: &mut &'a [u8]) -> Result<&'a [u8], ()> {
    if r.len() < 4 { return Err(()); }
    let n = u32::from_le_bytes(r[..4].try_into().map_err(|_| ())?) as usize;
    *r = &r[4..]; if n > r.len() { return Err(()); }
    let result = &r[..n]; *r = &r[n..]; Ok(result)
}
fn semantic(req: &Request) -> String {
    format!("{}\n{}\n{}\n{}\n{}\n{}\n{}\n", req.event_id, req.instruction_digest,
        req.request_digest, network_name(req.network), req.address, req.amount, req.max_miner_fee)
}
fn valid_id(s: &str) -> bool { s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }
fn load(path: &Path) -> Result<Zeroizing<Vec<u8>>, ()> {
    let mut bytes = Zeroizing::new(Vec::new());
    File::open(path).map_err(|_| ())?.take((MAX+1) as u64).read_to_end(&mut bytes).map_err(|_| ())?;
    if bytes.len() > MAX { return Err(()); } Ok(bytes)
}
/// Trusted digest arrives independently over the supervisor's private pipe.
pub fn restore(path: &Path, trusted: &[u8;32], id: &str, binding: &str, request: Request,
    selection: &str, inputs: Vec<PreparedInput>, vault: ViewPair, per_weight: u64, mask: u64) -> Result<String, ()> {
    Ok(restore_owned(path, trusted, id, binding, request, selection, inputs, vault, per_weight, mask)?.receipt().to_wire())
}
// Private adapter return: the exact decoded object survives every original keeper check.
pub(super) fn restore_owned(path: &Path, trusted: &[u8;32], id: &str, binding: &str, request: Request,
    selection: &str, inputs: Vec<PreparedInput>, vault: ViewPair, per_weight: u64, mask: u64) -> Result<UnapprovedNativeIntent, ()> {
    if !valid_id(id) || !valid_id(binding) { return Err(()); }
    let bytes = load(path)?;
    if Sha256::digest(&*bytes).as_slice() != trusted { return Err(()); }
    let mut r = bytes.as_slice();
    if take(&mut r)? != b"W1F-SYNTHETIC-PRIVATE-1" || take(&mut r)? != id.as_bytes()
       || take(&mut r)? != binding.as_bytes() || take(&mut r)? != semantic(&request).as_bytes()
       || take(&mut r)? != selection.as_bytes() { return Err(()); }
    let serialized = take(&mut r)?;
    if !r.is_empty() { return Err(()); }
    bound_inputs(&inputs, &vault).map_err(|_| ())?;
    let expected: Vec<_> = inputs.into_iter().map(|p| p.ring).collect();
    let fee_rate = FeeRate::new(per_weight, mask).ok_or(())?;
    // Bound every vector/schema before the published generic wallet decoder.
    // The supplied digest is authenticated against supervisor memory above.
    let actual = native_projection(serialized, &request, &expected, &vault, fee_rate).map_err(|_| ())?;
    let mut reader = serialized;
    let native = SignableTransaction::read(&mut reader).map_err(|_| ())?;
    if !reader.is_empty() { return Err(()); }
    private_round_trip(&native, serialized).map_err(|_| ())?;
    let fee = native.necessary_fee();
    if fee > request.max_miner_fee { return Err(()); }
    let receipt = Receipt { challenge: request.challenge, event_id: request.event_id,
        instruction_digest: request.instruction_digest, request_digest: request.request_digest,
        network: actual.network, recipient: actual.recipient, amount: actual.amount,
        ceiling: request.max_miner_fee, fee, input_count: actual.input_count };
    Ok(UnapprovedNativeIntent { _native: native, receipt })
}
/// The owning filename is opened before invoking native construction. Partial objects
/// are terminal failures under this identity, never overwritten or regenerated.
pub fn create(path: &Path, journal: &Path, id: &str, binding: &str, request: Request,
    selection: &str, inputs: Vec<PreparedInput>, vault: ViewPair, seed: Zeroizing<[u8;32]>) -> Result<String, ()> {
    Ok(create_pinned(path, journal, id, binding, request, selection, inputs, vault, seed)?.receipt)
}
pub(super) struct CreatedCustody { pub(super) expected_digest: [u8;32], receipt: String }
// NEW LOCAL MODEL trust producer: commit exact intended bytes in supervisor memory BEFORE writing.
// It does not authenticate a distributed supervisor, storage provider, or ceremony.
pub(super) fn create_pinned(path: &Path, journal: &Path, id: &str, binding: &str, request: Request,
    selection: &str, inputs: Vec<PreparedInput>, vault: ViewPair, seed: Zeroizing<[u8;32]>) -> Result<CreatedCustody, ()> {
    create_pinned_fee(path,journal,id,binding,request,selection,inputs,vault,seed,(1,1))
}
pub(super) fn create_pinned_fee(path: &Path, journal: &Path, id: &str, binding: &str, request: Request,
    selection: &str, inputs: Vec<PreparedInput>, vault: ViewPair, seed: Zeroizing<[u8;32]>, fee: (u64,u64)) -> Result<CreatedCustody, ()> {
    if !valid_id(id) || !valid_id(binding) { return Err(()); }
    let mut file = OpenOptions::new().write(true).create_new(true).open(path).map_err(|_| ())?;
    let mut calls = OpenOptions::new().append(true).create(true).open(journal).map_err(|_| ())?;
    calls.write_all(b"construct\n").map_err(|_| ())?; calls.sync_all().map_err(|_| ())?;
    let sem = semantic(&request);
    let intent = construct(request, inputs, vault, seed, fee.0, fee.1).map_err(|_| ())?;
    let mut bytes = Zeroizing::new(Vec::new());
    for value in [b"W1F-SYNTHETIC-PRIVATE-1".as_slice(), id.as_bytes(), binding.as_bytes(), sem.as_bytes(), selection.as_bytes()] { field(&mut bytes, value); }
    let serialized = Zeroizing::new(intent._native.serialize());
    field(&mut bytes, &serialized);
    let expected_digest = Sha256::digest(&*bytes).into();
    file.write_all(&bytes).map_err(|_| ())?; file.sync_all().map_err(|_| ())?;
    drop(file);
    // Equality is checked without formatting private values in diagnostics.
    if load(path)?.as_slice() != bytes.as_slice() { return Err(()); }
    Ok(CreatedCustody { expected_digest, receipt: intent.receipt().to_wire() })
}
