#!/usr/bin/env python3
"""Local CARROT deposit observation and durable credit ledger.

Cryptographic validity belongs to the pinned Core receipt verifier. This module
owns daemon observation consistency and idempotent local credit state only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any


RECEIPT_SIZE = 284
CORE_LINE = re.compile(
    r"^verified receipt txid=<([0-9a-f]{64})> output_index=([0-9]+) "
    r"K_o=<([0-9a-f]{64})> amount=([0-9]+) key_image=<([0-9a-f]{64})> "
    r"destination=([1-9A-HJ-NP-Za-km-z]+) intent=<([0-9a-f]{64})>$"
)
HEX64 = re.compile(r"^[0-9a-f]{64}$")


class ObservationError(RuntimeError):
    pass


class ConflictError(ObservationError):
    pass


class ChainStateError(ObservationError):
    """Observed chain state requires suspension of an existing event."""


class SnapshotChangedError(ObservationError):
    """The daemon changed during a read; no adverse chain state was established."""


def _hex64(value: Any, field: str) -> str:
    if not isinstance(value, str) or not HEX64.fullmatch(value):
        raise ObservationError(f"invalid {field}")
    return value


def receipt_selector(receipt: bytes, intent: bytes) -> tuple[str, int, str, int]:
    if len(receipt) != RECEIPT_SIZE or receipt[:4] != b"RCR1":
        raise ObservationError("invalid receipt format")
    if len(intent) != 32:
        raise ObservationError("intent must contain exactly 32 bytes")
    embedded_intent = receipt[124:156]
    if embedded_intent != intent:
        raise ConflictError("intent differs from the receipt-bound intent")
    txid = receipt[8:40].hex()
    output_index = int.from_bytes(receipt[40:44], "little")
    amount = int.from_bytes(receipt[116:124], "little")
    return txid, output_index, intent.hex(), amount


def validate_node_url(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or parsed.port is None
            or parsed.username is not None or parsed.password is not None
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise ObservationError("node URL must be http://127.0.0.1:PORT")
    return f"http://127.0.0.1:{parsed.port}"


def event_origin(genesis: str, txid: str, output_index: int, k_o: str,
                 key_image: str, intent: str, destination: str, amount: int) -> str:
    fields = (
        bytes.fromhex(_hex64(genesis, "genesis")), bytes.fromhex(_hex64(txid, "txid")),
        output_index.to_bytes(4, "little"), bytes.fromhex(_hex64(k_o, "K_o")),
        bytes.fromhex(_hex64(key_image, "key image")), bytes.fromhex(_hex64(intent, "intent")),
        destination.encode("ascii"), amount.to_bytes(8, "little"),
    )
    digest = hashlib.blake2b(digest_size=32, person=b"RosenDepOrigin1")
    for field in fields:
        digest.update(len(field).to_bytes(4, "little"))
        digest.update(field)
    return digest.hexdigest()


class DaemonClient:
    def __init__(self, url: str, timeout: int = 30):
        self.url = validate_node_url(url)
        self.timeout = timeout

    def _post(self, path: str, payload: dict[str, Any], limit: int = 8 * 1024 * 1024) -> dict[str, Any]:
        request = urllib.request.Request(
            self.url + path,
            data=json.dumps(payload, separators=(",", ":")).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read(limit + 1)
        except (OSError, urllib.error.URLError) as error:
            raise ObservationError(f"daemon transport failed: {error}") from error
        if len(raw) > limit:
            raise ObservationError("daemon response too large")
        try:
            value = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ObservationError("daemon returned invalid JSON") from error
        if not isinstance(value, dict):
            raise ObservationError("daemon returned wrong JSON type")
        return value

    @staticmethod
    def _status(value: dict[str, Any]) -> None:
        if value.get("status") != "OK":
            raise ObservationError(f"daemon status is {value.get('status')!r}")

    def height(self) -> tuple[int, str]:
        value = self._post("/get_height", {})
        self._status(value)
        height = value.get("height")
        if not isinstance(height, int) or height < 1:
            raise ObservationError("invalid daemon height")
        return height, _hex64(value.get("hash"), "tip hash")

    def identity(self) -> tuple[int, str]:
        value = self._post("/get_info", {})
        self._status(value)
        if (value.get("nettype") != "fakechain" or value.get("mainnet") is not False
                or value.get("offline") is not True
                or value.get("outgoing_connections_count") != 0
                or value.get("incoming_connections_count") != 0):
            raise ObservationError("daemon is not the isolated offline fakechain fixture")
        height = value.get("height")
        if not isinstance(height, int) or height < 1:
            raise ObservationError("invalid daemon identity height")
        return height, _hex64(value.get("top_block_hash"), "identity tip hash")

    def header(self, height: int) -> dict[str, Any]:
        value = self._post("/json_rpc", {
            "jsonrpc": "2.0", "id": "0", "method": "get_block_header_by_height",
            "params": {"height": height, "fill_pow_hash": False},
        })
        if "error" in value:
            raise ObservationError("block-header RPC error")
        result = value.get("result")
        if not isinstance(result, dict):
            raise ObservationError("missing block-header result")
        self._status(result)
        header = result.get("block_header")
        if (not isinstance(header, dict) or header.get("height") != height
                or not isinstance(header.get("orphan_status"), bool)):
            raise ObservationError("invalid block header")
        _hex64(header.get("hash"), "block hash")
        return header

    def transaction(self, txid: str) -> dict[str, Any]:
        value = self._post("/get_transactions", {
            "txs_hashes": [txid], "decode_as_json": False, "prune": False, "split": False,
        })
        self._status(value)
        if value.get("missed_tx"):
            raise ChainStateError("transaction is absent from daemon")
        txs = value.get("txs")
        if not isinstance(txs, list) or len(txs) != 1 or not isinstance(txs[0], dict):
            raise ObservationError("daemon did not return exactly one transaction")
        entry = txs[0]
        if _hex64(entry.get("tx_hash"), "returned transaction hash") != txid:
            raise ObservationError("daemon returned a different transaction")
        raw_hex = entry.get("as_hex")
        if (not isinstance(raw_hex, str) or not raw_hex or len(raw_hex) > 4 * 1024 * 1024
                or len(raw_hex) % 2 or re.fullmatch(r"[0-9a-f]+", raw_hex) is None):
            raise ObservationError("daemon did not return canonical full transaction bytes")
        if entry.get("pruned_as_hex") or entry.get("prunable_as_hex"):
            raise ObservationError("daemon returned split/pruned transaction data")
        entry = dict(entry)
        entry["blob"] = bytes.fromhex(raw_hex)
        return entry

    def spent(self, key_image: str) -> int:
        value = self._post("/is_key_image_spent", {"key_images": [key_image]})
        self._status(value)
        statuses = value.get("spent_status")
        if not isinstance(statuses, list) or len(statuses) != 1 or statuses[0] not in (0, 1, 2):
            raise ObservationError("invalid key-image spent response")
        return statuses[0]


@dataclass(frozen=True)
class ChainView:
    genesis: str
    tip_height: int
    tip_hash: str
    tx_blob: bytes
    in_pool: bool
    block_height: int | None
    block_hash: str | None
    confirmations: int
    output_indices: tuple[int, ...]


@dataclass(frozen=True)
class Deposit:
    genesis: str
    txid: str
    output_index: int
    k_o: str
    key_image: str
    intent: str
    destination: str
    amount: int
    tx_blob: bytes
    receipt: bytes
    block_height: int | None
    block_hash: str | None
    global_output_index: int | None
    endpoint: str


def chain_view(client: DaemonClient, txid: str, output_index: int) -> ChainView:
    tip_height, tip_hash = client.height()
    genesis_header = client.header(0)
    tip_header = client.header(tip_height - 1)
    if tip_header["hash"] != tip_hash or tip_header["orphan_status"]:
        raise SnapshotChangedError("daemon tip changed during observation")
    entry = client.transaction(txid)
    in_pool = entry.get("in_pool")
    if not isinstance(in_pool, bool) or not isinstance(entry.get("double_spend_seen"), bool):
        raise ObservationError("transaction state fields are missing")
    if entry["double_spend_seen"]:
        raise ChainStateError("daemon reports a double spend")
    indices = entry.get("output_indices", [])
    if not isinstance(indices, list) or any(not isinstance(item, int) or item < 0 for item in indices):
        raise ObservationError("invalid global output indices")
    block_height = None
    block_hash = None
    confirmations = 0
    if not in_pool:
        block_height = entry.get("block_height")
        confirmations = entry.get("confirmations")
        if (not isinstance(block_height, int) or block_height < 0 or block_height >= tip_height
                or not isinstance(confirmations, int)
                or confirmations != tip_height - block_height):
            raise SnapshotChangedError("inconsistent transaction confirmations")
        header = client.header(block_height)
        if header["orphan_status"]:
            raise ChainStateError("transaction block is orphaned")
        block_hash = header["hash"]
        if output_index >= len(indices):
            raise ObservationError("daemon omitted the receipt output index")
    return ChainView(
        genesis=genesis_header["hash"], tip_height=tip_height, tip_hash=tip_hash,
        tx_blob=entry["blob"], in_pool=in_pool, block_height=block_height,
        block_hash=block_hash, confirmations=confirmations, output_indices=tuple(indices),
    )


def retry_chain_view(client: DaemonClient, txid: str, output_index: int,
                     attempts: int = 3) -> ChainView:
    if attempts < 1:
        raise ValueError("chain-view attempts must be positive")
    for attempt in range(attempts):
        try:
            return chain_view(client, txid, output_index)
        except SnapshotChangedError:
            if attempt + 1 == attempts:
                raise
    raise AssertionError("unreachable chain-view retry state")


def tip_extends(client: DaemonClient, earlier: tuple[int, str], later: tuple[int, str]) -> bool:
    if later[0] < earlier[0]:
        return False
    if later[0] == earlier[0]:
        return later[1] == earlier[1]
    old_tip = client.header(earlier[0] - 1)
    return not old_tip["orphan_status"] and old_tip["hash"] == earlier[1]


def parse_core_output(output: str) -> tuple[str, int, str, int, str, str, str]:
    matches = [CORE_LINE.fullmatch(line.strip()) for line in output.splitlines()]
    matches = [match for match in matches if match is not None]
    if len(matches) != 1:
        raise ObservationError("Core verifier returned an ambiguous receipt result")
    match = matches[0]
    return (match.group(1), int(match.group(2)), match.group(3), int(match.group(4)),
            match.group(5), match.group(6), match.group(7))


def verify_core(core: Path, profile: str, tx_blob: bytes, receipt_path: Path,
                intent_path: Path, runtime: Path) -> tuple[str, int, str, int, str, str, str]:
    if profile != "user":
        raise ObservationError("only the user-to-vault fixture profile is supported")
    if not core.is_file():
        raise ObservationError("Core verifier executable is missing")
    runtime.mkdir(parents=True, exist_ok=True)
    fd, tx_name = tempfile.mkstemp(prefix="receipt-tx-", suffix=".bin", dir=runtime)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(tx_blob)
            output.flush()
            os.fsync(output.fileno())
        command = [str(core), "user", "verify-receipt", tx_name, str(receipt_path), str(intent_path)]
        result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=120, check=False)
        if result.returncode != 0:
            detail = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "Core rejected receipt"
            raise ObservationError(detail)
        return parse_core_output(result.stdout)
    finally:
        try:
            os.unlink(tx_name)
        except FileNotFoundError:
            pass


class Ledger:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, isolation_level=None, timeout=30)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("PRAGMA foreign_keys=ON")
        version = self.db.execute("PRAGMA user_version").fetchone()[0]
        if version not in (0, 1, 2):
            raise ObservationError("unsupported deposit ledger schema")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS deposits(
                id INTEGER PRIMARY KEY,
                genesis TEXT NOT NULL,
                txid TEXT NOT NULL,
                output_index INTEGER NOT NULL,
                k_o TEXT NOT NULL,
                key_image TEXT NOT NULL,
                intent TEXT NOT NULL,
                destination TEXT NOT NULL,
                amount INTEGER NOT NULL,
                event_origin TEXT NOT NULL UNIQUE,
                tx_blob BLOB NOT NULL,
                receipt BLOB NOT NULL,
                block_height INTEGER,
                block_hash TEXT,
                global_output_index INTEGER,
                first_endpoint TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('active','suspended')),
                credited INTEGER NOT NULL CHECK(credited IN (0,1)),
                credit_count INTEGER NOT NULL CHECK(credit_count IN (0,1)),
                suspension_reason TEXT,
                created_at INTEGER NOT NULL,
                last_seen INTEGER NOT NULL,
                UNIQUE(genesis,txid,output_index),
                UNIQUE(genesis,k_o),
                UNIQUE(genesis,key_image));
            CREATE TABLE IF NOT EXISTS observations(
                id INTEGER PRIMARY KEY,
                deposit_id INTEGER NOT NULL REFERENCES deposits(id),
                observed_at INTEGER NOT NULL,
                endpoint TEXT NOT NULL,
                decision TEXT NOT NULL,
                reason TEXT,
                tip_height INTEGER NOT NULL,
                tip_hash TEXT NOT NULL,
                confirmations INTEGER NOT NULL,
                spent_status INTEGER NOT NULL,
                tx_blob_sha256 TEXT NOT NULL);
        """)
        columns = {row[1] for row in self.db.execute("PRAGMA table_info(deposits)")}
        if "event_origin" not in columns:
            self.db.execute("ALTER TABLE deposits ADD COLUMN event_origin TEXT")
            rows = self.db.execute("""
                SELECT id,genesis,txid,output_index,k_o,key_image,intent,destination,amount FROM deposits
            """).fetchall()
            with self.write():
                for row in rows:
                    origin = event_origin(*row[1:])
                    self.db.execute("UPDATE deposits SET event_origin=? WHERE id=?", (origin, row[0]))
        self.db.execute("CREATE UNIQUE INDEX IF NOT EXISTS deposit_event_origin_unique ON deposits(event_origin)")
        self.db.execute("PRAGMA user_version=2")

    def close(self) -> None:
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

    @staticmethod
    def _immutable(deposit: Deposit) -> tuple[Any, ...]:
        return (deposit.genesis, deposit.txid, deposit.output_index, deposit.k_o,
                deposit.key_image, deposit.intent, deposit.destination, deposit.amount,
                event_origin(deposit.genesis, deposit.txid, deposit.output_index, deposit.k_o,
                    deposit.key_image, deposit.intent, deposit.destination, deposit.amount),
                deposit.tx_blob, deposit.receipt)

    def observe(self, deposit: Deposit, view: ChainView, spent_status: int,
                qualified: bool, reason: str | None) -> str:
        now = int(time.time())
        with self.write():
            rows = self.db.execute("""
                SELECT id,genesis,txid,output_index,k_o,key_image,intent,destination,amount,event_origin,
                       tx_blob,receipt,block_height,block_hash,global_output_index,status,credited,
                       credit_count,suspension_reason
                FROM deposits WHERE genesis=? AND ((txid=? AND output_index=?) OR k_o=? OR key_image=?)
            """, (deposit.genesis, deposit.txid, deposit.output_index, deposit.k_o, deposit.key_image)).fetchall()
            if len(rows) > 1:
                raise ConflictError("deposit uniqueness constraints resolve to different records")
            if not rows:
                credited = 1 if qualified else 0
                status = "active" if qualified else "suspended"
                cursor = self.db.execute("""
                    INSERT INTO deposits(genesis,txid,output_index,k_o,key_image,intent,destination,amount,event_origin,
                        tx_blob,receipt,block_height,block_hash,global_output_index,first_endpoint,status,
                        credited,credit_count,suspension_reason,created_at,last_seen)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """, (*self._immutable(deposit), deposit.block_height, deposit.block_hash,
                    deposit.global_output_index, deposit.endpoint, status, credited, credited,
                    reason, now, now))
                deposit_id = cursor.lastrowid
                decision = "credited" if qualified else "suspended"
            else:
                row = rows[0]
                deposit_id = row[0]
                if row[1:12] != self._immutable(deposit):
                    raise ConflictError("same backing is already bound to different event data")
                old_height, old_hash, old_global_index, old_status, credited, credit_count, old_reason = row[12:]
                was_credited = bool(credited)
                origin_changed = (old_height is not None and
                    (old_height != deposit.block_height or old_hash != deposit.block_hash))
                if origin_changed and was_credited:
                    qualified = False
                    reason = "event origin changed"
                if credited:
                    if old_status == "suspended" or not qualified:
                        status = "suspended"
                        decision = "suspended"
                        if reason is None:
                            reason = old_reason
                    else:
                        status = "active"
                        decision = "idempotent"
                elif qualified:
                    status = "active"
                    credited = credit_count = 1
                    decision = "credited"
                else:
                    status = "suspended"
                    decision = "suspended"
                if was_credited:
                    stored_height = old_height if old_height is not None else deposit.block_height
                    stored_hash = old_hash if old_hash is not None else deposit.block_hash
                    stored_global_index = (old_global_index if old_global_index is not None
                                           else deposit.global_output_index)
                else:
                    stored_height = deposit.block_height
                    stored_hash = deposit.block_hash
                    stored_global_index = deposit.global_output_index
                self.db.execute("""
                    UPDATE deposits SET status=?,credited=?,credit_count=?,suspension_reason=?,last_seen=?,
                        block_height=?,block_hash=?,global_output_index=? WHERE id=?
                """, (status, credited, credit_count, reason, now, stored_height,
                    stored_hash, stored_global_index, deposit_id))
            self.db.execute("""
                INSERT INTO observations(deposit_id,observed_at,endpoint,decision,reason,tip_height,
                    tip_hash,confirmations,spent_status,tx_blob_sha256) VALUES(?,?,?,?,?,?,?,?,?,?)
            """, (deposit_id, now, deposit.endpoint, decision, reason, view.tip_height,
                view.tip_hash, view.confirmations, spent_status,
                hashlib.sha256(deposit.tx_blob).hexdigest()))
            return decision

    def suspend_existing(self, genesis: str, txid: str, reason: str) -> int:
        with self.write():
            cursor = self.db.execute("""
                UPDATE deposits SET status='suspended',suspension_reason=?,last_seen=?
                WHERE genesis=? AND txid=?
            """, (reason, int(time.time()), genesis, txid))
            return cursor.rowcount


def observe(args: argparse.Namespace) -> int:
    runtime = Path(args.runtime).resolve()
    receipt_path = Path(args.receipt).resolve()
    intent_path = Path(args.intent).resolve()
    receipt = receipt_path.read_bytes()
    intent = intent_path.read_bytes()
    txid, output_index, intent_hex, receipt_amount = receipt_selector(receipt, intent)
    client = DaemonClient(args.url)
    ledger = Ledger(runtime / "deposits.sqlite3")
    genesis = None
    try:
        identity_first = client.identity()
        genesis = client.header(0)["hash"]
        first = retry_chain_view(client, txid, output_index)
        if (first.genesis != genesis or not tip_extends(
                client, identity_first, (first.tip_height, first.tip_hash))):
            raise ChainStateError("daemon identity changed before transaction observation")
        core = verify_core(Path(args.core).resolve(), args.profile, first.tx_blob,
                           receipt_path, intent_path, runtime)
        core_txid, core_index, k_o, amount, key_image, destination, core_intent = core
        if (core_txid != txid or core_index != output_index or core_intent != intent_hex
                or amount != receipt_amount):
            raise ObservationError("Core result differs from receipt selector")
        spent_first = client.spent(key_image)
        second = retry_chain_view(client, txid, output_index)
        spent_second = client.spent(key_image)
        identity_second = client.identity()
        stable = (first.genesis == second.genesis and first.tx_blob == second.tx_blob
                  and first.in_pool == second.in_pool and first.block_height == second.block_height
                  and first.block_hash == second.block_hash
                  and first.output_indices == second.output_indices
                   and tip_extends(client, (first.tip_height, first.tip_hash),
                                   (second.tip_height, second.tip_hash))
                   and tip_extends(client, (second.tip_height, second.tip_hash),
                                   identity_second))
        if not stable:
            reason = "daemon observation changed during verification"
        elif first.in_pool:
            reason = "transaction is still in pool"
        elif second.confirmations < args.min_confirmations:
            reason = "insufficient confirmations"
        elif spent_first != 0 or spent_second != 0:
            reason = "receiver key image is spent"
        else:
            reason = None
        global_index = (second.output_indices[output_index]
                        if not second.in_pool and output_index < len(second.output_indices) else None)
        deposit = Deposit(
            genesis=second.genesis, txid=txid, output_index=output_index, k_o=k_o,
            key_image=key_image, intent=intent_hex, destination=destination, amount=amount,
            tx_blob=second.tx_blob, receipt=receipt, block_height=second.block_height,
            block_hash=second.block_hash, global_output_index=global_index, endpoint=client.url,
        )
        decision = ledger.observe(deposit, second, spent_second, reason is None, reason)
        origin = event_origin(second.genesis, txid, output_index, k_o, key_image,
                              intent_hex, destination, amount)
        print(json.dumps({
            "decision": decision, "genesis": second.genesis, "txid": txid,
            "output_index": output_index, "K_o": k_o, "key_image": key_image,
            "intent": intent_hex, "destination": destination, "amount": amount,
            "confirmations": second.confirmations, "block_height": second.block_height,
            "block_hash": second.block_hash, "tip_height": second.tip_height,
            "tip_hash": second.tip_hash, "event_origin": origin, "endpoint_scope": "single",
        }, sort_keys=True))
        return 0 if decision in ("credited", "idempotent") else 2
    except ChainStateError as error:
        if genesis is not None:
            ledger.suspend_existing(genesis, txid, str(error))
        print(str(error), file=sys.stderr)
        return 2
    except (ObservationError, OSError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        return 2
    finally:
        ledger.close()


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description="Observe one local CARROT deposit")
    sub = value.add_subparsers(dest="command", required=True)
    node = sub.add_parser("node")
    node.add_argument("url")
    node.add_argument("core", help="path to the pinned fcmp_adapter_fixture executable")
    node.add_argument("runtime", help="local directory containing deposits.sqlite3")
    node.add_argument("receipt")
    node.add_argument("intent")
    node.add_argument("--profile", choices=("user",), default="user")
    node.add_argument("--min-confirmations", type=int, default=10)
    node.set_defaults(run=observe)
    return value


def main(argv: list[str] | None = None) -> int:
    try:
        args = parser().parse_args(argv)
        if args.min_confirmations < 1:
            raise ObservationError("--min-confirmations must be positive")
        return args.run(args)
    except (ObservationError, OSError, sqlite3.Error) as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
