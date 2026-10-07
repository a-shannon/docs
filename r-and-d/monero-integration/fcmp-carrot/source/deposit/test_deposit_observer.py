import dataclasses
import sqlite3
import tempfile
import unittest
from pathlib import Path

from deposit_observer import (
    ChainView, ConflictError, Deposit, Ledger, ObservationError,
    event_origin, parse_core_output, receipt_selector, validate_node_url,
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
        self.assertEqual(self.ledger.observe(item, view(), 0, True, None), "idempotent")
        self.restart()
        self.assertEqual(self.ledger.observe(item, view(), 0, True, None), "idempotent")
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

    def test_reorg_origin_change_suspends_without_replacement(self):
        item = deposit()
        self.ledger.observe(item, view(), 0, True, None)
        moved = dataclasses.replace(item, block_height=91, block_hash="22" * 32,
                                    global_output_index=7)
        moved_view = dataclasses.replace(view(), block_height=91, block_hash="22" * 32,
                                         confirmations=9, output_indices=(5, 7))
        self.assertEqual(self.ledger.observe(moved, moved_view, 0, True, None), "suspended")
        self.assertEqual(self.ledger.db.execute(
            "SELECT block_height,block_hash,status,credit_count FROM deposits").fetchone(),
            (90, "03" * 32, "suspended", 1))

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


if __name__ == "__main__":
    unittest.main()
