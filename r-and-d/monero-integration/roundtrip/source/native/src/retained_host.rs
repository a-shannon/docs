//! Owned local request/reservation pipe. There is no approval or signing transition.
use super::*;
use sha2::{Digest, Sha256};

const REQUEST_LIMIT: usize = 8_192;
const SELECTION_LIMIT: usize = 65_536;
const SELECTION_FRAME_LIMIT: usize = 147_456;
const RESULT_LIMIT: usize = 65_536;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Protocol { Reservation, Descriptor }
impl Protocol {
    fn offer(self) -> &'static str { match self { Self::Reservation => "W1HCO1", Self::Descriptor => "W1HDO1" } }
    fn grant(self) -> &'static str { match self { Self::Reservation => "W1HCG1", Self::Descriptor => "W1HDG1" } }
    fn result(self) -> &'static str { match self { Self::Reservation => "W1HCR1", Self::Descriptor => "W1HDR1" } }
}

// Limits count raw bytes, including every LF. A fixed field count never reads to EOF
// while the peer must keep this same pipe open for the next phase.
struct Frame<'a, R> { reader: &'a mut R, remaining: usize }
impl<'a, R: Read> Frame<'a, R> {
    fn field(&mut self, max: usize) -> HostResult<String> {
        let raw = line(self.reader, max.checked_add(1).ok_or(())?.min(self.remaining))?.ok_or(())?;
        self.remaining = self.remaining.checked_sub(raw.len() + 1).ok_or(())?;
        if raw.is_empty() || !raw.iter().all(u8::is_ascii_graphic) { return Err(()); }
        String::from_utf8(raw).map_err(|_| ())
    }
}
fn positive(value: &str) -> HostResult<()> {
    if value.is_empty() || value.starts_with('0') || !value.bytes().all(|b| b.is_ascii_digit())
        || value.parse::<u64>().is_err() { return Err(()); }
    Ok(())
}
fn valid_hex(value: &str, max_bytes: usize) -> HostResult<()> {
    if value.is_empty() || value.len() % 2 != 0 || value.len() / 2 > max_bytes
        || !value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { return Err(()); }
    Ok(())
}
fn unhex(value: &str, max_bytes: usize) -> HostResult<Vec<u8>> {
    valid_hex(value, max_bytes)?;
    value.as_bytes().chunks_exact(2).map(|pair| {
        let s = std::str::from_utf8(pair).map_err(|_| ())?;
        u8::from_str_radix(s, 16).map_err(|_| ())
    }).collect()
}
struct Requested { generation: String, wire: Vec<u8>, wire_hex: String, decoded: Request }
fn request_body(input: &mut impl Read) -> HostResult<Requested> {
    let mut frame = Frame { reader: input, remaining: REQUEST_LIMIT - b"W1HCQ1\n".len() };
    let generation = frame.field(20)?;
    positive(&generation)?;
    let wire_hex = frame.field(MAX_REQUEST_BYTES * 2)?;
    let wire = unhex(&wire_hex, MAX_REQUEST_BYTES)?;
    // The existing native decoder is the schema authority. Address validity and
    // the synthetic Testnet profile must also pass before any donor funding.
    let decoded = Request::decode(&wire).map_err(|_| ())?;
    if decoded.network != Network::Testnet { return Err(()); }
    let address = MoneroAddress::from_str(Network::Testnet, &decoded.address).map_err(|_| ())?;
    if address.to_string() != decoded.address { return Err(()); }
    Ok(Requested { generation, wire, wire_hex, decoded })
}

// Existing WMNS2 format: five header lines, 25 per input, two fee fields.
// This writer reads the held Scanner-backed inputs, including actual ring slots.
fn selection_wire(inputs: &[PreparedInput], vault: &ViewPair) -> HostResult<String> {
    selection_wire_fee(inputs,vault,(1,1))
}
pub(super) fn selection_wire_fee(inputs: &[PreparedInput], vault: &ViewPair, fee:(u64,u64)) -> HostResult<String> {
    bound_inputs(inputs, vault).map_err(|_| ())?;
    let mut value = format!("WMNS2\ntestnet\n{}\n{}\n{}\n",
        hex(&vault.spend().compress().to_bytes()), hex(&vault.view().compress().to_bytes()), inputs.len());
    for p in inputs {
        let s = &p.scanned;
        let d = p.ring.decoys();
        value.push_str(&format!("{}\n{}\n{}\n{}\n{}\n{}\n16\n{}\n{}\n",
            hex(&s.transaction()), s.index_in_transaction(), s.index_on_blockchain(),
            hex(&s.key().compress().to_bytes()), s.commitment().amount,
            hex(&s.commitment().commit().compress().to_bytes()), d.signer_index(),
            d.offsets().iter().map(u64::to_string).collect::<Vec<_>>().join(",")));
        for member in d.ring() {
            value.push_str(&format!("{}:{}\n", hex(&member[0].compress().to_bytes()),
                hex(&member[1].compress().to_bytes())));
        }
    }
    value.push_str(&format!("{}\n{}\n",fee.0,fee.1));
    if value.len() > SELECTION_LIMIT { return Err(()); }
    Ok(value)
}
struct OfferIdentity { protocol: Protocol, generation: String, request_hex: String, selection_hex: String }
impl OfferIdentity {
    fn wire(&self) -> HostResult<String> {
        let value = format!("{}\n{}\n{}\n{}\n", self.protocol.offer(), self.generation, self.request_hex, self.selection_hex);
        if value.len() > SELECTION_FRAME_LIMIT { return Err(()); }
        Ok(value)
    }
}
// Not Clone and never reconstructed from a public candidate. The pipe metadata
// is retained with the owners; native does not authenticate a registry or clock.
struct GrantContext { reservation_id: String, reservation_hash: String, owner: String,
    generation: String, lease_until: String }
fn grant(input: &mut impl Read, offered: &OfferIdentity) -> HostResult<GrantContext> {
    let mut frame = Frame { reader: input, remaining: SELECTION_FRAME_LIMIT };
    if frame.field(6)? != offered.protocol.grant() { return Err(()); }
    let generation = frame.field(20)?;
    positive(&generation)?;
    if generation != offered.generation { return Err(()); }
    let request = frame.field(MAX_REQUEST_BYTES * 2)?;
    valid_hex(&request, MAX_REQUEST_BYTES)?;
    if request != offered.request_hex { return Err(()); }
    let selection = frame.field(SELECTION_LIMIT * 2)?;
    valid_hex(&selection, SELECTION_LIMIT)?;
    if selection != offered.selection_hex { return Err(()); }
    let reservation_id = frame.field(64)?;
    let reservation_hash = frame.field(64)?;
    let owner = frame.field(64)?;
    for value in [&reservation_id, &reservation_hash, &owner] {
        valid_hex(value, 32)?;
        if value.len() != 64 { return Err(()); }
    }
    let generation = frame.field(20)?;
    let lease_until = frame.field(20)?;
    positive(&generation)?;
    positive(&lease_until)?;
    Ok(GrantContext { reservation_id, reservation_hash, owner, generation, lease_until })
}
struct HeldOffer {
    requested: Requested, identity: OfferIdentity, selection_digest: String,
    keys: Keys, inputs: Vec<PreparedInput>, vault: ViewPair, trace: Arc<Trace>, fee:(u64,u64),
}
impl HeldOffer {
    // Consumes the sole offer even on malformed grant. No retry or second grant.
    fn accept(self, input: &mut impl Read) -> HostResult<Granted> {
        let context = grant(input, &self.identity)?;
        zero_native(&self.trace)?;
        Ok(Granted { held: self, context })
    }
}
struct Granted { held: HeldOffer, context: GrantContext }
struct RetainedOwners { sealed: Vec<ImageBoundUnapproved>, _grant: GrantContext, _offered: OfferIdentity,
    _descriptor: Option<authorized_signing::Descriptor> }
impl Drop for RetainedOwners {
    fn drop(&mut self) { self.retire(); }
}
impl RetainedOwners {
    fn retire(&mut self) {
        if !self.sealed.is_empty() { self.sealed.clear(); eprintln!("host:retired"); }
    }
}
fn zero_native(trace: &Trace) -> HostResult<()> {
    if [&trace.constructs, &trace.restores, &trace.preprocesses, &trace.decodes, &trace.image_checks, &trace.seals, &trace.wallet_signs]
        .iter().any(|n| n.load(Ordering::SeqCst) != 0) { return Err(()); }
    Ok(())
}

fn transition(input: &mut impl Read, retained: &mut RetainedOwners, tag: &str,
    widths: &[usize], cap: usize) -> HostResult<Option<Vec<u8>>> {
    let first = line(input, 8)?;
    match first.as_deref() {
        None => { retained.retire(); return Ok(None); },
        Some(b"STOP") => {
            retained.retire();
            let mut byte = [0];
            if input.read(&mut byte).map_err(|_| ())? != 0 { return Err(()); }
            return Ok(None);
        },
        Some(value) if value == tag.as_bytes() => {},
        _ => return Err(()),
    }
    let mut raw = format!("{tag}\n");
    let mut frame = Frame { reader: input, remaining: cap.checked_sub(raw.len()).ok_or(())? };
    for width in widths { raw.push_str(&frame.field(*width)?); raw.push('\n'); }
    Ok(Some(raw.into_bytes()))
}
fn preparation_matches(raw: &[u8], retained: &RetainedOwners) -> HostResult<()> {
    let fields = std::str::from_utf8(raw).map_err(|_| ())?.lines().collect::<Vec<_>>();
    if fields.len() != 11 || fields[0] != "W1HDP1" { return Err(()); }
    let descriptor = retained._descriptor.as_ref().ok_or(())?;
    let selection = unhex(&retained._offered.selection_hex, SELECTION_LIMIT)?;
    let expected = [retained._offered.generation.as_str(), retained._offered.request_hex.as_str(),
        retained._grant.reservation_id.as_str(), retained._grant.reservation_hash.as_str(), retained._grant.owner.as_str(),
        retained._grant.generation.as_str(), retained._grant.lease_until.as_str()];
    if fields[1..8] != expected || fields[8] != hex(&Sha256::digest(&selection))
        || fields[9] != hex(&descriptor.identity()) { return Err(()); }
    valid_hex(fields[10], 32)?;
    if fields[10].len() != 64 { return Err(()); } Ok(())
}
fn approved_stages(directory: &Path, input: &mut impl Read, output: &mut impl Write,
    mut retained: RetainedOwners) -> HostResult<()> {
    let Some(preparation) = transition(input, &mut retained, "W1HDP1",
        &[20, MAX_REQUEST_BYTES*2, 64, 64, 64, 20, 20, 64, 64, 64], 8192)? else { return Ok(()); };
    preparation_matches(&preparation, &retained)?;
    let expectation = authorized_signing::Expectation::from_owners(&retained.sealed, preparation).map_err(|_| ())?;
    let prepared = authorized_signing::terminal::prepare(directory, expectation).map_err(|_| ())?;
    publish(output, &prepared.response())?;
    let Some(ack) = transition(input, &mut retained, "W1HDS1", &[64, 64], 137)? else { return Ok(()); };
    prepared.check_ack(&ack).map_err(|_| ())?;
    let owners = std::mem::take(&mut retained.sealed);
    let committed = authorized_signing::terminal::sign_and_commit(directory, owners, prepared).map_err(|_| ())?;
    publish(output, &committed.response().map_err(|_| ())?)?;
    // The terminal record remains; no original or intermediate signing machines
    // survive. Keep only the protocol alive for the issuer's final liveness check.
    retirement(input, || {})
}
fn publish(output: &mut impl Write, value: &str) -> HostResult<()> {
    output.write_all(value.as_bytes()).map_err(|_| ())?;
    output.flush().map_err(|_| ())
}
fn retirement(input: &mut impl Read, retire: impl FnOnce()) -> HostResult<()> {
    let command = line(input, 5);
    // Retire on every terminal command outcome. In particular STOP must release
    // the actual holders before the peer closes stdin or any EOF check blocks.
    retire();
    match command? {
        None => Ok(()),
        Some(command) if command == b"STOP" => {
            // The owners have already been destroyed. EOF now closes only the
            // framing check, and trailing bytes still reject the protocol.
            let mut byte = [0];
            if input.read(&mut byte).map_err(|_| ())? == 0 { Ok(()) } else { Err(()) }
        },
        _ => Err(()),
    }
}

pub(super) fn run(directory: &Path, input: &mut impl Read, protocol: Protocol) -> HostResult<()> {
    let requested = request_body(input)?;
    eprintln!("host:request-validated");
    let keys = support::distributed_keys();
    #[cfg(feature = "node-host")]
    let (vault,inputs,fee) = node::fund(&keys,2,directory)?;
    #[cfg(not(feature = "node-host"))]
    let (vault,inputs,fee) = { let (v,i)=funding::fund(&keys,2); (v,i,(1,1)) };
    let selection = selection_wire_fee(&inputs, &vault,fee)?;
    let identity = OfferIdentity { protocol, generation: requested.generation.clone(),
        request_hex: requested.wire_hex.clone(), selection_hex: hex(selection.as_bytes()) };
    let trace = Arc::new(Trace::default());
    zero_native(&trace)?;
    let held = HeldOffer { requested, identity, selection_digest: hex(&Sha256::digest(selection.as_bytes())),
        keys, inputs, vault, trace,fee };
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    eprintln!("host:pregrant-zero-native");
    publish(&mut output, &held.identity.wire()?)?;
    eprintln!("host:offer-held");
    let Granted { held, context } = held.accept(input)?;
    eprintln!("host:grant-accepted");
    let HeldOffer { requested, identity, selection_digest, keys, inputs, vault, trace,fee } = held;
    eprintln!("host:construction-start");
    let sealed = seal_held_fee(directory, &keys, inputs, vault, requested.wire, trace.clone(),fee)?;
    if trace.constructs.load(Ordering::SeqCst) != 1 || trace.restores.load(Ordering::SeqCst) != 2
        || trace.preprocesses.load(Ordering::SeqCst) != 2
        || trace.seals.load(Ordering::SeqCst) != 2 || sealed[0].receipt != sealed[1].receipt {
        return Err(());
    }
    let candidate = candidate_response(&sealed[0], &requested.decoded.challenge, &requested.generation)?;
    let receipt = &sealed[0].receipt;
    if receipt.len() > MAX_REQUEST_BYTES { return Err(()); }
    let mut response = format!("{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n",
        protocol.result(), requested.generation, context.reservation_id, context.reservation_hash, context.owner,
        context.generation, context.lease_until, requested.wire_hex, selection_digest,
        hex(receipt.as_bytes()), hex(candidate.as_bytes()));
    let descriptor = if protocol == Protocol::Descriptor {
        let descriptor = authorized_signing::describe_pair(&sealed).map_err(|_| ())?;
        // W1HDR1 adds exactly one final hex line. The 4096-byte descriptor cap
        // keeps the complete 12-line response within the existing 65536 cap.
        response.push_str(&hex(descriptor.wire().as_bytes())); response.push('\n');
        Some(descriptor)
    } else { None };
    if response.len() > RESULT_LIMIT { return Err(()); }
    let retained = RetainedOwners { sealed, _grant: context, _offered: identity, _descriptor: descriptor };
    eprintln!("host:sealed-two");
    publish(&mut output, &response)?;
    if protocol == Protocol::Descriptor { approved_stages(directory, input, &mut output, retained) }
    else { retirement(input, || drop(retained)) }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Vec<u8> {
        let view = ViewPair::new(monero_ed25519::Point::from(curve25519_dalek::constants::ED25519_BASEPOINT_POINT),
            Zeroizing::new(monero_ed25519::Scalar::from(1u8.into()))).unwrap();
        format!("WMNI1\n{}\n{}\n{}\n{}\ntestnet\n{}\n1000000000\n100000\n",
            "11".repeat(32), "22".repeat(32), "33".repeat(32), "44".repeat(32),
            view.legacy_address(Network::Testnet)).into_bytes()
    }
    fn identity() -> OfferIdentity {
        OfferIdentity { protocol: Protocol::Reservation, generation: "1".into(), request_hex: hex(&request()), selection_hex: hex(b"WMNS2\nsynthetic-parser-only\n") }
    }
    fn grant_wire(o: &OfferIdentity) -> String {
        format!("{}\n{}\n{}\n{}\n{}\n{}\n{}\n2\n100000\n",
            o.protocol.grant(), o.generation, o.request_hex, o.selection_hex, "aa".repeat(32), "bb".repeat(32), "cc".repeat(32))
    }
    #[test]
    fn retained_request_uses_existing_decoder_and_profile_before_funding() {
        let wire = request();
        let body = format!("1\n{}\n", hex(&wire));
        let decoded = request_body(&mut body.as_bytes()).unwrap();
        assert_eq!(decoded.decoded.address, "9vWx1vQmqjsJ8QgRfFWTzmJ8QgRfFWTzmJ8QgRfFWTzmJ7suhUXwdrDJ8QgRfFWTzmJ8QgRfFWTzmJ8QgRfFWTzmCaX3TNi");
        assert_eq!(decoded.wire, wire);
        for invalid in [body.replacen("1\n", "01\n", 1), body.replace('\n', "\r\n"),
            format!("1\n{}\n", hex(b"WMNI1\n")), format!("0\n{}\n", hex(&wire)),
            format!("18446744073709551616\n{}\n", hex(&wire)),
            format!("1\n{}\n", "aa".repeat(MAX_REQUEST_BYTES + 1)),
            format!("1\n{}\n", hex(&wire).to_uppercase())] {
            assert!(request_body(&mut invalid.as_bytes()).is_err());
        }
        let text = String::from_utf8(wire).unwrap();
        for invalid in [text.replace("testnet", "mainnet"), text.replace("testnet", "stagenet"),
            text.replace("WMNI1", "OTHER"), text.replace("1000000000", "0")] {
            assert!(request_body(&mut format!("1\n{}\n", hex(invalid.as_bytes())).as_bytes()).is_err());
        }
        let mut lines = text.lines().collect::<Vec<_>>();
        lines[6] = "invalid-recipient";
        assert!(request_body(&mut format!("1\n{}\n", hex(format!("{}\n", lines.join("\n")).as_bytes())).as_bytes()).is_err());
    }
    #[test]
    fn retained_grant_binds_all_offer_fields_and_canonical_context() {
        let o = identity();
        let valid = grant_wire(&o);
        let context = grant(&mut valid.as_bytes(), &o).unwrap();
        assert_eq!(context.reservation_id, "aa".repeat(32));
        assert_eq!(context.reservation_hash, "bb".repeat(32));
        assert_eq!(context.owner, "cc".repeat(32));
        assert_eq!(context.generation, "2");
        assert_eq!(context.lease_until, "100000");
        for (index, value) in [(0, "W1HCQ1"), (1, "2"), (2, "00"), (3, "00"),
            (4, "aa"), (5, "AA"), (6, "gg"), (7, "0"), (7, "02"),
            (8, "0"), (8, "18446744073709551616"), (8, " 1")] {
            let mut fields = valid.lines().map(str::to_owned).collect::<Vec<_>>();
            fields[index] = value.into();
            assert!(grant(&mut format!("{}\n", fields.join("\n")).as_bytes(), &o).is_err());
        }
        for length in 0..valid.len() {
            assert!(grant(&mut &valid.as_bytes()[..length], &o).is_err());
        }
        assert!(grant(&mut valid.replace('\n', "\r\n").as_bytes(), &o).is_err());
    }
    #[test]
    fn retained_descriptor_version_cannot_cross_reservation_grant_stage() {
        let c = identity();
        let mut d = identity(); d.protocol = Protocol::Descriptor;
        assert!(c.wire().unwrap().starts_with("W1HCO1\n"));
        assert!(d.wire().unwrap().starts_with("W1HDO1\n"));
        assert_eq!(c.wire().unwrap().lines().count(), 4);
        assert_eq!(d.wire().unwrap().lines().count(), 4);
        assert!(grant(&mut grant_wire(&c).as_bytes(), &c).is_ok());
        assert!(grant(&mut grant_wire(&d).as_bytes(), &d).is_ok());
        assert!(grant(&mut grant_wire(&c).as_bytes(), &d).is_err());
        assert!(grant(&mut grant_wire(&d).as_bytes(), &c).is_err());
        assert_eq!(Protocol::Reservation.result(), "W1HCR1");
        assert_eq!(Protocol::Descriptor.result(), "W1HDR1");
    }
    #[test]
    fn retained_phase_bounds_and_terminal_commands() {
        assert!(unhex("a", 1).is_err());
        assert!(unhex("AA", 1).is_err());
        assert!(unhex("0000", 1).is_err());
        assert!(unhex("", 1).is_err());
        let mut exact = b"aa\nbb\n".as_slice();
        let mut frame = Frame { reader: &mut exact, remaining: 6 };
        assert_eq!(frame.field(2).unwrap(), "aa");
        assert_eq!(frame.field(2).unwrap(), "bb");
        assert!(frame.field(2).is_err());
        let mut short = b"aa\nbb\n".as_slice();
        let mut frame = Frame { reader: &mut short, remaining: 5 };
        assert!(frame.field(2).is_ok());
        assert!(frame.field(2).is_err());
        assert!(retirement(&mut b"".as_slice(), || {}).is_ok());
        assert!(retirement(&mut b"STOP\n".as_slice(), || {}).is_ok());
        for invalid in ["STOP", "STOP\nX", "STOP\nSTOP\n", "STOP\r\n", "SIGN\n", "\n"] {
            assert!(retirement(&mut invalid.as_bytes(), || {}).is_err());
        }
        let o = identity();
        let duplicate = format!("{}{}", grant_wire(&o), grant_wire(&o));
        let mut bytes = duplicate.as_bytes();
        assert!(grant(&mut bytes, &o).is_ok());
        assert!(retirement(&mut bytes, || {}).is_err());
        let trace = Trace::default();
        assert!(zero_native(&trace).is_ok());
        for counter in [&trace.constructs, &trace.restores, &trace.preprocesses, &trace.decodes,
            &trace.image_checks, &trace.seals] {
            bump(counter);
            assert!(zero_native(&trace).is_err());
            counter.store(0, Ordering::SeqCst);
        }
    }
    #[test]
    fn retained_stop_destroys_owners_before_waiting_for_eof() {
        use std::cell::Cell;
        struct ObservedReader<'a> { pending: &'a [u8], retired: &'a Cell<bool>, eof_reads: usize }
        impl Read for ObservedReader<'_> {
            fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
                if self.pending.is_empty() {
                    self.eof_reads += 1;
                    if !self.retired.get() { return Err(std::io::Error::other("owners still held")); }
                    return Ok(0);
                }
                self.pending.read(output)
            }
        }
        let retired = Cell::new(false);
        let mut reader = ObservedReader { pending: b"STOP\n", retired: &retired, eof_reads: 0 };
        assert!(retirement(&mut reader, || retired.set(true)).is_ok());
        assert!(retired.get());
        assert_eq!(reader.eof_reads, 1);
        // EOF alone, malformed commands and trailing data all consume retirement
        // exactly once; trailing bytes cannot resurrect a retired owner.
        for command in ["", "STOP\nX", "SIGN\n", "STOP", "\n"] {
            let calls = Cell::new(0);
            let outcome = retirement(&mut command.as_bytes(), || calls.set(calls.get() + 1));
            assert_eq!(calls.get(), 1);
            assert_eq!(outcome.is_ok(), command.is_empty());
        }
    }
}
