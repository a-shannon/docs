import dataclasses
import io
import json
import sqlite3
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from deposit_observer import (
    ChainView, ConflictError, Deposit, Ledger, ObservationError,
    event_origin, observe as observe_command, parse_core_output, receipt_selector,
    tip_extends, validate_node_url,
)


def receipt(intent=b"i" * 32, txid=b"t" * 32, index=1, amount=200_000_000_000):
    value = bytearray(284)
    value[:4] = b"RCR1"
    value[8:40] = txid
    value[40:44] = index.to_bytes(4, "little")
    value[116:124] = amount.to_bytes(8, "little")
    value[124:156] = intent
    return bytes(value)


def view(confirmations=10):
    return ChainView("01" * 32, 100, "02" * 32, b"full-tx", False,
                     90, "03" * 32, confirmations, (5, 6))


def deposit(receipt_bytes=None, intent="04" * 32):
    return Deposit("01" * 32, "05" * 32, 1, "06" * 32, "07" * 32,
                   intent, "48cNbRvGyrb43yGQYLWKxshBnnq8nRkFfPcUwfqpihwJWcrHzKy8pyk9Ai1fXeg2Gf49S2CrTyPYJG9ru2hQcTWoLYsYWMG",
                   200_000_000_000, b"full-tx", receipt_bytes or b"r" * 284,
                   90, "03" * 32, 6, "http://127.0.0.1:18081")


def database_state(path):
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro&immutable=1", uri=True)
    try:
        return (
            connection.execute("PRAGMA user_version").fetchone()[0],
            tuple(connection.execute(
                "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name"
            )),
        )
    finally:
        connection.close()


class DepositObserverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "ledger.sqlite3"
        self.ledger = Ledger(self.path)

    def tearDown(self):
        self.ledger.close()
        self.temp.cleanup()

    def restart(self):
        self.ledger.close()
        self.ledger = Ledger(self.path)

    def test_receipt_selector_binds_standalone_fields(self):
        intent = bytes(range(32))
        value = receipt(intent=intent, txid=bytes(range(32, 64)), index=7, amount=123)
        self.assertEqual(receipt_selector(value, intent),
                         (bytes(range(32, 64)).hex(), 7, intent.hex(), 123))
        for changed in (value[:-1], b"bad!" + value[4:]):
            with self.assertRaises(ObservationError):
                receipt_selector(changed, intent)
        with self.assertRaises(ConflictError):
            receipt_selector(value, b"x" * 32)

    def test_loopback_url_is_exact(self):
        self.assertEqual(validate_node_url("http://127.0.0.1:18081"), "http://127.0.0.1:18081")
        for value in ("https://127.0.0.1:18081", "http://localhost:18081",
                      "http://127.0.0.1:18081/path", "http://user@127.0.0.1:18081"):
            with self.subTest(value=value), self.assertRaises(ObservationError):
                validate_node_url(value)

    def test_actual_core_receipt_output_contract(self):
        output = ("verified receipt "
            "txid=<f5d893e1c96f592b47561c4a177014be12955a27ba4e451a72b885d177b6d3e4> "
            "output_index=1 K_o=<540bb77fb822d9cdcabde1694eb7fd2da259751b220f3078fe618472f260997f> "
            "amount=200000000000 key_image=<37bd925d86500cd1516bd5f637fa231c1e0b18d3fecf79242f029b42218c7b10> "
            "destination=48cNbRvGyrb43yGQYLWKxshBnnq8nRkFfPcUwfqpihwJWcrHzKy8pyk9Ai1fXeg2Gf49S2CrTyPYJG9ru2hQcTWoLYsYWMG "
            "intent=<5ee1b852c825203ef9d855eca1f1725eed225704b546eb059b22352d11b1fb41>\n")
        parsed = parse_core_output(output)
        self.assertEqual(parsed[0], "f5d893e1c96f592b47561c4a177014be12955a27ba4e451a72b885d177b6d3e4")
        self.assertEqual(parsed[1:5], (1,
            "540bb77fb822d9cdcabde1694eb7fd2da259751b220f3078fe618472f260997f",
            200_000_000_000,
            "37bd925d86500cd1516bd5f637fa231c1e0b18d3fecf79242f029b42218c7b10"))
        with self.assertRaises(ObservationError):
            parse_core_output(output + output)

    def test_event_origin_is_canonical_and_field_sensitive(self):
        item = deposit()
        fields = (item.genesis, item.txid, item.output_index, item.k_o, item.key_image,
                  item.intent, item.destination, item.amount)
        origin = event_origin(*fields)
        self.assertEqual(origin, "449515b385f8be344827462880dbe679713d5bd70aa8eb2e8068854c0c0d9fd7")
        for index, replacement in ((2, 2), (7, item.amount + 1)):
            changed = list(fields)
            changed[index] = replacement
            self.assertNotEqual(event_origin(*changed), origin)

    def test_replay_and_restart_never_second_credit(self):
        item = deposit()
        self.assertEqual(self.ledger.observe(item, view(), 0, True, None), "credited")
        first = self.ledger.credit_state(item.genesis, item.txid, item.output_index)
        self.assertEqual(self.ledger.observe(item, view(), 0, True, None), "idempotent")
        self.restart()
        self.assertEqual(self.ledger.observe(item, view(), 0, True, None), "idempotent")
        restarted = self.ledger.credit_state(item.genesis, item.txid, item.output_index)
        self.assertEqual(restarted, first)
        self.assertRegex(first["ledger_id"], r"^[0-9a-f]{64}$")
        self.assertRegex(first["credit_id"], r"^[0-9a-f]{64}$")
        self.assertEqual(first["credit_block_height"], item.block_height)
        self.assertEqual(first["credit_block_hash"], item.block_hash)
        self.assertEqual(first["credit_global_output_index"], item.global_output_index)
        self.assertEqual(first["credit_status"], "active")
        self.assertEqual(first["credited"], 1)
        self.assertEqual(first["credit_count"], 1)
        row = self.ledger.db.execute(
            "SELECT status,credited,credit_count FROM deposits").fetchone()
        self.assertEqual(row, ("active", 1, 1))
        self.assertEqual(self.ledger.db.execute("SELECT count(*) FROM observations").fetchone()[0], 3)

    def test_same_backing_different_intent_is_refused(self):
        item = deposit()
        self.ledger.observe(item, view(), 0, True, None)
        with self.assertRaises(ConflictError):
            self.ledger.observe(dataclasses.replace(item, intent="08" * 32), view(), 0, True, None)
        self.assertEqual(self.ledger.db.execute("SELECT credit_count FROM deposits").fetchone()[0], 1)

    def test_wrong_intent_or_invalid_proof_output_does_not_suspend_credit(self):
        item = deposit()
        self.ledger.observe(item, view(), 0, True, None)
        with self.assertRaises(ConflictError):
            receipt_selector(receipt(intent=b"a" * 32), b"b" * 32)
        with self.assertRaises(ObservationError):
            parse_core_output("Core rejected receipt")
        self.assertEqual(self.ledger.db.execute(
            "SELECT status,credit_count FROM deposits").fetchone(), ("active", 1))

    def test_absent_transaction_suspends_existing_credit(self):
        item = deposit()
        self.ledger.observe(item, view(), 0, True, None)
        self.assertTrue(self.ledger.suspend_existing(item.genesis, item.txid,
                                                     "transaction is absent from daemon"))
        self.assertEqual(self.ledger.db.execute(
            "SELECT status,credit_count,suspension_reason FROM deposits").fetchone(),
            ("suspended", 1, "transaction is absent from daemon"))

    def test_absent_transaction_suspends_every_credited_output(self):
        first = deposit()
        second = dataclasses.replace(
            first, output_index=0, k_o="41" * 32, key_image="42" * 32,
            receipt=b"s" * 284, global_output_index=5)
        self.assertEqual(self.ledger.observe(first, view(), 0, True, None), "credited")
        self.assertEqual(self.ledger.observe(second, view(), 0, True, None), "credited")
        self.assertEqual(self.ledger.suspend_existing(
            first.genesis, first.txid, "transaction is absent from daemon"), 2)
        rows = self.ledger.db.execute("""
            SELECT output_index,status,credited,credit_count,suspension_reason
            FROM deposits ORDER BY output_index
        """).fetchall()
        self.assertEqual(rows, [
            (0, "suspended", 1, 1, "transaction is absent from daemon"),
            (1, "suspended", 1, 1, "transaction is absent from daemon"),
        ])

    def test_all_three_uniqueness_axes_are_enforced(self):
        base = deposit()
        self.ledger.observe(base, view(), 0, True, None)
        variants = (
            dataclasses.replace(base, k_o="11" * 32, key_image="12" * 32),
            dataclasses.replace(base, txid="13" * 32, key_image="14" * 32),
            dataclasses.replace(base, txid="15" * 32, k_o="16" * 32),
        )
        for changed in variants:
            with self.subTest(changed=changed), self.assertRaises(ConflictError):
                self.ledger.observe(changed, view(), 0, True, None)

    def test_suspension_is_persistent_and_never_recredits(self):
        item = deposit()
        self.ledger.observe(item, view(), 0, True, None)
        self.assertEqual(self.ledger.observe(item, view(2), 0, False, "insufficient confirmations"),
                         "suspended")
        self.restart()
        self.assertEqual(self.ledger.observe(item, view(), 0, True, None), "suspended")
        self.assertEqual(self.ledger.db.execute(
            "SELECT status,credited,credit_count FROM deposits").fetchone(), ("suspended", 1, 1))

    def test_uncredited_tombstone_can_receive_exactly_one_first_credit(self):
        item = deposit()
        self.assertEqual(self.ledger.observe(item, view(1), 0, False, "insufficient confirmations"),
                         "suspended")
        self.restart()
        self.assertEqual(self.ledger.observe(item, view(), 0, True, None), "credited")
        self.assertEqual(self.ledger.observe(item, view(), 0, True, None), "idempotent")
        self.assertEqual(self.ledger.db.execute(
            "SELECT credited,credit_count FROM deposits").fetchone(), (1, 1))

    def test_precredit_reorg_reinclusion_can_receive_its_first_credit(self):
        item = deposit()
        self.assertEqual(self.ledger.observe(item, view(2), 0, False, "insufficient confirmations"),
                         "suspended")
        moved = dataclasses.replace(item, block_height=91, block_hash="22" * 32,
                                    global_output_index=7)
        moved_view = dataclasses.replace(view(), block_height=91, block_hash="22" * 32,
                                         confirmations=9, output_indices=(5, 7))
        self.assertEqual(self.ledger.observe(moved, moved_view, 0, True, None), "credited")
        self.assertEqual(self.ledger.observe(moved, moved_view, 0, True, None), "idempotent")
        self.assertEqual(self.ledger.db.execute("""
            SELECT block_height,block_hash,global_output_index,status,credited,credit_count
            FROM deposits
        """).fetchone(), (91, "22" * 32, 7, "active", 1, 1))

    def test_healthy_tip_advances_do_not_suspend_existing_credit(self):
        item = deposit()
        self.ledger.observe(item, view(), 0, True, None)
        self.ledger.close()
        intent = Path(self.temp.name) / "intent.bin"
        receipt_path = Path(self.temp.name) / "receipt.bin"
        intent.write_bytes(bytes.fromhex(item.intent))
        receipt_path.write_bytes(receipt(intent=bytes.fromhex(item.intent),
                                         txid=bytes.fromhex(item.txid),
                                         index=item.output_index, amount=item.amount))
        tips = [(100, "10" * 32), (103, "13" * 32)]
        headers = {
            0: {"hash": item.genesis, "orphan_status": False},
            99: {"hash": "10" * 32, "orphan_status": False},
            100: {"hash": "11" * 32, "orphan_status": False},
            101: {"hash": "12" * 32, "orphan_status": False},
        }

        class AdvancingClient:
            url = item.endpoint

            def __init__(self, _url):
                self.identities = iter(tips)

            def identity(self):
                return next(self.identities)

            def header(self, height):
                return headers[height]

            def spent(self, _key_image):
                return 0

        first = dataclasses.replace(view(), tip_height=101, tip_hash="11" * 32)
        second = dataclasses.replace(view(12), tip_height=102, tip_hash="12" * 32)
        args = SimpleNamespace(
            runtime=self.temp.name, receipt=str(receipt_path), intent=str(intent),
            url=item.endpoint, core="core", profile="user", min_confirmations=10,
        )
        core_result = (item.txid, item.output_index, item.k_o, item.amount,
                       item.key_image, item.destination, item.intent)
        output = io.StringIO()
        with patch("deposit_observer.DaemonClient", AdvancingClient), \
                patch("deposit_observer.chain_view", side_effect=(first, second)), \
                patch("deposit_observer.verify_core", return_value=core_result), \
                redirect_stdout(output):
            self.assertEqual(observe_command(args), 0)
        observed = json.loads(output.getvalue())
        self.assertEqual(set(observed), {
            "decision", "genesis", "txid", "output_index", "K_o", "key_image",
            "intent", "destination", "amount", "confirmations", "block_height",
            "block_hash", "tip_height", "tip_hash", "event_origin", "endpoint_scope",
            "ledger_id", "credit_id", "credit_block_height", "credit_block_hash",
            "credit_global_output_index", "status", "credited", "credit_count",
            "spent_status", "in_pool", "global_output_index", "chain_qualified",
        })
        self.assertRegex(observed["ledger_id"], r"^[0-9a-f]{64}$")
        self.assertRegex(observed["credit_id"], r"^[0-9a-f]{64}$")
        self.assertEqual(observed["credit_block_height"], item.block_height)
        self.assertEqual(observed["credit_block_hash"], item.block_hash)
        self.assertEqual(observed["credit_global_output_index"], item.global_output_index)
        self.assertEqual(observed["spent_status"], 0)
        self.assertIs(observed["in_pool"], False)
        self.assertEqual(observed["global_output_index"], item.global_output_index)
        self.assertIs(observed["chain_qualified"], True)
        self.assertEqual((observed["status"], observed["credited"], observed["credit_count"]),
                         ("active", 1, 1))
        self.ledger = Ledger(self.path)
        self.assertEqual(self.ledger.db.execute(
            "SELECT status,credited,credit_count FROM deposits").fetchone(),
            ("active", 1, 1))

    def test_tip_advance_requires_the_prior_tip_to_remain_canonical(self):
        class Headers:
            def __init__(self, old_hash):
                self.old_hash = old_hash

            def header(self, height):
                self.assert_height = height
                return {"hash": self.old_hash, "orphan_status": False}

        self.assertTrue(tip_extends(Headers("10" * 32), (100, "10" * 32),
                                    (103, "13" * 32)))
        self.assertFalse(tip_extends(Headers("ff" * 32), (100, "10" * 32),
                                     (103, "13" * 32)))
        self.assertFalse(tip_extends(Headers("10" * 32), (103, "13" * 32),
                                     (100, "10" * 32)))
        self.assertFalse(tip_extends(Headers("10" * 32), (100, "10" * 32),
                                     (100, "11" * 32)))

    def test_inflight_confirmation_advance_retries_real_chain_view(self):
        item = deposit()
        self.ledger.observe(item, view(), 0, True, None)
        self.ledger.close()
        intent = Path(self.temp.name) / "retry-intent.bin"
        receipt_path = Path(self.temp.name) / "retry-receipt.bin"
        intent.write_bytes(bytes.fromhex(item.intent))
        receipt_path.write_bytes(receipt(intent=bytes.fromhex(item.intent),
                                         txid=bytes.fromhex(item.txid),
                                         index=item.output_index, amount=item.amount))

        class AdvancingClient:
            url = item.endpoint

            def __init__(self):
                self.heights = iter(((100, "10" * 32), (101, "11" * 32),
                                     (101, "11" * 32)))
                self.identities = iter(((100, "10" * 32), (101, "11" * 32)))
                self.height_calls = 0

            def height(self):
                self.height_calls += 1
                return next(self.heights)

            def identity(self):
                return next(self.identities)

            def header(self, height):
                hashes = {0: item.genesis, 90: item.block_hash,
                          99: "10" * 32, 100: "11" * 32}
                return {"height": height, "hash": hashes[height], "orphan_status": False}

            def transaction(self, _txid):
                return {"blob": item.tx_blob, "in_pool": False,
                        "double_spend_seen": False, "output_indices": [5, 6],
                        "block_height": item.block_height, "confirmations": 11}

            def spent(self, _key_image):
                return 0

        client = AdvancingClient()
        args = SimpleNamespace(
            runtime=self.temp.name, receipt=str(receipt_path), intent=str(intent),
            url=item.endpoint, core="core", profile="user", min_confirmations=10,
        )
        core_result = (item.txid, item.output_index, item.k_o, item.amount,
                       item.key_image, item.destination, item.intent)
        with patch("deposit_observer.DaemonClient", return_value=client), \
                patch("deposit_observer.verify_core", return_value=core_result):
            self.assertEqual(observe_command(args), 0)
        self.assertEqual(client.height_calls, 3)
        self.ledger = Ledger(self.path)
        self.assertEqual(self.ledger.db.execute(
            "SELECT status,credited,credit_count FROM deposits").fetchone(),
            ("active", 1, 1))

    def test_unsettled_snapshot_drift_fails_without_suspension(self):
        item = deposit()
        self.ledger.observe(item, view(), 0, True, None)
        self.ledger.close()
        intent = Path(self.temp.name) / "unsettled-intent.bin"
        receipt_path = Path(self.temp.name) / "unsettled-receipt.bin"
        intent.write_bytes(bytes.fromhex(item.intent))
        receipt_path.write_bytes(receipt(intent=bytes.fromhex(item.intent),
                                         txid=bytes.fromhex(item.txid),
                                         index=item.output_index, amount=item.amount))

        class UnsettledClient:
            url = item.endpoint

            def __init__(self):
                self.height_calls = 0

            def height(self):
                self.height_calls += 1
                return 100, "10" * 32

            def identity(self):
                return 100, "10" * 32

            def header(self, height):
                hashes = {0: item.genesis, 90: item.block_hash, 99: "10" * 32}
                return {"height": height, "hash": hashes[height], "orphan_status": False}

            def transaction(self, _txid):
                return {"blob": item.tx_blob, "in_pool": False,
                        "double_spend_seen": False, "output_indices": [5, 6],
                        "block_height": item.block_height, "confirmations": 11}

            def spent(self, _key_image):
                return 0

        client = UnsettledClient()
        args = SimpleNamespace(
            runtime=self.temp.name, receipt=str(receipt_path), intent=str(intent),
            url=item.endpoint, core="core", profile="user", min_confirmations=10,
        )
        with patch("deposit_observer.DaemonClient", return_value=client), \
                patch("deposit_observer.verify_core"):
            self.assertEqual(observe_command(args), 2)
        self.assertEqual(client.height_calls, 3)
        self.ledger = Ledger(self.path)
        self.assertEqual(self.ledger.db.execute(
            "SELECT status,credited,credit_count FROM deposits").fetchone(),
            ("active", 1, 1))

    def test_reorg_origin_change_suspends_without_replacement(self):
        item = deposit()
        self.ledger.observe(item, view(), 0, True, None)
        moved = dataclasses.replace(item, block_height=91, block_hash="22" * 32,
                                    global_output_index=7)
        moved_view = dataclasses.replace(view(), block_height=91, block_hash="22" * 32,
                                         confirmations=9, output_indices=(5, 7))
        self.assertEqual(self.ledger.observe(moved, moved_view, 0, True, None), "suspended")
        self.assertEqual(self.ledger.db.execute(
            "SELECT block_height,block_hash,global_output_index,status,credit_count FROM deposits"
        ).fetchone(), (90, "03" * 32, 6, "suspended", 1))
        state = self.ledger.credit_state(item.genesis, item.txid, item.output_index)
        self.assertEqual(state["credit_block_height"], 90)
        self.assertEqual(state["credit_block_hash"], "03" * 32)
        self.assertEqual(state["credit_global_output_index"], 6)
        self.assertEqual(state["credit_status"], "suspended")

    def test_sqlite_constraints_exist_independently(self):
        item = deposit()
        self.ledger.observe(item, view(), 0, True, None)
        with self.assertRaises(sqlite3.IntegrityError):
            with self.ledger.write():
                self.ledger.db.execute("""
                    INSERT INTO deposits(genesis,txid,output_index,k_o,key_image,intent,destination,amount,
                    tx_blob,receipt,first_endpoint,status,credited,credit_count,created_at,last_seen)
                    SELECT genesis,txid,output_index,?, ?,intent,destination,amount,tx_blob,receipt,
                    first_endpoint,status,credited,credit_count,created_at,last_seen FROM deposits
                """, ("31" * 32, "32" * 32))

    def test_ledger_and_credit_identities_are_immutable(self):
        item = deposit()
        self.ledger.observe(item, view(), 0, True, None)
        state = self.ledger.credit_state(item.genesis, item.txid, item.output_index)
        with self.assertRaises(sqlite3.IntegrityError):
            self.ledger.db.execute(
                "UPDATE deposits SET credit_id=? WHERE credit_id=?",
                ("31" * 32, state["credit_id"]),
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.ledger.db.execute(
                "UPDATE ledger_meta SET ledger_id=? WHERE singleton=1",
                ("32" * 32,),
            )

    def test_expected_ledger_id_rejects_missing_database_before_connect(self):
        missing = Path(self.temp.name) / "missing" / "deposits.sqlite3"
        intent_path = Path(self.temp.name) / "missing-intent.bin"
        receipt_path = Path(self.temp.name) / "missing-receipt.bin"
        item = deposit()
        intent_path.write_bytes(bytes.fromhex(item.intent))
        receipt_path.write_bytes(receipt(intent=bytes.fromhex(item.intent),
                                         txid=bytes.fromhex(item.txid),
                                         index=item.output_index, amount=item.amount))
        args = SimpleNamespace(
            runtime=str(missing.parent), receipt=str(receipt_path), intent=str(intent_path),
            url=item.endpoint, core="core", profile="user", min_confirmations=10,
            expected_ledger_id="31" * 32,
        )
        with patch("deposit_observer.sqlite3.connect",
                   side_effect=AssertionError("must refuse before sqlite connect")), \
                patch("deposit_observer.DaemonClient",
                      side_effect=AssertionError("must refuse before network")):
            self.assertEqual(observe_command(args), 2)
        self.assertFalse(missing.exists())

    def test_expected_ledger_id_mismatch_refuses_before_network_or_credit(self):
        item = deposit()
        observer_path = Path(self.temp.name) / "deposits.sqlite3"
        observer_ledger = Ledger(observer_path)
        actual_ledger_id = observer_ledger.ledger_id
        observer_ledger.close()
        before_bytes = observer_path.read_bytes()
        before_state = database_state(observer_path)
        wrong_ledger_id = "31" * 32 if actual_ledger_id != "31" * 32 else "32" * 32
        intent_path = Path(self.temp.name) / "wrong-id-intent.bin"
        receipt_path = Path(self.temp.name) / "wrong-id-receipt.bin"
        intent_path.write_bytes(bytes.fromhex(item.intent))
        receipt_path.write_bytes(receipt(intent=bytes.fromhex(item.intent),
                                         txid=bytes.fromhex(item.txid),
                                         index=item.output_index, amount=item.amount))
        args = SimpleNamespace(
            runtime=self.temp.name, receipt=str(receipt_path), intent=str(intent_path),
            url=item.endpoint, core="core", profile="user", min_confirmations=10,
            expected_ledger_id=wrong_ledger_id,
        )
        with patch.object(Ledger, "_migrate",
                          side_effect=AssertionError("must refuse before migration")), \
                patch("deposit_observer.DaemonClient",
                      side_effect=AssertionError("must refuse before network")):
            self.assertEqual(observe_command(args), 2)
        self.assertEqual(observer_path.read_bytes(), before_bytes)
        self.assertEqual(database_state(observer_path), before_state)
        connection = sqlite3.connect(observer_path)
        try:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM deposits").fetchone()[0], 0)
            self.assertEqual(connection.execute(
                "SELECT ledger_id FROM ledger_meta WHERE singleton=1").fetchone()[0],
                actual_ledger_id)
        finally:
            connection.close()

    def test_matching_expected_identity_reports_chain_state_before_sticky_suspension(self):
        base = deposit()
        receipt_bytes = receipt(
            intent=bytes.fromhex(base.intent), txid=bytes.fromhex(base.txid),
            index=base.output_index, amount=base.amount,
        )
        item = deposit(receipt_bytes=receipt_bytes)
        observer_path = Path(self.temp.name) / "deposits.sqlite3"
        observer_ledger = Ledger(observer_path)
        observer_ledger.observe(item, view(), 0, True, None)
        observer_ledger.observe(
            item, view(2), 0, False, "insufficient confirmations"
        )
        expected_ledger_id = observer_ledger.ledger_id
        observer_ledger.close()
        intent_path = Path(self.temp.name) / "resume-intent.bin"
        receipt_path = Path(self.temp.name) / "resume-receipt.bin"
        intent_path.write_bytes(bytes.fromhex(item.intent))
        receipt_path.write_bytes(receipt_bytes)

        class StableClient:
            url = item.endpoint

            def __init__(self, _url):
                pass

            def identity(self):
                return view().tip_height, view().tip_hash

            def header(self, height):
                self.assert_genesis_height = height
                return {"hash": item.genesis, "orphan_status": False}

            def spent(self, _key_image):
                return 0

        args = SimpleNamespace(
            runtime=self.temp.name, receipt=str(receipt_path), intent=str(intent_path),
            url=item.endpoint, core="core", profile="user", min_confirmations=10,
            expected_ledger_id=expected_ledger_id,
        )
        core_result = (item.txid, item.output_index, item.k_o, item.amount,
                       item.key_image, item.destination, item.intent)
        output = io.StringIO()
        with patch("deposit_observer.DaemonClient", StableClient), \
                patch("deposit_observer.retry_chain_view", side_effect=(view(), view())), \
                patch("deposit_observer.tip_extends", return_value=True), \
                patch("deposit_observer.verify_core", return_value=core_result), \
                redirect_stdout(output):
            self.assertEqual(observe_command(args), 2)
        observed = json.loads(output.getvalue())
        self.assertEqual(observed["ledger_id"], expected_ledger_id)
        self.assertIs(observed["chain_qualified"], True)
        self.assertEqual((observed["decision"], observed["status"], observed["credit_count"]),
                         ("suspended", "suspended", 1))


class LedgerMigrationTests(unittest.TestCase):
    LEGACY_SCHEMA = """
        CREATE TABLE deposits(
            id INTEGER PRIMARY KEY,
            genesis TEXT NOT NULL,
            txid TEXT NOT NULL,
            output_index INTEGER NOT NULL,
            k_o TEXT NOT NULL,
            key_image TEXT NOT NULL,
            intent TEXT NOT NULL,
            destination TEXT NOT NULL,
            amount INTEGER NOT NULL,
            tx_blob BLOB NOT NULL,
            receipt BLOB NOT NULL,
            block_height INTEGER,
            block_hash TEXT,
            global_output_index INTEGER,
            first_endpoint TEXT NOT NULL,
            status TEXT NOT NULL,
            credited INTEGER NOT NULL,
            credit_count INTEGER NOT NULL,
            suspension_reason TEXT,
            created_at INTEGER NOT NULL,
            last_seen INTEGER NOT NULL,
            UNIQUE(genesis,txid,output_index),
            UNIQUE(genesis,k_o),
            UNIQUE(genesis,key_image));
    """

    @staticmethod
    def insert_legacy(connection, item, origin_column=False, origin=None):
        columns = (
            "genesis,txid,output_index,k_o,key_image,intent,destination,amount,"
            "tx_blob,receipt,block_height,block_hash,global_output_index,first_endpoint,"
            "status,credited,credit_count,suspension_reason,created_at,last_seen"
        )
        values = (
            item.genesis, item.txid, item.output_index, item.k_o, item.key_image,
            item.intent, item.destination, item.amount, item.tx_blob, item.receipt,
            item.block_height, item.block_hash, item.global_output_index, item.endpoint,
            "active", 1, 1, None, 1, 1,
        )
        if origin_column:
            columns += ",event_origin"
            values += (origin,)
        placeholders = ",".join("?" for _ in values)
        connection.execute(f"INSERT INTO deposits({columns}) VALUES({placeholders})", values)

    def make_legacy(self, path, version, origin_column, origin=None):
        connection = sqlite3.connect(path)
        try:
            connection.executescript(self.LEGACY_SCHEMA)
            if origin_column:
                connection.execute("ALTER TABLE deposits ADD COLUMN event_origin TEXT")
            self.insert_legacy(connection, deposit(), origin_column, origin)
            connection.execute(f"PRAGMA user_version={version}")
            connection.commit()
        finally:
            connection.close()

    def test_v1_v2_interrupted_states_backfill_atomically(self):
        cases = ((1, False), (1, True), (2, True))
        for version, origin_column in cases:
            with self.subTest(version=version, origin_column=origin_column), \
                    tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "legacy.sqlite3"
                self.make_legacy(path, version, origin_column)
                ledger = Ledger(path)
                try:
                    state = ledger.credit_state("01" * 32, "05" * 32, 1)
                    self.assertEqual(ledger.db.execute("PRAGMA user_version").fetchone()[0], 3)
                    self.assertEqual(state["event_origin"], event_origin(
                        *self._event_fields(deposit())))
                    self.assertRegex(state["ledger_id"], r"^[0-9a-f]{64}$")
                    self.assertRegex(state["credit_id"], r"^[0-9a-f]{64}$")
                    self.assertEqual(ledger.db.execute(
                        "SELECT COUNT(*) FROM deposits WHERE event_origin IS NULL OR credit_id IS NULL"
                    ).fetchone()[0], 0)
                finally:
                    ledger.close()

    def test_existing_wrong_origin_fails_without_promoting_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "wrong.sqlite3"
            self.make_legacy(path, 2, True, "ff" * 32)
            with self.assertRaisesRegex(ObservationError, "event origin"):
                Ledger(path)
            connection = sqlite3.connect(path)
            try:
                self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 2)
                self.assertNotIn("credit_id", {
                    row[1] for row in connection.execute("PRAGMA table_info(deposits)")
                })
                self.assertEqual(connection.execute(
                    "SELECT event_origin FROM deposits").fetchone()[0], "ff" * 32)
            finally:
                connection.close()

    def test_expected_identity_refuses_old_or_empty_database_without_mutation(self):
        item = deposit()
        for case in ("v2", "empty"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                runtime = Path(directory)
                path = runtime / "deposits.sqlite3"
                if case == "v2":
                    self.make_legacy(path, 2, True)
                else:
                    sqlite3.connect(path).close()
                before_bytes = path.read_bytes()
                before_state = database_state(path)
                intent_path = runtime / "intent.bin"
                receipt_path = runtime / "receipt.bin"
                intent_path.write_bytes(bytes.fromhex(item.intent))
                receipt_path.write_bytes(receipt(
                    intent=bytes.fromhex(item.intent), txid=bytes.fromhex(item.txid),
                    index=item.output_index, amount=item.amount,
                ))
                args = SimpleNamespace(
                    runtime=str(runtime), receipt=str(receipt_path), intent=str(intent_path),
                    url=item.endpoint, core="core", profile="user", min_confirmations=10,
                    expected_ledger_id="31" * 32,
                )
                with patch.object(
                        Ledger, "_migrate",
                        side_effect=AssertionError("must refuse before migration")), \
                        patch("deposit_observer.DaemonClient",
                              side_effect=AssertionError("must refuse before network")):
                    self.assertEqual(observe_command(args), 2)
                self.assertEqual(path.read_bytes(), before_bytes)
                self.assertEqual(database_state(path), before_state)

    @staticmethod
    def _event_fields(item):
        return (item.genesis, item.txid, item.output_index, item.k_o, item.key_image,
                item.intent, item.destination, item.amount)


if __name__ == "__main__":
    unittest.main()
