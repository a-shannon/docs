//! Exact local unsigned proposal; decoded bytes alone confer no native authority.
use super::*;
use crate::key_image::VerifiedInputImage;
use monero_wallet::{transaction::{Transaction,TransactionPrefix,Input,Timelock},ringct::{RctBase,RctProofs,RctPrunable,bulletproofs::Bulletproof}};
use sha2::{Digest,Sha256};

pub(super) const MAX_BODY:usize=8192;
pub(super) const MAX_FRAME:usize=8400;
const HEADER:&[u8]=b"W1HC\x01\x01\x01"; // version 1, synthetic testnet, CLSAG-BP+ standard-change profile
pub(super) struct Context {pub owner:[u8;32],pub request:Vec<u8>,pub vault:ViewPair,pub fee:FeeRate}
#[derive(Debug,PartialEq,Eq)]
pub(super) enum Error {Bounds,Wire,Profile,Canonical,Message,Proposal,Native,Fee,Conservation,Binding}
type Result<T>=std::result::Result<T,Error>;

// Private native-derived semantic disclosure; never included in the public frame.
pub(super) struct Semantics {
    pub recipient:String,pub amount:u64,pub input_total:u64,pub change:u64,pub fee:u64,
    pub ceiling:u64,pub change_spend:[u8;32],pub change_view:[u8;32],pub input_count:usize,
}
impl Semantics {
    fn bytes(&self)->Vec<u8>{
        let mut b=b"W1h/private-native-semantics/v1\0".to_vec();
        b.extend((self.recipient.len() as u32).to_le_bytes());b.extend(self.recipient.as_bytes());
        for n in [self.amount,self.input_total,self.change,self.fee,self.ceiling,self.input_count as u64]{b.extend(n.to_le_bytes());}
        b.extend(self.change_spend);b.extend(self.change_view);b
    }
}
pub(super) struct IssuedCandidate {pub bytes:Box<[u8]>,pub semantic:Semantics}
pub(super) struct Decoded {pub owner:[u8;32],pub body:Vec<u8>,pub message:[u8;32],pub proposal:[u8;32],pub tx:Transaction}
fn hash(domain:&[u8],bytes:&[u8])->[u8;32]{let mut h=Sha256::new();h.update(domain);h.update(bytes);h.finalize().into()}
fn digest_hex(s:&str)->Result<[u8;32]>{
    if s.len()!=64||!s.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){return Err(Error::Wire);}
    let mut b=[0;32];for (n,x) in b.iter_mut().enumerate(){*x=u8::from_str_radix(&s[2*n..2*n+2],16).map_err(|_|Error::Wire)?;}Ok(b)
}

// Allocation-free declared-count preflight before any published vector reader.
struct Cursor<'a>{r:&'a[u8]}
impl<'a> Cursor<'a>{
    fn take(&mut self,n:usize)->Result<&'a[u8]>{if self.r.len()<n{return Err(Error::Bounds)}let (a,b)=self.r.split_at(n);self.r=b;Ok(a)}
    fn byte(&mut self)->Result<u8>{Ok(self.take(1)?[0])}
    fn var(&mut self)->Result<u64>{
        let mut n=0u64;for i in 0..10 {let b=self.byte()?;if i==9&&b>1{return Err(Error::Wire)}n|=u64::from(b&127)<<(7*i);
            if b&128==0 {if i>0&&b==0{return Err(Error::Canonical)}return Ok(n)}}Err(Error::Wire)
    }
    fn count(&mut self,max:u64)->Result<usize>{let n=self.var()?;if n>max{return Err(Error::Bounds)}Ok(n as usize)}
}
pub(super) fn unsigned_decode(bytes:&[u8])->Result<Transaction>{
    if bytes.is_empty()||bytes.len()>MAX_BODY{return Err(Error::Bounds)}
    let mut c=Cursor{r:bytes};if c.var()?!=2||c.var()?!=0{return Err(Error::Profile)}
    let inputs=c.count(16)?;if inputs==0{return Err(Error::Profile)}
    for _ in 0..inputs {
        if c.byte()?!=2||c.var()?!=0{return Err(Error::Profile)}
        if c.count(16)?!=16{return Err(Error::Profile)}
        for _ in 0..16{c.var()?;}c.take(32)?;
    }
    if c.count(2)?!=2{return Err(Error::Profile)}
    for _ in 0..2{if c.var()?!=0||c.byte()?!=3{return Err(Error::Profile)}c.take(33)?;}
    let extra=c.count(256)?;c.take(extra)?;
    if c.byte()?!=6{return Err(Error::Profile)}c.var()?;c.take(2*8+2*32)?;
    if c.var()?!=1{return Err(Error::Profile)}
    c.take(6*32)?;
    for _ in 0..2{if c.count(7)?!=7{return Err(Error::Profile)}c.take(7*32)?;}
    if !c.r.is_empty(){return Err(Error::Wire)}
    let mut r=bytes;let version:u64=VarInt::read(&mut r).map_err(|_|Error::Wire)?;
    let prefix=TransactionPrefix::read(&mut r,version).map_err(|_|Error::Wire)?;
    let (kind,base)=RctBase::read(inputs,2,&mut r).map_err(|_|Error::Wire)?.ok_or(Error::Profile)?;
    if kind!=RctType::ClsagBulletproofPlus{return Err(Error::Profile)}
    let _:u64=VarInt::read(&mut r).map_err(|_|Error::Wire)?;
    let bulletproof=Bulletproof::read_plus(&mut r).map_err(|_|Error::Wire)?;
    if !r.is_empty(){return Err(Error::Wire)}
    let tx=Transaction::V2{prefix,proofs:Some(RctProofs{base,prunable:RctPrunable::Clsag{bulletproof,clsags:vec![],pseudo_outs:vec![]}})};
    if tx.serialize()!=bytes{return Err(Error::Canonical)}
    Ok(tx)
}
pub(super) fn decode(bytes:&[u8])->Result<Decoded>{
    if bytes.len()>MAX_FRAME{return Err(Error::Bounds)}
    let mut c=Cursor{r:bytes};if c.take(HEADER.len())?!=HEADER{return Err(Error::Profile)}
    let owner=c.take(32)?.try_into().unwrap();c.take(3*32)?;
    let n=u32::from_le_bytes(c.take(4)?.try_into().unwrap()) as usize;if n>MAX_BODY{return Err(Error::Bounds)}
    let body=c.take(n)?.to_vec();let message=c.take(32)?.try_into().unwrap();let proposal=c.take(32)?.try_into().unwrap();
    if !c.r.is_empty(){return Err(Error::Wire)}
    let tx=unsigned_decode(&body)?;
    if tx.signature_hash()!=Some(message){return Err(Error::Message)}
    if hash(b"W1h/local-native-proposal/v1\0",&bytes[..bytes.len()-32])!=proposal{return Err(Error::Proposal)}
    Ok(Decoded{owner,body,message,proposal,tx})
}
pub(super) fn conservation(total:u64,payment:u64,fee:u64)->Result<u64>{
    let spent=payment.checked_add(fee).ok_or(Error::Conservation)?;
    let change=total.checked_sub(spent).ok_or(Error::Conservation)?;
    if payment.checked_add(change).and_then(|x|x.checked_add(fee))!=Some(total){return Err(Error::Conservation)}Ok(change)
}
pub(super) fn checked_fee(actual:u64,necessary:u64,ceiling:u64)->Result<u64>{
    if actual!=necessary||actual>ceiling{return Err(Error::Fee)}Ok(actual)
}
impl IssuedCandidate {
    pub fn issue(native:&SignableTransaction,context:&Context,inputs:&[PreparedInput],certs:&[VerifiedInputImage])->Result<Self>{
        let req=Request::decode(&context.request).map_err(|_|Error::Native)?;
        if req.network!=Network::Testnet{return Err(Error::Profile)}
        bound_inputs(inputs,&context.vault).map_err(|_|Error::Native)?;
        if certs.len()!=inputs.len(){return Err(Error::Native)}
        let rings=inputs.iter().map(|x|x.ring.clone()).collect::<Vec<_>>();
        let private=Zeroizing::new(native.serialize());
        let actual=native_projection(&private,&req,&rings,&context.vault,context.fee).map_err(|_|Error::Native)?;
        let images=certs.iter().zip(inputs).map(|(c,i)|{
            if c.identity().output_key()!=i.ring.key().compress().to_bytes(){return Err(Error::Native)}Ok(CompressedPoint::from(c.image()))
        }).collect::<Result<Vec<_>>>()?;
        let tx=native.clone().unsigned_transaction(images.clone()).ok_or(Error::Native)?;
        let Transaction::V2{prefix,proofs:Some(proofs)}=&tx else{return Err(Error::Profile)};
        if prefix.additional_timelock!=Timelock::None||prefix.outputs.len()!=2||!proofs.base.pseudo_outs.is_empty(){return Err(Error::Profile)}
        if !matches!(&proofs.prunable,RctPrunable::Clsag{bulletproof:Bulletproof::Plus(_),clsags,pseudo_outs} if clsags.is_empty()&&pseudo_outs.is_empty()){return Err(Error::Profile)}
        let mut paired=images.into_iter().zip(&rings).collect::<Vec<_>>();paired.sort_by(|a,b|b.0.cmp(&a.0));
        for (input,(image,ring)) in prefix.inputs.iter().zip(&paired){
            if !matches!(input,Input::ToKey{amount:None,key_image,key_offsets} if key_image==image&&key_offsets==ring.decoys().offsets()){return Err(Error::Native)}
        }
        let fee=checked_fee(proofs.base.fee,native.necessary_fee(),req.max_miner_fee)?;
        let change=conservation(actual.input_total,actual.amount,fee)?;
        let semantic=Semantics{recipient:actual.recipient,amount:actual.amount,input_total:actual.input_total,change,fee,ceiling:req.max_miner_fee,
            change_spend:actual.change_spend,change_view:actual.change_view,input_count:actual.input_count};
        let body=tx.serialize();unsigned_decode(&body)?;
        let mut bytes=HEADER.to_vec();bytes.extend(context.owner);
        for id in [&req.event_id,&req.instruction_digest,&req.request_digest]{bytes.extend(digest_hex(id)?);}
        bytes.extend((body.len() as u32).to_le_bytes());bytes.extend(body);bytes.extend(tx.signature_hash().ok_or(Error::Message)?);
        let proposal=hash(b"W1h/local-native-proposal/v1\0",&bytes);bytes.extend(proposal);
        decode(&bytes)?;Ok(Self{bytes:bytes.into_boxed_slice(),semantic})
    }
    pub fn identity(&self)->[u8;32]{let mut b=self.bytes.to_vec();b.extend(self.semantic.bytes());hash(b"W1h/private-issued-candidate/v1\0",&b)}
    pub fn check(&self,expected:&[u8;32])->Result<()> {
        decode(&self.bytes)?;
        if self.identity()!=*expected{return Err(Error::Binding)}
        Ok(())
    }
}
