//! Public fixed-view local-fixture observation; no participant custody or signing state.
use super::host::node;
use crate::participant_envelope as w;
use serde_json::{json, Value};
use std::io::{Read, Write};
type R<T> = std::result::Result<T, ()>;

fn hash32(v: &Value, field: &str) -> R<[u8; 32]> {
    let result: [u8; 32] = w::unhex(w::string(v, field)?)?.try_into().map_err(|_| ())?;
    if result == [0; 32] { return Err(()); }
    Ok(result)
}
fn integer(v: &Value, field: &str) -> R<u64> { v.get(field).and_then(Value::as_u64).ok_or(()) }
fn decimal(v: &Value, field: &str) -> R<()> {
    let value = w::string(v, field)?;
    if value.is_empty() || (value.len() > 1 && value.starts_with('0')) ||
        !value.bytes().all(|b| b.is_ascii_digit()) || value.parse::<u64>().is_err() { return Err(()); }
    Ok(())
}
struct Request { value: Value, group: [u8;32], genesis: [u8;32], image: [u8;32] }
fn parse(frame: &[u8]) -> R<Request> {
    let value = w::parse(frame)?;
    w::fields(&value, &["observerNonce","groupPublicKey","genesis","snapshot","source","keyImage"])?;
    hash32(&value,"observerNonce")?;
    let group=hash32(&value,"groupPublicKey")?;
    let genesis=hash32(&value,"genesis")?;
    let image=hash32(&value,"keyImage")?;
    w::fields(&value["snapshot"], &["height","hash"])?;
    let height=integer(&value["snapshot"],"height")?;
    if height==0 || height>4096 { return Err(()); }
    hash32(&value["snapshot"],"hash")?;
    let source=&value["source"];
    w::fields(source,&["kind","startHeight","blockHashes","ringIndices","outputIds","deposit"])?;
    if w::string(source,"kind")?!="deposit" || integer(source,"startHeight")?.checked_add(18).ok_or(())?>height {return Err(())}
    let hashes=source["blockHashes"].as_array().ok_or(())?;
    let indices=source["ringIndices"].as_array().ok_or(())?;
    let ids=source["outputIds"].as_array().ok_or(())?;
    if hashes.len()!=18 || indices.len()!=16 || ids.len()!=2 {return Err(())}
    for hash in hashes { hash32(&json!({"hash":hash}),"hash")?; }
    for index in indices { index.as_u64().ok_or(())?; }
    for id in ids {
        w::fields(id,&["transaction","index","chainIndex"])?;
        hash32(id,"transaction")?;integer(id,"index")?;integer(id,"chainIndex")?;
    }
    let deposit=&source["deposit"];
    w::fields(deposit,&["txId","txBytes","blockHash","blockHeight","outputKey","outputIndex","chainIndex","amountAtomic","feeAtomic"])?;
    for field in ["txId","blockHash","outputKey"] {hash32(deposit,field)?;}
    let tx=w::unhex(w::string(deposit,"txBytes")?)?;
    if tx.is_empty() { return Err(()); }
    if integer(deposit,"blockHeight")?.checked_add(60).ok_or(())?>height {return Err(())}
    integer(deposit,"outputIndex")?;integer(deposit,"chainIndex")?;
    decimal(deposit,"amountAtomic")?;decimal(deposit,"feeAtomic")?;
    Ok(Request {value,group,genesis,image})
}

fn observe(request: Request) -> R<Value> {
    let v=&request.value;
    node::participant_snapshot(request.genesis,&v["snapshot"])?;
    let (vault, mut inputs, _)=node::participant_scan_readonly(request.group,request.genesis,&v["source"])?;
    if inputs.len()!=2 {return Err(())}
    let output=inputs.pop().ok_or(())?.scanned;
    let public_key=output.key().compress().to_bytes();
    // This checks only the supplied image's status. Its association with P needs
    // the separately verified original-holder threshold image attestation.
    let occurrences=node::participant_unspent_history(request.genesis,&v["snapshot"],public_key,request.image)?;
    node::participant_snapshot(request.genesis,&v["snapshot"])?;
    Ok(json!({"type":"public-source-observation","observerNonce":v["observerNonce"],
        "observerKind":"local-fixture-fixed-view-v1","genesis":v["genesis"],"snapshot":v["snapshot"],
        "vaultAddress":vault.legacy_address(monero_wallet::address::Network::Mainnet).to_string(),
        "sourceRequestDigest":w::hex(&w::digest(b"rosen-monero/public-source-observer/v1",&w::bytes(v))),
        "outputs":[{"txId":w::hex(&output.transaction()),"blockHash":v["source"]["deposit"]["blockHash"],
          "blockHeight":v["source"]["deposit"]["blockHeight"],"publicKey":w::hex(&public_key),
          "outputIndex":output.index_in_transaction(),"chainIndex":output.index_on_blockchain(),
          "amountAtomic":output.commitment().amount.to_string(),"feeAtomic":v["source"]["deposit"]["feeAtomic"],
          "owned":true,"maturity":"unlocked","historyOccurrences":occurrences}],
        "suppliedKeyImage":w::hex(&request.image),"suppliedKeyImageSpentStatus":0,"imageAssociationVerified":false}))
}
pub(crate) fn run(mut input: impl Read, mut output: impl Write) -> R<()> {
    let mut frame=Vec::new();
    input.by_ref().take((w::MAX_FRAME+1) as u64).read_to_end(&mut frame).map_err(|_|())?;
    let result=observe(parse(&frame)?)?;
    output.write_all(&w::bytes(&result)).map_err(|_|())?;
    output.write_all(b"\n").map_err(|_|())?;output.flush().map_err(|_|())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn value() -> Value {
        let h="11".repeat(32);
        json!({"observerNonce":h,"groupPublicKey":h,"genesis":h,"keyImage":h,
          "snapshot":{"height":100,"hash":h},"source":{"kind":"deposit","startHeight":0,
          "blockHashes":vec![h.clone();18],"ringIndices":(0..16).collect::<Vec<_>>(),
          "outputIds":vec![json!({"transaction":h,"index":0,"chainIndex":1});2],
          "deposit":{"txId":h,"txBytes":"0102","blockHash":h,"blockHeight":20,"outputKey":h,
          "outputIndex":0,"chainIndex":1,"amountAtomic":"500000240","feeAtomic":"20"}}})
    }
    fn frame(v:&Value)->Vec<u8>{let mut b=w::bytes(v);b.push(b'\n');b}
    #[test] fn public_source_observer_schema_positive() {assert!(parse(&frame(&value())).is_ok());}
    #[test] fn public_source_observer_single_faults() {
        for path in ["observerNonce","groupPublicKey","genesis","keyImage"] {
            let mut v=value();v[path]=json!("00".repeat(32));assert!(parse(&frame(&v)).is_err());
        }
        let mut cases=Vec::new();
        let mut v=value();v["privatePath"]=json!("forbidden");cases.push(v);
        let mut v=value();v["snapshot"]["height"]=json!(4097);cases.push(v);
        let mut v=value();v["snapshot"]["height"]=json!(0);cases.push(v);
        let mut v=value();v["source"]["kind"]=json!("coinbase");cases.push(v);
        let mut v=value();v["source"]["blockHashes"]=json!([]);cases.push(v);
        let mut v=value();v["source"]["ringIndices"]=json!([]);cases.push(v);
        let mut v=value();v["source"]["outputIds"][0]["index"]=json!(-1);cases.push(v);
        let mut v=value();v["source"]["deposit"]["blockHeight"]=json!(41);cases.push(v);
        let mut v=value();v["source"]["deposit"]["txBytes"]=json!("ABC");cases.push(v);
        let mut v=value();v["source"]["deposit"]["amountAtomic"]=json!("0500000240");cases.push(v);
        for v in cases {assert!(parse(&frame(&v)).is_err());}
        assert!(parse(&w::bytes(&value())).is_err());
        assert!(parse(&vec![b'a';w::MAX_FRAME+1]).is_err());
    }
    #[test] fn public_source_observer_uses_existing_readonly_native_functions() {
        let _:fn([u8;32],&Value)->R<()>=node::participant_snapshot;
        let _=node::participant_scan_readonly;
        let _:fn([u8;32],&Value,[u8;32],[u8;32])->R<usize>=node::participant_unspent_history;
    }
}
