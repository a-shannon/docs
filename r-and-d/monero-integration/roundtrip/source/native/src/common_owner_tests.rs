use super::*;
#[path="../tests/support/mod.rs"] mod support;
#[path="common_funding.rs"] mod funding;
use support::{Keys,id};
use std::sync::OnceLock;
use std::io::Write;

struct Fixture {keys:Keys,vault:ViewPair,inputs:Vec<PreparedInput>,request:Vec<u8>}
fn fixture() -> &'static Fixture {
    static F:OnceLock<Fixture>=OnceLock::new();F.get_or_init(||{
        let keys=support::distributed_keys();let (vault,inputs)=funding::fund(&keys,16);
        // Receiver is unrelated; only its address is needed, and no receiver spend scalar retained.
        let receiver=ViewPair::new(monero_ed25519::Point::from(curve25519_dalek::constants::ED25519_BASEPOINT_POINT),Zeroizing::new(monero_ed25519::Scalar::random(&mut OsRng))).unwrap();
        let request=format!("WMNI1\n{}\n{}\n{}\n{}\ntestnet\n{}\n1000000000\n100000\n","11".repeat(32),"22".repeat(32),"33".repeat(32),"44".repeat(32),receiver.legacy_address(Network::Testnet)).into_bytes();
        Fixture{keys,vault,inputs,request}
    })
}
fn runtime_path() -> PathBuf {
    let root=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("evidence/runtime");
    std::fs::create_dir_all(&root).unwrap();let dir=root.join(hex(&fresh()));std::fs::create_dir(&dir).unwrap();dir
}
fn owner(n:usize) -> CustodyOwner {
    owner_with(copy_inputs(&fixture().inputs[..n]))
}
fn owner_with(inputs:Vec<PreparedInput>) -> CustodyOwner {
    let f=fixture();let dir=runtime_path();let trace=Arc::new(Trace::default());
    CustodyOwner::create(&dir.join("private-object"),&dir.join("journal"),f.request.clone(),inputs,f.vault.clone(),Zeroizing::new(fresh()),trace).unwrap()
}
fn count(n:&AtomicUsize)->usize {n.load(Ordering::SeqCst)}
fn reject<T>(value:Result<T>,expected:GateError) {assert!(matches!(value,Err(e) if e==expected));}
fn start(o:&CustodyOwner,subset:&[u16],attempt:[u8;32]) -> (Vec<CollectingAttempt>,Vec<LocalModelMessage>) {
    let mut pending=Vec::new();let mut proof_sets=Vec::new();
    for i in subset {let (p,proof)=o.restore_guard(fixture().keys[&id(*i)].clone(),subset.iter().map(|i|id(*i)).collect(),attempt).unwrap();pending.push(p);proof_sets.push(proof);}
    let rows=(0..o.inputs.len()).flat_map(|n|proof_sets.iter().map(move |v|v[n].clone())).collect::<Vec<_>>();
    pending.into_iter().map(|p|p.certify(&rows).unwrap()).unzip()
}
fn single(o:&CustodyOwner) -> (CollectingAttempt,Vec<LocalModelMessage>) {let (mut p,m)=start(o,&[1,2],[9;32]);(p.remove(0),m)}

#[test]
fn common_two_input_restored_native_all_six_subsets_and_both_local_roles() {
    for subset in [[1,2],[1,3],[1,4],[2,3],[2,4],[3,4]] {
        let o=owner(2);let (pending,messages)=start(&o,&subset,[9;32]);
        assert_eq!(count(&o.trace.restores),2);assert_eq!(count(&o.trace.preprocesses),2);
        for (local,p) in subset.iter().zip(pending) {
            let bound=p.seal(messages.iter().filter(|m|m.participant!=id(*local)).cloned().collect()).unwrap();
            let certs=bound._session.consume(&bound._verified).unwrap();assert_eq!(certs.len(),2);
            for (c,held) in certs.iter().zip(&o.inputs) {assert_eq!(c.identity().output_key(),held.scanned.key().compress().to_bytes());}
        }
        assert_eq!(count(&o.trace.seals),2);assert_eq!(std::fs::read_to_string(o.path.parent().unwrap().join("journal")).unwrap(),"construct\n");
    }
}
#[test]
fn actual_one_and_sixteen_input_preprocess_bounds() {
    for n in [1,16] {let o=owner(n);let (p,m)=single(&o);assert_eq!(m[0].wire.len(),160*n);assert_eq!(m[1].wire.len(),160*n);
        p.seal(vec![m[1].clone()]).unwrap();assert_eq!(count(&o.trace.seals),1);}
    let f=fixture();for n in [0,17] {let dir=runtime_path();let mut inputs=copy_inputs(&f.inputs);if n==0{inputs.clear()}else{inputs.push(PreparedInput{scanned:f.inputs[0].scanned.clone(),ring:f.inputs[0].ring.clone()})}
        let trace=Arc::new(Trace::default());reject(CustodyOwner::create(&dir.join("private"),&dir.join("journal"),f.request.clone(),inputs,f.vault.clone(),Zeroizing::new(fresh()),trace.clone()),GateError::Inputs);
        assert!(!dir.join("private").exists());assert_eq!(count(&trace.preprocesses),0);}
}
#[test]
fn canonical_altered_late_remote_j_reaches_equality_gate_and_burns() {
    let o=owner(2);let (p,mut m)=single(&o);let before=count(&o.trace.image_checks);let decoded=count(&o.trace.decodes);
    m[1].wire[288..320].copy_from_slice(&(Ed25519::generator()*dalek_ff_group::Scalar::from(900u64)).to_bytes());
    reject(p.seal(vec![m.remove(1)]),GateError::ImageShare);
    assert_eq!(count(&o.trace.decodes),decoded+1);assert_eq!(count(&o.trace.image_checks),before+2);assert_eq!(count(&o.trace.seals),0);
}
#[test]
fn participant_and_local_model_binding_branches_precede_decoding() {
    for case in 0..10 {let o=owner(2);let (p,m)=single(&o);let before=count(&o.trace.decodes);
        let (messages,expected)=match case {
            0=>(vec![],GateError::Missing),
            1=>(vec![m[1].clone(),m[1].clone()],GateError::Duplicate),
            2=>(vec![m[0].clone()],GateError::Participant),
            3=>{let mut x=m[1].clone();x.participant=id(3);(vec![x],GateError::Participant)},
            4=>{let mut x=m[1].clone();x.binding.subset=vec![id(1),id(3)];(vec![x],GateError::ModelBinding)},
            n=>{let mut x=m[1].clone();x.binding.context[n-5][0]^=1;(vec![x],GateError::ModelBinding)},
        };
        reject(p.seal(messages),expected);assert_eq!(count(&o.trace.seals),0);
        assert_eq!(count(&o.trace.decodes),before+usize::from(case==1));
    }
}
#[test]
fn exact_wire_and_all_nonce_point_boundaries() {
    for case in 0..9 {let o=owner(2);let (p,m)=single(&o);let mut x=m[1].clone();
        let expected=match case {
            0=>{x.wire=x.wire[..319].to_vec().into_boxed_slice();GateError::WireLength},
            1=>{let mut b=x.wire.to_vec();b.push(0);x.wire=b.into_boxed_slice();GateError::WireLength},
            2..=5=>{let offset=(case-2)*32;let mut identity=[0;32];identity[0]=1;x.wire[offset..offset+32].copy_from_slice(&identity);GateError::NativeDecode},
            6=>{x.wire[128..160].fill(0);GateError::NativeDecode},
            7=>{x.wire[128..160].fill(0xff);GateError::NativeDecode},
            _=>{let mut identity=[0;32];identity[0]=1;x.wire[128..160].copy_from_slice(&identity);GateError::ImageShare},
        };
        reject(p.seal(vec![x]),expected);assert_eq!(count(&o.trace.seals),0);
    }
}
#[test]
fn input_row_order_and_proof_session_substitution_fail_before_seal() {
    let o=owner(2);let (p,m)=single(&o);let mut x=m[1].clone();let first=x.wire[..160].to_vec();x.wire.copy_within(160..320,0);x.wire[160..320].copy_from_slice(&first);
    reject(p.seal(vec![x]),GateError::ImageShare);assert_eq!(count(&o.trace.seals),0);
    let o=owner(2);let (a,_)=o.restore_guard(fixture().keys[&id(1)].clone(),vec![id(1),id(2)],[9;32]).unwrap();
    let (_,p1)=o.restore_guard(fixture().keys[&id(1)].clone(),vec![id(1),id(2)],[8;32]).unwrap();
    let (_,p2)=o.restore_guard(fixture().keys[&id(2)].clone(),vec![id(1),id(2)],[8;32]).unwrap();
    let rows=vec![p1[0].clone(),p2[0].clone(),p1[1].clone(),p2[1].clone()];reject(a.certify(&rows),GateError::ImageProof);assert_eq!(count(&o.trace.preprocesses),0);
}
fn replace_payload(original:&[u8],payload:&[u8])->Zeroizing<Vec<u8>> {
    let mut offset=0;for _ in 0..5{let n=u32::from_le_bytes(original[offset..offset+4].try_into().unwrap())as usize;offset+=4+n;}
    let mut out=Zeroizing::new(original[..offset].to_vec());out.extend((payload.len()as u32).to_le_bytes());out.extend(payload);out
}
fn corrupted_copy(o:&mut CustodyOwner,payload:&[u8]) {
    let original=Zeroizing::new(std::fs::read(&o.path).unwrap());let altered=replace_payload(&original,payload);
    let path=o.path.with_extension("altered");let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(&path).unwrap();file.write_all(&altered).unwrap();file.sync_all().unwrap();o.path=path;
}
#[test]
fn same_p_changed_native_seed_cannot_acquire_original_owner() {
    let mut o=owner(2);let request=Request::decode(&o.request).unwrap();
    let alternate=construct(request,copy_inputs(&o.inputs),o.vault.clone(),Zeroizing::new(fresh()),1,1).unwrap();
    let payload=Zeroizing::new(alternate._native.serialize());
    // Positive control: same input/ring/view/payment projection with a fresh outgoing seed is valid.
    native_projection(&payload,&Request::decode(&o.request).unwrap(),&o.inputs.iter().map(|p|p.ring.clone()).collect::<Vec<_>>(),&o.vault,FeeRate::new(1,1).unwrap()).unwrap();
    corrupted_copy(&mut o,&payload);
    reject(o.restore_guard(fixture().keys[&id(1)].clone(),vec![id(1),id(2)],[9;32]),GateError::Custody);
    assert_eq!(count(&o.trace.restores),0);assert_eq!(count(&o.trace.preprocesses),0);
}
#[test]
fn changed_native_payment_and_reordered_held_inputs_reject_at_restore() {
    let mut o=owner(2);let request=String::from_utf8(o.request.clone()).unwrap().replace("1000000000\n","1000000001\n");
    let alternate=construct(Request::decode(request.as_bytes()).unwrap(),copy_inputs(&o.inputs),o.vault.clone(),Zeroizing::new(fresh()),1,1).unwrap();
    corrupted_copy(&mut o,&Zeroizing::new(alternate._native.serialize()));reject(o.restore_guard(fixture().keys[&id(1)].clone(),vec![id(1),id(2)],[9;32]),GateError::Custody);assert_eq!(count(&o.trace.preprocesses),0);
    let mut o=owner(2);o.inputs.swap(0,1);reject(o.restore_guard(fixture().keys[&id(1)].clone(),vec![id(1),id(2)],[9;32]),GateError::Custody);assert_eq!(count(&o.trace.restores),0);
}
#[test]
fn real_ring_key_and_vault_ownership_are_required_before_preprocess() {
    let o=owner(2);let unrelated=support::distributed_keys();reject(o.restore_guard(unrelated[&id(1)].clone(),vec![id(1),id(2)],[9;32]),GateError::Vault);assert_eq!(count(&o.trace.restores),0);
    let f=fixture();let mut inputs=copy_inputs(&f.inputs[..2]);let output=&inputs[0].ring;let mut points=output.decoys().ring().to_vec();points[7][0]=monero_ed25519::Point::from(curve25519_dalek::constants::ED25519_BASEPOINT_POINT);
    let decoys=monero_wallet::ringct::clsag::Decoys::new(output.decoys().offsets().to_vec(),7,points).unwrap();
    let mut bytes=Zeroizing::new(output.key().compress().to_bytes().to_vec());output.key_offset().write(&mut *bytes).unwrap();output.commitment().write(&mut *bytes).unwrap();decoys.write(&mut *bytes).unwrap();
    inputs[0].ring=OutputWithDecoys::read(&mut bytes.as_slice()).unwrap();let dir=runtime_path();let trace=Arc::new(Trace::default());
    reject(CustodyOwner::create(&dir.join("native"),&dir.join("journal"),f.request.clone(),inputs,f.vault.clone(),Zeroizing::new(fresh()),trace.clone()),GateError::Inputs);
    assert!(!dir.join("native").exists());assert_eq!(count(&trace.preprocesses),0);
}

#[test]
fn every_input_remote_role_and_stored_own_row_are_checked() {
    for local in 0..2 {for row in 0..2 {
        let o=owner(2);let (mut p,m)=start(&o,&[1,2],[9;32]);let pending=p.remove(local);let mut remote=m[1-local].clone();
        remote.wire[row*160+128..row*160+160].copy_from_slice(&(Ed25519::generator()*dalek_ff_group::Scalar::from(777u64)).to_bytes());
        let before=count(&o.trace.image_checks);reject(pending.seal(vec![remote]),GateError::ImageShare);
        assert_eq!(count(&o.trace.image_checks),before+row+1);assert_eq!(count(&o.trace.seals),0);
    }}
    let o=owner(2);let (mut p,m)=single(&o);let mut own=p.our_generated.serialize();own[288..320].copy_from_slice(&(Ed25519::generator()*dalek_ff_group::Scalar::from(888u64)).to_bytes());
    // Test-only corruption of private storage; no such replacement API exists for callers.
    p.our_generated=p.machine.read_preprocess(&mut own.as_slice()).unwrap();
    reject(p.seal(vec![m[1].clone()]),GateError::ImageShare);assert_eq!(count(&o.trace.seals),0);
}
#[test]
fn actual_same_input_changed_seed_and_old_attempt_have_same_j_but_no_owner_equivalence() {
    let o=owner(2);let (p,m)=single(&o);
    let alternate=construct(Request::decode(&o.request).unwrap(),copy_inputs(&o.inputs),o.vault.clone(),Zeroizing::new(fresh()),1,1).unwrap();
    let (_other_machine,other)=alternate._native.multisig(fixture().keys[&id(2)].clone()).unwrap().preprocess(&mut OsRng);
    let other_wire=other.serialize();let certs=p.session.consume(&p.verified).unwrap();
    // Decisive limitation control: actual distinct-native preprocess passes image-only decoder.
    decode(&p.machine,&other_wire,certs,id(2),&o.trace).unwrap();
    for n in 0..2 {assert!(other_wire[n*160+128..n*160+160]==m[1].wire[n*160+128..n*160+160]);}
    let (_new,old)=start(&o,&[1,2],[8;32]);
    for n in 0..2 {assert!(old[1].wire[n*160+128..n*160+160]==m[1].wire[n*160+128..n*160+160]);}
    reject(p.seal(vec![old[1].clone()]),GateError::ModelBinding);assert_eq!(count(&o.trace.seals),0);
    // Changed native bytes under the original custody authority are separately rejected by
    // same_p_changed_native_seed_cannot_acquire_original_owner, before preprocessing.
}
fn reference_image(input:&PreparedInput)->CompressedPoint {
    let keys=&fixture().keys;let view=keys[&id(1)].view(vec![id(1),id(2)]).unwrap();
    let h=Ed25519::read_G(&mut monero_ed25519::Point::biased_hash(input.scanned.key().compress().to_bytes()).compress().to_bytes().as_slice()).unwrap();
    let sum:PrimePoint=[id(1),id(2)].iter().map(|i|(h * **keys[i].original_secret_share())*view.interpolation_factor(*i).unwrap()).sum();
    let d=Zeroizing::new(Ed25519::read_F(&mut <[u8;32]>::from(input.scanned.key_offset()).as_slice()).unwrap());
    CompressedPoint::from((sum+h * *d).to_bytes())
}
#[test]
fn native_projection_has_deliberately_nonidentity_input_image_permutation() {
    let mut inputs=copy_inputs(&fixture().inputs[..2]);inputs.sort_by_key(reference_image);
    let o=owner_with(inputs);let key=fixture().keys[&id(1)].clone();
    let (a,p1)=o.restore_guard(key,vec![id(1),id(2)],[9;32]).unwrap();
    let (b,p2)=o.restore_guard(fixture().keys[&id(2)].clone(),vec![id(1),id(2)],[9;32]).unwrap();
    let rows=vec![p1[0].clone(),p2[0].clone(),p1[1].clone(),p2[1].clone()];
    let v=a.session.verify(&rows).unwrap();let certs=a.session.consume(&v).unwrap();let images=certs.iter().map(|c|CompressedPoint::from(c.image())).collect::<Vec<_>>();
    assert!(images[0]<images[1]); // Ensures the wallet's descending image sort really reverses inputs.
    let tx=a.native.clone().unsigned_transaction(images.clone()).unwrap();
    for (n,entry) in tx.prefix().inputs.iter().enumerate() {
        let monero_wallet::transaction::Input::ToKey{key_image,key_offsets,..}=entry else {panic!("expected input kind")};
        assert_eq!(*key_image,images[1-n]);assert_eq!(key_offsets.as_slice(),o.inputs[1-n].ring.decoys().offsets());
    }
    let (a,_)=a.certify(&rows).unwrap();let (_b,message)=b.certify(&rows).unwrap();a.seal(vec![message]).unwrap();assert_eq!(count(&o.trace.seals),1);
}

#[test]
fn cancelling_late_remote_j_changes_preserve_final_image_but_must_not_seal() {
    let o=owner(2);let (mut attempts,mut messages)=start(&o,&[1,2,3],[9;32]);let local=attempts.remove(0);
    let view=fixture().keys[&id(1)].view(vec![id(1),id(2),id(3)]).unwrap();
    let l2=view.interpolation_factor(id(2)).unwrap();let l3=view.interpolation_factor(id(3)).unwrap();
    let j2=Ed25519::read_G(&mut &messages[1].wire[288..320]).unwrap();
    let j3=Ed25519::read_G(&mut &messages[2].wire[288..320]).unwrap();
    let delta=Ed25519::generator()*dalek_ff_group::Scalar::from(17u64);
    let changed2=j2+delta;let changed3=j3-delta*(l2*l3.invert());
    assert!(changed2!=j2 && changed3!=j3);
    assert_eq!(j2*l2+j3*l3,changed2*l2+changed3*l3); // Same final image, wrong certified rows.
    messages[1].wire[288..320].copy_from_slice(&changed2.to_bytes());
    messages[2].wire[288..320].copy_from_slice(&changed3.to_bytes());
    // Both remain valid complete native preprocess encodings under the actual consuming machine.
    for m in &messages[1..] {let mut r=m.wire.as_ref();local.machine.read_preprocess(&mut r).unwrap();assert!(r.is_empty());}
    let before=count(&o.trace.image_checks);
    reject(local.seal(messages.into_iter().skip(1).collect()),GateError::ImageShare);
    assert_eq!(count(&o.trace.image_checks),before+2);assert_eq!(count(&o.trace.seals),0);
}

#[path="candidate_tests.rs"]
mod candidate_tests;
