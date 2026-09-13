use super::*;
#[path="../tests/support/mod.rs"] mod support;
#[path="../tests/support/funding.rs"] mod funding;
use support::{Keys,id};
use rand_core::OsRng;

fn setup() -> (Keys,LocalImageSession) {
    let k=support::distributed_keys();let outputs=funding::fund(&k,1);
    let c=LocalContext{network_genesis:[1;32],epoch:[2;32],epoch_manifest:[3;32],session:[4;32],retained_intent:[5;32]};
    let s=LocalImageSession::capture(c,&k[&id(1)],vec![id(1),id(2)],&outputs).unwrap();(k,s)
}
fn rows(k:&Keys,s:&LocalImageSession) -> Vec<ProofRow> { [1,2].iter().map(|i|s.prove(&mut OsRng,&k[&id(*i)]).unwrap().remove(0)).collect() }
#[test]
fn self_declared_replacement_v_valid_dleq_is_rejected_by_captured_roster() {
    let (k,s)=setup();let mut r=rows(&k,&s);
    let replacement=Zeroizing::new(Scalar::from(123456u64));let h=s.inputs[0].h;
    let v=Ed25519::generator() * *replacement;let j=h * *replacement;
    assert_ne!(v,s.roster[0].1);
    let proof=DLEqProof::<EdwardsPoint>::prove(&mut OsRng,&mut s.transcript(0,id(1)),&[Ed25519::generator(),h],&replacement);
    proof.verify(&mut s.transcript(0,id(1)),&[Ed25519::generator(),h],&[v,j]).unwrap();
    r[0]=ProofRow{ordinal:0,participant:id(1),image_share:j.to_bytes(),proof:proof.serialize().try_into().unwrap()};
    assert!(matches!(s.verify(&r),Err(Error::Proof)));
}
#[test]
fn domain_and_hash_generator_are_independent_proof_boundaries() {
    let (k,mut s)=setup();let r=rows(&k,&s);
    let original=s.binding.clone();
    for field in [DOMAIN,PROFILE,PURPOSE,b"lagrange".as_slice()] {
        let index=s.binding.windows(field.len()).position(|w|w==field).unwrap();
        s.binding[index]^=1;assert!(matches!(s.verify(&r),Err(Error::Proof)));s.binding=original.clone();
    }
    let mut t=s.transcript(0,id(1));t.domain_separate(b"payout-signing-domain");
    let proof=DLEqProof::<EdwardsPoint>::prove(&mut OsRng,&mut t,&[Ed25519::generator(),s.inputs[0].h],k[&id(1)].original_secret_share());
    let mut domain_rows=r.clone();domain_rows[0].proof=proof.serialize().try_into().unwrap();
    assert!(matches!(s.verify(&domain_rows),Err(Error::Proof)));
    let old=s.inputs[0].h;s.inputs[0].h=Ed25519::generator();assert_ne!(old,s.inputs[0].h);
    assert!(matches!(s.verify(&r),Err(Error::Proof)));
}
#[test]
fn identity_epoch_group_and_identity_roster_share_fail_closed() {
    let (k,s)=setup();let outputs=funding::fund(&k,1);let original=&k[&id(1)];
    for group_identity in [true,false] {
        let shares=(1..=4).map(|i|(id(i),if group_identity {Ed25519::generator()*Scalar::from(u64::from(i))} else if i==4 {EdwardsPoint::identity()} else {original.original_verification_share(id(i))})).collect();
        let key=ThresholdKeys::new(original.params(),Interpolation::Lagrange,original.original_secret_share().clone(),shares).unwrap();
        assert!(matches!(LocalImageSession::capture(s.context.clone(),&key,vec![id(1),id(2)],&outputs),Err(Error::Point)));
    }
}
