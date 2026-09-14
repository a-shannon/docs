//! One process owns one identity and one actual PedPoP share. Trusted launcher
//! bootstrap is a local fixture boundary; no Rosen vote or spending authority.
use crate::participant_envelope::{self as wire, Result};
use ciphersuite::{group::GroupEncoding, Ciphersuite};
use dkg::{Participant, ThresholdKeys, ThresholdParams};
use dkg_pedpop::{
    Commitments, EncryptedMessage, EncryptionKeyMessage, KeyGenMachine, KeyMachine, SecretShare,
    SecretShareMachine,
};
use frost::curve::Ed25519;
use k256::ecdsa::{SigningKey, VerifyingKey};
use rand_core::OsRng;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, Write},
};

enum Phase {
    Init,
    Commitments(SecretShareMachine<Ed25519>),
    Shares(KeyMachine<Ed25519>),
    Roster,
    Ack,
    Ready,
    Retired,
}
struct Actor {
    id: u16,
    identity: SigningKey,
    params: ThresholdParams,
    phase: Phase,
    ceremony: String,
    epoch: String,
    peers: HashMap<u16, VerifyingKey>,
    inbox: HashMap<u16, Vec<u8>>,
    keys: Option<ThresholdKeys<Ed25519>>,
    public_roster: Vec<u8>,
    roster_digest: String,
    signing: Option<crate::common_owner::participant_signing::ActorSigning>,
    funded: bool,
    deposit: Option<crate::common_owner::participant_signing::PendingDeposit>,
    inspection: Option<crate::common_owner::participant_source::SourceInspection>,
    inspected: bool,
}
fn participant(n: u16) -> Result<Participant> {
    Participant::new(n).ok_or(())
}
impl Actor {
    fn new(id: u16) -> Result<Self> {
        if !(1..=4).contains(&id) {
            return Err(());
        }
        Ok(Self {
            id,
            identity: SigningKey::random(&mut OsRng),
            params: ThresholdParams::new(2, 4, participant(id)?).map_err(|_| ())?,
            phase: Phase::Init,
            ceremony: String::new(),
            epoch: String::new(),
            peers: HashMap::new(),
            inbox: HashMap::new(),
            keys: None,
            public_roster: vec![],
            roster_digest: String::new(),
            signing: None,
            funded: false,
            deposit: None,
            inspection: None,
            inspected: false,
        })
    }
    fn identity(&self) -> Value {
        json!({"type":"identity","id":self.id,"pid":std::process::id(),"publicKey":wire::hex(self.identity.verifying_key().to_encoded_point(true).as_bytes())})
    }
    fn outgoing(&self, to: u16, round: u16, payload: &[u8]) -> Result<Value> {
        wire::sign(
            json!({"type":"peer","ceremony":self.ceremony,"epoch":self.epoch,"from":self.id,"to":to,"round":round,"sequence":round,"payload":wire::hex(payload)}),
            &self.identity,
        )
    }
    fn broadcast(&self, round: u16, payload: &[u8]) -> Result<Vec<Value>> {
        (1..=4)
            .filter(|i| *i != self.id)
            .map(|i| self.outgoing(i, round, payload))
            .collect()
    }
    fn init(&mut self, v: &Value) -> Result<Vec<Value>> {
        wire::fields(v, &["type", "ceremony", "epoch", "threshold", "roster"])?;
        if wire::number(v, "threshold")? != 2 {
            return Err(());
        }
        self.ceremony = wire::string(v, "ceremony")?.into();
        self.epoch = wire::string(v, "epoch")?.into();
        if wire::unhex(&self.ceremony)?.len() != 32 || wire::unhex(&self.epoch)?.len() != 32 {
            return Err(());
        }
        let roster = v.get("roster").and_then(Value::as_array).ok_or(())?;
        if roster.len() != 4 {
            return Err(());
        }
        let mut seen = std::collections::HashSet::new();
        for (slot, item) in roster.iter().enumerate() {
            wire::fields(item, &["id", "publicKey"])?;
            let id = wire::number(item, "id")?;
            if id as usize != slot + 1 {
                return Err(());
            }
            let text = wire::string(item, "publicKey")?;
            if !seen.insert(text) {
                return Err(());
            }
            let key = wire::public_key(text)?;
            if id == self.id && key != *self.identity.verifying_key() {
                return Err(());
            }
            self.peers.insert(id, key);
        }
        let context = wire::digest(b"rosen-monero/local-dkg-init/v1", &wire::bytes(v));
        let (machine, commitment) =
            KeyGenMachine::<Ed25519>::new(self.params, context).generate_coefficients(&mut OsRng);
        self.phase = Phase::Commitments(machine);
        self.broadcast(1, &commitment.serialize())
    }
    fn accept(&mut self, v: &Value) -> Result<Vec<Value>> {
        // On any fault consume all retained protocol state before returning.
        let result = self.accept_inner(v);
        if result.is_err() {
            self.phase = Phase::Retired;
            self.keys = None;
            self.signing = None;
            self.deposit = None;
            self.inspection = None;
            self.inbox.clear();
        }
        result
    }
    fn accept_inner(&mut self, v: &Value) -> Result<Vec<Value>> {
        let kind = wire::string(v, "type")?;
        if kind == "stop" {
            wire::fields(v, &["type"])?;
            self.phase = Phase::Retired;
            self.keys = None;
            self.signing = None;
            self.deposit = None;
            self.inspection = None;
            self.inbox.clear();
            return Ok(vec![]);
        }
        // Taking the opaque capability consumes it before request validation or
        // any node effect. Every other command while pending retires the actor.
        if let Some(deposit) = self.deposit.take() {
            return Ok(vec![deposit.submit(v)?]);
        }
        if let Some(signing) = &mut self.signing {
            return signing.accept(v, &self.identity, &self.peers);
        }
        if let Some(inspection) = self.inspection.take() {
            return Ok(vec![inspection.complete(v, &self.peers)?]);
        }
        if matches!(self.phase, Phase::Ready) && kind == "inspect-source" {
            if self.inspected
                || wire::string(v, "ceremony")? != self.ceremony
                || wire::string(v, "epoch")? != self.epoch
                || wire::string(v, "rosterDigest")? != self.roster_digest
            {
                return Err(());
            }
            self.inspected = true;
            let (inspection, out) = crate::common_owner::participant_source::SourceInspection::new(
                self.id,
                self.keys.as_ref().ok_or(())?,
                v.clone(),
                &self.identity,
            )?;
            self.inspection = Some(inspection);
            return Ok(vec![out]);
        }
        if matches!(self.phase, Phase::Ready) && matches!(kind, "fund" | "fund-deposit" | "prepare-deposit") {
            if kind == "fund" {
                wire::fields(v, &["type"])?
            } else {
                wire::fields(v, &["type", "runtimeDirectory"])?
            }
            if self.id != 1 || self.funded {
                return Err(());
            }
            self.funded = true;
            let group = self.keys.as_ref().ok_or(())?.group_key().to_bytes();
            if kind == "prepare-deposit" {
                let (pending, frame) = crate::common_owner::participant_signing::prepare_deposit(
                    group,
                    std::path::Path::new(wire::string(v, "runtimeDirectory")?),
                )?;
                self.deposit = Some(pending);
                return Ok(vec![frame]);
            }
            return Ok(vec![if kind == "fund" {
                crate::common_owner::participant_signing::fund(group)?
            } else {
                crate::common_owner::participant_signing::fund_deposit(
                    group,
                    std::path::Path::new(wire::string(v, "runtimeDirectory")?),
                )?
            }]);
        }
        if matches!(self.phase, Phase::Ready) && kind == "configure" {
            if wire::string(v, "ceremony")? != self.ceremony
                || wire::string(v, "epoch")? != self.epoch
                || wire::string(v, "rosterDigest")? != self.roster_digest
            {
                return Err(());
            }
            let (signing, outbound) = crate::common_owner::participant_signing::ActorSigning::new(
                self.id,
                self.keys.take().ok_or(())?,
                v.clone(),
                &self.identity,
            )?;
            self.signing = Some(signing);
            return Ok(outbound);
        }
        if matches!(self.phase, Phase::Init) {
            if kind != "init" {
                return Err(());
            }
            return self.init(v);
        }
        if kind != "peer" {
            return Err(());
        }
        wire::fields(
            v,
            &[
                "type",
                "ceremony",
                "epoch",
                "from",
                "to",
                "round",
                "sequence",
                "payload",
                "signature",
            ],
        )?;
        let round = match self.phase {
            Phase::Commitments(_) => 1,
            Phase::Shares(_) => 2,
            Phase::Roster => 3,
            Phase::Ack => 4,
            _ => return Err(()),
        };
        let from = wire::number(v, "from")?;
        if !(1..=4).contains(&from)
            || from == self.id
            || wire::number(v, "to")? != self.id
            || wire::number(v, "round")? != round
            || wire::number(v, "sequence")? != round
            || wire::string(v, "ceremony")? != self.ceremony
            || wire::string(v, "epoch")? != self.epoch
            || self.inbox.contains_key(&from)
        {
            return Err(());
        }
        // Authentication is before native decoding and state consumption.
        wire::verify(v, self.peers.get(&from).ok_or(())?)?;
        let payload = wire::unhex(wire::string(v, "payload")?)?;
        self.inbox.insert(from, payload);
        if self.inbox.len() != 3 {
            return Ok(vec![]);
        }
        let phase = std::mem::replace(&mut self.phase, Phase::Retired);
        let inbox = std::mem::take(&mut self.inbox);
        match phase {
            Phase::Commitments(machine) => {
                let mut decoded = HashMap::new();
                for (from, raw) in inbox {
                    let mut input = raw.as_slice();
                    let m = EncryptionKeyMessage::<Ed25519, Commitments<Ed25519>>::read(
                        &mut input,
                        self.params,
                    )
                    .map_err(|_| ())?;
                    if !input.is_empty() || m.serialize() != raw {
                        return Err(());
                    }
                    decoded.insert(participant(from)?, m);
                }
                let (machine, shares) = machine
                    .generate_secret_shares(&mut OsRng, decoded)
                    .map_err(|_| ())?;
                if shares.len() != 3 {
                    return Err(());
                }
                self.phase = Phase::Shares(machine);
                (1..=4)
                    .filter(|i| *i != self.id)
                    .map(|i| {
                        self.outgoing(i, 2, &shares.get(&participant(i)?).ok_or(())?.serialize())
                    })
                    .collect()
            }
            Phase::Shares(machine) => {
                let mut decoded = HashMap::new();
                for (from, raw) in inbox {
                    let mut input = raw.as_slice();
                    let m=EncryptedMessage::<Ed25519,SecretShare<<Ed25519 as Ciphersuite>::F>>::read(&mut input,self.params).map_err(|_| ())?;
                    if !input.is_empty() || m.serialize() != raw {
                        return Err(());
                    }
                    decoded.insert(participant(from)?, m);
                }
                let keys = machine
                    .calculate_share(&mut OsRng, decoded)
                    .map_err(|_| ())?
                    .complete();
                let shares=(1..=4).map(|id| Ok(json!({"id":id,"publicKey":wire::hex(keys.original_verification_share(participant(id)?).to_bytes().as_ref())}))).collect::<Result<Vec<_>>>()?;
                self.public_roster = wire::bytes(
                    &json!({"groupKey":wire::hex(keys.group_key().to_bytes().as_ref()),"verificationShares":shares}),
                );
                self.roster_digest = wire::hex(&wire::digest(
                    b"rosen-monero/local-dkg-roster/v1",
                    &self.public_roster,
                ));
                self.keys = Some(keys);
                self.phase = Phase::Roster;
                self.broadcast(3, &self.public_roster)
            }
            Phase::Roster => {
                if !inbox.values().all(|raw| raw == &self.public_roster) {
                    return Err(());
                }
                self.phase = Phase::Ack;
                self.broadcast(4, &wire::unhex(&self.roster_digest)?)
            }
            Phase::Ack => {
                let expected = wire::unhex(&self.roster_digest)?;
                if !inbox.values().all(|raw| raw == &expected) || self.keys.is_none() {
                    return Err(());
                }
                self.phase = Phase::Ready;
                let roster: Value = serde_json::from_slice(&self.public_roster).map_err(|_| ())?;
                Ok(vec![
                    json!({"type":"ready","id":self.id,"pid":std::process::id(),"ceremony":self.ceremony,"epoch":self.epoch,"threshold":2,"n":4,"groupKey":roster["groupKey"],"verificationShares":roster["verificationShares"],"rosterDigest":self.roster_digest}),
                ])
            }
            _ => Err(()),
        }
    }
}

/// Bounded LF-delimited process transport. EOF drops the actor and its local share.
pub fn recover(directory: &std::path::Path, expected: &str, mut output: impl Write) -> Result<()> {
    let expected: [u8; 32] = wire::unhex(expected)?.try_into().map_err(|_| ())?;
    let value = crate::common_owner::participant_signing::recover(directory, expected)?;
    let raw = wire::bytes(&value);
    if raw.len() + 1 > wire::MAX_FRAME {
        return Err(());
    }
    output
        .write_all(&raw)
        .and_then(|_| output.write_all(b"\n"))
        .and_then(|_| output.flush())
        .map_err(|_| ())
}
pub fn observe(directory: &std::path::Path, expected: &str, mut output: impl Write) -> Result<()> {
    let expected: [u8; 32] = wire::unhex(expected)?.try_into().map_err(|_| ())?;
    let value = crate::common_owner::participant_signing::observe(directory, expected)?;
    let raw = wire::bytes(&value);
    if raw.len() + 1 > wire::MAX_FRAME {
        return Err(());
    }
    output
        .write_all(&raw)
        .and_then(|_| output.write_all(b"\n"))
        .and_then(|_| output.flush())
        .map_err(|_| ())
}
/// Bounded LF-delimited process transport. EOF drops the actor and its local share.
pub fn run(id: u16, mut input: impl BufRead, mut output: impl Write) -> Result<()> {
    fn emit(output: &mut impl Write, v: Value) -> Result<()> {
        let bytes = wire::bytes(&v);
        if bytes.len() + 1 > wire::MAX_FRAME {
            return Err(());
        }
        output
            .write_all(&bytes)
            .and_then(|_| output.write_all(b"\n"))
            .and_then(|_| output.flush())
            .map_err(|_| ())
    }
    let mut actor = Actor::new(id)?;
    emit(&mut output, actor.identity())?;
    loop {
        let mut frame = Vec::new();
        let count = std::io::Read::take(&mut input, (wire::MAX_FRAME + 1) as u64)
            .read_until(b'\n', &mut frame)
            .map_err(|_| ())?;
        if count == 0 {
            return Ok(());
        }
        let value = wire::parse(&frame)?;
        for message in actor.accept(&value)? {
            emit(&mut output, message)?;
        }
        if matches!(actor.phase, Phase::Retired) {
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn initialized() -> (Vec<Actor>, Vec<Value>) {
        let mut actors = (1..=4).map(|i| Actor::new(i).unwrap()).collect::<Vec<_>>();
        let roster = actors
            .iter()
            .map(|a| json!({"id":a.id,"publicKey":a.identity()["publicKey"]}))
            .collect::<Vec<_>>();
        let init = json!({"type":"init","ceremony":"11".repeat(32),"epoch":"22".repeat(32),"threshold":2,"roster":roster});
        let outbound = actors
            .iter_mut()
            .flat_map(|a| a.accept(&init).unwrap())
            .collect();
        (actors, outbound)
    }
    fn advance(actors: &mut [Actor], messages: Vec<Value>) -> Vec<Value> {
        messages
            .into_iter()
            .flat_map(|m| {
                let to = wire::number(&m, "to").unwrap();
                actors[to as usize - 1].accept(&m).unwrap()
            })
            .collect()
    }
    #[test]
    fn actual_dkg_roster_and_ack_barrier() {
        let (mut actors, mut messages) = initialized();
        for round in 1..=3 {
            assert_eq!(messages.len(), 12);
            assert!(messages.iter().all(|m| m["round"] == round));
            messages = advance(&mut actors, messages);
            assert!(actors.iter().all(|a| !matches!(a.phase, Phase::Ready)));
        }
        let ready = advance(&mut actors, messages);
        assert_eq!(ready.len(), 4);
        assert!(actors
            .iter()
            .all(|a| matches!(a.phase, Phase::Ready) && a.keys.is_some()));
        for r in &ready {
            assert_eq!(r["groupKey"], ready[0]["groupKey"]);
            assert_eq!(r["verificationShares"], ready[0]["verificationShares"]);
            assert_eq!(r["rosterDigest"], ready[0]["rosterDigest"]);
        }
        assert!(actors[0].accept(&ready[0]).is_err());
        assert!(actors[0].keys.is_none());
    }
    #[test]
    fn faults_retire_and_replay_fails() {
        for field in [
            "from",
            "to",
            "round",
            "sequence",
            "ceremony",
            "epoch",
            "payload",
            "signature",
        ] {
            let (mut actors, messages) = initialized();
            let mut wrong = messages[0].clone();
            let to = wire::number(&wrong, "to").unwrap();
            wrong[field] = if matches!(field, "from" | "to" | "round" | "sequence") {
                json!(4)
            } else {
                json!("00")
            };
            assert!(actors[to as usize - 1].accept(&wrong).is_err());
            assert!(matches!(actors[to as usize - 1].phase, Phase::Retired));
        }
        let (mut actors, messages) = initialized();
        let to = wire::number(&messages[0], "to").unwrap() as usize - 1;
        assert!(actors[to].accept(&messages[0]).is_ok());
        assert!(actors[to].accept(&messages[0]).is_err());
    }
    #[test]
    fn authenticated_malformed_payload_and_roster_fail() {
        for round in 1..=4 {
            let (mut actors, mut messages) = initialized();
            for _ in 1..round {
                messages = advance(&mut actors, messages);
            }
            let from = wire::number(&messages[0], "from").unwrap();
            let to = wire::number(&messages[0], "to").unwrap();
            messages[0] = actors[from as usize - 1]
                .outgoing(to, round, b"bad")
                .unwrap();
            let selected = messages
                .into_iter()
                .filter(|m| wire::number(m, "to").unwrap() == to)
                .collect::<Vec<_>>();
            let mut rejected = false;
            for m in selected {
                if actors[to as usize - 1].accept(&m).is_err() {
                    rejected = true;
                }
            }
            assert!(rejected);
            assert!(actors[to as usize - 1].keys.is_none());
        }
    }
    #[test]
    fn invalid_initial_profiles_retire() {
        for case in 0..8 {
            let mut actors = (1..=4).map(|i| Actor::new(i).unwrap()).collect::<Vec<_>>();
            let roster = actors
                .iter()
                .map(|a| json!({"id":a.id,"publicKey":a.identity()["publicKey"]}))
                .collect::<Vec<_>>();
            let mut init = json!({"type":"init","ceremony":"11".repeat(32),"epoch":"22".repeat(32),"threshold":2,"roster":roster});
            match case {
                0 => init["threshold"] = json!(3),
                1 => init["roster"][1]["publicKey"] = init["roster"][0]["publicKey"].clone(),
                2 => {
                    init["roster"][0]["publicKey"] =
                        Actor::new(1).unwrap().identity()["publicKey"].clone()
                }
                3 => init["roster"][1]["id"] = json!(3),
                4 => init["ceremony"] = json!("aa"),
                5 => init["epoch"] = json!("BB".repeat(32)),
                6 => init["extra"] = json!(0),
                _ => init["roster"][1]["extra"] = json!(0),
            }
            assert!(actors[0].accept(&init).is_err());
            assert!(matches!(actors[0].phase, Phase::Retired));
        }
    }
    #[test]
    fn interruption_before_ack_prevents_ready() {
        let (mut actors, mut messages) = initialized();
        for _ in 1..=3 {
            messages = advance(&mut actors, messages);
        }
        let target = 1;
        let peer_acks = messages
            .iter()
            .filter(|m| wire::number(m, "to").unwrap() == target)
            .collect::<Vec<_>>();
        assert_eq!(peer_acks.len(), 3);
        for message in &peer_acks[..2] {
            assert!(actors[0].accept(message).unwrap().is_empty());
        }
        assert!(!matches!(actors[0].phase, Phase::Ready));
        assert!(actors[0]
            .accept(&json!({"type":"stop"}))
            .unwrap()
            .is_empty());
        assert!(actors[0].keys.is_none());
        assert!(actors[0].accept(peer_acks[2]).is_err());
    }
    #[test]
    fn init_closed_profile_and_eof() {
        let (mut actors, _) = initialized();
        assert!(actors[0].accept(&json!({"type":"init"})).is_err());
        let mut output = vec![];
        assert!(run(1, std::io::Cursor::new(b""), &mut output).is_ok());
        assert_eq!(output.iter().filter(|b| **b == b'\n').count(), 1);
        assert!(run(
            1,
            std::io::Cursor::new(vec![b'x'; wire::MAX_FRAME + 1]),
            vec![]
        )
        .is_err());
    }
}
