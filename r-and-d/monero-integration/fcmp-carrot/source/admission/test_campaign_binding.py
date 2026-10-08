import copy
import subprocess
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from pathlib import Path

import local_campaign
from local_campaign import execute, match_backing, require_bytes, retained_on_daemon
from retained_gate import Gate, candidate, canonical, strict_json
from test_retained_gate import candidate_fixture, certificate, fixture_policy


class BackingBindingTests(unittest.TestCase):
    def setUp(self):
        self.value = candidate_fixture()
        self.value.update(domain="rosen-monero/fcmp-candidate/v2",
                          backing_event="07" * 32, backing_ledger_id="08" * 32,
                          backing_credit_id="09" * 32, backing_credit_block_height=90,
                          backing_credit_block_hash="0a" * 32,
                          backing_credit_global_output_index=12)
        self.observed = {"event_origin": "07" * 32, "genesis": "05" * 32,
                         "K_o": "03" * 32, "key_image": "04" * 32,
                         "ledger_id": "08" * 32, "credit_id": "09" * 32,
                         "credit_block_height": 90, "credit_block_hash": "0a" * 32,
                         "credit_global_output_index": 12}

    def test_each_independent_output_identity_must_match(self):
        match_backing(self.value, self.observed)
        for field in ("event_origin", "genesis", "K_o", "key_image", "ledger_id",
                      "credit_id", "credit_block_height", "credit_block_hash",
                      "credit_global_output_index"):
            changed = dict(self.observed)
            changed[field] = 13 if isinstance(changed[field], int) else "0b" * 32
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
                for field in ("backing_ledger_id", "backing_credit_id",
                              "backing_credit_block_height", "backing_credit_block_hash",
                              "backing_credit_global_output_index"):
                    changed = copy.deepcopy(self.value)
                    changed[field] = (13 if isinstance(changed[field], int)
                                      else "0b" * 32)
                    with self.subTest(field=field), self.assertRaises(Exception):
                        gate.admit(canonical(changed), votes, policy)
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

    def test_confirmation_requires_canonical_exact_ten_block_inclusion(self):
        url, txid, blob = "http://127.0.0.1:58181", "07" * 32, b"retained transaction"
        entry = {"tx_hash": txid, "as_hex": blob.hex(), "in_pool": False,
                 "block_height": 90, "confirmations": 10}

        def good_rpc(_url, method, _params=None):
            if method == "get_info":
                return {"height": 100, "top_block_hash": "08" * 32}
            return {"block_header": {"height": 90, "hash": "09" * 32,
                                      "orphan_status": False}}

        def response(_url, _path, _payload):
            return {"status": "OK", "txs": [dict(entry)]}

        with patch("local_campaign.rpc", side_effect=good_rpc), \
                patch("local_campaign.post", side_effect=response):
            self.assertEqual(local_campaign.confirmed_on_daemon(url, txid, blob),
                             (90, "09" * 32))
        for field, replacement in (("in_pool", True), ("confirmations", 9),
                                   ("block_height", 91), ("as_hex", "00")):
            changed = dict(entry, **{field: replacement})
            with self.subTest(field=field), \
                    patch("local_campaign.rpc", side_effect=good_rpc), \
                    patch("local_campaign.post", return_value={"status": "OK", "txs": [changed]}), \
                    self.assertRaises(ValueError):
                local_campaign.confirmed_on_daemon(url, txid, blob)
        deconfirmed = dict(entry, in_pool=True, confirmations=0)
        with patch("local_campaign.rpc", side_effect=good_rpc), \
                patch("local_campaign.post", side_effect=[
                    {"status": "OK", "txs": [entry]},
                    {"status": "OK", "txs": [deconfirmed]},
                ]), self.assertRaises(ValueError):
            local_campaign.confirmed_on_daemon(url, txid, blob)
        with patch("local_campaign.rpc", side_effect=lambda _url, method, _params=None: (
                {"height": 100, "top_block_hash": "08" * 32}
                if method == "get_info" else
                {"block_header": {"height": 90, "hash": "09" * 32}})), \
                patch("local_campaign.post", side_effect=response), self.assertRaises(ValueError):
            local_campaign.confirmed_on_daemon(url, txid, blob)

    def _retained_runtime(self, directory, finalized, backed=False, legacy_backed=False):
        root = Path(directory)
        value = candidate_fixture()
        if backed:
            value.update(self.value)
        if legacy_backed:
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
            with patch("local_campaign.rpc", side_effect=self._rpc), \
                    patch("local_campaign.Gate", FinalizedGate), \
                    patch("local_campaign.backing_observation", return_value=self.observed) as observer, \
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

    def test_initial_bundle_publication_recovers_after_each_crash_boundary(self):
        class StopAfterBundle(Exception):
            pass

        for boundary in ("certificate.json", "intent.bin", "candidate.json"):
            with self.subTest(boundary=boundary), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                fixture = candidate_fixture()
                args = SimpleNamespace(
                    core="core", signer="signer", node="http://127.0.0.1:58181",
                    runtime=str(root), era="carrot", profile="vault", input_key=None,
                    deposit_observer=None, deposit_runtime=None, deposit_receipt=None,
                    deposit_intent=None, deposit_confirmations=10, submit=False,
                )
                commands = []
                gate_opens = []

                def fake_run(arguments):
                    commands.append(tuple(arguments))
                    if "node-export" not in arguments:
                        raise AssertionError("signing/finalization must not start")
                    Path(arguments[-2]).write_bytes(bytes.fromhex(fixture["request"]))
                    Path(arguments[-1]).write_bytes(bytes.fromhex(fixture["proposal"]))
                    return ""

                class StopGate:
                    def __init__(self, _path):
                        gate_opens.append(True)
                        raise StopAfterBundle()

                original_replace = local_campaign.atomic_replace_bytes
                interrupted = False

                def interrupt_after_replace(path, expected):
                    nonlocal interrupted
                    original_replace(path, expected)
                    if not interrupted and path.name == boundary:
                        interrupted = True
                        raise KeyboardInterrupt("synthetic initial-bundle interruption")

                with patch("local_campaign.rpc", side_effect=self._rpc), \
                        patch("local_campaign.run", side_effect=fake_run), \
                        patch("local_campaign.Gate", StopGate), \
                        patch("local_campaign.atomic_replace_bytes",
                              side_effect=interrupt_after_replace), \
                        self.assertRaises(KeyboardInterrupt):
                    execute(args)

                self.assertEqual(gate_opens, [])
                self.assertEqual((root / "candidate.json").exists(),
                                 boundary == "candidate.json")

                with patch("local_campaign.rpc", side_effect=self._rpc), \
                        patch("local_campaign.run", side_effect=fake_run), \
                        patch("local_campaign.Gate", StopGate), \
                        self.assertRaises(StopAfterBundle):
                    execute(args)

                self.assertEqual(len(gate_opens), 1)
                node_exports = [command for command in commands if "node-export" in command]
                self.assertEqual(len(node_exports),
                                 1 if boundary == "candidate.json" else 2)
                self.assertFalse(any(command[0] == args.signer for command in commands))

                text = (root / "candidate.json").read_text()
                value, _digest, _input = candidate(text)
                cert = strict_json((root / "certificate.json").read_text())
                _private, policy = fixture_policy()
                policy.verify(cert, text, value["intent"])
                self.assertEqual(value["request"], fixture["request"])
                self.assertEqual(value["proposal"], fixture["proposal"])
                self.assertEqual((root / "intent.bin").read_bytes(),
                                 bytes.fromhex(value["intent"]))

    def test_campaign_lock_excludes_another_process_and_releases_after_crash(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "campaign-lock.sqlite3"
            command = [sys.executable, "-c",
                       "import sqlite3,sys; db=sqlite3.connect(sys.argv[1],timeout=.05); "
                       "db.execute('BEGIN IMMEDIATE')", str(database)]
            with local_campaign.campaign_lock(root):
                second = subprocess.run(command, capture_output=True, text=True,
                                        timeout=5, check=False)
                self.assertNotEqual(second.returncode, 0)
                self.assertIn("database is locked", second.stderr)
            crashed = subprocess.run([sys.executable, "-c",
                "import os,sqlite3,sys; db=sqlite3.connect(sys.argv[1]); "
                "db.execute('BEGIN IMMEDIATE'); os._exit(91)", str(database)],
                capture_output=True, text=True, timeout=5, check=False)
            self.assertEqual(crashed.returncode, 91)
            with local_campaign.campaign_lock(root):
                pass
            args = SimpleNamespace(runtime=str(root))
            with patch("local_campaign._execute_locked") as body:
                local_campaign.execute(args)
            body.assert_called_once_with(args)

    def test_concurrent_gate_finalizers_retain_and_restore_only_winner(self):
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
                    # Exercise the Gate's own immutable-finalizer race below the
                    # public campaign lock, which is tested separately.
                    local_campaign._execute_locked(copy.copy(args))
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

    def test_changed_ledger_refuses_before_signing_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            args, value = self._retained_runtime(directory, finalized=False, backed=True)
            self._supply_backing_hooks(args)
            changed = dict(self.observed, ledger_id="0b" * 32)
            with patch("local_campaign.rpc", side_effect=self._rpc), \
                    patch("local_campaign.backing_observation", return_value=changed) as observer, \
                    patch("local_campaign.run") as run, \
                    self.assertRaisesRegex(ValueError, "differs from independently"):
                execute(args)
            observer.assert_called_once_with(args, value["backing_ledger_id"])
            run.assert_not_called()
            gate = Gate(str(Path(directory) / "gate.db"))
            try:
                self.assertEqual(gate.db.execute("SELECT count(*) FROM attempts").fetchone()[0], 0)
            finally:
                gate.close()

    def test_legacy_backed_candidate_cannot_start_new_signing(self):
        with tempfile.TemporaryDirectory() as directory:
            args, _ = self._retained_runtime(directory, finalized=False, legacy_backed=True)
            self._supply_backing_hooks(args)
            with patch("local_campaign.rpc", side_effect=self._rpc), \
                    patch("local_campaign.backing_observation", return_value=self.observed), \
                    patch("local_campaign.run") as run, \
                    self.assertRaisesRegex(ValueError, "new v2 certificate"):
                execute(args)
            run.assert_not_called()
            gate = Gate(str(Path(directory) / "gate.db"))
            try:
                self.assertEqual(gate.db.execute("SELECT count(*) FROM attempts").fetchone()[0], 0)
            finally:
                gate.close()

    def test_submitted_return_reorg_replays_exact_bytes_without_new_credit_or_signing(self):
        for rejected in (False, True):
            with self.subTest(rejected=rejected), tempfile.TemporaryDirectory() as directory:
                args, value = self._retained_runtime(directory, finalized=True, backed=True)
                self._supply_backing_hooks(args)
                args.submit = True
                root = Path(directory)
                gate = Gate(str(root / "gate.db"))
                digest = gate.admit(canonical(value),
                                    strict_json((root / "certificate.json").read_text()), fixture_policy()[1])
                gate.begin(digest)
                gate.retain_sal(digest, b"s" * 416)
                gate.finalize(digest, b"retained transaction", "07" * 32, b"r" * 284)
                gate.submitted(digest, b"retained transaction", "07" * 32)
                gate.confirm(digest, b"retained transaction", "07" * 32, 120, "0b" * 32)
                gate.close()
                commands = []

                def fake_run(arguments):
                    commands.append(tuple(arguments))
                    if "audit-final" in arguments:
                        return "txid=" + "07" * 32
                    if "node-submit" in arguments:
                        if rejected:
                            raise RuntimeError("daemon rejected exact retained transaction")
                        self.assertEqual((root / "transaction.bin").read_bytes(),
                                         b"retained transaction")
                        return ""
                    raise AssertionError("no new signing or finalization is permitted")

                with patch("local_campaign.rpc", side_effect=self._rpc), \
                        patch("local_campaign.retained_on_daemon", return_value=False), \
                        patch("local_campaign.backing_observation",
                              side_effect=AssertionError("suspended credit must not be reobserved")) as observer, \
                        patch("local_campaign.replay_backing_observation") as anchor, \
                        patch("local_campaign.run", side_effect=fake_run):
                    if rejected:
                        with self.assertRaisesRegex(RuntimeError, "daemon rejected"):
                            execute(args)
                    else:
                        execute(args)
                observer.assert_not_called()
                anchor.assert_called_once_with(args, value)
                self.assertEqual(sum("node-submit" in command for command in commands), 1)
                self.assertEqual(sum("audit-final" in command for command in commands), 1)
                gate = Gate(str(root / "gate.db"))
                try:
                    self.assertEqual(gate.db.execute("SELECT count(*) FROM attempts").fetchone()[0], 1)
                    self.assertEqual(gate.recover(digest)[1:5],
                                     (b"s" * 416, b"retained transaction", "07" * 32, 1))
                finally:
                    gate.close()

    def test_mempool_only_submission_cannot_bypass_suspended_credit(self):
        with tempfile.TemporaryDirectory() as directory:
            args, value = self._retained_runtime(directory, finalized=True, backed=True)
            self._supply_backing_hooks(args)
            args.submit = True
            root = Path(directory)
            gate = Gate(str(root / "gate.db"))
            digest = gate.admit(canonical(value),
                                strict_json((root / "certificate.json").read_text()), fixture_policy()[1])
            gate.begin(digest)
            gate.retain_sal(digest, b"s" * 416)
            gate.finalize(digest, b"retained transaction", "07" * 32, b"r" * 284)
            gate.submitted(digest, b"retained transaction", "07" * 32)
            gate.close()
            with patch("local_campaign.rpc", side_effect=self._rpc), \
                    patch("local_campaign.retained_on_daemon", return_value=False), \
                    patch("local_campaign.backing_observation",
                          side_effect=ValueError("deposit backing is not active")) as observer, \
                    patch("local_campaign.replay_backing_observation") as anchor, \
                    patch("local_campaign.run", return_value="txid=" + "07" * 32) as run, \
                    self.assertRaisesRegex(ValueError, "not active"):
                execute(args)
            observer.assert_called_once_with(args, value["backing_ledger_id"])
            anchor.assert_not_called()
            self.assertFalse(any("node-submit" in call.args[0] for call in run.call_args_list))

    def test_replay_inspection_requires_current_original_unspent_anchor(self):
        args = SimpleNamespace(deposit_observer="observer", node="http://127.0.0.1:58181",
                               core="core", deposit_runtime="ledger", deposit_receipt="receipt",
                               deposit_intent="intent", deposit_confirmations=10)
        observed = dict(self.observed, decision="suspended", status="suspended",
                        credited=1, credit_count=1, chain_qualified=True,
                        spent_status=0, in_pool=False, block_height=90,
                        block_hash="0a" * 32, global_output_index=12)

        def inspect(value):
            response = SimpleNamespace(returncode=2, stdout=canonical(value), stderr="")
            with patch("local_campaign.subprocess.run", return_value=response) as process:
                local_campaign.replay_backing_observation(args, self.value)
            self.assertIn("--expected-ledger-id", process.call_args.args[0])
            self.assertIn(self.value["backing_ledger_id"], process.call_args.args[0])

        inspect(observed)
        for field, replacement in (("block_height", 91), ("block_hash", "0b" * 32),
                                   ("global_output_index", 13), ("chain_qualified", False),
                                   ("spent_status", 1), ("in_pool", True)):
            changed = dict(observed, **{field: replacement})
            with self.subTest(field=field), self.assertRaises(ValueError):
                inspect(changed)
        legacy = dict(self.value, domain="rosen-monero/fcmp-candidate/v1")
        for field in ("backing_ledger_id", "backing_credit_id",
                      "backing_credit_block_height", "backing_credit_block_hash",
                      "backing_credit_global_output_index"):
            legacy.pop(field)
        with patch("local_campaign.subprocess.run") as process, \
                self.assertRaisesRegex(ValueError, "legacy backed"):
            local_campaign.replay_backing_observation(args, legacy)
        process.assert_not_called()

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
