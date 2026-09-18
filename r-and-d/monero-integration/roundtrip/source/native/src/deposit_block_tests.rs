use super::*;
use curve25519_dalek::{
    constants::ED25519_BASEPOINT_POINT as G, edwards::EdwardsPoint, scalar::Scalar as CurveScalar,
};
use monero_wallet::{
    address::Network,
    block::BlockHeader,
    ed25519::{Commitment, CompressedPoint, Point, Scalar},
    extra::ExtraField,
    interface::FeeRate,
    io::VarInt,
    ringct::{clsag::Decoys, RctType},
    send::{Change, SignableTransaction},
    transaction::{Output, Timelock, TransactionPrefix},
    OutputWithDecoys,
};
use rand_core::{OsRng, RngCore};
use std::sync::OnceLock;
use zeroize::Zeroizing;

const HEIGHT: u64 = 4097;
const FIRST: u64 = 100_000;
fn limits() -> Limits {
    Limits {
        max_block_bytes: 1_000_000,
        max_transaction_bytes: 100_000,
        max_total_bytes: 10_000_000,
        max_transactions: 64,
        max_outputs_per_transaction: 32,
        max_outputs: 512,
        max_owned_outputs: 64,
    }
}
fn view(spend: u64, view: u64) -> ViewPair {
    ViewPair::new(
        Point::from(G * CurveScalar::from(spend)),
        Zeroizing::new(Scalar::from(CurveScalar::from(view))),
    )
    .unwrap()
}
fn miner(pair: &ViewPair, height: usize, count: usize) -> Transaction {
    let r = Zeroizing::new(CurveScalar::random(&mut OsRng));
    let public_view: EdwardsPoint = pair.view().into();
    let shared = (public_view * *r).mul_by_cofactor().compress().to_bytes();
    let spend: EdwardsPoint = pair.spend().into();
    let outputs = (0..count)
        .map(|index| {
            let mut derivation = shared.to_vec();
            VarInt::write(&index, &mut derivation).unwrap();
            let offset = Zeroizing::<CurveScalar>::new(Scalar::hash(&derivation).into());
            Output {
                amount: Some(1_000_000_000_000),
                key: CompressedPoint::from((spend + G * *offset).compress().to_bytes()),
                view_tag: None,
            }
        })
        .collect();
    Transaction::V2 {
        prefix: TransactionPrefix {
            additional_timelock: Timelock::Block(height + 60),
            inputs: vec![Input::Gen(height)],
            outputs,
            extra: ExtraField::PublicKey(CompressedPoint::from((G * *r).compress().to_bytes()))
                .serialize(),
        },
        proofs: None,
    }
}
fn block(height: usize, miner: Transaction, transactions: &[Transaction]) -> Block {
    let result = Block::new(
        BlockHeader {
            hardfork_version: 16,
            hardfork_signal: 16,
            timestamp: 1_700_000_000,
            previous: [9; 32],
            nonce: 0,
        },
        miner,
        transactions.iter().map(Transaction::hash).collect(),
    )
    .unwrap();
    assert_eq!(result.number(), height);
    result
}
fn ring(output: &WalletOutput) -> OutputWithDecoys {
    let points = (0..16)
        .map(|n| {
            if n == 7 {
                [output.key(), output.commitment().commit()]
            } else {
                [
                    Point::from(G * CurveScalar::from(100 + n as u64)),
                    Commitment::new(Scalar::random(&mut OsRng), 1000 + n as u64).commit(),
                ]
            }
        })
        .collect();
    let mut offsets = vec![1; 16];
    offsets[0] = output.index_on_blockchain() - 7;
    let decoys = Decoys::new(offsets, 7, points).unwrap();
    let mut bytes = Zeroizing::new(output.key().compress().to_bytes().to_vec());
    output.key_offset().write(&mut *bytes).unwrap();
    output.commitment().write(&mut *bytes).unwrap();
    decoys.write(&mut *bytes).unwrap();
    let mut reader = bytes.as_slice();
    let result = OutputWithDecoys::read(&mut reader).unwrap();
    assert!(reader.is_empty());
    result
}
struct Fixture {
    view: ViewPair,
    block: Block,
    transactions: Vec<Transaction>,
    blobs: Vec<Vec<u8>>,
}
fn fixture() -> &'static Fixture {
    static FIXTURE: OnceLock<Fixture> = OnceLock::new();
    FIXTURE.get_or_init(|| {
        let vault = view(9, 7);
        let donor = view(11, 13);
        // Seventeen different donor inputs; no duplicate spends within the fixture block.
        // Wallet construction/signing is in-memory only, with synthetic coins and rings.
        let funding = block(1000, miner(&donor, 1000, 17), &[]);
        let acquired = Scanner::new(donor.clone())
            .scan(ScannableBlock {
                block: funding,
                transactions: vec![],
                output_index_for_first_ringct_output: Some(10_000),
            })
            .unwrap()
            .additional_timelock_satisfied_by(1060, 1_700_000_000);
        assert_eq!(acquired.len(), 17);
        let transactions = acquired
            .iter()
            .map(|output| {
                let mut seed = Zeroizing::new([0; 32]);
                OsRng.fill_bytes(seed.as_mut());
                let unsigned = SignableTransaction::new(
                    RctType::ClsagBulletproofPlus,
                    seed,
                    vec![ring(output)],
                    vec![(vault.legacy_address(Network::Testnet), 10_000_000_000)],
                    Change::new(donor.clone(), None),
                    vec![],
                    FeeRate::new(1, 1).unwrap(),
                )
                .unwrap();
                unsigned
                    .sign(
                        &mut OsRng,
                        &Zeroizing::new(Scalar::from(CurveScalar::from(11u64))),
                    )
                    .unwrap()
            })
            .collect::<Vec<_>>();
        let mut images = HashSet::new();
        for tx in &transactions {
            for input in &tx.prefix().inputs {
                if let Input::ToKey { key_image, .. } = input {
                    assert!(images.insert(key_image.to_bytes()));
                } else {
                    panic!("ordinary transaction has coinbase input");
                }
            }
        }
        let selected = block(
            HEIGHT as usize,
            miner(&vault, HEIGHT as usize, 1),
            &transactions,
        );
        let blobs = transactions.iter().map(Transaction::serialize).collect();
        Fixture {
            view: vault,
            block: selected,
            transactions,
            blobs,
        }
    })
}
fn run(
    f: &Fixture,
    raw: &[u8],
    blobs: &[Vec<u8>],
    hash: [u8; 32],
    height: u64,
    bounds: Limits,
    index: Option<u64>,
) -> Result<ScannedBlock> {
    scan(&f.view, raw, blobs, index, hash, height, bounds)
}

#[test]
fn deposit_block_scans_height_4097_seventeen_actual_wallet_transactions_nonunit_view() {
    let f = fixture();
    let result = run(
        f,
        &f.block.serialize(),
        &f.blobs,
        f.block.hash(),
        HEIGHT,
        limits(),
        Some(FIRST),
    )
    .unwrap();
    assert_eq!(result.height(), HEIGHT);
    assert_eq!(result.block_hash(), f.block.hash());
    assert_eq!(result.first_ringct_index(), Some(FIRST));
    assert_eq!(result.outputs().len(), 18);
    assert_eq!(result.ringct_outputs(), 35);
    assert_eq!(
        result.outputs()[0].transaction(),
        f.block.miner_transaction().hash()
    );
    assert_eq!(
        result.outputs()[0].additional_timelock(),
        Timelock::Block(HEIGHT as usize + 60)
    );
    assert_eq!(result.outputs()[0].index_on_blockchain(), FIRST);
    for (tx, output) in f.transactions.iter().zip(&result.outputs()[1..]) {
        assert_eq!(output.transaction(), tx.hash());
        assert_eq!(output.commitment().amount, 10_000_000_000);
        assert_eq!(output.additional_timelock(), Timelock::None);
        assert_eq!(
            output.key().compress().to_bytes(),
            tx.prefix().outputs[output.index_in_transaction() as usize]
                .key
                .to_bytes()
        );
    }
    let wrong_view = view(9, 1);
    assert!(scan(
        &wrong_view,
        &f.block.serialize(),
        &f.blobs,
        Some(FIRST),
        f.block.hash(),
        HEIGHT,
        limits()
    )
    .unwrap()
    .outputs()
    .is_empty());
}
#[test]
fn deposit_block_binds_canonical_block_hash_and_coinbase_height() {
    let f = fixture();
    let raw = f.block.serialize();
    for bytes in [&raw[..raw.len() - 1], &[raw.as_slice(), &[0]].concat()] {
        assert_eq!(
            run(
                f,
                bytes,
                &f.blobs,
                f.block.hash(),
                HEIGHT,
                limits(),
                Some(FIRST)
            )
            .err(),
            Some(Error::BlockEncoding)
        );
    }
    let mut noncanonical = raw.clone();
    noncanonical[0] |= 0x80;
    noncanonical.insert(1, 0);
    assert_eq!(
        run(
            f,
            &noncanonical,
            &f.blobs,
            f.block.hash(),
            HEIGHT,
            limits(),
            Some(FIRST)
        )
        .err(),
        Some(Error::BlockEncoding)
    );
    assert_eq!(
        run(f, &raw, &f.blobs, [0; 32], HEIGHT, limits(), Some(FIRST)).err(),
        Some(Error::BlockHash)
    );
    assert_eq!(
        run(
            f,
            &raw,
            &f.blobs,
            f.block.hash(),
            HEIGHT + 1,
            limits(),
            Some(FIRST)
        )
        .err(),
        Some(Error::BlockHeight)
    );
    let mut unsupported = f.block.clone();
    unsupported.header.hardfork_version = 17;
    assert_eq!(
        run(
            f,
            &unsupported.serialize(),
            &f.blobs,
            unsupported.hash(),
            HEIGHT,
            limits(),
            Some(FIRST)
        )
        .err(),
        Some(Error::UnsupportedProtocol)
    );
}
#[test]
fn deposit_block_requires_complete_canonical_transactions_in_block_order() {
    let f = fixture();
    let raw = f.block.serialize();
    let mut missing = f.blobs.clone();
    missing.pop();
    assert_eq!(
        run(
            f,
            &raw,
            &missing,
            f.block.hash(),
            HEIGHT,
            limits(),
            Some(FIRST)
        )
        .err(),
        Some(Error::TransactionCount)
    );
    let mut reordered = f.blobs.clone();
    reordered.swap(0, 1);
    assert_eq!(
        run(
            f,
            &raw,
            &reordered,
            f.block.hash(),
            HEIGHT,
            limits(),
            Some(FIRST)
        )
        .err(),
        Some(Error::TransactionHash)
    );
    for trailing in [false, true] {
        let mut malformed = f.blobs.clone();
        if trailing {
            malformed[0].push(0);
        } else {
            malformed[0].pop();
        }
        assert_eq!(
            run(
                f,
                &raw,
                &malformed,
                f.block.hash(),
                HEIGHT,
                limits(),
                Some(FIRST)
            )
            .err(),
            Some(Error::TransactionEncoding)
        );
    }
    let mut duplicate = f.block.clone();
    duplicate.transactions[1] = duplicate.transactions[0];
    let mut blobs = f.blobs.clone();
    blobs[1] = blobs[0].clone();
    assert_eq!(
        run(
            f,
            &duplicate.serialize(),
            &blobs,
            duplicate.hash(),
            HEIGHT,
            limits(),
            Some(FIRST)
        )
        .err(),
        Some(Error::DuplicateTransaction)
    );
    let tx = miner(&f.view, HEIGHT as usize, 1);
    let invalid = block(
        HEIGHT as usize,
        f.block.miner_transaction().clone(),
        std::slice::from_ref(&tx),
    );
    assert_eq!(
        run(
            f,
            &invalid.serialize(),
            &[tx.serialize()],
            invalid.hash(),
            HEIGHT,
            limits(),
            Some(FIRST)
        )
        .err(),
        Some(Error::TransactionKind)
    );
}
#[test]
fn deposit_block_resource_bounds_are_independent() {
    let f = fixture();
    let raw = f.block.serialize();
    for mode in 0..7 {
        let mut bounds = limits();
        let expected = match mode {
            0 => {
                bounds.max_block_bytes = raw.len() - 1;
                Error::ByteBound
            }
            1 => {
                bounds.max_transaction_bytes = f.blobs.iter().map(Vec::len).max().unwrap() - 1;
                Error::ByteBound
            }
            2 => {
                bounds.max_total_bytes =
                    raw.len() + f.blobs.iter().map(Vec::len).sum::<usize>() - 1;
                Error::ByteBound
            }
            3 => {
                bounds.max_transactions = 16;
                Error::TransactionBound
            }
            4 => {
                bounds.max_outputs_per_transaction = 1;
                Error::OutputBound
            }
            5 => {
                bounds.max_outputs = 34;
                Error::OutputBound
            }
            _ => {
                bounds.max_owned_outputs = 17;
                Error::OutputBound
            }
        };
        assert_eq!(
            run(
                f,
                &raw,
                &f.blobs,
                f.block.hash(),
                HEIGHT,
                bounds,
                Some(FIRST)
            )
            .err(),
            Some(expected)
        );
    }
}
#[test]
fn deposit_block_checks_index_presence_and_overflow_but_does_not_authenticate_its_origin() {
    let f = fixture();
    let raw = f.block.serialize();
    for index in [None, Some(u64::MAX - 34)] {
        assert_eq!(
            run(f, &raw, &f.blobs, f.block.hash(), HEIGHT, limits(), index).err(),
            Some(Error::RingctIndex)
        );
    }
    let first = run(
        f,
        &raw,
        &f.blobs,
        f.block.hash(),
        HEIGHT,
        limits(),
        Some(FIRST),
    )
    .unwrap();
    let shifted = run(
        f,
        &raw,
        &f.blobs,
        f.block.hash(),
        HEIGHT,
        limits(),
        Some(FIRST + 7),
    )
    .unwrap();
    for (a, b) in first.outputs().iter().zip(shifted.outputs()) {
        assert_eq!(a.transaction(), b.transaction());
        assert_eq!(a.key(), b.key());
        assert_eq!(a.index_on_blockchain() + 7, b.index_on_blockchain());
    }
    let coinbase = Transaction::V1 {
        prefix: f.block.miner_transaction().prefix().clone(),
        signatures: vec![],
    };
    let mut old = block(HEIGHT as usize, coinbase, &[]);
    old.header.hardfork_version = 1;
    assert!(
        run(f, &old.serialize(), &[], old.hash(), HEIGHT, limits(), None)
            .unwrap()
            .outputs()
            .is_empty()
    );
    assert_eq!(
        run(
            f,
            &old.serialize(),
            &[],
            old.hash(),
            HEIGHT,
            limits(),
            Some(0)
        )
        .err(),
        Some(Error::RingctIndex)
    );
}
#[test]
fn deposit_block_refuses_same_owned_key_in_two_distinct_transaction_locators() {
    let f = fixture();
    let original = f.transactions[0].clone();
    let mut copied = original.clone();
    // Byte/scan-layer adversarial fixture, not a claim that the mutated signature is valid.
    copied.prefix_mut().additional_timelock = Timelock::Block(9000);
    assert_ne!(original.hash(), copied.hash());
    let selected = block(
        HEIGHT as usize,
        f.block.miner_transaction().clone(),
        &[original.clone(), copied.clone()],
    );
    assert_eq!(
        run(
            f,
            &selected.serialize(),
            &[original.serialize(), copied.serialize()],
            selected.hash(),
            HEIGHT,
            limits(),
            Some(FIRST)
        )
        .err(),
        Some(Error::DuplicateOutput)
    );
}

#[test]
fn deposit_block_extreme_encoded_lengths_and_invalid_coinbase_fail_without_panicking() {
    let vault = view(9, 7);
    let coinbase = miner(&vault, HEIGHT as usize, 1);
    let header = BlockHeader {
        hardfork_version: 16,
        hardfork_signal: 16,
        timestamp: 1_700_000_000,
        previous: [9; 32],
        nonce: 0,
    };
    // The declared transaction count is below the library's absolute count bound,
    // but not backed by even one hash. It must fail on the first read, not allocate it.
    let mut huge_transactions = header.serialize();
    huge_transactions.extend(coinbase.serialize());
    VarInt::write(&(Block::MAX_TRANSACTIONS - 1), &mut huge_transactions).unwrap();
    assert!(huge_transactions.len() < 256);
    assert_eq!(
        scan(
            &vault,
            &huge_transactions,
            &[],
            Some(FIRST),
            [0; 32],
            HEIGHT,
            limits()
        )
        .err(),
        Some(Error::BlockEncoding)
    );
    // Miner output lengths have no protocol count cap. EOF still precedes allocation.
    let mut huge_outputs = header.serialize();
    huge_outputs.extend([2, 0, 1, 255]);
    VarInt::write(&(HEIGHT as usize), &mut huge_outputs).unwrap();
    VarInt::write(&usize::MAX, &mut huge_outputs).unwrap();
    assert!(huge_outputs.len() < 80);
    assert_eq!(
        scan(
            &vault,
            &huge_outputs,
            &[],
            Some(FIRST),
            [0; 32],
            HEIGHT,
            limits()
        )
        .err(),
        Some(Error::BlockEncoding)
    );
    // A miner with two Gen inputs is rejected by Block::new inside Block::read;
    // it can never reach Block::number's unreachable non-coinbase branch.
    let mut bad_coinbase = coinbase.clone();
    bad_coinbase
        .prefix_mut()
        .inputs
        .push(Input::Gen(HEIGHT as usize));
    let mut raw = header.serialize();
    raw.extend(bad_coinbase.serialize());
    raw.push(0);
    assert_eq!(
        scan(&vault, &raw, &[], Some(FIRST), [0; 32], HEIGHT, limits()).err(),
        Some(Error::BlockEncoding)
    );
    let ordinary_block = Block::new(header.clone(), coinbase.clone(), vec![[3; 32]]).unwrap();
    for prefix in [vec![2, 0], vec![2, 0, 1, 2, 0]] {
        // Respectively a huge input count and huge ring-offset count, no elements.
        let mut blob = prefix;
        VarInt::write(&usize::MAX, &mut blob).unwrap();
        assert!(blob.len() < 20);
        assert_eq!(
            scan(
                &vault,
                &ordinary_block.serialize(),
                &[blob],
                Some(FIRST),
                ordinary_block.hash(),
                HEIGHT,
                limits()
            )
            .err(),
            Some(Error::TransactionEncoding)
        );
    }
    let mut no_proof = coinbase.clone();
    no_proof.prefix_mut().inputs = vec![Input::ToKey {
        amount: None,
        key_offsets: vec![1],
        key_image: CompressedPoint::from((G * CurveScalar::from(5u64)).compress().to_bytes()),
    }];
    for output in &mut no_proof.prefix_mut().outputs {
        output.amount = None;
    }
    let invalid = Block::new(header, coinbase, vec![no_proof.hash()]).unwrap();
    assert_eq!(
        scan(
            &vault,
            &invalid.serialize(),
            &[no_proof.serialize()],
            Some(FIRST),
            invalid.hash(),
            HEIGHT,
            limits()
        )
        .err(),
        Some(Error::TransactionKind)
    );
}
