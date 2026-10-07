import copy
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils

from retained_gate import Gate, ORDER, Policy, b2, canonical


def fixture_policy():
    private = [ec.derive_private_key(i, ec.SECP256K1()) for i in range(1, 5)]
    public = [key.public_key().public_bytes(serialization.Encoding.X962,
              serialization.PublicFormat.CompressedPoint).hex() for key in private]
    return private, Policy(public, 1791374400)


def certificate(text, policy, private, votes=3):
    digest = b2(text.encode()).hex()
    signatures = []
    for index, (key, public) in enumerate(zip(private, policy.keys)):
        if index >= votes:
            signatures.append("")
            continue
        payload = '{"txDataHash":"' + digest + '"}' + str(policy.timestamp) + public + "1.0.0"
        signature = key.sign(b2(payload.encode()), ec.ECDSA(utils.Prehashed(hashes.SHA256())))
        r, s = utils.decode_dss_signature(signature)
        s = min(s, ORDER - s)
        signatures.append((r.to_bytes(32, "big") + s.to_bytes(32, "big")).hex())
    return {"txJson": text, "txId": __import__("json").loads(text)["intent"],
            "txDataHash": digest, "signatures": signatures,
            "timestamp": policy.timestamp, "publicKeys": list(policy.keys),
            "protocolVersion": "1.0.0", "requiredSign": 3}


def candidate_fixture():
    # Storage/policy test only. Actual curve/proposal validity belongs to Core.
    request = bytes([0]) + bytes([1]) * 32 + bytes([2]) * 256 + bytes([3]) * 32 + bytes([4]) * 160
    return {"domain": "rosen-monero/fcmp-candidate/v1", "network": "regtest-fcmp-beta3",
            "genesis": "05" * 32, "intent": "06" * 32,
            "proposal": "010203", "request": request.hex()}


class RetainedGateTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = str(Path(self.directory.name) / "gate.db")
        self.private, self.policy = fixture_policy()
        self.value = candidate_fixture()
        self.text = canonical(self.value)
        self.cert = certificate(self.text, self.policy, self.private)
        self.gate = Gate(self.path)

    def tearDown(self):
        self.gate.close()
        self.directory.cleanup()

    def test_quorum_and_independent_certificate_fields(self):
        self.policy.verify(self.cert, self.text, self.value["intent"])
        for field, replacement in [("txJson", self.text + " "), ("txId", "00" * 32),
                ("txDataHash", "00" * 32), ("timestamp", self.policy.timestamp + 1),
                ("protocolVersion", "2.0.0"), ("requiredSign", 2),
                ("publicKeys", list(reversed(self.policy.keys)))]:
            changed = copy.deepcopy(self.cert)
            changed[field] = replacement
            with self.subTest(field=field), self.assertRaises(Exception):
                self.policy.verify(changed, self.text, self.value["intent"])
        with self.assertRaises(ValueError):
            self.gate.admit(self.text, certificate(self.text, self.policy, self.private, 2), self.policy)
        high = copy.deepcopy(self.cert)
        signature = bytes.fromhex(high["signatures"][0])
        high["signatures"][0] = (signature[:32] + (ORDER - int.from_bytes(signature[32:], "big")).to_bytes(32, "big")).hex()
        with self.assertRaises(ValueError):
            self.gate.admit(self.text, high, self.policy)
        wrong = copy.deepcopy(self.cert)
        wrong["signatures"][0] = wrong["signatures"][1]
        with self.assertRaises(Exception):
            self.gate.admit(self.text, wrong, self.policy)
        self.assertEqual(self.gate.db.execute("SELECT count(*) FROM candidates").fetchone()[0], 0)

    def test_consumption_survives_restart_without_nonce_reuse(self):
        digest = self.gate.admit(self.text, self.cert, self.policy)
        # Terminate without close/finally after the consumption transaction.
        # The parent then opens the same database as a fresh participant owner.
        process = subprocess.run([sys.executable, "-c",
            "from retained_gate import Gate; import os,sys; "
            "gate=Gate(sys.argv[1]); gate.begin(sys.argv[2]); os._exit(91)",
            self.path, digest], cwd=Path(__file__).parent, check=False)
        self.assertEqual(process.returncode, 91)
        self.gate.close()
        self.gate = Gate(self.path)
        with self.assertRaises(sqlite3.IntegrityError):
            self.gate.begin(digest)
        self.assertIsNone(self.gate.recover(digest)[1])

    def test_retained_result_and_submission_are_immutable_after_restart(self):
        digest = self.gate.admit(self.text, self.cert, self.policy)
        self.gate.begin(digest)
        sal = b"s" * 416
        self.gate.retain_sal(digest, sal)
        self.gate.finalize(digest, b"Core-validated-transaction-fixture", "07" * 32, b"r" * 284)
        self.gate.close()
        self.gate = Gate(self.path)
        recovered = self.gate.recover(digest)
        self.assertEqual(recovered[1:4], (sal, b"Core-validated-transaction-fixture", "07" * 32))
        self.assertEqual(recovered[5], b"r" * 284)
        self.gate.submitted(digest, recovered[2], recovered[3])
        self.gate.submitted(digest, recovered[2], recovered[3])
        with self.assertRaises(ValueError):
            self.gate.retain_sal(digest, b"t" * 416)
        with self.assertRaises(ValueError):
            self.gate.finalize(digest, b"different", "07" * 32, b"r" * 284)
        with self.assertRaises(ValueError):
            self.gate.finalize(digest, recovered[2], "07" * 32, b"q" * 284)
        with self.assertRaises(ValueError):
            self.gate.submitted(digest, recovered[2], "08" * 32)

    def test_intent_and_input_cannot_be_reassigned_to_second_candidate(self):
        self.gate.admit(self.text, self.cert, self.policy)
        for field in ("proposal", "intent"):
            changed = dict(self.value)
            changed[field] = "090a" if field == "proposal" else "09" * 32
            text = canonical(changed)
            with self.subTest(field=field), self.assertRaises(sqlite3.IntegrityError):
                self.gate.admit(text, certificate(text, self.policy, self.private), self.policy)

    def test_no_unsigned_attempt_or_finalization(self):
        with self.assertRaises(ValueError):
            self.gate.begin("00" * 32)
        digest = self.gate.admit(self.text, self.cert, self.policy)
        with self.assertRaises(ValueError):
            self.gate.retain_sal(digest, b"s" * 416)
        self.gate.begin(digest)
        with self.assertRaises(ValueError):
            self.gate.finalize(digest, b"tx", "00" * 32, b"r" * 284)


if __name__ == "__main__":
    unittest.main()
