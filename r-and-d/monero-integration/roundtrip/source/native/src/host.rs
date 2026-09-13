//! Explicit synthetic coordinator and private retained candidate host.
//! Committee-wide keys stay in this fixture; each runtime guard receives one key.
use super::*;
use std::io::{Read, Write};
#[path = "../tests/support/mod.rs"]
mod support;
#[path = "common_funding.rs"]
mod funding;
#[cfg(feature = "node-host")]
#[path = "node_funding.rs"]
pub(in crate::common_owner) mod node;
#[path = "retained_host.rs"]
mod retained;
use support::{id, Keys};

type HostResult<T> = std::result::Result<T, ()>;
#[cfg(feature="participant-host")]
pub(in crate::common_owner) fn participant_selection(inputs:&[PreparedInput],vault:&ViewPair,fee:(u64,u64))->HostResult<String>{retained::selection_wire_fee(inputs,vault,fee)}

fn line(reader: &mut impl Read, max: usize) -> HostResult<Option<Vec<u8>>> {
    let mut value = Vec::with_capacity(max.min(256));
    for _ in 0..max {
        let mut b = [0];
        if reader.read(&mut b).map_err(|_| ())? == 0 {
            return if value.is_empty() { Ok(None) } else { Err(()) };
        }
        if b[0] == b'\n' { return Ok(Some(value)); }
        if b[0] < 32 || b[0] > 126 { return Err(()); }
        value.push(b[0]);
    }
    Err(())
}

fn request(reader: &mut impl Read) -> HostResult<(String, String)> {
    if line(reader, 7)?.as_deref() != Some(b"W1HQ1") { return Err(()); }
    legacy_request_body(reader)
}

fn legacy_request_body(reader: &mut impl Read) -> HostResult<(String, String)> {
    let nonce = line(reader, 65)?.ok_or(())?;
    if nonce.len() != 64 || !nonce.iter().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b)) {
        return Err(());
    }
    let generation = line(reader, 21)?.ok_or(())?;
    if generation.is_empty() || generation[0] == b'0' || !generation.iter().all(u8::is_ascii_digit) {
        return Err(());
    }
    let generation = String::from_utf8(generation).map_err(|_| ())?;
    generation.parse::<u64>().map_err(|_| ())?;
    Ok((String::from_utf8(nonce).map_err(|_| ())?, generation))
}

fn sealed_fixture(directory: &Path) -> HostResult<Vec<ImageBoundUnapproved>> {
    let keys = support::distributed_keys();
    let (vault, inputs) = funding::fund(&keys, 2);
    let receiver = ViewPair::new(
        monero_ed25519::Point::from(curve25519_dalek::constants::ED25519_BASEPOINT_POINT),
        Zeroizing::new(monero_ed25519::Scalar::random(&mut OsRng)),
    ).map_err(|_| ())?;
    let request = format!(
        "WMNI1\n{}\n{}\n{}\n{}\ntestnet\n{}\n1000000000\n100000\n",
        "11".repeat(32), "22".repeat(32), "33".repeat(32), "44".repeat(32),
        receiver.legacy_address(Network::Testnet),
    ).into_bytes();
    let trace = Arc::new(Trace::default());
    seal_held(directory, &keys, inputs, vault, request, trace)
}

fn seal_held(directory: &Path, keys: &Keys, inputs: Vec<PreparedInput>, vault: ViewPair,
    request: Vec<u8>, trace: Arc<Trace>) -> HostResult<Vec<ImageBoundUnapproved>> {
    seal_held_fee(directory,keys,inputs,vault,request,trace,(1,1))
}
fn seal_held_fee(directory: &Path, keys: &Keys, inputs: Vec<PreparedInput>, vault: ViewPair,
    request: Vec<u8>, trace: Arc<Trace>, fee:(u64,u64)) -> HostResult<Vec<ImageBoundUnapproved>> {
    let owner = CustodyOwner::create_with_fee(
        &directory.join("native.private"), &directory.join("constructor-journal"),
        request, inputs, vault, Zeroizing::new(fresh()), trace.clone(), fee,
    ).map_err(|_| ())?;
    let subset = vec![id(1), id(2)];
    let mut pending = Vec::new();
    let mut proofs = Vec::new();
    let attempt = fresh();
    for participant in &subset {
        let (guard, rows) = owner.restore_guard(keys[participant].clone(), subset.clone(), attempt).map_err(|_| ())?;
        pending.push(guard);
        proofs.push(rows);
    }
    let rows = (0..owner.inputs.len())
        .flat_map(|n| proofs.iter().map(move |p| p[n].clone())).collect::<Vec<_>>();
    let mut attempts = Vec::new();
    let mut messages = Vec::new();
    for guard in pending {
        let (attempt, message) = guard.certify(&rows).map_err(|_| ())?;
        attempts.push(attempt);
        messages.push(message);
    }
    let mut sealed = Vec::new();
    for (local, attempt) in subset.iter().zip(attempts) {
        let remote = messages.iter().filter(|m| m.participant != *local).cloned().collect();
        sealed.push(attempt.seal(remote).map_err(|_| ())?);
    }
    if sealed.len() != 2 || trace.seals.load(Ordering::SeqCst) != 2 {
        return Err(());
    }
    if sealed[0]._candidate.bytes != sealed[1]._candidate.bytes
        || sealed[0]._candidate.identity() != sealed[1]._candidate.identity() {
        return Err(());
    }
    Ok(sealed)
}

pub(crate) fn run() -> HostResult<()> {
    let mut args = std::env::args_os().skip(1);
    let first = args.next().ok_or(())?;
    #[cfg(feature = "node-host")]
    if first == "--node-address" { if args.next().is_some(){return Err(())}return node::address(); }
    #[cfg(feature = "node-host")]
    if first == "--node-observe" { return node::observe(args); }
    if first == "--recover" {
        let directory = PathBuf::from(args.next().ok_or(())?);
        let digest = args.next().ok_or(())?.into_string().map_err(|_| ())?;
        if args.next().is_some() || !directory.is_dir() { return Err(()); }
        let expected = authorized_signing::digest_hex(&digest).map_err(|_| ())?;
        let committed = authorized_signing::terminal::recover(&directory, expected).map_err(|_| ())?;
        let response = committed.response().map_err(|_| ())?;
        let mut output = std::io::stdout().lock();
        output.write_all(response.as_bytes()).map_err(|_| ())?;
        return output.flush().map_err(|_| ());
    }
    let directory = PathBuf::from(first);
    if args.next().is_some() || !directory.is_dir() { return Err(()); }
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let tag = line(&mut input, 8)?.ok_or(())?;
    if tag == b"W1HCQ1" { return retained::run(&directory, &mut input, retained::Protocol::Reservation); }
    if tag == b"W1HDQ1" { return retained::run(&directory, &mut input, retained::Protocol::Descriptor); }
    // A node-selected executable never reaches synthetic funding.
    #[cfg(feature = "node-host")]
    return Err(());
    #[allow(unreachable_code)]
    if tag != b"W1HQ1" { return Err(()); }
    let (nonce, generation) = legacy_request_body(&mut input)?;
    let sealed = sealed_fixture(&directory)?;
    let response = candidate_response(&sealed[0], &nonce, &generation)?;
    // This observation is emitted only after the two actual native owners seal.
    eprintln!("host:sealed-two");
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    output.write_all(response.as_bytes()).map_err(|_| ())?;
    output.flush().map_err(|_| ())?;
    // Native owners stay in this scope after publication. No signing transition exists.
    match line(&mut input, 5)? {
        None => {},
        Some(command) if command == b"STOP" => {},
        _ => return Err(()),
    }
    drop(sealed);
    eprintln!("host:retired");
    Ok(())
}

#[cfg(test)]
pub(super) fn signing_test_fixture(directory: &Path) -> HostResult<Vec<ImageBoundUnapproved>> {
    sealed_fixture(directory)
}

fn candidate_response(sealed: &ImageBoundUnapproved, nonce: &str, generation: &str) -> HostResult<String> {
    let candidate = &sealed._candidate;
    let s = &candidate.semantic;
    let response = format!(
        "W1HA1\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n",
        nonce, generation, hex(&candidate.bytes), s.recipient, s.amount, s.input_total,
        s.change, s.fee, s.ceiling, hex(&s.change_spend), hex(&s.change_view), s.input_count,
    );
    if response.len() > 18_000 || !response.is_ascii() { return Err(()); }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn host_request_canonical_and_bounded_before_fixture() {
        let valid = format!("W1HQ1\n{}\n1\n", "ab".repeat(32));
        assert!(request(&mut valid.as_bytes()).is_ok());
        let mut invalid = vec![valid.replace("W1HQ1", "OTHER"), valid.replace("\n1\n", "\n01\n"),
            valid.replace("\n1\n", "\n0\n"), valid.replace("\n1\n", "\n18446744073709551616\n"),
            valid.replace("ab", "AB"), valid.replace("\n", "\r\n")];
        invalid.push(format!("W1HQ1\n{}\n1\n", "ab".repeat(33)));
        for value in invalid { assert!(request(&mut value.as_bytes()).is_err()); }
        let truncated = &valid.as_bytes()[..valid.len()-1];
        assert!(request(&mut &truncated[..]).is_err());
        assert!(line(&mut b"STOP\n".as_slice(), 5).unwrap().unwrap() == b"STOP");
        assert!(line(&mut b"OTHER\n".as_slice(), 5).is_err());
    }
}
