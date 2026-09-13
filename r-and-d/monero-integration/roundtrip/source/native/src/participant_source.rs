//! Read-only ordinary-deposit admission inspection with threshold image proofs.
//! The original DKG share is borrowed, never moved, serialized, or restored.
use super::*;
use crate::participant_envelope as w;
use k256::ecdsa::{SigningKey, VerifyingKey};
use serde_json::{json, Value};
type R<T> = std::result::Result<T, ()>;
const DOMAIN: &[u8] = b"rosen-monero/local-source-envelope/v1";
fn hash32(v: &Value, name: &str) -> R<[u8; 32]> {
    w::unhex(w::string(v, name)?)?.try_into().map_err(|_| ())
}
pub(crate) struct SourceInspection {
    id: u16,
    config: Value,
    binding: [u8; 32],
    session: LocalImageSession,
    own: ProofRow,
    output: WalletOutput,
}
impl SourceInspection {
    pub(crate) fn new(
        id: u16,
        key: &ThresholdKeys<Ed25519>,
        config: Value,
        identity: &SigningKey,
    ) -> R<(Self, Value)> {
        let opted=config.get("sourcePolicy").is_some();
        if opted && w::string(&config,"sourcePolicy")?!="authenticated-backing-v1" {return Err(())}
        let mut fields=vec!["type","ceremony","epoch","rosterDigest","genesis","inspection","snapshot","source"];
        if opted {fields.push("sourcePolicy");}
        w::fields(&config,&fields)?;
        if id == 0
            || id > 2
            || u16::from(key.params().i()) != id
            || w::string(&config["source"], "kind")? != "deposit"
        {
            return Err(());
        }
        for name in ["ceremony", "epoch", "rosterDigest", "genesis", "inspection"] {
            if hash32(&config, name)? == [0; 32] {
                return Err(());
            }
        }
        let genesis = hash32(&config, "genesis")?;
        host::node::participant_snapshot(genesis, &config["snapshot"])?;
        let (_, mut inputs, _) = host::node::participant_scan_readonly(
            key.group_key().to_bytes(),
            genesis,
            &config["source"],
        )?;
        if inputs.len() != 2 {
            return Err(());
        }
        let output = inputs.remove(1).scanned;
        let mut shared = config.clone();
        shared.as_object_mut().ok_or(())?.remove("type");
        let binding = w::digest(b"rosen-monero/local-source-config/v1", &w::bytes(&shared));
        let context = LocalContext {
            network_genesis: genesis,
            epoch: hash32(&config, "epoch")?,
            epoch_manifest: binding,
            session: hash32(&config, "inspection")?,
            retained_intent: w::digest(
                b"rosen-monero/local-source-intent/v1",
                &w::bytes(&config["source"]),
            ),
        };
        let session = LocalImageSession::capture(
            context,
            key,
            vec![Participant::new(1).unwrap(), Participant::new(2).unwrap()],
            std::slice::from_ref(&output),
        )
        .map_err(|_| ())?;
        let mut rows = session.prove(&mut OsRng, key).map_err(|_| ())?;
        if rows.len() != 1 {
            return Err(());
        }
        let own = rows.remove(0);
        host::node::participant_snapshot(genesis, &config["snapshot"])?;
        let envelope = w::sign_domain(
            json!({"type":"inspection-peer","ceremony":config["ceremony"],"epoch":config["epoch"],"rosterDigest":config["rosterDigest"],"genesis":config["genesis"],"inspection":config["inspection"],"binding":w::hex(&binding),"from":id,"to":3-id,"round":1,"sequence":1,"payload":w::hex(&own.encode())}),
            identity,
            DOMAIN,
        )?;
        Ok((
            Self {
                id,
                config,
                binding,
                session,
                own,
                output,
            },
            envelope,
        ))
    }
    pub(crate) fn complete(self, v: &Value, keys: &HashMap<u16, VerifyingKey>) -> R<Value> {
        w::fields(
            v,
            &[
                "type",
                "ceremony",
                "epoch",
                "rosterDigest",
                "genesis",
                "inspection",
                "binding",
                "from",
                "to",
                "round",
                "sequence",
                "payload",
                "signature",
            ],
        )?;
        if w::string(v, "type")? != "inspection-peer"
            || w::number(v, "from")? != 3 - self.id
            || w::number(v, "to")? != self.id
            || w::number(v, "round")? != 1
            || w::number(v, "sequence")? != 1
            || hash32(v, "binding")? != self.binding
        {
            return Err(());
        }
        for field in ["ceremony", "epoch", "rosterDigest", "genesis", "inspection"] {
            if v[field] != self.config[field] {
                return Err(());
            }
        }
        w::verify_domain(v, keys.get(&(3 - self.id)).ok_or(())?, DOMAIN)?;
        let remote = ProofRow::decode(&w::unhex(w::string(v, "payload")?)?).map_err(|_| ())?;
        let rows = if self.id == 1 {
            vec![self.own, remote]
        } else {
            vec![remote, self.own]
        };
        let verified = self.session.verify(&rows).map_err(|_| ())?;
        let certificates = self.session.consume(&verified).map_err(|_| ())?;
        if certificates.len() != 1
            || certificates[0].identity().output_key() != self.output.key().compress().to_bytes()
        {
            return Err(());
        }
        let image = certificates[0].image();
        let history=if self.config.get("sourcePolicy").is_some(){host::node::participant_unspent_occurrences}else{host::node::participant_unspent_history};
        let occurrences = history(
            hash32(&self.config, "genesis")?,
            &self.config["snapshot"],
            self.output.key().compress().to_bytes(),
            image,
        )?;
        let deposit = &self.config["source"]["deposit"];
        let mut result=json!({"type":"source-verified","id":self.id,"ceremony":self.config["ceremony"],"epoch":self.config["epoch"],"rosterDigest":self.config["rosterDigest"],"genesis":self.config["genesis"],"inspection":self.config["inspection"],"snapshot":self.config["snapshot"],
            "txId":w::hex(&self.output.transaction()),"blockHeight":deposit["blockHeight"],"blockHash":deposit["blockHash"],"outputKey":w::hex(&self.output.key().compress().to_bytes()),"outputIndex":self.output.index_in_transaction(),"chainIndex":self.output.index_on_blockchain(),
            "amountAtomic":self.output.commitment().amount.to_string(),"keyImage":w::hex(&image),"spentStatus":0,"historyOccurrences":occurrences,"walletSigns":0});
        if let Some(policy)=self.config.get("sourcePolicy"){result["sourcePolicy"]=policy.clone();}
        Ok(result)
    }
}
