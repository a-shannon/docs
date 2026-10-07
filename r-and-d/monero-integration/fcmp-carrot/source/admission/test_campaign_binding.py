import copy
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from local_campaign import match_backing, retained_on_daemon
from retained_gate import Gate, candidate, canonical
from test_retained_gate import candidate_fixture, certificate, fixture_policy


class BackingBindingTests(unittest.TestCase):
    def setUp(self):
        self.value = candidate_fixture()
        self.value["backing_event"] = "07" * 32
        self.observed = {"event_origin": "07" * 32, "genesis": "05" * 32,
                         "K_o": "03" * 32, "key_image": "04" * 32}

    def test_each_independent_output_identity_must_match(self):
        match_backing(self.value, self.observed)
        for field in ("event_origin", "genesis", "K_o", "key_image"):
            changed = dict(self.observed)
            changed[field] = "08" * 32
            with self.subTest(field=field), self.assertRaises(ValueError):
                match_backing(self.value, changed)

    def test_event_origin_is_in_the_authenticated_candidate(self):
        private, policy = fixture_policy()
        text = canonical(self.value)
        votes = certificate(text, policy, private)
        with tempfile.TemporaryDirectory() as directory:
            gate = Gate(str(Path(directory) / "gate.db"))
            try:
                gate.admit(text, votes, policy)
                changed = copy.deepcopy(self.value)
                changed["backing_event"] = "08" * 32
                with self.assertRaises(ValueError):
                    gate.admit(canonical(changed), votes, policy)
                changed["backing_event"] = "08"
                with self.assertRaises(ValueError):
                    candidate(canonical(changed))
            finally:
                gate.close()

    def test_reconcile_exact_blob_before_already_present_recovery(self):
        txid, blob = "09" * 32, b"exact retained Core transaction"
        entry = {"tx_hash": txid, "as_hex": blob.hex(), "in_pool": True}
        with patch("local_campaign.post", return_value={"status": "OK", "txs": [entry]}):
            self.assertTrue(retained_on_daemon("http://127.0.0.1:58181", txid, blob))
        for field, changed in (("tx_hash", "08" * 32), ("as_hex", b"different".hex()),
                               ("in_pool", "true")):
            bad = dict(entry)
            bad[field] = changed
            with self.subTest(field=field), patch("local_campaign.post", return_value={
                    "status": "OK", "txs": [bad]}), self.assertRaises(ValueError):
                retained_on_daemon("http://127.0.0.1:58181", txid, blob)
        with patch("local_campaign.post", return_value={"status": "OK", "missed_tx": [txid]}):
            self.assertFalse(retained_on_daemon("http://127.0.0.1:58181", txid, blob))
        with patch("local_campaign.post", return_value={"status": "OK"}), self.assertRaises(ValueError):
            retained_on_daemon("http://127.0.0.1:58181", txid, blob)


if __name__ == "__main__":
    unittest.main()
