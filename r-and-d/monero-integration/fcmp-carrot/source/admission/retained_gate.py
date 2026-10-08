"""Local FCMP candidate admission and durable, one-candidate payment ownership.

This consumes the existing Rosen 3-of-4 ECDSA certificate encoding. It does not
replace a participant's independent Core reconstruction or daemon checks. The
candidate's txJson contains canonical proposal/request bytes, not a final txid:
FCMP membership finalization determines that txid after SAL signing.
"""
import hashlib
import json
import sqlite3
from contextlib import contextmanager

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, utils


ORDER = int("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141", 16)


def b2(data):
    return hashlib.blake2b(data, digest_size=32).digest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def unhex(value, length=None):
    if not isinstance(value, str) or value != value.lower():
        raise ValueError("noncanonical hex")
    raw = bytes.fromhex(value)
    if raw.hex() != value or (length is not None and len(raw) != length):
        raise ValueError("wrong hex length")
    return raw


def strict_json(text):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result
    def forbidden(_):
        raise ValueError("noninteger JSON number")
    return json.loads(text, object_pairs_hook=unique, parse_float=forbidden,
                      parse_constant=forbidden)


def fields(value, expected):
    if not isinstance(value, dict) or set(value) != set(expected):
        raise ValueError("unexpected fields")


class Policy:
    """Pinned local roster; certificate data cannot replace this authority."""
    def __init__(self, public_keys, timestamp):
        if len(public_keys) != 4 or len(set(public_keys)) != 4:
            raise ValueError("expected four distinct guard keys")
        if type(timestamp) is not int or not 0 <= timestamp <= 0xffffffff:
            raise ValueError("invalid epoch timestamp")
        self.timestamp = timestamp
        self.keys = tuple(public_keys)
        for key in self.keys:
            raw = unhex(key, 33)
            if raw[0] not in (2, 3):
                raise ValueError("expected compressed guard key")
            ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256K1(), raw)

    def verify(self, certificate, tx_json, intent):
        fields(certificate, ("txJson", "txId", "txDataHash", "signatures", "timestamp",
                             "publicKeys", "protocolVersion", "requiredSign"))
        digest = b2(tx_json.encode()).hex()
        if (certificate["txJson"] != tx_json or certificate["txId"] != intent
                or certificate["txDataHash"] != digest
                or type(certificate["timestamp"]) is not int
                or certificate["timestamp"] != self.timestamp
                or certificate["protocolVersion"] != "1.0.0"
                or type(certificate["requiredSign"]) is not int
                or certificate["requiredSign"] != 3
                or certificate["publicKeys"] != list(self.keys)):
            raise ValueError("certificate does not match retained candidate/roster")
        signatures = certificate["signatures"]
        if not isinstance(signatures, list) or len(signatures) != 4:
            raise ValueError("wrong certificate signature count")
        count = 0
        for key, signature in zip(self.keys, signatures):
            if signature == "":
                continue
            raw = unhex(signature, 64)
            r, s = int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")
            if not 0 < r < ORDER or not 0 < s <= ORDER // 2:
                raise ValueError("noncanonical ECDSA signature")
            payload = '{"txDataHash":"' + digest + '"}' + str(self.timestamp) + key + "1.0.0"
            public = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256K1(), unhex(key, 33))
            # ECDSA consumes the same 32-byte Blake2b digest as Rosen. Prehashed
            # SHA256 here specifies the digest width; it performs no rehashing.
            public.verify(utils.encode_dss_signature(r, s), b2(payload.encode()),
                          ec.ECDSA(utils.Prehashed(hashes.SHA256())))
            count += 1
        if count < 3:
            raise ValueError("insufficient independently valid guard votes")


def candidate(tx_json):
    value = strict_json(tx_json)
    expected = ("domain", "genesis", "intent", "network", "proposal", "request")
    if not isinstance(value, dict):
        raise ValueError("candidate must be an object")
    if value.get("domain") == "rosen-monero/fcmp-candidate/v1":
        if "backing_event" in value:
            expected += ("backing_event",)
            unhex(value["backing_event"], 32)
    elif value.get("domain") == "rosen-monero/fcmp-candidate/v2":
        expected += ("backing_event", "backing_ledger_id", "backing_credit_id",
                     "backing_credit_block_height", "backing_credit_block_hash",
                     "backing_credit_global_output_index")
        fields(value, expected)
        for field in ("backing_event", "backing_ledger_id", "backing_credit_id",
                      "backing_credit_block_hash"):
            unhex(value[field], 32)
        for field in ("backing_credit_block_height", "backing_credit_global_output_index"):
            number = value[field]
            if type(number) is not int or not 0 <= number <= 0x7fffffffffffffff:
                raise ValueError("invalid backing credit anchor")
        if value["backing_credit_block_height"] == 0:
            raise ValueError("unconfirmed backing credit anchor")
    else:
        raise ValueError("unsupported candidate domain")
    fields(value, expected)
    if canonical(value) != tx_json:
        raise ValueError("noncanonical candidate")
    if value["network"] != "regtest-fcmp-beta3":
        raise ValueError("local synthetic network required")
    unhex(value["genesis"], 32)
    unhex(value["intent"], 32)
    proposal = unhex(value["proposal"])
    request = unhex(value["request"], 481)
    if not proposal or len(proposal) > 1024 * 1024 or request[0] != 0:
        raise ValueError("unsupported candidate profile")
    # Fixed ABI: mode1 + message32 + rerandomization256 + OTA32 + group32
    # + multiplier32 + offset32 + y32 + image32. Core rechecks each field.
    return value, b2(tx_json.encode()).hex(), request[289:321].hex()


class Gate:
    def __init__(self, path):
        self.db = sqlite3.connect(path, isolation_level=None, timeout=10)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS candidates(
                digest TEXT PRIMARY KEY, intent TEXT NOT NULL UNIQUE,
                input TEXT NOT NULL UNIQUE, candidate TEXT NOT NULL,
                certificate TEXT NOT NULL, final_tx BLOB, final_txid TEXT,
                submitted INTEGER NOT NULL DEFAULT 0, final_receipt BLOB);
            CREATE TABLE IF NOT EXISTS attempts(
                candidate TEXT PRIMARY KEY REFERENCES candidates(digest),
                sal BLOB);
            CREATE TABLE IF NOT EXISTS confirmations(
                candidate TEXT PRIMARY KEY REFERENCES candidates(digest),
                txid TEXT NOT NULL, block_height INTEGER NOT NULL,
                block_hash TEXT NOT NULL);
        """)

    def close(self):
        self.db.close()

    @contextmanager
    def write(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def admit(self, tx_json, certificate, policy):
        value, digest, ota = candidate(tx_json)
        policy.verify(certificate, tx_json, value["intent"])
        with self.write():
            old = self.db.execute("SELECT candidate FROM candidates WHERE digest=?", (digest,)).fetchone()
            if old is None:
                self.db.execute("INSERT INTO candidates(digest,intent,input,candidate,certificate) VALUES(?,?,?,?,?)",
                                (digest, value["intent"], ota, tx_json, canonical(certificate)))
            elif old[0] != tx_json:
                raise ValueError("retained candidate changed")
        return digest

    def begin(self, digest):
        """Commit consumption BEFORE any threshold nonce/preprocessing exists."""
        with self.write():
            row = self.db.execute("SELECT candidate FROM candidates WHERE digest=?", (digest,)).fetchone()
            if row is None:
                raise ValueError("candidate was not admitted")
            value = strict_json(row[0])
            if "backing_event" in value and value["domain"] != "rosen-monero/fcmp-candidate/v2":
                raise ValueError("legacy backed candidate requires a new v2 certificate")
            self.db.execute("INSERT INTO attempts(candidate) VALUES(?)", (digest,))

    def retain_sal(self, digest, sal):
        if not isinstance(sal, bytes) or len(sal) != 416:
            raise ValueError("wrong single-input SAL response length")
        with self.write():
            row = self.db.execute("SELECT sal FROM attempts WHERE candidate=?", (digest,)).fetchone()
            if row is None or (row[0] is not None and row[0] != sal):
                raise ValueError("missing attempt or immutable SAL changed")
            self.db.execute("UPDATE attempts SET sal=? WHERE candidate=?", (sal, digest))

    def finalize(self, digest, tx_blob, core_txid, receipt):
        """Only after the Core consumer verifies SAL, final hash and transaction.

        core_txid is the pinned Core result, never a hash of SAL or proposal.
        This storage boundary cannot itself establish Monero validity.
        """
        unhex(core_txid, 32)
        if not isinstance(tx_blob, bytes) or not 0 < len(tx_blob) <= 1024 * 1024:
            raise ValueError("invalid final transaction bytes")
        if not isinstance(receipt, bytes) or len(receipt) != 284:
            raise ValueError("invalid final receipt bytes")
        with self.write():
            row = self.db.execute("SELECT a.sal,c.final_tx,c.final_txid,c.final_receipt FROM candidates c JOIN attempts a ON c.digest=a.candidate WHERE c.digest=?", (digest,)).fetchone()
            if row is None or row[0] is None:
                raise ValueError("missing retained SAL")
            if row[1] is not None and row[1:] != (tx_blob, core_txid, receipt):
                raise ValueError("immutable finalized transaction changed")
            self.db.execute("UPDATE candidates SET final_tx=?,final_txid=?,final_receipt=? WHERE digest=?", (tx_blob, core_txid, receipt, digest))

    def recover(self, digest):
        row = self.db.execute("SELECT c.candidate,a.sal,c.final_tx,c.final_txid,c.submitted,c.final_receipt FROM candidates c LEFT JOIN attempts a ON c.digest=a.candidate WHERE c.digest=?", (digest,)).fetchone()
        if row is None:
            raise ValueError("unknown candidate")
        return row

    def submitted(self, digest, tx_blob, core_txid):
        with self.write():
            row = self.db.execute("SELECT final_tx,final_txid FROM candidates WHERE digest=?", (digest,)).fetchone()
            if row is None or row != (tx_blob, core_txid):
                raise ValueError("submission differs from retained final transaction")
            self.db.execute("UPDATE candidates SET submitted=1 WHERE digest=?", (digest,))

    def confirm(self, digest, tx_blob, core_txid, block_height, block_hash):
        unhex(core_txid, 32)
        unhex(block_hash, 32)
        if type(block_height) is not int or block_height < 1:
            raise ValueError("invalid confirmed return height")
        with self.write():
            row = self.db.execute("""
                SELECT final_tx,final_txid,submitted FROM candidates WHERE digest=?
            """, (digest,)).fetchone()
            if row != (tx_blob, core_txid, 1):
                raise ValueError("confirmation differs from submitted final transaction")
            previous = self.db.execute("""
                SELECT txid,block_height,block_hash FROM confirmations WHERE candidate=?
            """, (digest,)).fetchone()
            authority = (core_txid, block_height, block_hash)
            # Keep the first durable inclusion as the replay authority. The
            # same exact transaction may confirm in a different block after a
            # reorg; this current inclusion was independently checked by the
            # caller and must not overwrite the historical proof.
            if previous is not None and previous[0] != core_txid:
                raise ValueError("confirmed return transaction changed")
            if previous is None:
                self.db.execute("""
                    INSERT INTO confirmations(candidate,txid,block_height,block_hash)
                    VALUES(?,?,?,?)
                """, (digest, *authority))

    def confirmation(self, digest):
        return self.db.execute("""
            SELECT txid,block_height,block_hash FROM confirmations WHERE candidate=?
        """, (digest,)).fetchone()
