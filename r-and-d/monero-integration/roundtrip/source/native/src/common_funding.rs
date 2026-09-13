//! Synthetic donor funding only. Never signs a vault payout.
use curve25519_dalek::{constants::ED25519_BASEPOINT_POINT as G, scalar::Scalar as CS, edwards::EdwardsPoint};
use monero_wallet::{ViewPair, Scanner, WalletOutput, OutputWithDecoys,
    ed25519::{Point, CompressedPoint, Scalar, Commitment}, address::Network, extra::ExtraField,
    block::{Block,BlockHeader}, transaction::{Transaction,TransactionPrefix,Input,Output,Timelock,Pruned},
    ringct::RctType, interface::{FeeRate,ScannableBlock}, io::VarInt, ringct::clsag::Decoys,
    send::{SignableTransaction,Change}};
use rand_core::{OsRng,RngCore};
use zeroize::Zeroizing;
use super::{Keys,id};

fn miner(view: &ViewPair) -> Transaction {
    let r=Zeroizing::new(CS::random(&mut OsRng));
    let public_view: EdwardsPoint=view.view().into();
    let mut derivation=(public_view * *r).mul_by_cofactor().compress().to_bytes().to_vec();
    VarInt::write(&0usize,&mut derivation).unwrap();
    let offset=Zeroizing::<CS>::new(Scalar::hash(&derivation).into());
    let spend: EdwardsPoint=view.spend().into();
    Transaction::V2 { prefix:TransactionPrefix { additional_timelock:Timelock::Block(1060), inputs:vec![Input::Gen(1000)],
        outputs:vec![Output { amount:Some(1_000_000_000_000),key:CompressedPoint::from((spend+G * *offset).compress().to_bytes()),view_tag:None }],
        extra:ExtraField::PublicKey(CompressedPoint::from((G * *r).compress().to_bytes())).serialize() },proofs:None }
}
fn block(miner: Transaction, regular: Option<&Transaction>) -> ScannableBlock {
    ScannableBlock { block:Block::new(BlockHeader {hardfork_version:16,hardfork_signal:16,timestamp:1_000_000,previous:[0;32],nonce:0},
        miner,regular.map(|t|vec![t.hash()]).unwrap_or_default()).unwrap(),
        transactions:regular.map(|t|vec![Transaction::<Pruned>::from(t.clone())]).unwrap_or_default(),output_index_for_first_ringct_output:Some(2000) }
}
fn ring(output: &WalletOutput) -> OutputWithDecoys {
    let mut points=Vec::new();
    for n in 0..16 { points.push(if n==7 {[output.key(),output.commitment().commit()]} else {
        [Point::from(G*CS::from(100+n as u64)),Commitment::new(Scalar::random(&mut OsRng),1000+n as u64).commit()] }); }
    let mut offsets=vec![1;16]; offsets[0]=output.index_on_blockchain()-7;
    let decoys=Decoys::new(offsets,7,points).unwrap();
    let mut bytes=Zeroizing::new(output.key().compress().to_bytes().to_vec());
    output.key_offset().write(&mut *bytes).unwrap(); output.commitment().write(&mut *bytes).unwrap(); decoys.write(&mut *bytes).unwrap();
    let mut r=bytes.as_slice(); let result=OutputWithDecoys::read(&mut r).unwrap(); assert!(r.is_empty()); result
}
pub fn fund(keys:&Keys,count:usize) -> (ViewPair,Vec<crate::PreparedInput>) {
    let vault=ViewPair::new(Point::from(keys[&id(1)].group_key().0),Zeroizing::new(Scalar::random(&mut OsRng))).unwrap();
    let mut outputs=Vec::new();
    for (batch,n) in (0..count).step_by(8).enumerate() { outputs.extend(fund_batch(keys,&vault,(count-n).min(8),2000+batch as u64*1000)); }
    let inputs=outputs.into_iter().map(|scanned|{let ring=ring(&scanned);crate::PreparedInput{scanned,ring}}).collect();
    (vault,inputs)
}
fn fund_batch(keys:&Keys,vault:&ViewPair,count:usize,start:u64) -> Vec<WalletOutput> {
    let secret=Zeroizing::new(Scalar::random(&mut OsRng));
    let spend=Zeroizing::<CS>::new((*secret).into());
    let donor=ViewPair::new(Point::from(G * *spend),Zeroizing::new(Scalar::random(&mut OsRng))).unwrap();
    let mut acquired=Scanner::new(donor.clone()).scan(block(miner(&donor),None)).unwrap().additional_timelock_satisfied_by(1060,1_000_000);
    assert_eq!(acquired.len(),1);
    let mut seed=Zeroizing::new([0;32]); OsRng.fill_bytes(seed.as_mut());
    let intent=SignableTransaction::new(RctType::ClsagBulletproofPlus,seed,vec![ring(&acquired.remove(0))],
        (0..count).map(|_|(vault.legacy_address(Network::Testnet),10_000_000_000)).collect(),
        Change::new(donor.clone(),None),vec![],FeeRate::new(1,1).unwrap()).unwrap();
    // Unrelated synthetic donor's single-party signature; never DKG vault signing.
    let tx=intent.sign(&mut OsRng,&secret).unwrap();
    let mut bytes=Vec::new(); tx.write(&mut bytes).unwrap(); let mut r=bytes.as_slice();
    let parsed=Transaction::read(&mut r).unwrap(); assert!(r.is_empty()); assert_eq!(parsed.hash(),tx.hash());
    let mut scanned=block(miner(&donor),Some(&parsed));scanned.output_index_for_first_ringct_output=Some(start);
    let outputs=Scanner::new(vault.clone()).scan(scanned).unwrap().not_additionally_locked();
    assert_eq!(outputs.len(),count);
    for o in &outputs { assert_eq!(o.transaction(),tx.hash()); assert_eq!(o.commitment().amount,10_000_000_000);
        assert_eq!(o.index_on_blockchain(),start+1+o.index_in_transaction());
        let d=Zeroizing::<CS>::new(o.key_offset().into()); assert_ne!(*d,CS::ZERO);
        assert_eq!(o.key().compress().to_bytes(),(keys[&id(1)].group_key().0+G * *d).compress().to_bytes()); }
    outputs
}
