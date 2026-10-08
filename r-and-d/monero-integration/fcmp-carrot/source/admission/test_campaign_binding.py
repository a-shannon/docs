import copy
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from pathlib import Path

from local_campaign import execute, match_backing, require_bytes, retained_on_daemon
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

    def _retained_runtime(self, directory, finalized, backed=False):
        root = Path(directory)
        value = candidate_fixture()
        if backed:
            value["backing_event"] = "07" * 32
        private, policy = fixture_policy()
        (root / "candidate.json").write_text(canonical(value))
        (root / "certificate.json").write_text(canonical(certificate(canonical(value), policy, private)))
        (root / "request.bin").write_bytes(bytes.fromhex(value["request"]))
        (root / "proposal.bin").write_bytes(bytes.fromhex(value["proposal"]))
        (root / "intent.bin").write_bytes(bytes.fromhex(value["intent"]))
        (root / "response.bin").write_bytes(b"s" * 416)
        if finalized:
            (root / "transaction.bin").write_bytes(b"retained transaction")
            (root / "transaction.bin.receipt").write_bytes(b"r" * 284)
            (root / "transaction.bin.intent").write_bytes(bytes.fromhex(value["intent"]))
        args = SimpleNamespace(
            core="core", signer="signer", node="http://127.0.0.1:58181",
            runtime=str(root), era="carrot", profile="return", input_key=None,
            deposit_observer=None, deposit_runtime=None, deposit_receipt=None,
            deposit_intent=None, deposit_confirmations=10, submit=False,
        )
        return args, value

    @staticmethod
    def _rpc(_url, method, _params=None):
        if method == "get_info":
            return {"nettype": "fakechain", "mainnet": False, "offline": True}
        return {"block_header": {"hash": "05" * 32}}

    @staticmethod
    def _supply_backing_hooks(args):
        args.deposit_observer = "observer"
        args.deposit_runtime = "deposit-runtime"
        args.deposit_receipt = "deposit.receipt"
        args.deposit_intent = "deposit.intent"

    def test_retained_unbacked_candidate_rejects_later_backing_hooks(self):
        class FinalizedGate:
            def __init__(self, _path):
                pass

            def admit(self, *_args):
                return "digest"

            def recover(self, _digest):
                return ("candidate", b"s" * 416, b"retained transaction", "07" * 32,
                        0, b"r" * 284)

            def close(self):
                pass

        with tempfile.TemporaryDirectory() as directory:
            args, _ = self._retained_runtime(directory, finalized=True)
            args.deposit_observer = "observer"
            args.deposit_runtime = "deposit-runtime"
            args.deposit_receipt = "deposit.receipt"
            args.deposit_intent = "deposit.intent"
            observed = {"event_origin": "07" * 32, "genesis": "05" * 32,
                        "K_o": "03" * 32, "key_image": "04" * 32}
            with patch("local_campaign.rpc", side_effect=self._rpc), \
                    patch("local_campaign.Gate", FinalizedGate), \
                    patch("local_campaign.backing_observation", return_value=observed) as observer, \
                    patch("local_campaign.run", return_value="txid=07" + "07" * 31):
                with self.assertRaisesRegex(ValueError, "without deposit backing"):
                    execute(args)
                observer.assert_not_called()

    def test_retained_backed_candidate_requires_its_consumer_hooks(self):
        with tempfile.TemporaryDirectory() as directory:
            args, _ = self._retained_runtime(directory, finalized=True, backed=True)
            with patch("local_campaign.rpc", side_effect=self._rpc), \
                    patch("local_campaign.backing_observation") as observer:
                with self.assertRaisesRegex(ValueError, "requires its independent consumer"):
                    execute(args)
                observer.assert_not_called()

    def test_concurrent_finalizers_retain_and_restore_only_gate_winner(self):
        with tempfile.TemporaryDirectory() as directory:
            args, value = self._retained_runtime(directory, finalized=False)
            text = canonical(value)
            private, policy = fixture_policy()
            votes = certificate(text, policy, private)
            setup = Gate(str(Path(directory) / "gate.db"))
            digest = setup.admit(text, votes, policy)
            setup.begin(digest)
            setup.retain_sal(digest, b"s" * 416)
            setup.close()
            barrier = threading.Barrier(2)
            assignment_lock = threading.Lock()
            private_outputs = []
            errors = []
            successes = []
            variants = (
                (b"first distinct final transaction", "07" * 32, b"a" * 284),
                (b"second distinct final transaction", "08" * 32, b"b" * 284),
            )
            txids = {transaction: txid for transaction, txid, _receipt in variants}

            def fake_run(arguments):
                if "node-verify" in arguments:
                    with assignment_lock:
                        index = len(private_outputs)
                        transaction, txid, receipt = variants[index]
                        output = Path(arguments[-2])
                        private_outputs.append(output)
                    output.write_bytes(transaction)
                    Path(str(output) + ".receipt").write_bytes(receipt)
                    Path(str(output) + ".intent").write_bytes(bytes.fromhex(value["intent"]))
                    barrier.wait(timeout=5)
                    return "txid=" + txid
                if "audit-final" in arguments:
                    transaction = Path(arguments[-3]).read_bytes()
                    return "txid=" + txids[transaction]
                raise AssertionError("unexpected command: " + repr(arguments))

            def worker():
                try:
                    execute(copy.copy(args))
                    successes.append(True)
                except BaseException as error:
                    errors.append(error)

            with patch("local_campaign.rpc", side_effect=self._rpc), \
                    patch("local_campaign.run", side_effect=fake_run):
                threads = [threading.Thread(target=worker) for _ in range(2)]
                for thread in threads:
                    thread.start()
                for thread in threads:
                    thread.join(timeout=10)
            self.assertFalse(any(thread.is_alive() for thread in threads))
            self.assertEqual(len(successes), 1)
            self.assertEqual(len(errors), 1)
            self.assertRegex(str(errors[0]), "immutable finalized transaction changed")
            self.assertEqual(len({str(path) for path in private_outputs}), 2)
            self.assertNotIn(Path(directory) / "transaction.bin", private_outputs)
            result = Gate(str(Path(directory) / "gate.db"))
            try:
                retained = result.recover(digest)
            finally:
                result.close()
            self.assertIn((retained[2], retained[3], retained[5]), variants)
            self.assertEqual((Path(directory) / "transaction.bin").read_bytes(), retained[2])
            self.assertEqual((Path(directory) / "transaction.bin.receipt").read_bytes(), retained[5])
            self.assertEqual((Path(directory) / "transaction.bin.intent").read_bytes(),
                             bytes.fromhex(value["intent"]))

    def test_daemon_present_backed_recovery_does_not_reobserve_spent_backing(self):
        class SubmittedGate:
            submitted_calls = 0

            def __init__(self, _path):
                pass

            def admit(self, *_args):
                return "digest"

            def recover(self, _digest):
                return ("candidate", b"s" * 416, b"retained transaction", "07" * 32,
                        1, b"r" * 284)

            def submitted(self, *_args):
                type(self).submitted_calls += 1

            def close(self):
                pass

        with tempfile.TemporaryDirectory() as directory:
            args, _ = self._retained_runtime(directory, finalized=True, backed=True)
            self._supply_backing_hooks(args)
            args.submit = True
            with patch("local_campaign.rpc", side_effect=self._rpc), \
                    patch("local_campaign.Gate", SubmittedGate), \
                    patch("local_campaign.backing_observation",
                          side_effect=AssertionError("spent backing must not be reobserved")) as observer, \
                    patch("local_campaign.retained_on_daemon", return_value=True) as reconcile, \
                    patch("local_campaign.run", return_value="txid=" + "07" * 32):
                execute(args)
            observer.assert_not_called()
            reconcile.assert_called_once()
            self.assertEqual(SubmittedGate.submitted_calls, 1)

    def test_backed_candidate_reobserves_once_before_new_signing(self):
        class StopBeforeSigner(Exception):
            pass

        class SigningGate:
            def __init__(self, _path):
                pass

            def admit(self, *_args):
                return "digest"

            def recover(self, _digest):
                return ("candidate", None, None, None, 0, None)

            def begin(self, _digest):
                pass

            def close(self):
                pass

        with tempfile.TemporaryDirectory() as directory:
            args, _ = self._retained_runtime(directory, finalized=False, backed=True)
            self._supply_backing_hooks(args)
            with patch("local_campaign.rpc", side_effect=self._rpc), \
                    patch("local_campaign.Gate", SigningGate), \
                    patch("local_campaign.backing_observation", return_value=self.observed) as observer:
                def fake_run(arguments):
                    if arguments[0] == args.signer:
                        self.assertEqual(observer.call_count, 1)
                        raise StopBeforeSigner()
                    return ""

                with patch("local_campaign.run", side_effect=fake_run), \
                        self.assertRaises(StopBeforeSigner):
                    execute(args)
            observer.assert_called_once()

    def test_backed_candidate_reobserves_once_before_first_submit(self):
        class FinalizedGate:
            def __init__(self, _path):
                pass

            def admit(self, *_args):
                return "digest"

            def recover(self, _digest):
                return ("candidate", b"s" * 416, b"retained transaction", "07" * 32,
                        0, b"r" * 284)

            def submitted(self, *_args):
                pass

            def close(self):
                pass

        with tempfile.TemporaryDirectory() as directory:
            args, _ = self._retained_runtime(directory, finalized=True, backed=True)
            self._supply_backing_hooks(args)
            args.submit = True
            with patch("local_campaign.rpc", side_effect=self._rpc), \
                    patch("local_campaign.Gate", FinalizedGate), \
                    patch("local_campaign.retained_on_daemon", return_value=False), \
                    patch("local_campaign.backing_observation", return_value=self.observed) as observer:
                def fake_run(arguments):
                    if "node-submit" in arguments:
                        self.assertEqual(observer.call_count, 1)
                        return ""
                    return "txid=" + "07" * 32

                with patch("local_campaign.run", side_effect=fake_run):
                    execute(args)
            observer.assert_called_once()

    def test_interrupted_derived_restore_never_leaves_partial_target(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "transaction.bin"
            with patch("os.replace", side_effect=KeyboardInterrupt("synthetic interruption")):
                with self.assertRaises(KeyboardInterrupt):
                    require_bytes(target, b"complete retained bytes")
            self.assertFalse(target.exists())
            require_bytes(target, b"complete retained bytes")
            self.assertEqual(target.read_bytes(), b"complete retained bytes")


if __name__ == "__main__":
    unittest.main()
