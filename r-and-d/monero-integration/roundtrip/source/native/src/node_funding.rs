//! Isolated fakechain provider. Deterministic rings are a fixture policy, not
//! production decoy selection. This module never owns an aggregate spend key.
use super::*;
use monero_wallet::{Scanner,block::Block,interface::ScannableBlock,
    transaction::{Transaction,Pruned},ed25519::{Point,Scalar},ringct::clsag::Decoys};
use serde_json::{json,Value};
use std::{net::{TcpStream,SocketAddrV4,Ipv4Addr},time::Duration,fs::OpenOptions};

const MAX_RPC: usize = 2_097_152;
struct Rpc { port:u16 }
fn number(v:&Value,key:&str)->HostResult<u64>{v.get(key).and_then(Value::as_u64).ok_or(())}
fn bytes(s:&str,max:usize)->HostResult<Vec<u8>>{
    if s.is_empty()||s.len()%2!=0||s.len()>max*2||!s.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){return Err(())}
    s.as_bytes().chunks_exact(2).map(|p|u8::from_str_radix(std::str::from_utf8(p).map_err(|_|())?,16).map_err(|_|())).collect()
}
fn digest(s:&str)->HostResult<[u8;32]>{bytes(s,32)?.try_into().map_err(|_|())}
fn string<'a>(v:&'a Value,key:&str)->HostResult<&'a str>{v.get(key).and_then(Value::as_str).ok_or(())}
fn local_profile(v:&Value)->HostResult<()> {
    if string(v,"nettype")?!="fakechain"||v.get("offline")!=Some(&Value::Bool(true)){return Err(())}
    for key in ["mainnet","testnet","stagenet"] {if v.get(key)!=Some(&Value::Bool(false)){return Err(())}}
    for key in ["incoming_connections_count","outgoing_connections_count"] {if number(v,key)?!=0{return Err(())}}
    Ok(())
}
impl Rpc {
    fn connect()->HostResult<Self>{
        let p=std::env::var("MONERO_LOCAL_RPC_PORT").map_err(|_|())?;
        if p.is_empty()||p.starts_with('0')||!p.bytes().all(|b|b.is_ascii_digit()){return Err(())}
        let port=p.parse::<u16>().map_err(|_|())?;if port==0{return Err(())}
        let rpc=Self{port};rpc.check()?;Ok(rpc)
    }
    fn call(&self,path:&str,payload:Value)->HostResult<Value>{
        let body=serde_json::to_vec(&payload).map_err(|_|())?;if body.len()>MAX_RPC{return Err(())}
        let address=SocketAddrV4::new(Ipv4Addr::LOCALHOST,self.port);
        let mut socket=TcpStream::connect_timeout(&address.into(),Duration::from_secs(5)).map_err(|_|())?;
        socket.set_read_timeout(Some(Duration::from_secs(45))).map_err(|_|())?;
        socket.set_write_timeout(Some(Duration::from_secs(5))).map_err(|_|())?;
        write!(socket,"POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).map_err(|_|())?;
        socket.write_all(&body).map_err(|_|())?;
        let mut raw=Vec::new();socket.take((MAX_RPC+1) as u64).read_to_end(&mut raw).map_err(|_|())?;
        if raw.len()>MAX_RPC{return Err(())}
        let split=raw.windows(4).position(|v|v==b"\r\n\r\n").ok_or(())?;
        if split>8192{return Err(())}
        let header=std::str::from_utf8(&raw[..split]).map_err(|_|())?;
        if !header.starts_with("HTTP/1.1 200 ")&&!header.starts_with("HTTP/1.0 200 "){return Err(())}
        let mut lengths=header.lines().filter_map(|l|l.split_once(':')).filter(|(k,_)|k.eq_ignore_ascii_case("content-length"));
        let len=lengths.next().ok_or(())?.1.trim().parse::<usize>().map_err(|_|())?;
        if lengths.next().is_some()||len!=raw.len()-split-4||header.to_ascii_lowercase().contains("transfer-encoding:"){return Err(())}
        let v:Value=serde_json::from_slice(&raw[split+4..]).map_err(|_|())?;
        if v.get("error").is_some(){return Err(())}
        let v=v.get("result").cloned().unwrap_or(v);
        if string(&v,"status")?!="OK"||v.get("untrusted")==Some(&Value::Bool(true)){return Err(())}Ok(v)
    }
    fn json(&self,method:&str,params:Value)->HostResult<Value>{self.call("/json_rpc",json!({"jsonrpc":"2.0","id":"0","method":method,"params":params}))}
    fn check(&self)->HostResult<u64>{
        let info=self.json("get_info",json!({}))?;local_profile(&info)?;
        if number(&self.json("hard_fork_info",json!({}))?,"version")?!=16{return Err(())}
        number(&info,"height")
    }
    fn mine(&self,address:String,count:u64)->HostResult<()> {
        self.check()?;if count==0||count>60{return Err(())}
        let r=self.json("generateblocks",json!({"wallet_address":address,"amount_of_blocks":count}))?;
        if r.get("blocks").and_then(Value::as_array).ok_or(())?.len()!=count as usize{return Err(())}Ok(())
    }
    fn tx(&self,id:[u8;32])->HostResult<Value>{
        let result=self.call("/get_transactions",json!({"txs_hashes":[hex(&id)],"decode_as_json":false,"prune":false}))?;
        let txs=result.get("txs").and_then(Value::as_array).ok_or(())?;
        if txs.len()!=1||digest(string(&txs[0],"tx_hash")?)?!=id||txs[0].get("in_pool")!=Some(&Value::Bool(false)){return Err(())}Ok(txs[0].clone())
    }
    fn block(&self,height:u64)->HostResult<ScannableBlock>{
        let response=self.json("get_block",json!({"height":height}))?;
        let header=response.get("block_header").ok_or(())?;
        if number(header,"height")?!=height||header.get("orphan_status")!=Some(&Value::Bool(false)){return Err(())}
        let blob=bytes(string(&response,"blob")?,MAX_RPC/2)?;let mut reader=blob.as_slice();
        let block=Block::read(&mut reader).map_err(|_|())?;
        if !reader.is_empty()||block.hash()!=digest(string(header,"hash")?)?||block.header.hardfork_version!=16{return Err(())}
        let miner=self.tx(block.miner_transaction().hash())?;
        if number(&miner,"block_height")?!=height{return Err(())}
        let indexes=miner.get("output_indices").and_then(Value::as_array).ok_or(())?;
        if indexes.len()!=block.miner_transaction().prefix().outputs.len(){return Err(())}
        let first=indexes.first().and_then(Value::as_u64).ok_or(())?;
        let mut expected=first;
        for i in indexes {if i.as_u64()!=Some(expected){return Err(())}expected=expected.checked_add(1).ok_or(())?;}
        let mut transactions=Vec::new();
        if block.transactions.len()>16{return Err(())}
        for id in &block.transactions {
            let row=self.tx(*id)?;if number(&row,"block_height")?!=height{return Err(())}
            let blob=bytes(string(&row,"as_hex")?,MAX_RPC/2)?;let mut reader=blob.as_slice();
            let tx=Transaction::read(&mut reader).map_err(|_|())?;
            if !reader.is_empty()||tx.hash()!=*id{return Err(())}
            let indexes=row.get("output_indices").and_then(Value::as_array).ok_or(())?;
            if indexes.len()!=tx.prefix().outputs.len(){return Err(())}
            for i in indexes {if i.as_u64()!=Some(expected){return Err(())}expected=expected.checked_add(1).ok_or(())?;}
            transactions.push(Transaction::<Pruned>::from(tx));
        }
        Ok(ScannableBlock{block,transactions,output_index_for_first_ringct_output:Some(first)})
    }
    fn ring(&self,output:&WalletOutput,indices:&[u64],height:u64)->HostResult<OutputWithDecoys>{
        if indices.len()!=16||!indices.windows(2).all(|w|w[0]<w[1]){return Err(())}
        let real=indices.iter().position(|i|*i==output.index_on_blockchain()).ok_or(())?;
        let result=self.call("/get_outs",json!({"outputs":indices.iter().map(|i|json!({"amount":0,"index":i})).collect::<Vec<_>>(),"get_txid":true}))?;
        let rows=result.get("outs").and_then(Value::as_array).ok_or(())?;if rows.len()!=16{return Err(())}
        let mut points=Vec::new();
        for row in rows {
            // All fixture ring members are mined coinbase outputs; enforce 60,
            // stronger than the ordinary-output age of 10, plus daemon unlock.
            if row.get("unlocked")!=Some(&Value::Bool(true))||number(row,"height")?.checked_add(60).ok_or(())?>height{return Err(())}
            points.push([CompressedPoint::from(digest(string(row,"key")?)?).decompress().ok_or(())?,CompressedPoint::from(digest(string(row,"mask")?)?).decompress().ok_or(())?]);
        }
        if points[real]!=[output.key(),output.commitment().commit()]||digest(string(&rows[real],"txid")?)?!=output.transaction(){return Err(())}
        let mut offsets=vec![indices[0]];offsets.extend(indices.windows(2).map(|w|w[1]-w[0]));
        let decoys=Decoys::new(offsets,real as u8,points).ok_or(())?;
        let mut serialized=Zeroizing::new(output.key().compress().to_bytes().to_vec());
        output.key_offset().write(&mut *serialized).map_err(|_|())?;output.commitment().write(&mut *serialized).map_err(|_|())?;
        decoys.write(&mut *serialized).map_err(|_|())?;
        let mut reader=serialized.as_slice();let ring=OutputWithDecoys::read(&mut reader).map_err(|_|())?;
        if !reader.is_empty(){return Err(())}Ok(ring)
    }
}
fn recipient()->HostResult<ViewPair>{ViewPair::new(Point::from(curve25519_dalek::constants::ED25519_BASEPOINT_POINT),Zeroizing::new(Scalar::from(curve25519_dalek::scalar::Scalar::ONE))).map_err(|_|())}
#[cfg(feature="participant-host")]
fn public_vault(group:[u8;32])->HostResult<ViewPair>{
    ViewPair::new(CompressedPoint::from(group).decompress().ok_or(())?,Zeroizing::new(Scalar::from(curve25519_dalek::scalar::Scalar::ONE))).map_err(|_|())
}
#[cfg(feature="participant-host")]
fn genesis(rpc:&Rpc)->HostResult<[u8;32]>{
    let r=rpc.json("get_block_header_by_height",json!({"height":0}))?;
    let h=r.get("block_header").ok_or(())?;
    if number(h,"height")?!=0||h.get("orphan_status")!=Some(&Value::Bool(false)){return Err(())}
    digest(string(h,"hash")?)
}
#[cfg(feature="participant-host")]
pub(in crate::common_owner) fn participant_fund(group:[u8;32])->HostResult<Value>{
    let rpc=Rpc::connect()?;let start=rpc.check()?;let original_genesis=genesis(&rpc)?;
    let vault=public_vault(group)?;
    rpc.mine(vault.legacy_address(Network::Mainnet).to_string(),18)?;
    rpc.mine(recipient()?.legacy_address(Network::Mainnet).to_string(),60)?;
    let height=rpc.check()?;let mut scanner=Scanner::new(vault.clone());let mut outputs=Vec::new();let mut hashes=Vec::new();
    for n in start..start+18 {let block=rpc.block(n)?;hashes.push(hex(&block.block.hash()));outputs.extend(scanner.scan(block).map_err(|_|())?.additional_timelock_satisfied_by(height as usize,0));}
    if outputs.len()!=18||genesis(&rpc)?!=original_genesis{return Err(())}
    let mut indices=outputs.iter().map(WalletOutput::index_on_blockchain).collect::<Vec<_>>();indices.sort_unstable();indices.truncate(16);
    let ids=outputs.iter().take(2).map(|o|json!({"transaction":hex(&o.transaction()),"index":o.index_in_transaction(),"chainIndex":o.index_on_blockchain()})).collect::<Vec<_>>();
    Ok(json!({"type":"funded","id":1,"genesis":hex(&original_genesis),"source":{"kind":"coinbase","startHeight":start,"blockHashes":hashes,"ringIndices":indices,"outputIds":ids},"vaultAddress":vault.legacy_address(Network::Mainnet).to_string()}))
}
#[cfg(feature="participant-host")]
fn scan_deposit(rpc:&Rpc,vault:&ViewPair,deposit:&Value,height:u64)->HostResult<WalletOutput>{
    crate::participant_envelope::fields(deposit,&["txId","txBytes","blockHash","blockHeight","outputKey","outputIndex","chainIndex","amountAtomic","feeAtomic"])?;
    let txid=digest(string(deposit,"txId")?)?;let block_height=number(deposit,"blockHeight")?;
    if block_height.checked_add(60).ok_or(())?>height{return Err(())}
    let row=rpc.tx(txid)?;if number(&row,"block_height")?!=block_height||string(&row,"as_hex")?!=string(deposit,"txBytes")?{return Err(())}
    let blob=bytes(string(deposit,"txBytes")?,MAX_RPC/2)?;let mut r=blob.as_slice();let tx=Transaction::read(&mut r).map_err(|_|())?;
    if !r.is_empty()||tx.serialize()!=blob||tx.hash()!=txid{return Err(())}
    let Transaction::V2{proofs:Some(ref proofs),..}=tx else{return Err(())};
    if proofs.base.fee.to_string()!=string(deposit,"feeAtomic")?{return Err(())}
    let block=rpc.block(block_height)?;
    if block.block.hash()!=digest(string(deposit,"blockHash")?)?||block.block.transactions.iter().filter(|id|**id==txid).count()!=1{return Err(())}
    let mut outputs=Scanner::new(vault.clone()).scan(block).map_err(|_|())?.not_additionally_locked().into_iter().filter(|o|o.transaction()==txid).collect::<Vec<_>>();
    if outputs.len()!=1{return Err(())}let output=outputs.remove(0);
    if output.key().compress().to_bytes()!=digest(string(deposit,"outputKey")?)?||output.index_in_transaction()!=number(deposit,"outputIndex")?
        ||output.index_on_blockchain()!=number(deposit,"chainIndex")?||output.commitment().amount.to_string()!=string(deposit,"amountAtomic")?
        ||output.commitment().amount!=500_000_240{return Err(())}
    Ok(output)
}
#[cfg(feature="participant-host")]
pub(in crate::common_owner) fn participant_fund_deposit(group:[u8;32],directory:&Path)->HostResult<Value>{
    if !directory.is_absolute(){return Err(())}std::fs::create_dir_all(directory).map_err(|_|())?;
    if std::fs::read_dir(directory).map_err(|_|())?.next().is_some(){return Err(())}
    let guard=directory.join("donor-session.private");let mut guard_file=OpenOptions::new().write(true).create_new(true).open(&guard).map_err(|_|())?;
    guard_file.write_all(b"WMDONOR1\n").map_err(|_|())?;guard_file.sync_all().map_err(|_|())?;
    let rpc=Rpc::connect()?;let original_genesis=genesis(&rpc)?;let donor_start=rpc.check()?;
    let donor=recipient()?;let vault=public_vault(group)?;
    rpc.mine(donor.legacy_address(Network::Mainnet).to_string(),18)?;
    let start=rpc.check()?;rpc.mine(vault.legacy_address(Network::Mainnet).to_string(),18)?;
    rpc.mine(donor.legacy_address(Network::Mainnet).to_string(),60)?;
    let height=rpc.check()?;let mut donor_scanner=Scanner::new(donor.clone());let mut donor_outputs=Vec::new();
    for n in donor_start..donor_start+18{donor_outputs.extend(donor_scanner.scan(rpc.block(n)?).map_err(|_|())?.additional_timelock_satisfied_by(height as usize,0));}
    if donor_outputs.len()!=18{return Err(())}
    let mut donor_indices=donor_outputs.iter().map(WalletOutput::index_on_blockchain).collect::<Vec<_>>();donor_indices.sort_unstable();donor_indices.truncate(16);
    let donor_ring=rpc.ring(&donor_outputs[0],&donor_indices,height)?;
    let estimate=rpc.json("get_fee_estimate",json!({"grace_blocks":10}))?;
    let fee=FeeRate::new(number(&estimate,"fee")?,number(&estimate,"quantization_mask")?).ok_or(())?;
    let outgoing=Zeroizing::new(fresh());
    let tx_secret=monero_wallet::send::TransactionKeys::new(&outgoing,vec![(donor_ring.key(),donor_ring.commitment().commit())]).next().ok_or(())?;
    let native=SignableTransaction::new(RctType::ClsagBulletproofPlus,outgoing,vec![donor_ring],
        vec![(vault.legacy_address(Network::Testnet),500_000_240)],Change::new(donor.clone(),None),vec![],fee).map_err(|_|())?;
    // Explicit fixture donor scalar1 only. The threshold spend scalar is never
    // reconstructed or accepted by this funding path.
    let tx=native.sign(&mut OsRng,&Zeroizing::new(Scalar::from(curve25519_dalek::scalar::Scalar::ONE))).map_err(|_|())?;
    let extra=monero_wallet::extra::Extra::read(&mut tx.prefix().extra.as_slice()).map_err(|_|())?;
    let (tx_keys,additional)=extra.keys().ok_or(())?;
    let tx_scalar=Zeroizing::new(curve25519_dalek::scalar::Scalar::from_canonical_bytes(<[u8;32]>::from(*tx_secret)).into_option().ok_or(())?);
    let expected_public=Point::from(curve25519_dalek::constants::ED25519_BASEPOINT_POINT * *tx_scalar);
    if tx_keys!=vec![expected_public]||additional.is_some(){return Err(())}
    let mut private=Zeroizing::new(Vec::new());tx_secret.write(&mut *private).map_err(|_|())?;
    let key_path=directory.join("donor-tx-key.private");let mut key_file=OpenOptions::new().write(true).create_new(true).open(&key_path).map_err(|_|())?;
    key_file.write_all(&private).map_err(|_|())?;key_file.sync_all().map_err(|_|())?;
    let readback=Zeroizing::new(std::fs::read(&key_path).map_err(|_|())?);if *readback!=*private||readback.len()!=32{return Err(())}
    let txid=tx.hash();let raw=tx.serialize();rpc.check()?;
    let submitted=rpc.call("/send_raw_transaction",json!({"tx_as_hex":hex(&raw),"do_not_relay":false}))?;
    for flag in ["double_spend","fee_too_low","invalid_input","invalid_output","low_mixin","not_rct","overspend","too_big","too_few_outputs"]{if submitted.get(flag)==Some(&Value::Bool(true)){return Err(())}}
    let admission_height=rpc.check()?;rpc.mine(donor.legacy_address(Network::Mainnet).to_string(),1)?;
    rpc.mine(donor.legacy_address(Network::Mainnet).to_string(),60)?;let height=rpc.check()?;
    let admission=rpc.block(admission_height)?;
    if admission.block.transactions.iter().filter(|id|**id==txid).count()!=1{return Err(())}
    let deposit_outputs=Scanner::new(vault.clone()).scan(admission.clone()).map_err(|_|())?.not_additionally_locked().into_iter().filter(|o|o.transaction()==txid).collect::<Vec<_>>();
    if deposit_outputs.len()!=1{return Err(())}let deposit_output=&deposit_outputs[0];
    let Transaction::V2{proofs:Some(ref proofs),..}=tx else{return Err(())};
    let deposit=json!({"txId":hex(&txid),"txBytes":hex(&raw),"blockHash":hex(&admission.block.hash()),"blockHeight":admission_height,
        "outputKey":hex(&deposit_output.key().compress().to_bytes()),"outputIndex":deposit_output.index_in_transaction(),"chainIndex":deposit_output.index_on_blockchain(),
        "amountAtomic":deposit_output.commitment().amount.to_string(),"feeAtomic":proofs.base.fee.to_string()});
    let ordinary=scan_deposit(&rpc,&vault,&deposit,height)?;
    let mut scanner=Scanner::new(vault.clone());let mut reserves=Vec::new();let mut hashes=Vec::new();
    for n in start..start+18{let block=rpc.block(n)?;hashes.push(hex(&block.block.hash()));reserves.extend(scanner.scan(block).map_err(|_|())?.additional_timelock_satisfied_by(height as usize,0));}
    if reserves.len()!=18||genesis(&rpc)?!=original_genesis{return Err(())}
    let mut indices=reserves.iter().map(WalletOutput::index_on_blockchain).collect::<Vec<_>>();indices.sort_unstable();indices.truncate(15);indices.push(ordinary.index_on_blockchain());indices.sort_unstable();
    let ids=[&reserves[0],&ordinary].iter().map(|o|json!({"transaction":hex(&o.transaction()),"index":o.index_in_transaction(),"chainIndex":o.index_on_blockchain()})).collect::<Vec<_>>();
    Ok(json!({"type":"funded","id":1,"genesis":hex(&original_genesis),"source":{"kind":"deposit","startHeight":start,"blockHashes":hashes,"ringIndices":indices,"outputIds":ids,"deposit":deposit},"vaultAddress":vault.legacy_address(Network::Mainnet).to_string(),"snapshot":{"height":height,"hash":hex(&rpc.block(height-1)?.block.hash())}}))
}
#[cfg(feature="participant-host")]
pub(in crate::common_owner) fn participant_scan(group:[u8;32],expected_genesis:[u8;32],source:&Value,directory:&Path)->HostResult<(ViewPair,Vec<PreparedInput>,(u64,u64))>{
    participant_scan_inner(group,expected_genesis,source,Some(directory))
}
#[cfg(feature="participant-host")]
pub(in crate::common_owner) fn participant_scan_readonly(group:[u8;32],expected_genesis:[u8;32],source:&Value)->HostResult<(ViewPair,Vec<PreparedInput>,(u64,u64))>{
    participant_scan_inner(group,expected_genesis,source,None)
}
#[cfg(feature="participant-host")]
fn participant_scan_inner(group:[u8;32],expected_genesis:[u8;32],source:&Value,directory:Option<&Path>)->HostResult<(ViewPair,Vec<PreparedInput>,(u64,u64))>{
    use crate::participant_envelope as w;
    let deposit_mode=match string(source,"kind")?{"coinbase"=>false,"deposit"=>true,_=>return Err(())};
    if deposit_mode{w::fields(source,&["kind","startHeight","blockHashes","ringIndices","outputIds","deposit"])?;}
    else{w::fields(source,&["kind","startHeight","blockHashes","ringIndices","outputIds"])?;}
    let start=number(source,"startHeight")?;
    let hashes=source.get("blockHashes").and_then(Value::as_array).ok_or(())?;
    let indices=source.get("ringIndices").and_then(Value::as_array).ok_or(())?.iter().map(|v|v.as_u64().ok_or(())).collect::<HostResult<Vec<_>>>()?;
    let ids=source.get("outputIds").and_then(Value::as_array).ok_or(())?;
    if hashes.len()!=18||ids.len()!=2||indices.len()!=16{return Err(())}
    let rpc=Rpc::connect()?;let height=rpc.check()?;
    if genesis(&rpc)?!=expected_genesis{return Err(())}
    let vault=public_vault(group)?;let mut scanner=Scanner::new(vault.clone());let mut outputs=Vec::new();
    for (offset,hash) in hashes.iter().enumerate(){let block=rpc.block(start.checked_add(offset as u64).ok_or(())?)?;
        if hex(&block.block.hash())!=hash.as_str().ok_or(())?{return Err(())}
        outputs.extend(scanner.scan(block).map_err(|_|())?.additional_timelock_satisfied_by(height as usize,0));}
    if outputs.len()!=18{return Err(())}
    let mut actual_indices=outputs.iter().map(WalletOutput::index_on_blockchain).collect::<Vec<_>>();actual_indices.sort_unstable();actual_indices.truncate(if deposit_mode{15}else{16});
    if deposit_mode{let ordinary=scan_deposit(&rpc,&vault,&source["deposit"],height)?;actual_indices.push(ordinary.index_on_blockchain());actual_indices.sort_unstable();outputs.truncate(1);outputs.push(ordinary);}
    if actual_indices!=indices{return Err(())}
    let mut prepared=Vec::new();
    for (scanned,id) in outputs.into_iter().take(2).zip(ids){
        w::fields(id,&["transaction","index","chainIndex"])?;
        if digest(string(id,"transaction")?)?!=scanned.transaction()||number(id,"index")?!=scanned.index_in_transaction()||number(id,"chainIndex")?!=scanned.index_on_blockchain(){return Err(())}
        let ring=rpc.ring(&scanned,&indices,height)?;prepared.push(PreparedInput{scanned,ring});
    }
    // Recheck canonical source blocks after all scanner/ring reads.
    for (offset,hash) in hashes.iter().enumerate(){if hex(&rpc.block(start+offset as u64)?.block.hash())!=hash.as_str().ok_or(())?{return Err(())}}
    if deposit_mode{scan_deposit(&rpc,&vault,&source["deposit"],height)?;}
    if genesis(&rpc)?!=expected_genesis{return Err(())}
    let estimate=rpc.json("get_fee_estimate",json!({"grace_blocks":10}))?;
    let fee=(number(&estimate,"fee")?,number(&estimate,"quantization_mask")?);FeeRate::new(fee.0,fee.1).ok_or(())?;
    let total=prepared.iter().try_fold(0u64,|sum,p|sum.checked_add(p.scanned.commitment().amount).ok_or(()))?;
    if let Some(directory)=directory{
        let mut record=Zeroizing::new(vault.spend().compress().to_bytes().to_vec());Scalar::from(curve25519_dalek::scalar::Scalar::ONE).write(&mut *record).map_err(|_|())?;record.extend(total.to_le_bytes());
        let mut file=OpenOptions::new().write(true).create_new(true).open(directory.join("node-view.private")).map_err(|_|())?;
        file.write_all(&record).map_err(|_|())?;file.sync_all().map_err(|_|())?;
    }
    Ok((vault,prepared,fee))
}
#[cfg(feature="participant-host")]
pub(in crate::common_owner) fn participant_snapshot(expected_genesis:[u8;32],snapshot:&Value)->HostResult<()>{
    crate::participant_envelope::fields(snapshot,&["height","hash"])?;
    let height=number(snapshot,"height")?;
    if height==0||height>4096{return Err(())}
    let rpc=Rpc::connect()?;
    if genesis(&rpc)?!=expected_genesis||rpc.check()?!=height||rpc.block(height-1)?.block.hash()!=digest(string(snapshot,"hash")?)?{return Err(())}Ok(())
}
#[cfg(feature="participant-host")]
pub(in crate::common_owner) fn participant_unspent_history(expected_genesis:[u8;32],snapshot:&Value,output_key:[u8;32],key_image:[u8;32])->HostResult<usize>{
    participant_snapshot(expected_genesis,snapshot)?;let rpc=Rpc::connect()?;let height=number(snapshot,"height")?;
    let mut occurrences=0usize;
    // Full bounded chain traversal includes miner and ordinary outputs. Genesis
    // may use an earlier transaction format, so only this count reader permits
    // historical versions; source/ring admission still uses the HF16 provider.
    for n in 0..height{
        let response=rpc.json("get_block",json!({"height":n}))?;let header=response.get("block_header").ok_or(())?;
        if number(header,"height")?!=n||header.get("orphan_status")!=Some(&Value::Bool(false)){return Err(())}
        let blob=bytes(string(&response,"blob")?,MAX_RPC/2)?;let mut reader=blob.as_slice();let block=Block::read(&mut reader).map_err(|_|())?;
        if !reader.is_empty()||block.hash()!=digest(string(header,"hash")?)?||block.transactions.len()>16{return Err(())}
        occurrences+=block.miner_transaction().prefix().outputs.iter().filter(|o|o.key.to_bytes()==output_key).count();
        for txid in &block.transactions{let row=rpc.tx(*txid)?;if number(&row,"block_height")?!=n{return Err(())}
            let blob=bytes(string(&row,"as_hex")?,MAX_RPC/2)?;let mut reader=blob.as_slice();let tx=Transaction::read(&mut reader).map_err(|_|())?;
            if !reader.is_empty()||tx.serialize()!=blob||tx.hash()!=*txid{return Err(())}
            occurrences+=tx.prefix().outputs.iter().filter(|o|o.key.to_bytes()==output_key).count();
        }
    }
    if occurrences!=1{return Err(())}
    let spent=rpc.call("/is_key_image_spent",json!({"key_images":[hex(&key_image)]}))?;
    if spent.get("spent_status")!=Some(&json!([0])){return Err(())}
    participant_snapshot(expected_genesis,snapshot)?;Ok(occurrences)
}
#[cfg(feature="participant-host")]
pub(in crate::common_owner) fn participant_change(group:[u8;32],candidate:&crate::candidate::IssuedCandidate,source:&Value)->HostResult<([u8;32],u64)>{
    let decoded=crate::candidate::decode(&candidate.bytes).map_err(|_|())?;
    // Scanner projection over the locally constructed candidate. The temporary
    // container supplies only Scanner's block-shaped API; this is not a claim
    // that the candidate exists on chain. Exact change identity is captured now.
    let rpc=Rpc::connect()?;let mut container=rpc.block(number(source,"startHeight")?)?;
    let candidate_id=decoded.tx.hash();container.block.transactions=vec![candidate_id];
    container.transactions=vec![Transaction::<Pruned>::from(decoded.tx)];
    let outputs=Scanner::new(public_vault(group)?).scan(container).map_err(|_|())?.ignore_additional_timelock()
        .into_iter().filter(|o|o.transaction()==candidate_id).collect::<Vec<_>>();
    if outputs.len()!=1||outputs[0].commitment().amount!=candidate.semantic.change{return Err(())}
    Ok((outputs[0].key().compress().to_bytes(),outputs[0].index_in_transaction()))
}
#[cfg(feature="participant-host")]
pub(in crate::common_owner) struct ObservationAnchor {
    pub genesis:[u8;32], pub group:[u8;32], pub candidate_identity:[u8;32], pub candidate:Vec<u8>,
}
#[cfg(feature="participant-host")]
fn observed_semantics(anchor:&ObservationAnchor,request:&Request,fee:u64,change:u64,input_count:usize)->HostResult<u64>{
    let vault=public_vault(anchor.group)?;
    let total=request.amount.checked_add(fee).and_then(|v|v.checked_add(change)).ok_or(())?;
    let candidate=crate::candidate::IssuedCandidate{bytes:anchor.candidate.clone().into_boxed_slice(),semantic:crate::candidate::Semantics{
        recipient:request.address.clone(),amount:request.amount,input_total:total,change,fee,ceiling:request.max_miner_fee,
        change_spend:anchor.group,change_view:vault.view().compress().to_bytes(),input_count}};
    // Recovery already validated these exact candidate bytes. Reconstructing the
    // private semantic commitment from the actual scans closes amount/fee/total
    // and the original group, without trusting node-view.private at observation.
    if candidate.identity()!=anchor.candidate_identity{return Err(())}Ok(total)
}
#[cfg(feature="participant-host")]
fn with_observation_genesis<T>(expected:[u8;32],mut read:impl FnMut()->HostResult<[u8;32]>,observe:impl FnOnce()->HostResult<T>)->HostResult<T>{
    if read()?!=expected{return Err(())}let result=observe()?;
    if read()?!=expected{return Err(())}Ok(result)
}
#[cfg(feature="participant-host")]
pub(in crate::common_owner) fn participant_observe(anchor:ObservationAnchor,request:Request,final_bytes:Vec<u8>)->HostResult<Value>{
    let vault=public_vault(anchor.group)?;
    let recipient=recipient()?;
    if request.network!=Network::Testnet||request.address!=recipient.legacy_address(Network::Testnet).to_string(){return Err(())}
    let mut r=final_bytes.as_slice();let tx=Transaction::read(&mut r).map_err(|_|())?;
    if !r.is_empty()||tx.serialize()!=final_bytes{return Err(())}let txid=tx.hash();
    let Transaction::V2{proofs:Some(ref proofs),..}=tx else{return Err(())};
    let fee=proofs.base.fee;if fee>request.max_miner_fee{return Err(())}
    let rpc=Rpc::connect()?;
    with_observation_genesis(anchor.genesis,||genesis(&rpc),||{
    let tip=rpc.check()?;let row=rpc.tx(txid)?;let height=number(&row,"block_height")?;
    if height>=tip||bytes(string(&row,"as_hex")?,MAX_RPC/2)?!=final_bytes{return Err(())}
    let block=rpc.block(height)?;let block_hash=block.block.hash();
    if block.block.transactions.iter().filter(|id|**id==txid).count()!=1{return Err(())}
    let received=Scanner::new(recipient).scan(block.clone()).map_err(|_|())?.not_additionally_locked().into_iter().filter(|o|o.transaction()==txid).collect::<Vec<_>>();
    let changed=Scanner::new(vault).scan(block).map_err(|_|())?.not_additionally_locked().into_iter().filter(|o|o.transaction()==txid).collect::<Vec<_>>();
    if received.len()!=1||changed.len()!=1||received[0].commitment().amount!=request.amount
        ||received[0].index_in_transaction()==changed[0].index_in_transaction()||rpc.block(height)?.block.hash()!=block_hash{return Err(())}
    let change=changed[0].commitment().amount;
    let total=observed_semantics(&anchor,&request,fee,change,tx.prefix().inputs.len())?;
    Ok(json!({"type":"observed","txId":hex(&txid),"blockHeight":height,"blockHash":hex(&block_hash),"inputAtomic":total.to_string(),
        "recipientAtomic":request.amount.to_string(),"feeAtomic":fee.to_string(),"changeAtomic":change.to_string(),
        "recipientOutputKey":hex(&received[0].key().compress().to_bytes()),"recipientOutputIndex":received[0].index_in_transaction(),
        "changeOutputKey":hex(&changed[0].key().compress().to_bytes()),"changeOutputIndex":changed[0].index_in_transaction()}))
    })
}
pub(super) fn address()->HostResult<()>{println!("{}",recipient()?.legacy_address(Network::Mainnet));Ok(())}
pub(super) fn fund(keys:&Keys,count:usize,directory:&Path)->HostResult<(ViewPair,Vec<PreparedInput>,(u64,u64))>{
    if count!=2{return Err(())}let rpc=Rpc::connect()?;let start=rpc.check()?;
    let secret=Zeroizing::new(Scalar::random(&mut OsRng));
    let vault=ViewPair::new(Point::from(keys[&id(1)].group_key().0),secret.clone()).map_err(|_|())?;
    // Only this RPC address string maps testnet-keypair encoding to fakechain's
    // mainnet address encoding. No public-network connection is possible here.
    rpc.mine(vault.legacy_address(Network::Mainnet).to_string(),18)?;
    rpc.mine(recipient()?.legacy_address(Network::Mainnet).to_string(),60)?;
    let height=rpc.check()?;let mut outputs=Vec::new();let mut scanner=Scanner::new(vault.clone());
    for n in start..start+18 {
        let block=rpc.block(n)?;
        outputs.extend(scanner.scan(block).map_err(|_|())?.additional_timelock_satisfied_by(height as usize,0));
    }
    if outputs.len()!=18{return Err(())}
    let mut indices=outputs.iter().map(WalletOutput::index_on_blockchain).collect::<Vec<_>>();indices.sort_unstable();
    if !indices.windows(2).all(|w|w[0]<w[1]){return Err(())}indices.truncate(16);
    let mut prepared=Vec::new();
    for scanned in outputs.into_iter().take(count) {let ring=rpc.ring(&scanned,&indices,height)?;prepared.push(PreparedInput{scanned,ring});}
    let estimate=rpc.json("get_fee_estimate",json!({"grace_blocks":10}))?;
    let fee=(number(&estimate,"fee")?,number(&estimate,"quantization_mask")?);FeeRate::new(fee.0,fee.1).ok_or(())?;
    // Private, create-once local runtime material only. No shares or spend key.
    let mut private=Zeroizing::new(vault.spend().compress().to_bytes().to_vec());secret.write(&mut *private).map_err(|_|())?;
    let total=prepared.iter().try_fold(0u64,|sum,p|sum.checked_add(p.scanned.commitment().amount).ok_or(()))?;
    private.extend(total.to_le_bytes());
    let mut file=OpenOptions::new().write(true).create_new(true).open(directory.join("node-view.private")).map_err(|_|())?;
    file.write_all(&private).map_err(|_|())?;file.sync_all().map_err(|_|())?;
    eprintln!("host:node-funded");Ok((vault,prepared,fee))
}
pub(super) fn observe(mut args:impl Iterator<Item=std::ffi::OsString>)->HostResult<()> {
    let directory=PathBuf::from(args.next().ok_or(())?);
    let txid=digest(&args.next().ok_or(())?.into_string().map_err(|_|())?)?;
    let mut values=Vec::new();for _ in 0..3 {values.push(args.next().ok_or(())?.into_string().map_err(|_|())?.parse::<u64>().map_err(|_|())?);}
    if args.next().is_some(){return Err(())}
    let mut private=Zeroizing::new(Vec::new());std::fs::File::open(directory.join("node-view.private")).map_err(|_|())?.take(73).read_to_end(&mut private).map_err(|_|())?;
    if private.len()!=72{return Err(())}let mut reader=&private[..64];
    let input_total=u64::from_le_bytes(private[64..].try_into().map_err(|_|())?);
    let spend=CompressedPoint::read(&mut reader).map_err(|_|())?.decompress().ok_or(())?;
    let view=Scalar::read(&mut reader).map_err(|_|())?;if !reader.is_empty(){return Err(())}
    let vault=ViewPair::new(spend,Zeroizing::new(view)).map_err(|_|())?;
    let rpc=Rpc::connect()?;let tip=rpc.check()?;let row=rpc.tx(txid)?;let height=number(&row,"block_height")?;
    if height>=tip{return Err(())}let blob=bytes(string(&row,"as_hex")?,MAX_RPC/2)?;let mut reader=blob.as_slice();
    let tx=Transaction::read(&mut reader).map_err(|_|())?;if !reader.is_empty()||tx.hash()!=txid{return Err(())}
    let Transaction::V2{proofs:Some(ref proofs),..}=tx else{return Err(())};
    if proofs.base.fee!=values[1]||tx.prefix().outputs.len()!=2{return Err(())}
    let block=rpc.block(height)?;if block.block.transactions.iter().filter(|h|**h==txid).count()!=1{return Err(())}
    let canonical=block.block.hash();
    let received=Scanner::new(recipient()?).scan(block.clone()).map_err(|_|())?.not_additionally_locked().into_iter().filter(|o|o.transaction()==txid).collect::<Vec<_>>();
    let changed=Scanner::new(vault).scan(block).map_err(|_|())?.not_additionally_locked().into_iter().filter(|o|o.transaction()==txid).collect::<Vec<_>>();
    if received.len()!=1||changed.len()!=1||received[0].commitment().amount!=values[0]||changed[0].commitment().amount!=values[2]||received[0].index_in_transaction()==changed[0].index_in_transaction(){return Err(())}
    if rpc.block(height)?.block.hash()!=canonical{return Err(())}
    let total=values[0].checked_add(values[1]).and_then(|v|v.checked_add(values[2])).ok_or(())?;
    if total!=input_total{return Err(())}
    println!("{}",json!({"status":"node-observed","txId":hex(&txid),"blockHeight":height,"recipientOutputs":1,"changeOutputs":1,"recipientAtomic":values[0].to_string(),"feeAtomic":values[1].to_string(),"changeAtomic":values[2].to_string()}));Ok(())
}

#[cfg(test)]mod tests {
    use super::*;
    #[cfg(feature="participant-host")]
    #[test]fn observation_genesis_before_and_after_reads_prevents_delivery(){
        use std::cell::Cell;
        for case in 0..4{
            let reads=Cell::new(0);let operations=Cell::new(0);
            let result=with_observation_genesis([1;32],||{
                let read=reads.get();reads.set(read+1);
                if case==0&&read==0||case==1&&read==1{Ok([2;32])}else if case==2&&read==1{Err(())}else{Ok([1;32])}
            },||{operations.set(operations.get()+1);Ok(17u8)});
            if case==3{assert_eq!(result,Ok(17));}else{assert!(result.is_err());}
            assert_eq!(operations.get(),usize::from(case!=0));assert_eq!(reads.get(),if case==0{1}else{2});
        }
    }
    #[cfg(feature="participant-host")]
    #[test]fn observation_amounts_and_group_match_original_semantic_commitment(){
        let group=Point::from(curve25519_dalek::constants::ED25519_BASEPOINT_POINT*curve25519_dalek::scalar::Scalar::from(7u64)).compress().to_bytes();
        let request=Request{challenge:"11".repeat(32),event_id:"22".repeat(32),instruction_digest:"33".repeat(32),request_digest:"44".repeat(32),network:Network::Testnet,address:recipient().unwrap().legacy_address(Network::Testnet).to_string(),amount:50,max_miner_fee:20};
        let candidate=crate::candidate::IssuedCandidate{bytes:b"semantic commitment fixture".to_vec().into_boxed_slice(),semantic:crate::candidate::Semantics{
            recipient:request.address.clone(),amount:50,input_total:100,change:40,fee:10,ceiling:20,change_spend:group,change_view:public_vault(group).unwrap().view().compress().to_bytes(),input_count:2}};
        let mut anchor=ObservationAnchor{genesis:[1;32],group,candidate_identity:candidate.identity(),candidate:candidate.bytes.to_vec()};
        assert_eq!(observed_semantics(&anchor,&request,10,40,2),Ok(100));
        for (fee,change,inputs) in [(11,40,2),(10,41,2),(10,40,1),(11,39,2),(u64::MAX,40,2)]{assert!(observed_semantics(&anchor,&request,fee,change,inputs).is_err());}
        anchor.group=Point::from(curve25519_dalek::constants::ED25519_BASEPOINT_POINT*curve25519_dalek::scalar::Scalar::from(8u64)).compress().to_bytes();assert!(observed_semantics(&anchor,&request,10,40,2).is_err());anchor.group=group;
        anchor.candidate[0]^=1;assert!(observed_semantics(&anchor,&request,10,40,2).is_err());anchor.candidate[0]^=1;
        anchor.candidate_identity[0]^=1;assert!(observed_semantics(&anchor,&request,10,40,2).is_err());
    }
    #[test]fn pinned_fee_crosses_constructor_restore_and_candidate(){
        let keys=support::distributed_keys();let (vault,inputs)=funding::fund(&keys,2);
        let directory=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("evidence/runtime").join(hex(&fresh()));
        std::fs::create_dir_all(&directory).unwrap();
        let request=format!("WMNI1\n{}\n{}\n{}\n{}\ntestnet\n{}\n1000000000\n1000000000000\n","11".repeat(32),"22".repeat(32),"33".repeat(32),"44".repeat(32),recipient().unwrap().legacy_address(Network::Testnet)).into_bytes();
        let fee=(1_200_000,10_000);let trace=Arc::new(Trace::default());
        let sealed=seal_held_fee(&directory,&keys,copy_inputs(&inputs),vault.clone(),request.clone(),trace,fee).unwrap();
        assert_eq!(sealed.len(),2);assert!(sealed[0]._candidate.semantic.fee>100_000);
        assert_eq!(sealed[0]._candidate.semantic.fee%fee.1,0);
        let mut owner=CustodyOwner::create_with_fee(&directory.join("alter-private"),&directory.join("alter-journal"),request,inputs,vault,Zeroizing::new(fresh()),Arc::new(Trace::default()),fee).unwrap();
        for altered in [(fee.0+1,fee.1),(fee.0,fee.1+1)]{
            owner.fee=altered;
            assert!(matches!(owner.restore_guard(keys[&id(1)].clone(),vec![id(1),id(2)],fresh()),Err(GateError::Custody)));
        }
    }
    #[test]fn isolated_profile_fields_fail_independently(){
        let good=json!({"nettype":"fakechain","offline":true,"mainnet":false,"testnet":false,"stagenet":false,"incoming_connections_count":0,"outgoing_connections_count":0});
        assert!(local_profile(&good).is_ok());
        for key in ["nettype","offline","mainnet","testnet","stagenet","incoming_connections_count","outgoing_connections_count"] {
            let mut missing=good.clone();missing.as_object_mut().unwrap().remove(key);assert!(local_profile(&missing).is_err());
            let mut bad=good.clone();bad[key]=match key {"nettype"=>json!("mainnet"),"offline"=>json!(false),"incoming_connections_count"|"outgoing_connections_count"=>json!(1),_=>json!(true)};assert!(local_profile(&bad).is_err());
        }
    }
}
