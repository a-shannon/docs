#!/usr/bin/env python3
"""Run one fresh, disposable FCMP++/CARROT fakechain roundtrip.

This is a local maintainer replay fixture.  It owns the node process and every
runtime artifact it creates.  Core, the signer, the campaign, and the deposit
observer remain the authorities for transaction construction, verification,
admission, and observation; this runner only connects and checks those paths.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import signal
import socket
import sqlite3
import subprocess
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Iterable

from local_campaign import post, retained_on_daemon, rpc


VAULT_ADDRESS = (
    "48cNbRvGyrb43yGQYLWKxshBnnq8nRkFfPcUwfqpihwJWcrHzKy8pyk9Ai1fXeg2Gf49S2CrTyPYJG9ru2hQcTWoLYsYWMG"
)
HEX64 = re.compile(r"^[0-9a-f]{64}$")
CAMPAIGN_RESULT = re.compile(
    r"^retained_candidate=([0-9a-f]{64}) final_txid=([0-9a-f]{64})$"
)
DEPOSIT_AMOUNT = 200_000_000_000
INITIAL_PAYMENT = 400_000_000_000
RETURN_PAYMENT = 100_000_000_000
MAX_CAPTURE = 8 * 1024 * 1024
READY_TIMEOUT = 60.0


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def executable(value: str, name: str) -> Path:
    path = Path(value).resolve()
    require(path.is_file(), f"{name} executable is missing: {path}")
    require(os.access(path, os.X_OK), f"{name} is not executable: {path}")
    return path


def runtime_path(value: str, source_root: Path) -> Path:
    supplied = Path(value)
    require(supplied.is_absolute(), "--runtime must be an absolute path")
    require(not supplied.is_symlink(), "--runtime must not be a symbolic link")
    runtime = supplied.resolve(strict=False)
    require(runtime != Path(runtime.anchor), "--runtime must not be a filesystem root")
    require(not runtime.exists(), "--runtime must name a new, nonexistent directory")
    require(runtime.parent.is_dir(), "--runtime parent directory must already exist")
    require(not runtime.is_relative_to(source_root), "--runtime must be outside the adapter source tree")
    for ancestor in (runtime.parent, *runtime.parent.parents):
        require(not (ancestor / ".git").exists(), "--runtime must be outside every Git worktree")
    return runtime


def port(value: str) -> int:
    try:
        parsed = int(value, 10)
    except ValueError as error:
        raise argparse.ArgumentTypeError("port must be a decimal integer") from error
    if not 1024 <= parsed <= 65535 or str(parsed) != value:
        raise argparse.ArgumentTypeError("port must be canonical decimal in [1024,65535]")
    return parsed


def reserve_ports(values: Iterable[int]) -> list[socket.socket]:
    reservations: list[socket.socket] = []
    try:
        for value in values:
            current = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                current.bind(("127.0.0.1", value))
                current.listen(1)
            except OSError as error:
                current.close()
                raise RuntimeError(f"loopback port {value} is already in use") from error
            reservations.append(current)
        return reservations
    except BaseException:
        for current in reservations:
            current.close()
        raise


def read_bounded(path: Path, limit: int = MAX_CAPTURE) -> str:
    size = path.stat().st_size
    require(size <= limit, f"subprocess output exceeds {limit} bytes: {path.name}")
    return path.read_text(encoding="utf-8", errors="replace")


def log_tail(path: Path, limit: int = 16 * 1024) -> str:
    if not path.is_file():
        return "<node log unavailable>"
    with path.open("rb") as stream:
        size = stream.seek(0, os.SEEK_END)
        stream.seek(max(0, size - limit))
        return stream.read(limit).decode("utf-8", errors="replace")


def terminate_command_group(process: subprocess.Popen[bytes]) -> None:
    # start_new_session gives this command and its descendants a group we own.
    # Kill remaining descendants even if their immediate parent exits first.
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    finally:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=10)


def run_logged(logs: Path, label: str, arguments: list[object],
               expected: tuple[int, ...] = (0,), timeout: float = 300.0) -> tuple[int, str, str]:
    command = [str(item) for item in arguments]
    stdout_path = logs / f"{label}.stdout.log"
    stderr_path = logs / f"{label}.stderr.log"
    with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                                   start_new_session=True)
        try:
            returncode = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"subprocess timed out: {label}")
        finally:
            # These commands must never leave a background Core/signer process,
            # including when their parent exits normally or exits with an error.
            terminate_command_group(process)
    out = read_bounded(stdout_path)
    err = read_bounded(stderr_path)
    require(returncode in expected,
            f"subprocess {label} exited {returncode}, expected {expected}: {err.strip()}")
    return returncode, out, err


def strict_fixture_info(node_url: str) -> dict[str, Any]:
    info = rpc(node_url, "get_info")
    require(
        info.get("nettype") == "fakechain"
        and info.get("mainnet") is False
        and info.get("offline") is True
        and info.get("incoming_connections_count") == 0
        and info.get("outgoing_connections_count") == 0,
        "node readiness did not identify an isolated offline fakechain",
    )
    require(type(info.get("height")) is int and info["height"] >= 1,
            "node readiness returned an invalid height")
    require(isinstance(info.get("top_block_hash"), str)
            and HEX64.fullmatch(info["top_block_hash"]) is not None,
            "node readiness returned an invalid tip hash")
    return info


def wait_ready(process: subprocess.Popen[bytes], node_url: str, node_log: Path) -> dict[str, Any]:
    deadline = time.monotonic() + READY_TIMEOUT
    last_error = "RPC has not accepted a request"
    marker = (
        f"fixture_ready rpc={node_url} network=fakechain offline=true "
        "forks=1:0,16:1,17:70,18:71"
    )
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(
                f"node fixture exited before readiness with {process.returncode}:\n{log_tail(node_log)}"
            )
        try:
            info = strict_fixture_info(node_url)
            require(info["height"] == 1, "fresh fixture readiness height must be one")
            require(marker in log_tail(node_log), "owned fixture readiness marker is not yet durable")
            require(process.poll() is None, "owned fixture exited during readiness verification")
            return info
        except (OSError, ValueError, RuntimeError) as error:
            last_error = str(error)
            time.sleep(0.2)
    raise RuntimeError(f"node fixture was not ready within 60 seconds ({last_error}):\n{log_tail(node_log)}")


def stop_owned(process: subprocess.Popen[bytes] | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.send_signal(signal.SIGTERM)
    try:
        process.wait(timeout=30)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)


def mine(node_url: str, count: int) -> int:
    require(type(count) is int and count > 0, "mine count must be positive")
    result = rpc(node_url, "generateblocks", {
        "amount_of_blocks": count,
        "wallet_address": VAULT_ADDRESS,
        "prev_block": "",
        "starting_nonce": 0,
    })
    blocks = result.get("blocks")
    require(isinstance(blocks, list) and len(blocks) == count,
            "generateblocks returned the wrong block count")
    require(all(isinstance(item, str) and HEX64.fullmatch(item) is not None for item in blocks),
            "generateblocks returned an invalid block hash")
    require(type(result.get("height")) is int and result["height"] >= count,
            "generateblocks returned an invalid height")
    return result["height"]


def campaign_result(output: str) -> tuple[str, str]:
    matches = [CAMPAIGN_RESULT.fullmatch(line.strip()) for line in output.splitlines()]
    matches = [match for match in matches if match is not None]
    require(len(matches) == 1, "campaign did not report exactly one retained candidate and txid")
    return matches[0].group(1), matches[0].group(2)


def require_core_payment(output: str, txid: str, amount: int) -> None:
    pattern = re.compile(
        rf"^PASS Core membership/range finalizer, txid=<{txid}>, bytes=[1-9][0-9]*, "
        rf"recipient={amount}; node tree, awaiting submission$"
    )
    matches = [line for line in output.splitlines() if pattern.fullmatch(line.strip())]
    require(len(matches) == 1, "Core did not report the exact node-backed fixture payment")


def observer_result(output: str) -> dict[str, Any]:
    try:
        value = json.loads(output.strip())
    except json.JSONDecodeError as error:
        raise RuntimeError("observer did not return one JSON result") from error
    require(isinstance(value, dict), "observer result is not an object")
    return value


def ledger_state(runtime: Path, genesis: str, txid: str) -> tuple[str, int, int]:
    database = runtime / "deposits.sqlite3"
    require(database.is_file(), f"observer ledger is missing: {database}")
    connection = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=10)
    try:
        connection.execute("PRAGMA query_only=ON")
        rows = connection.execute(
            "SELECT status,credited,credit_count FROM deposits WHERE genesis=? AND txid=?",
            (genesis, txid),
        ).fetchall()
    finally:
        connection.close()
    require(len(rows) == 1, "observer ledger does not contain exactly one matching deposit")
    return rows[0]


def digest_file(path: Path) -> str:
    require(path.is_file(), f"retained file is missing: {path.name}")
    size = path.stat().st_size
    require(0 < size <= 2 * 1024 * 1024, f"retained file has invalid size: {path.name}")
    return hashlib.sha256(path.read_bytes()).hexdigest()


def set_recovery_gap(database: Path, digest: str) -> None:
    connection = sqlite3.connect(database, isolation_level=None, timeout=10)
    try:
        connection.execute("BEGIN IMMEDIATE")
        candidates = connection.execute(
            "SELECT digest,submitted FROM candidates"
        ).fetchall()
        attempts = connection.execute("SELECT COUNT(*) FROM attempts").fetchone()[0]
        require(candidates == [(digest, 1)], "return gate is not one submitted owned candidate")
        require(attempts == 1, "return gate does not contain exactly one signing attempt")
        cursor = connection.execute(
            "UPDATE candidates SET submitted=0 WHERE digest=? AND submitted=1", (digest,)
        )
        require(cursor.rowcount == 1, "could not create the submitted-state recovery gap")
        connection.execute("COMMIT")
    except BaseException:
        if connection.in_transaction:
            connection.execute("ROLLBACK")
        raise
    finally:
        connection.close()


def recovery_state(database: Path, digest: str) -> tuple[int, int]:
    connection = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=10)
    try:
        connection.execute("PRAGMA query_only=ON")
        rows = connection.execute(
            "SELECT submitted FROM candidates WHERE digest=?", (digest,)
        ).fetchall()
        attempts = connection.execute("SELECT COUNT(*) FROM attempts").fetchone()[0]
    finally:
        connection.close()
    require(len(rows) == 1, "return candidate disappeared during recovery")
    return attempts, rows[0][0]


def confirmed_retained(node_url: str, txid: str, transaction: Path) -> int:
    blob = transaction.read_bytes()
    require(retained_on_daemon(node_url, txid, blob), "retained transaction is absent from daemon")
    value = post(node_url, "/get_transactions", {
        "txs_hashes": [txid], "decode_as_json": False, "prune": False, "split": False,
    })
    require(value.get("status") == "OK" and value.get("missed_tx", []) == [],
            "daemon did not return the exact confirmed transaction")
    entries = value.get("txs")
    require(isinstance(entries, list) and len(entries) == 1 and isinstance(entries[0], dict),
            "daemon returned an ambiguous confirmed transaction")
    entry = entries[0]
    require(entry.get("tx_hash") == txid and entry.get("as_hex") == blob.hex()
            and entry.get("in_pool") is False,
            "daemon confirmed transaction differs from retained bytes")
    confirmations = entry.get("confirmations")
    require(type(confirmations) is int and confirmations >= 10,
            "retained transaction has fewer than ten confirmations")
    return confirmations


def write_result(runtime: Path, value: dict[str, Any]) -> None:
    encoded = (json.dumps(value, sort_keys=True, indent=2) + "\n").encode("utf-8")
    require(len(encoded) <= 32 * 1024, "result JSON exceeds its 32 KiB bound")
    temporary = runtime / "result.json.tmp"
    destination = runtime / "result.json"
    with temporary.open("xb") as stream:
        stream.write(encoded)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(destination)


def execute(args: argparse.Namespace) -> int:
    script = Path(__file__).resolve()
    source_root = script.parent.parent
    campaign_cli = script.with_name("local_campaign.py")
    observer_cli = source_root / "deposit" / "deposit_observer.py"
    require(campaign_cli.is_file() and observer_cli.is_file(), "campaign or observer source is missing")
    node_fixture = executable(args.node_fixture, "node fixture")
    core = executable(args.core, "Core fixture")
    signer = executable(args.signer, "fixture signer")
    runtime = runtime_path(args.runtime, source_root)
    require(args.rpc_port != args.p2p_port, "RPC and P2P ports must differ")
    reservations = reserve_ports((args.rpc_port, args.p2p_port))
    node: subprocess.Popen[bytes] | None = None
    node_log_stream = None
    owned_runtime = False
    try:
        runtime.mkdir()
        owned_runtime = True
        logs = runtime / "logs"
        logs.mkdir()
        node_data = runtime / "node"
        node_log = logs / "node.stdout-stderr.log"
        node_url = f"http://127.0.0.1:{args.rpc_port}"
        node_log_stream = node_log.open("wb")
        for reservation in reservations:
            reservation.close()
        reservations.clear()
        node = subprocess.Popen(
            [str(node_fixture), str(node_data), str(args.rpc_port), str(args.p2p_port)],
            stdin=subprocess.DEVNULL, stdout=node_log_stream, stderr=subprocess.STDOUT,
        )
        ready = wait_ready(node, node_url, node_log)
        genesis = rpc(node_url, "get_block_header_by_height", {"height": 0})["block_header"]["hash"]
        require(isinstance(genesis, str) and HEX64.fullmatch(genesis) is not None,
                "fixture returned an invalid genesis hash")

        legacy_runtime = runtime / "campaign-legacy"
        deposit_runtime = runtime / "campaign-deposit"
        return_runtime = runtime / "campaign-return"
        reader_a = runtime / "reader-a"
        reader_b = runtime / "reader-b"

        mine(node_url, 80)
        _, legacy_out, _ = run_logged(logs, "01-legacy-campaign", [
            sys.executable, campaign_cli, "--core", core, "--signer", signer,
            "--node", node_url, "--runtime", legacy_runtime, "--era", "legacy", "--submit",
        ])
        _, legacy_txid = campaign_result(legacy_out)
        require_core_payment(legacy_out, legacy_txid, INITIAL_PAYMENT)
        mine(node_url, 12)

        _, deposit_out, _ = run_logged(logs, "02-deposit-campaign", [
            sys.executable, campaign_cli, "--core", core, "--signer", signer,
            "--node", node_url, "--runtime", deposit_runtime, "--era", "carrot",
            "--profile", "user", "--submit",
        ])
        deposit_digest, deposit_txid = campaign_result(deposit_out)
        require_core_payment(deposit_out, deposit_txid, DEPOSIT_AMOUNT)
        mine(node_url, 12)

        deposit_receipt = deposit_runtime / "transaction.bin.receipt"
        deposit_intent = deposit_runtime / "transaction.bin.intent"
        observer_base = [sys.executable, observer_cli, "node", node_url, core]
        _, observer_a_out, _ = run_logged(logs, "03-reader-a-credit", [
            *observer_base, reader_a, deposit_receipt, deposit_intent,
            "--min-confirmations", "10",
        ])
        _, observer_b_out, _ = run_logged(logs, "04-reader-b-credit", [
            *observer_base, reader_b, deposit_receipt, deposit_intent,
            "--min-confirmations", "10",
        ])
        observed_a = observer_result(observer_a_out)
        observed_b = observer_result(observer_b_out)
        identity_fields = (
            "event_origin", "genesis", "txid", "output_index", "K_o", "key_image",
            "amount", "destination", "intent",
        )
        require(observed_a.get("decision") == observed_b.get("decision") == "credited",
                "both fresh readers must independently credit the deposit")
        require(all(observed_a.get(field) == observed_b.get(field) for field in identity_fields),
                "independent readers reconstructed different deposit identities")
        require(observed_a.get("genesis") == genesis and observed_a.get("txid") == deposit_txid,
                "observer identity differs from the fixture genesis or deposit campaign")
        require(observed_a.get("amount") == DEPOSIT_AMOUNT
                and observed_a.get("destination") == VAULT_ADDRESS,
                "observer did not reconstruct the exact 0.2 XMR vault deposit")
        require(observed_a.get("intent") == deposit_intent.read_bytes().hex(),
                "observer intent differs from the campaign intent")
        require(observed_a.get("endpoint_scope") == observed_b.get("endpoint_scope") == "single",
                "observer did not preserve single-endpoint scope")
        require(type(observed_a.get("confirmations")) is int and observed_a["confirmations"] >= 10
                and type(observed_b.get("confirmations")) is int and observed_b["confirmations"] >= 10,
                "credited deposit has fewer than ten confirmations")
        require(ledger_state(reader_a, genesis, deposit_txid) == ("active", 1, 1)
                and ledger_state(reader_b, genesis, deposit_txid) == ("active", 1, 1),
                "fresh reader ledger did not record one active credit")

        _, return_out, _ = run_logged(logs, "05-return-campaign", [
            sys.executable, campaign_cli, "--core", core, "--signer", signer,
            "--node", node_url, "--runtime", return_runtime, "--era", "carrot",
            "--profile", "return", "--input-key", observed_a["K_o"],
            "--deposit-observer", observer_cli, "--deposit-runtime", reader_a,
            "--deposit-receipt", deposit_receipt, "--deposit-intent", deposit_intent,
            "--deposit-confirmations", "10", "--submit",
        ])
        return_digest, return_txid = campaign_result(return_out)
        require_core_payment(return_out, return_txid, RETURN_PAYMENT)
        mine(node_url, 12)

        legacy_confirmations = confirmed_retained(
            node_url, legacy_txid, legacy_runtime / "transaction.bin"
        )
        return_confirmations = confirmed_retained(
            node_url, return_txid, return_runtime / "transaction.bin"
        )

        retained_paths = {
            "request": return_runtime / "request.bin",
            "proposal": return_runtime / "proposal.bin",
            "response": return_runtime / "response.bin",
            "transaction": return_runtime / "transaction.bin",
            "transaction.receipt": return_runtime / "transaction.bin.receipt",
            "transaction.intent": return_runtime / "transaction.bin.intent",
            "intent": return_runtime / "intent.bin",
        }
        retained_hashes = {name: digest_file(path) for name, path in retained_paths.items()}
        backups: dict[str, Path] = {}
        for name, path in retained_paths.items():
            backup = path.with_name(path.name + ".before-recovery")
            require(not backup.exists(), f"recovery backup already exists: {backup.name}")
            path.rename(backup)
            backups[name] = backup
        set_recovery_gap(return_runtime / "gate.db", return_digest)
        _, recovered_out, _ = run_logged(logs, "06-return-recovery", [
            sys.executable, campaign_cli, "--core", core, "--signer", signer,
            "--node", node_url, "--runtime", return_runtime, "--era", "carrot",
            "--profile", "return", "--submit",
        ])
        recovered_digest, recovered_txid = campaign_result(recovered_out)
        require((recovered_digest, recovered_txid) == (return_digest, return_txid),
                "recovery selected a different retained candidate or transaction")
        require(all(digest_file(retained_paths[name]) == retained_hashes[name]
                    and digest_file(backups[name]) == retained_hashes[name]
                    for name in retained_paths),
                "recovery changed one of the seven retained files")
        attempts, submitted = recovery_state(return_runtime / "gate.db", return_digest)
        require((attempts, submitted) == (1, 1),
                "recovery regenerated a signing attempt or failed to persist submission")

        _, spent_out, _ = run_logged(logs, "07-reader-a-spent", [
            *observer_base, reader_a, deposit_receipt, deposit_intent,
            "--min-confirmations", "10",
        ], expected=(2,))
        spent_observation = observer_result(spent_out)
        require(spent_observation.get("decision") == "suspended",
                "spent deposit observer did not return suspended")
        require(ledger_state(reader_a, genesis, deposit_txid) == ("suspended", 1, 1),
                "spent deposit changed credit ownership or count")

        height = strict_fixture_info(node_url)["height"]
        deposit_height = observed_a.get("block_height")
        require(type(deposit_height) is int and 0 < deposit_height < height,
                "deposit block height is invalid for rollback")
        removed_blocks = height - deposit_height
        popped = post(node_url, "/pop_blocks", {
            "nblocks": removed_blocks, "keep_txs": False,
        })
        require(popped.get("status") == "OK" and popped.get("height") == deposit_height,
                "pop_blocks did not remove the deposit block and every successor")
        require(not retained_on_daemon(
            node_url, deposit_txid, (deposit_runtime / "transaction.bin").read_bytes()
        ), "popped deposit transaction remains on the daemon")

        run_logged(logs, "08-reader-b-reorg", [
            *observer_base, reader_b, deposit_receipt, deposit_intent,
            "--min-confirmations", "10",
        ], expected=(2,))
        require(ledger_state(reader_b, genesis, deposit_txid) == ("suspended", 1, 1),
                "reorg suspension changed reader B credit ownership or count")

        _, reintroduced_out, _ = run_logged(logs, "09-deposit-reintroduction", [
            sys.executable, campaign_cli, "--core", core, "--signer", signer,
            "--node", node_url, "--runtime", deposit_runtime, "--era", "carrot",
            "--profile", "user", "--submit",
        ])
        require(campaign_result(reintroduced_out) == (deposit_digest, deposit_txid),
                "reintroduction changed the retained deposit transaction")
        mine(node_url, 12)
        _, replay_out, _ = run_logged(logs, "10-reader-b-reintroduced", [
            *observer_base, reader_b, deposit_receipt, deposit_intent,
            "--min-confirmations", "10",
        ], expected=(2,))
        replay_observation = observer_result(replay_out)
        require(replay_observation.get("decision") == "suspended",
                "reintroduced deposit automatically reactivated")
        require(type(replay_observation.get("confirmations")) is int
                and replay_observation["confirmations"] >= 10,
                "reintroduced deposit has fewer than ten confirmations")
        require(all(replay_observation.get(field) == observed_b.get(field) for field in identity_fields),
                "reintroduced exact transaction changed the deposit identity")
        require(ledger_state(reader_b, genesis, deposit_txid) == ("suspended", 1, 1),
                "reintroduced deposit was recredited or reactivated")

        result = {
            "scope": {
                "fixture_only": True,
                "network": "offline fakechain",
                "endpoint_scope": "single",
                "rosen_acceptance": False,
                "production_readiness": False,
            },
            "fixture": {
                "genesis": genesis,
                "initial_height": ready["height"],
                "fork_schedule": "1:0,16:1,17:70,18:71",
            },
            "txids": {
                "legacy_input_migration": legacy_txid,
                "carrot_deposit": deposit_txid,
                "carrot_return": return_txid,
            },
            "event": {field: observed_a[field] for field in identity_fields},
            "amounts_atomic": {
                "vault_to_user": INITIAL_PAYMENT,
                "user_to_vault_deposit": DEPOSIT_AMOUNT,
                "return_payment": RETURN_PAYMENT,
            },
            "confirmations": {
                "deposit_initial_reader_a": observed_a["confirmations"],
                "deposit_initial_reader_b": observed_b["confirmations"],
                "legacy_before_reorg": legacy_confirmations,
                "return_before_reorg": return_confirmations,
                "deposit_reintroduced": replay_observation["confirmations"],
            },
            "recovery": {
                "seven_files_sha256": retained_hashes,
                "attempts": attempts,
                "submitted": submitted,
                "identical": True,
            },
            "rollback": {
                "removed_blocks": removed_blocks,
                "reader_a_after_spend": {"status": "suspended", "credited": 1, "credit_count": 1},
                "reader_b_after_reorg": {"status": "suspended", "credited": 1, "credit_count": 1},
                "reader_b_after_reintroduction": {
                    "status": "suspended", "credited": 1, "credit_count": 1,
                },
            },
        }
        write_result(runtime, result)
        return 0
    except BaseException:
        if owned_runtime:
            failure = (traceback.format_exc() + "\n").encode("utf-8", errors="replace")[:64 * 1024]
            try:
                (runtime / "failure.log").write_bytes(failure)
            except OSError:
                pass
        raise
    finally:
        for reservation in reservations:
            reservation.close()
        stop_owned(node)
        if node_log_stream is not None:
            node_log_stream.close()


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(
        description="Replay the complete local FCMP++/CARROT fakechain roundtrip"
    )
    value.add_argument("--node-fixture", required=True)
    value.add_argument("--core", required=True)
    value.add_argument("--signer", required=True)
    value.add_argument("--runtime", required=True, metavar="NEW_ABSOLUTE")
    value.add_argument("--rpc-port", required=True, type=port)
    value.add_argument("--p2p-port", required=True, type=port)
    return value


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if os.name != "posix":
        print("replay_roundtrip: this fixture requires Linux or WSL", file=sys.stderr)
        return 1

    def interrupted(signum: int, frame: object) -> None:
        raise KeyboardInterrupt(f"runner interrupted by signal {signum}")

    previous_term = signal.signal(signal.SIGTERM, interrupted)
    try:
        return execute(args)
    except BaseException as error:
        print(f"replay_roundtrip: {error}", file=sys.stderr)
        return 1
    finally:
        signal.signal(signal.SIGTERM, previous_term)


if __name__ == "__main__":
    raise SystemExit(main())
