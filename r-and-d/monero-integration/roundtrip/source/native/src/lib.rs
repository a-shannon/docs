//! Local unapproved native-intent boundary. No authorization or signing capability.
use curve25519_dalek::{
    constants::ED25519_BASEPOINT_POINT as G, edwards::EdwardsPoint, scalar::Scalar as CurveScalar,
};
use monero_wallet::{
    address::{MoneroAddress, Network},
    ed25519::{CompressedPoint, Scalar},
    interface::FeeRate,
    io::{read_byte, read_bytes, read_u32, read_u64, read_vec, VarInt},
    ringct::RctType,
    send::{Change, SignableTransaction},
    OutputWithDecoys, ViewPair, WalletOutput,
};
use std::{collections::HashSet, io};
use zeroize::Zeroizing;

pub const MAX_REQUEST_BYTES: usize = 2048;
pub const MAX_INPUTS: usize = 16;

#[derive(Debug, PartialEq, Eq)]
pub enum IntentError {
    Wire,
    Address,
    InputCount,
    DuplicateInput,
    InputBinding,
    VaultBinding,
    RingSize,
    RingBinding,
    FeeRate,
    NativeConstruction,
    FeeCeiling,
    PrivateRoundTrip,
    NativeProjection,
}

/// Only the closed wire decoder can construct this owned request. Metadata is unauthenticated.
pub struct Request {
    challenge: String,
    event_id: String,
    instruction_digest: String,
    request_digest: String,
    network: Network,
    address: String,
    amount: u64,
    max_miner_fee: u64,
}

fn decimal(s: &str) -> Result<u64, IntentError> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) || (s.len() > 1 && s.starts_with('0'))
    {
        return Err(IntentError::Wire);
    }
    s.parse().map_err(|_| IntentError::Wire)
}

impl Request {
    pub fn decode(bytes: &[u8]) -> Result<Self, IntentError> {
        if bytes.len() > MAX_REQUEST_BYTES
            || !bytes.is_ascii()
            || bytes.contains(&0)
            || bytes.contains(&b'\r')
            || !bytes.ends_with(b"\n")
        {
            return Err(IntentError::Wire);
        }
        let text = std::str::from_utf8(bytes).map_err(|_| IntentError::Wire)?;
        let lines: Vec<_> = text[..text.len() - 1].split('\n').collect();
        if lines.len() != 9 || lines[0] != "WMNI1" {
            return Err(IntentError::Wire);
        }
        for s in &lines[1..5] {
            if s.len() != 64
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err(IntentError::Wire);
            }
        }
        let network = match lines[5] {
            "mainnet" => Network::Mainnet,
            "testnet" => Network::Testnet,
            "stagenet" => Network::Stagenet,
            _ => return Err(IntentError::Wire),
        };
        if lines[6].is_empty()
            || lines[6].len() > 256
            || !lines[6].bytes().all(|b| b.is_ascii_graphic())
        {
            return Err(IntentError::Wire);
        }
        let amount = decimal(lines[7])?;
        if amount == 0 {
            return Err(IntentError::Wire);
        }
        Ok(Self {
            challenge: lines[1].into(),
            event_id: lines[2].into(),
            instruction_digest: lines[3].into(),
            request_digest: lines[4].into(),
            network,
            address: lines[6].into(),
            amount,
            max_miner_fee: decimal(lines[8])?,
        })
    }
}

/// External scanner provenance and chain validity remain obligations of the supplying port.
pub struct PreparedInput {
    pub scanned: WalletOutput,
    pub ring: OutputWithDecoys,
}

/// The private field is deliberately inaccessible, without Debug, Clone, byte or signer APIs.
pub struct UnapprovedNativeIntent {
    _native: SignableTransaction,
    receipt: Receipt,
}
pub struct Receipt {
    challenge: String,
    event_id: String,
    instruction_digest: String,
    request_digest: String,
    network: Network,
    recipient: String,
    amount: u64,
    ceiling: u64,
    fee: u64,
    input_count: usize,
}
fn network_name(network: Network) -> &'static str {
    match network {
        Network::Mainnet => "mainnet",
        Network::Testnet => "testnet",
        Network::Stagenet => "stagenet",
    }
}
impl UnapprovedNativeIntent {
    pub fn receipt(&self) -> &Receipt {
        &self.receipt
    }
}
impl Receipt {
    /// Nonsecret projection only. This is not a certificate or authorization proof.
    pub fn to_wire(&self) -> String {
        format!(
            "WMNR1\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\nunapproved-native-intent\nprohibited\n",
            self.challenge,
            self.event_id,
            self.instruction_digest,
            self.request_digest,
            network_name(self.network),
            self.recipient,
            self.amount,
            self.ceiling,
            self.fee,
            self.input_count
        )
    }
}

fn bound_inputs(inputs: &[PreparedInput], vault: &ViewPair) -> Result<(), IntentError> {
    if inputs.is_empty() || inputs.len() > MAX_INPUTS {
        return Err(IntentError::InputCount);
    }
    let mut absolute = HashSet::new();
    let mut global = HashSet::new();
    let mut keys = HashSet::new();
    for p in inputs {
        let s = &p.scanned;
        let r = &p.ring;
        if !absolute.insert((s.transaction(), s.index_in_transaction()))
            || !global.insert(s.index_on_blockchain())
            || !keys.insert(s.key().compress().to_bytes())
        {
            return Err(IntentError::DuplicateInput);
        }
        if s.key() != r.key()
            || s.key_offset() != r.key_offset()
            || s.commitment().mask != r.commitment().mask
            || s.commitment().amount != r.commitment().amount
            || s.commitment().commit() != r.commitment().commit()
        {
            return Err(IntentError::InputBinding);
        }
        let d = r.decoys();
        if d.len() != 16 {
            return Err(IntentError::RingSize);
        }
        let slot = usize::from(d.signer_index());
        if slot >= 16
            || d.positions()[slot] != s.index_on_blockchain()
            || d.ring()[slot] != [s.key(), s.commitment().commit()]
        {
            return Err(IntentError::RingBinding);
        }
        let spend: EdwardsPoint = vault.spend().into();
        let offset: CurveScalar = s.key_offset().into();
        if s.subaddress().is_some()
            || s.key().compress().to_bytes() != (spend + G * offset).compress().to_bytes()
        {
            return Err(IntentError::VaultBinding);
        }
    }
    Ok(())
}

fn private_round_trip(native: &SignableTransaction, bytes: &[u8]) -> Result<(), IntentError> {
    let mut reader = bytes;
    let decoded =
        SignableTransaction::read(&mut reader).map_err(|_| IntentError::PrivateRoundTrip)?;
    if !reader.is_empty() || decoded != *native {
        return Err(IntentError::PrivateRoundTrip);
    }
    let canonical = Zeroizing::new(decoded.serialize());
    if canonical.as_slice() != bytes {
        return Err(IntentError::PrivateRoundTrip);
    }
    Ok(())
}

struct NativeProjection {
    network: Network,
    recipient: String,
    amount: u64,
    input_count: usize,
    input_total: u64,
    change_spend: [u8;32],
    change_view: [u8;32],
}

// Exact published wallet 0.2.0 send/mod.rs::write contract. Only internally generated bytes enter.
// Read the actual payment and standard change with published bounded IO; no JSON decoder or
// assumed fixed payment offset. Private view scalars and serialized input material never escape.
fn native_projection(
    bytes: &[u8],
    req: &Request,
    expected_inputs: &[OutputWithDecoys],
    vault: &ViewPair,
    expected_fee_rate: FeeRate,
) -> Result<NativeProjection, IntentError> {
    fn extract(
        bytes: &[u8],
        req: &Request,
        expected_inputs: &[OutputWithDecoys],
        vault: &ViewPair,
        expected_fee_rate: FeeRate,
    ) -> io::Result<NativeProjection> {
        let reject = || io::Error::other("native projection mismatch");
        let mut r = bytes;
        if read_byte(&mut r)? != u8::from(RctType::ClsagBulletproofPlus) {
            return Err(reject());
        }
        let _outgoing = Zeroizing::new(read_bytes::<_, 32>(&mut r)?);
        let inputs = read_vec(OutputWithDecoys::read, Some(MAX_INPUTS), &mut r)?;
        // Published Eq compares key, key offset, mask, amount and the complete decoy structure.
        if inputs.len() != expected_inputs.len() || inputs != expected_inputs {
            return Err(reject());
        }
        let input_total=inputs.iter().try_fold(0u64,|sum,input|sum.checked_add(input.commitment().amount)).ok_or_else(reject)?;
        let payments: usize = VarInt::read(&mut r)?;
        if payments != 2 {
            return Err(reject());
        }
        let mut actual = None;
        let mut change_seen = false;
        let mut change_keys = None;
        // The native constructor shuffles these two entries. Extract by tag, never offset/order.
        for _ in 0..payments {
            match read_byte(&mut r)? {
                0 if actual.is_none() => {
                    let recipient = String::from_utf8(read_vec(read_byte, Some(256), &mut r)?)
                        .map_err(|_| reject())?;
                    let address =
                        MoneroAddress::from_str(req.network, &recipient).map_err(|_| reject())?;
                    let amount = read_u64(&mut r)?;
                    if recipient != address.to_string()
                        || recipient != req.address
                        || amount != req.amount
                    {
                        return Err(reject());
                    }
                    actual = Some(NativeProjection {
                        network: address.network(),
                        recipient,
                        amount,
                        input_count: inputs.len(),
                        input_total,
                        change_spend: [0;32],
                        change_view: [0;32],
                    });
                }
                2 if !change_seen => {
                    let spend = CompressedPoint::read(&mut r)?;
                    let view_secret = Zeroizing::new(Scalar::read(&mut r)?);
                    let parsed_vault =
                        ViewPair::new(spend.decompress().ok_or_else(reject)?, view_secret)
                            .map_err(|_| reject())?;
                    if parsed_vault.spend() != vault.spend()
                        || parsed_vault.view() != vault.view()
                        || read_u32(&mut r)? != 0
                        || read_u32(&mut r)? != 0
                    {
                        return Err(reject());
                    }
                    change_seen = true;
                    change_keys=Some((parsed_vault.spend().compress().to_bytes(),parsed_vault.view().compress().to_bytes()));
                }
                _ => return Err(reject()),
            }
        }
        if !change_seen {
            return Err(reject());
        }
        let data_count: usize = VarInt::read(&mut r)?;
        if data_count != 0 || FeeRate::read(&mut r)? != expected_fee_rate || !r.is_empty() {
            return Err(reject());
        }
        let mut actual=actual.ok_or_else(reject)?;
        let (spend,view)=change_keys.ok_or_else(reject)?;
        actual.change_spend=spend;actual.change_view=view;
        Ok(actual)
    }
    extract(bytes, req, expected_inputs, vault, expected_fee_rate)
        .map_err(|_| IntentError::NativeProjection)
}

pub fn construct(
    request: Request,
    inputs: Vec<PreparedInput>,
    vault: ViewPair,
    outgoing_view_key: Zeroizing<[u8; 32]>,
    per_weight: u64,
    fee_mask: u64,
) -> Result<UnapprovedNativeIntent, IntentError> {
    let recipient = MoneroAddress::from_str(request.network, &request.address)
        .map_err(|_| IntentError::Address)?;
    if recipient.to_string() != request.address {
        return Err(IntentError::Address);
    }
    bound_inputs(&inputs, &vault)?;
    let expected_inputs: Vec<_> = inputs.into_iter().map(|p| p.ring).collect();
    let fee_rate = FeeRate::new(per_weight, fee_mask).ok_or(IntentError::FeeRate)?;
    let native = SignableTransaction::new(
        RctType::ClsagBulletproofPlus,
        outgoing_view_key,
        expected_inputs.clone(),
        vec![(recipient, request.amount)],
        Change::new(vault.clone(), None),
        vec![],
        fee_rate,
    )
    .map_err(|_| IntentError::NativeConstruction)?;
    let fee = native.necessary_fee();
    if fee > request.max_miner_fee {
        return Err(IntentError::FeeCeiling);
    }
    let bytes = Zeroizing::new(native.serialize());
    private_round_trip(&native, &bytes)?;
    let actual = native_projection(&bytes, &request, &expected_inputs, &vault, fee_rate)?;
    let receipt = Receipt {
        challenge: request.challenge,
        event_id: request.event_id,
        instruction_digest: request.instruction_digest,
        request_digest: request.request_digest,
        network: actual.network,
        recipient: actual.recipient,
        amount: actual.amount,
        ceiling: request.max_miner_fee,
        fee,
        input_count: actual.input_count,
    };
    Ok(UnapprovedNativeIntent {
        _native: native,
        receipt,
    })
}

pub mod synthetic_keeper;

#[cfg(feature = "participant-host")]
pub mod participant;
#[cfg(feature = "participant-host")]
mod participant_envelope;

/// Local synthetic fixture entry point. No signing, submission or production custody API.
#[cfg(feature = "synthetic-host")]
pub fn run_synthetic_candidate_host() -> Result<(), ()> {
    common_owner::host::run()
}
#[allow(dead_code)]
mod key_image;
#[allow(dead_code)]
mod common_owner;
#[allow(dead_code)]
mod candidate;
