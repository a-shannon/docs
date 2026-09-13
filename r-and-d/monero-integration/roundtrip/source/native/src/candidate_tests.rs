use super::*;
use crate::candidate::{self,IssuedCandidate,Error as CandidateError};

fn issued(o:&CustodyOwner)->IssuedCandidate {
    let (a,p1)=o.restore_guard(fixture().keys[&id(1)].clone(),vec![id(1),id(2)],[9;32]).unwrap();
    let (_,p2)=o.restore_guard(fixture().keys[&id(2)].clone(),vec![id(1),id(2)],[9;32]).unwrap();
    let rows=(0..o.inputs.len()).flat_map(|n|[p1[n].clone(),p2[n].clone()]).collect::<Vec<_>>();
    let v=a.session.verify(&rows).unwrap();let certs=a.session.consume(&v).unwrap();
    IssuedCandidate::issue(&a.native,&a.candidate_context,&a.inputs,certs).unwrap()
}
fn rehash(bytes:&mut [u8]) {
    use sha2::{Sha256,Digest};let n=bytes.len()-32;let mut h=Sha256::new();h.update(b"W1h/local-native-proposal/v1\0");h.update(&bytes[..n]);bytes[n..].copy_from_slice(&h.finalize());
}
fn body_frame(original:&[u8],tx:&Transaction)->Box<[u8]> {
    let mut b=original[..135].to_vec();let body=tx.serialize();b.extend((body.len() as u32).to_le_bytes());b.extend(body);b.extend(tx.signature_hash().unwrap());b.extend([0;32]);rehash(&mut b);b.into_boxed_slice()
}
fn request_amount(amount:u64)->Vec<u8>{let text=String::from_utf8(fixture().request.clone()).unwrap();let mut lines=text.lines().map(str::to_owned).collect::<Vec<_>>();lines[7]=amount.to_string();(lines.join("\n")+"\n").into_bytes()}
fn owner_request(request:Vec<u8>)->CustodyOwner{let dir=runtime_path();CustodyOwner::create(&dir.join("private"),&dir.join("journal"),request,copy_inputs(&fixture().inputs[..2]),fixture().vault.clone(),Zeroizing::new(fresh()),Arc::new(Trace::default())).unwrap()}
fn scan_projection(tx:&Transaction,vault:ViewPair)->Vec<WalletOutput>{
    use monero_wallet::{block::{Block,BlockHeader},transaction::{Input,Timelock,TransactionPrefix,Pruned},interface::ScannableBlock,Scanner};
    let miner=Transaction::V2{prefix:TransactionPrefix{additional_timelock:Timelock::None,inputs:vec![Input::Gen(1000)],outputs:vec![],extra:vec![]},proofs:None};
    let block=Block::new(BlockHeader{hardfork_version:16,hardfork_signal:16,timestamp:1_000_000,previous:[0;32],nonce:0},miner,vec![tx.hash()]).unwrap();
    Scanner::new(vault).scan(ScannableBlock{block,transactions:vec![Transaction::<Pruned>::from(tx.clone())],output_index_for_first_ringct_output:Some(9000)}).unwrap().not_additionally_locked()
}

#[test]
fn candidate_same_owner_all_six_subsets_and_attempts_are_stable_through_seal(){
    let mut inputs=copy_inputs(&fixture().inputs[..2]);inputs.sort_by_key(reference_image);let o=owner_with(inputs);
    let expected=issued(&o);let decoded=candidate::decode(&expected.bytes).unwrap();
    let images=o.inputs.iter().map(reference_image).collect::<Vec<_>>();assert!(images[0]<images[1]);
    for (n,x) in decoded.tx.prefix().inputs.iter().enumerate(){assert!(matches!(x,monero_wallet::transaction::Input::ToKey{key_image,key_offsets,..} if *key_image==images[1-n]&&key_offsets.as_slice()==o.inputs[1-n].ring.decoys().offsets()));}
    for (attempt,subset) in [[1,2],[1,3],[1,4],[2,3],[2,4],[3,4]].iter().enumerate(){
        let (pending,messages)=start(&o,subset,[(attempt+1) as u8;32]);
        for (local,p) in subset.iter().zip(pending){assert!(p.candidate.bytes==expected.bytes);assert!(p.candidate.identity()==expected.identity());
            let sealed=p.seal(messages.iter().filter(|m|m.participant!=id(*local)).cloned().collect()).unwrap();assert!(sealed._candidate.bytes==expected.bytes);}
    }
    assert_eq!(count(&o.trace.seals),12);
}

#[test]
fn fresh_seed_changes_actual_body_and_message_with_equal_receipt_and_images(){
    let a=owner(2);let b=owner(2);let ca=issued(&a);let cb=issued(&b);
    let da=candidate::decode(&ca.bytes).unwrap();let db=candidate::decode(&cb.bytes).unwrap();
    assert!(da.body!=db.body);assert!(da.message!=db.message);
    assert!(da.tx.prefix().inputs==db.tx.prefix().inputs);
    for o in [&a,&b]{assert!(o.request==a.request);}
    let restore=|o:&CustodyOwner|synthetic_keeper::restore_owned(&o.path,&o.expected_digest,&hex(&o.id),&hex(&o.binding),Request::decode(&o.request).unwrap(),&o.selection,copy_inputs(&o.inputs),o.vault.clone(),1,1).unwrap();
    assert!(restore(&a).receipt().to_wire()==restore(&b).receipt().to_wire());
    let (mut p,m)=single(&a);p.candidate=cb;let result=p.seal(vec![m[1].clone()]);
    eprintln!("CANDIDATE_SWAP accepted={} seals={}",result.is_ok(),count(&a.trace.seals));
    reject(result,GateError::Candidate);assert_eq!(count(&a.trace.seals),0);
}

#[test]
fn native_semantics_match_scanned_change_and_zero_change_output(){
    let receiver=ViewPair::new(monero_ed25519::Point::from(G),Zeroizing::new(monero_ed25519::Scalar::random(&mut OsRng))).unwrap();
    let text=String::from_utf8(fixture().request.clone()).unwrap();let mut request=text.lines().map(str::to_owned).collect::<Vec<_>>();request[6]=receiver.legacy_address(Network::Testnet).to_string();
    let regular=owner_request((request.join("\n")+"\n").into_bytes());let c=issued(&regular);let d=candidate::decode(&c.bytes).unwrap();let outputs=scan_projection(&d.tx,regular.vault.clone());
    assert_eq!(outputs.len(),1);assert_eq!(outputs[0].commitment().amount,c.semantic.change);
    let payment=scan_projection(&d.tx,receiver);assert_eq!(payment.len(),1);assert_eq!(payment[0].commitment().amount,c.semantic.amount);
    assert_eq!(c.semantic.input_total,20_000_000_000);assert_eq!(c.semantic.amount,1_000_000_000);
    assert!(c.semantic.change_spend==regular.vault.spend().compress().to_bytes());assert!(c.semantic.change_view==regular.vault.view().compress().to_bytes());
    let zero=owner_request(request_amount(c.semantic.input_total-c.semantic.fee));let z=issued(&zero);let zd=candidate::decode(&z.bytes).unwrap();
    assert_eq!(z.semantic.change,0);assert_eq!(zd.tx.prefix().outputs.len(),2);let scanned=scan_projection(&zd.tx,zero.vault.clone());
    assert_eq!(scanned.len(),1);assert_eq!(scanned[0].commitment().amount,0);
    let (p,m)=single(&zero);p.seal(vec![m[1].clone()]).unwrap();assert_eq!(count(&zero.trace.seals),1);
    let mut forged=issued(&zero);let identity=forged.identity();forged.semantic.change=1;assert!(matches!(forged.check(&identity),Err(CandidateError::Binding)));
    let dir=runtime_path();let bad=CustodyOwner::create(&dir.join("private"),&dir.join("journal"),request_amount(z.semantic.input_total-z.semantic.fee+1),copy_inputs(&zero.inputs),zero.vault.clone(),Zeroizing::new(fresh()),Arc::new(Trace::default()));
    reject(bad,GateError::Custody);
}

#[test]
fn public_candidate_excludes_separate_private_semantics(){
    let o=owner(2);let c=issued(&o);let d=candidate::decode(&c.bytes).unwrap();
    assert_eq!(c.bytes.len(),139+d.body.len()+64);assert!(d.owner==o.id);
    assert!(!c.bytes.windows(c.semantic.recipient.len()).any(|w|w==c.semantic.recipient.as_bytes()));
    assert!(!c.bytes.windows(32).any(|w|w==o.expected_digest));
    // Public schema has only fixed IDs, actual public body, message and proposal ID.
    // Hidden semantics remain a distinct field, checked under private issued identity.
    assert_eq!(c.semantic.recipient,Request::decode(&o.request).unwrap().address);
}

#[test]
fn canonical_metadata_body_and_private_semantic_mutations_fail_at_candidate_seal(){
    let o=owner(2);
    for field in 0..4 {let (mut p,m)=single(&o);p.candidate.bytes[7+32*field]^=1;rehash(&mut p.candidate.bytes);
        assert!(candidate::decode(&p.candidate.bytes).is_ok());reject(p.seal(vec![m[1].clone()]),GateError::Candidate);assert_eq!(count(&o.trace.seals),0);}
    let (mut p,m)=single(&o);let mut tx=candidate::decode(&p.candidate.bytes).unwrap().tx;
    let Transaction::V2{proofs:Some(proofs),..}=&mut tx else{panic!("profile")};proofs.base.fee+=1;
    p.candidate.bytes=body_frame(&p.candidate.bytes,&tx);assert!(candidate::decode(&p.candidate.bytes).is_ok());reject(p.seal(vec![m[1].clone()]),GateError::Candidate);
    for field in 0..9 {let (mut p,m)=single(&o);let s=&mut p.candidate.semantic;
        match field {0=>s.amount+=1,1=>s.input_total+=1,2=>s.change+=1,3=>s.fee+=1,4=>s.ceiling+=1,5=>s.change_spend[0]^=1,6=>s.change_view[0]^=1,7=>s.input_count+=1,_=>s.recipient.push('1')}
        let result=p.seal(vec![m[1].clone()]);eprintln!("SEMANTIC_MUTATION field={} accepted={} seals={}",field,result.is_ok(),count(&o.trace.seals));
        reject(result,GateError::Candidate);assert_eq!(count(&o.trace.seals),0);}
}

#[test]
fn fee_and_conservation_predicates_are_independently_load_bearing(){
    assert_eq!(candidate::checked_fee(100,100,101).unwrap(),100);
    assert!(matches!(candidate::checked_fee(100,101,101),Err(CandidateError::Fee)));
    assert!(matches!(candidate::checked_fee(102,102,101),Err(CandidateError::Fee)));
    assert_eq!(candidate::conservation(100,99,1).unwrap(),0);
    for (a,b,c) in [(100,100,1),(u64::MAX,u64::MAX,1),(0,1,0)]{assert!(matches!(candidate::conservation(a,b,c),Err(CandidateError::Conservation)));}
}

fn var_at(bytes:&[u8],at:&mut usize)->u64{let mut n=0;let mut shift=0;loop{let b=bytes[*at];*at+=1;n|=u64::from(b&127)<<shift;if b&128==0{return n}shift+=7;}}
#[test]
fn bounded_unsigned_decoder_rejects_each_declared_count_and_signed_tail(){
    let c=issued(&owner(2));let d=candidate::decode(&c.bytes).unwrap();let bytes=d.body;let mut at=2;
    let mut positions=vec![(at,17u64,CandidateError::Bounds,Some(0u64))];let n=var_at(&bytes,&mut at);
    for _ in 0..n{at+=2;positions.push((at,17,CandidateError::Bounds,Some(15)));let ring=var_at(&bytes,&mut at);for _ in 0..ring{var_at(&bytes,&mut at);}at+=32;}
    positions.push((at,3,CandidateError::Bounds,Some(1)));let outputs=var_at(&bytes,&mut at);for _ in 0..outputs{at+=35;}
    positions.push((at,257,CandidateError::Bounds,None));let extra=var_at(&bytes,&mut at);at+=extra as usize;at+=1;var_at(&bytes,&mut at);at+=80;
    positions.push((at,2,CandidateError::Profile,Some(0)));var_at(&bytes,&mut at);at+=192;positions.push((at,8,CandidateError::Bounds,Some(6)));let l=var_at(&bytes,&mut at);at+=l as usize*32;positions.push((at,8,CandidateError::Bounds,Some(6)));
    for (p,too_many,expected,too_few) in positions {
        let mut end=p;var_at(&bytes,&mut end);let mut encoded=Vec::new();VarInt::write(&too_many,&mut encoded).unwrap();
        let mut altered=bytes.clone();altered.splice(p..end,encoded);assert!(matches!(candidate::unsigned_decode(&altered),Err(e) if e==expected));
        if let Some(n)=too_few{let mut encoded=Vec::new();VarInt::write(&n,&mut encoded).unwrap();let mut altered=bytes.clone();altered.splice(p..end,encoded);assert!(matches!(candidate::unsigned_decode(&altered),Err(CandidateError::Profile)));}
        let mut malformed=bytes.clone();malformed.splice(p..end,[0xff;10]);assert!(matches!(candidate::unsigned_decode(&malformed),Err(CandidateError::Wire)));
    }
    let mut noncanonical=bytes.clone();noncanonical.splice(0..1,[0x82,0]);assert!(matches!(candidate::unsigned_decode(&noncanonical),Err(CandidateError::Canonical)));
    let mut signed=bytes.clone();signed.extend(vec![0u8;n as usize*(16*32+64+32)]);
    let parsed:std::io::Result<Transaction>=Transaction::read(&mut signed.as_slice());assert!(parsed.is_ok());
    assert!(matches!(candidate::unsigned_decode(&signed),Err(CandidateError::Wire)));
    for b in [&bytes[..bytes.len()-1],&[0u8;8193][..]]{assert!(candidate::unsigned_decode(b).is_err());}
}

#[test]
fn frame_domain_lengths_message_proposal_and_trailing_are_closed(){
    let c=issued(&owner(2));for index in [0,4,5,6]{let mut b=c.bytes.to_vec();b[index]^=1;assert!(matches!(candidate::decode(&b),Err(CandidateError::Profile)));}
    let mut b=c.bytes.to_vec();b[135..139].copy_from_slice(&u32::MAX.to_le_bytes());assert!(matches!(candidate::decode(&b),Err(CandidateError::Bounds)));
    let mut b=c.bytes.to_vec();let at=b.len()-64;b[at]^=1;rehash(&mut b);assert!(matches!(candidate::decode(&b),Err(CandidateError::Message)));
    let mut b=c.bytes.to_vec();let n=b.len();b[n-1]^=1;assert!(matches!(candidate::decode(&b),Err(CandidateError::Proposal)));
    let mut b=c.bytes.to_vec();b.push(0);assert!(matches!(candidate::decode(&b),Err(CandidateError::Wire)));
    assert!(candidate::decode(&c.bytes[..c.bytes.len()-1]).is_err());
}

#[test]
fn unsigned_shape_prototype() {
    use monero_wallet::{transaction::{TransactionPrefix,Transaction},ringct::{RctBase,RctPrunable,bulletproofs::Bulletproof}};
    let o=owner(2);let (a,_)=o.restore_guard(fixture().keys[&id(1)].clone(),vec![id(1),id(2)],[9;32]).unwrap();
    let tx=a.native.clone().unsigned_transaction(o.inputs.iter().map(reference_image).collect()).unwrap();
    let bytes=tx.serialize();let mut r=bytes.as_slice();let version:u64=VarInt::read(&mut r).unwrap();assert_eq!(version,2);
    let prefix=TransactionPrefix::read(&mut r,2).unwrap();let prefix_end=bytes.len()-r.len();
    let (kind,base)=RctBase::read(prefix.inputs.len(),prefix.outputs.len(),&mut r).unwrap().unwrap();
    assert_eq!(kind,RctType::ClsagBulletproofPlus);let base_end=bytes.len()-r.len();
    let proof_count:u64=VarInt::read(&mut r).unwrap();assert_eq!(proof_count,1);
    let bp=Bulletproof::read_plus(&mut r).unwrap();assert!(r.is_empty());
    let Transaction::V2{proofs:Some(proofs),..}=&tx else {panic!("unsigned profile")};
    assert!(matches!(&proofs.prunable,RctPrunable::Clsag{clsags,pseudo_outs,..} if clsags.is_empty()&&pseudo_outs.is_empty()));
    assert_eq!(base.fee,a.native.necessary_fee());assert_eq!(prefix.outputs.len(),2);
    let complete:std::io::Result<Transaction>=Transaction::read(&mut bytes.as_slice());assert!(complete.is_err());
    eprintln!("UNSIGNED_SHAPE inputs={} outputs={} prefix_version_bytes={} base_bytes={} proof_count={} bp_bytes={} tail_bytes={} total_bytes={} message_present={}",prefix.inputs.len(),prefix.outputs.len(),prefix_end,base_end-prefix_end,proof_count,bp.serialize().len(),r.len(),bytes.len(),tx.signature_hash().is_some());
}
