//! Closed local-fixture envelope. This is not Rosen vote authentication.
use k256::ecdsa::{
    signature::hazmat::{PrehashSigner, PrehashVerifier},
    Signature, SigningKey, VerifyingKey,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const MAX_FRAME: usize = 65536;
pub type Result<T> = std::result::Result<T, ()>;
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn unhex(s: &str) -> Result<Vec<u8>> {
    if s.len() % 2 != 0
        || !s
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(());
    }
    s.as_bytes()
        .chunks_exact(2)
        .map(|p| u8::from_str_radix(std::str::from_utf8(p).map_err(|_| ())?, 16).map_err(|_| ()))
        .collect()
}
pub fn bytes(v: &Value) -> Vec<u8> {
    serde_json::to_vec(v).expect("JSON value serialization")
}
fn bounded(v: &Value) -> bool {
    match v {
        Value::Number(n) => n.as_u64().is_some_and(|n| n <= u32::MAX as u64),
        Value::Array(a) => a.iter().all(bounded),
        Value::Object(o) => o.iter().all(|(k, v)| k.is_ascii() && bounded(v)),
        Value::String(s) => s.is_ascii(),
        _ => true,
    }
}
pub fn parse(frame: &[u8]) -> Result<Value> {
    if frame.len() > MAX_FRAME || !frame.is_ascii() || !frame.ends_with(b"\n") {
        return Err(());
    }
    let raw = &frame[..frame.len() - 1];
    let value: Value = serde_json::from_slice(raw).map_err(|_| ())?;
    // Reserialization also rejects duplicate object keys, whitespace, escaped aliases,
    // noncanonical integers, and any second spelling of a frame.
    if !bounded(&value) || bytes(&value) != raw {
        return Err(());
    }
    Ok(value)
}
pub fn fields(v: &Value, expected: &[&str]) -> Result<()> {
    let object = v.as_object().ok_or(())?;
    if object.len() != expected.len() || !expected.iter().all(|k| object.contains_key(*k)) {
        return Err(());
    }
    Ok(())
}
pub fn string<'a>(v: &'a Value, name: &str) -> Result<&'a str> {
    v.get(name).and_then(Value::as_str).ok_or(())
}
pub fn number(v: &Value, name: &str) -> Result<u16> {
    u16::try_from(v.get(name).and_then(Value::as_u64).ok_or(())?).map_err(|_| ())
}
pub fn digest(domain: &[u8], payload: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(domain);
    h.update([0]);
    h.update(payload);
    h.finalize().into()
}
pub fn public_key(s: &str) -> Result<VerifyingKey> {
    let raw = unhex(s)?;
    if raw.len() != 33 || !matches!(raw[0], 2 | 3) {
        return Err(());
    }
    let key = VerifyingKey::from_sec1_bytes(&raw).map_err(|_| ())?;
    if key.to_encoded_point(true).as_bytes() != raw {
        return Err(());
    }
    Ok(key)
}
const DOMAIN: &[u8] = b"rosen-monero/local-dkg-envelope/v1";
pub fn sign(message: Value, key: &SigningKey) -> Result<Value> {
    sign_domain(message, key, DOMAIN)
}
pub fn sign_domain(mut message: Value, key: &SigningKey, domain: &[u8]) -> Result<Value> {
    let hash = digest(domain, &bytes(&message));
    let signature: Signature = key.sign_prehash(&hash).map_err(|_| ())?;
    message.as_object_mut().ok_or(())?.insert(
        "signature".into(),
        Value::String(hex(&signature.to_bytes())),
    );
    Ok(message)
}
pub fn verify(message: &Value, key: &VerifyingKey) -> Result<()> {
    verify_domain(message, key, DOMAIN)
}
pub fn verify_domain(message: &Value, key: &VerifyingKey, domain: &[u8]) -> Result<()> {
    let signature =
        Signature::from_slice(&unhex(string(message, "signature")?)?).map_err(|_| ())?;
    if signature.normalize_s().is_some() {
        return Err(());
    }
    let mut unsigned = message.clone();
    unsigned.as_object_mut().ok_or(())?.remove("signature");
    key.verify_prehash(&digest(domain, &bytes(&unsigned)), &signature)
        .map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn known_k256_vector_and_mutation() {
        // Pinned k256 0.13.4 ecdsa.rs recovery vector, SHA256("example message").
        let key = public_key("021a7a569e91dbf60581509c7fc946d1003b60c7dee85299538db6353538d59574")
            .unwrap();
        let raw=unhex("ce53abb3721bafc561408ce8ff99c909f7f0b18a2f788649d6470162ab1aa0323971edc523a6d6453f3fb6128d318d9db1a5ff3386feb1047d9816e780039d52").unwrap();
        let signature = Signature::from_slice(&raw).unwrap();
        assert!(signature.normalize_s().is_none());
        assert!(key
            .verify_prehash(&Sha256::digest(b"example message"), &signature)
            .is_ok());
        let mut mutated = raw;
        mutated[5] ^= 1;
        assert!(key
            .verify_prehash(
                &Sha256::digest(b"example message"),
                &Signature::from_slice(&mutated).unwrap()
            )
            .is_err());
    }
    #[test]
    fn canonical_profile_rejects_aliases() {
        for s in [
            "{\"a\":1,\"a\":1}\n",
            "{\"b\":1,\"a\":1}\n",
            "{\"a\":1.0}\n",
            "{\"a\":-1}\n",
            "{\"a\":4294967296}\n",
            "{\"a\":\"\\u0061\"}\n",
            "{}\r\n",
            "{}",
            " {}\n",
        ] {
            assert!(parse(s.as_bytes()).is_err());
        }
        assert!(parse(b"{\"a\":[1,2],\"b\":\"c\"}\n").is_ok());
        assert!(parse(&vec![b'x'; MAX_FRAME + 1]).is_err());
        assert!(fields(&json!({"type":"stop","extra":1}), &["type"]).is_err());
    }
    #[test]
    fn authenticated_fields_and_high_s() {
        let key = SigningKey::from_bytes((&[7u8; 32]).into()).unwrap();
        let m=sign(json!({"ceremony":"aa","epoch":"bb","from":1,"payload":"00","round":1,"sequence":1,"to":2,"type":"peer"}),&key).unwrap();
        assert!(verify(&m, key.verifying_key()).is_ok());
        for field in [
            "ceremony", "epoch", "from", "payload", "round", "sequence", "to", "type",
        ] {
            let mut wrong = m.clone();
            wrong[field] = json!("changed");
            assert!(verify(&wrong, key.verifying_key()).is_err());
        }
        let mut high = m.clone();
        let sig = Signature::from_slice(&unhex(string(&m, "signature").unwrap()).unwrap()).unwrap();
        let hs = Signature::from_scalars(sig.r().to_bytes(), (-sig.s()).to_bytes()).unwrap();
        high["signature"] = json!(hex(&hs.to_bytes()));
        assert!(verify(&high, key.verifying_key()).is_err());
    }
}
