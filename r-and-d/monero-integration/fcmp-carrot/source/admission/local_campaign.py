"""Disposable regtest consumer of retained approval -> Rust SAL -> Core finalizer.

This fixture creates synthetic Rosen votes locally. It is not a Rosen service,
key ceremony, endpoint qualification or production signer. Resume consumes the
stored candidate and transaction; it never rebuilds a finalized transaction.
"""
import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import urllib.request
from contextlib import contextmanager
from pathlib import Path

from retained_gate import Gate, b2, canonical, strict_json, unhex
from test_retained_gate import certificate, fixture_policy


def run(arguments):
    result = subprocess.run([str(arg) for arg in arguments], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    print(result.stdout, end="", flush=True)
    return result.stdout


def core_command(args, command, *arguments):
    return [args.core] + ([args.profile] if args.profile != "vault" else []) + [command] + list(arguments)


def post(url, path, payload):
    if not re.fullmatch(r"http://127\.0\.0\.1:[0-9]{1,5}", url):
        raise ValueError("only explicit loopback regtest RPC is supported")
    request = urllib.request.Request(url + path, json.dumps(payload).encode(),
                                     {"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=120) as response:
        raw = response.read(8 * 1024 * 1024 + 1)
    if len(raw) > 8 * 1024 * 1024:
        raise ValueError("daemon response exceeds bound")
    value = strict_json(raw.decode())
    if not isinstance(value, dict):
        raise ValueError("daemon response must be an object")
    return value


def rpc(url, method, params=None):
    value = post(url, "/json_rpc", {"jsonrpc": "2.0", "id": "local", "method": method,
                                    "params": params or {}})
    if "error" in value or value.get("result", {}).get("status", "OK") != "OK":
        raise ValueError("daemon RPC refused: " + str(value))
    return value["result"]


def retained_on_daemon(url, txid, blob):
    value = post(url, "/get_transactions", {"txs_hashes": [txid], "decode_as_json": False,
                                            "prune": False, "split": False})
    if value.get("status") != "OK":
        raise ValueError("daemon could not reconcile retained payment")
    txs, missed = value.get("txs", []), value.get("missed_tx", [])
    if txs == [] and missed == [txid]:
        return False
    if (not isinstance(txs, list) or len(txs) != 1 or missed
            or not isinstance(txs[0], dict)):
        raise ValueError("ambiguous retained payment observation")
    entry = txs[0]
    if (entry.get("tx_hash") != txid or entry.get("as_hex") != blob.hex()
            or type(entry.get("in_pool")) is not bool):
        raise ValueError("daemon payment differs from exact retained transaction")
    return True


def confirmed_on_daemon(url, txid, blob):
    before = rpc(url, "get_info")
    tip = (before.get("height"), before.get("top_block_hash"))
    if type(tip[0]) is not int or tip[0] < 1:
        raise ValueError("invalid confirmation tip height")
    unhex(tip[1], 32)
    def exact_confirmed_entry():
        value = post(url, "/get_transactions", {"txs_hashes": [txid],
                                                "decode_as_json": False,
                                                "prune": False, "split": False})
        entries = value.get("txs")
        if (value.get("status") != "OK" or value.get("missed_tx", [])
                or not isinstance(entries, list) or len(entries) != 1
                or not isinstance(entries[0], dict)):
            raise ValueError("confirmed return is absent or ambiguous")
        entry = entries[0]
        height, confirmations = entry.get("block_height"), entry.get("confirmations")
        if (entry.get("tx_hash") != txid or entry.get("as_hex") != blob.hex()
                or entry.get("in_pool") is not False or type(height) is not int
                or not 0 < height < tip[0] or type(confirmations) is not int
                or confirmations < 10 or confirmations != tip[0] - height):
            raise ValueError("exact return has no stable ten-block confirmation")
        return height

    height = exact_confirmed_entry()
    header = rpc(url, "get_block_header_by_height", {"height": height})["block_header"]
    block_hash = header.get("hash")
    unhex(block_hash, 32)
    if header.get("height") != height or header.get("orphan_status") is not False:
        raise ValueError("return confirmation block is not canonical")
    if exact_confirmed_entry() != height:
        raise ValueError("return confirmation moved during verification")
    after = rpc(url, "get_info")
    if (after.get("height"), after.get("top_block_hash")) != tip:
        raise ValueError("confirmation tip changed during verification")
    return height, block_hash


def txid_from_core(output):
    ids = re.findall(r"txid=<?([0-9a-f]{64})>?", output)
    if not ids or len(set(ids)) != 1:
        raise ValueError("Core did not identify exactly one final transaction")
    return ids[0]


def atomic_replace_bytes(path, expected):
    descriptor, temporary = tempfile.mkstemp(prefix="." + path.name + ".",
                                             suffix=".tmp", dir=path.parent)
    temporary_path = Path(temporary)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(expected)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def require_bytes(path, expected):
    if path.exists() and path.read_bytes() != expected:
        raise ValueError("retained file differs from database: " + path.name)
    if path.exists():
        return
    atomic_replace_bytes(path, expected)


def publish_initial_bundle(candidate_path, certificate_path, intent_path,
                           candidate_text, cert, intent_bytes):
    # The candidate is the recovery commit marker. Publish its complete
    # sidecars first so a process interruption either leaves no marker or a
    # fully readable bundle. Orphan sidecars are safe to replace on retry.
    atomic_replace_bytes(certificate_path, canonical(cert).encode("ascii"))
    atomic_replace_bytes(intent_path, intent_bytes)
    atomic_replace_bytes(candidate_path, candidate_text.encode("ascii"))


@contextmanager
def campaign_lock(directory):
    # SQLite's process-wide writer lock also covers the initial files, which
    # exist before Gate can own a candidate. A crash releases this OS lock.
    db = sqlite3.connect(directory / "campaign-lock.sqlite3", isolation_level=None,
                         timeout=120)
    try:
        db.execute("BEGIN IMMEDIATE")
        yield
    finally:
        if db.in_transaction:
            db.execute("ROLLBACK")
        db.close()


def backing_observation(args, expected_ledger_id=None):
    command = [sys.executable, args.deposit_observer, "node", args.node, args.core,
               args.deposit_runtime, args.deposit_receipt, args.deposit_intent,
               "--min-confirmations", str(args.deposit_confirmations)]
    if expected_ledger_id is not None:
        command.extend(("--expected-ledger-id", expected_ledger_id))
    output = run(command)
    value = strict_json(output.strip())
    if value.get("decision") not in ("credited", "idempotent"):
        raise ValueError("deposit backing is not active")
    if (value.get("status") != "active" or type(value.get("credited")) is not int
            or value["credited"] != 1 or type(value.get("credit_count")) is not int
            or value["credit_count"] != 1):
        raise ValueError("deposit ledger has no single active credit")
    for field in ("event_origin", "genesis", "K_o", "key_image", "ledger_id",
                  "credit_id", "credit_block_hash"):
        unhex(value[field], 32)
    for field in ("credit_block_height", "credit_global_output_index"):
        number = value[field]
        if type(number) is not int or not 0 <= number <= 0x7fffffffffffffff:
            raise ValueError("invalid credited deposit anchor")
    if value["credit_block_height"] == 0:
        raise ValueError("unconfirmed credited deposit anchor")
    return value


def match_backing(value, observed):
    if value.get("domain") != "rosen-monero/fcmp-candidate/v2":
        raise ValueError("legacy backed candidate requires a new v2 certificate")
    request = bytes.fromhex(value["request"])
    if (value.get("backing_event") != observed["event_origin"]
            or value["genesis"] != observed["genesis"]
            or request[289:321].hex() != observed["K_o"]
            or request[449:481].hex() != observed["key_image"]
            or value["backing_ledger_id"] != observed["ledger_id"]
            or value["backing_credit_id"] != observed["credit_id"]
            or value["backing_credit_block_height"] != observed["credit_block_height"]
            or value["backing_credit_block_hash"] != observed["credit_block_hash"]
            or value["backing_credit_global_output_index"]
                != observed["credit_global_output_index"]):
        raise ValueError("withdrawal candidate differs from independently reconstructed deposit")


def replay_backing_observation(args, value):
    if value.get("domain") != "rosen-monero/fcmp-candidate/v2":
        raise ValueError("legacy backed candidate cannot replay a return")
    command = [sys.executable, args.deposit_observer, "node", args.node, args.core,
               args.deposit_runtime, args.deposit_receipt, args.deposit_intent,
               "--min-confirmations", str(args.deposit_confirmations),
               "--expected-ledger-id", value["backing_ledger_id"]]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode not in (0, 2):
        raise ValueError("deposit replay observation failed")
    observed = strict_json(result.stdout.strip())
    match_backing(value, observed)
    if (observed.get("decision") not in ("idempotent", "suspended")
            or observed.get("status") not in ("active", "suspended")
            or type(observed.get("credited")) is not int or observed["credited"] != 1
            or type(observed.get("credit_count")) is not int or observed["credit_count"] != 1
            or observed.get("chain_qualified") is not True
            or type(observed.get("spent_status")) is not int or observed["spent_status"] != 0
            or observed.get("in_pool") is not False
            or observed.get("block_height") != value["backing_credit_block_height"]
            or observed.get("block_hash") != value["backing_credit_block_hash"]
            or observed.get("global_output_index")
                != value["backing_credit_global_output_index"]):
        raise ValueError("current deposit differs from the confirmed return's original anchor")


def finalize_private(args, gate, digest, request, proposal, response, transaction, intent,
                     expected_intent):
    with tempfile.TemporaryDirectory(prefix=".finalize-", dir=transaction.parent) as directory:
        private_transaction = Path(directory) / transaction.name
        output = run(core_command(args, "node-verify", args.node, request, proposal,
                                  response, private_transaction, intent))
        private_receipt = Path(str(private_transaction) + ".receipt")
        private_intent = Path(str(private_transaction) + ".intent")
        if private_intent.read_bytes() != expected_intent:
            raise ValueError("Core derived intent differs from retained candidate")
        gate.finalize(digest, private_transaction.read_bytes(), txid_from_core(output),
                      private_receipt.read_bytes())


def execute(args):
    directory = Path(args.runtime)
    directory.mkdir(parents=True, exist_ok=True)
    with campaign_lock(directory):
        return _execute_locked(args)


def _execute_locked(args):
    if getattr(args, "confirm", False) and args.submit:
        raise ValueError("confirm and submit are separate recovery actions")
    supplied = (args.deposit_observer, args.deposit_runtime, args.deposit_receipt, args.deposit_intent)
    if any(supplied) and not all(supplied):
        raise ValueError("all four deposit consumer arguments are required")
    backing_mode = all(supplied)
    if args.deposit_confirmations < 1:
        raise ValueError("deposit confirmations must be positive")
    info = rpc(args.node, "get_info")
    if info["nettype"] != "fakechain" or info["mainnet"] or not info["offline"]:
        raise ValueError("isolated offline fakechain required")
    genesis = rpc(args.node, "get_block_header_by_height", {"height": 0})["block_header"]["hash"]
    directory = Path(args.runtime)
    directory.mkdir(parents=True, exist_ok=True)
    request, proposal, response, transaction, intent = [directory / name for name in
        ("request.bin", "proposal.bin", "response.bin", "transaction.bin", "intent.bin")]
    candidate_path = directory / "candidate.json"
    private, policy = fixture_policy()
    if candidate_path.exists():
        text = candidate_path.read_text()
        value = strict_json(text)
        cert = strict_json((directory / "certificate.json").read_text())
        if value["genesis"] != genesis:
            raise ValueError("retained candidate belongs to a different genesis")
        if backing_mode and "backing_event" not in value:
            raise ValueError("retained candidate was admitted without deposit backing")
        if not backing_mode and "backing_event" in value:
            raise ValueError("deposit-bound candidate requires its independent consumer")
        require_bytes(request, bytes.fromhex(value["request"]))
        require_bytes(proposal, bytes.fromhex(value["proposal"]))
        require_bytes(intent, bytes.fromhex(value["intent"]))
    else:
        backing = backing_observation(args) if backing_mode else None
        if backing:
            if args.input_key and args.input_key != backing["K_o"]:
                raise ValueError("requested input differs from deposit event")
            args.input_key = backing["K_o"]
        selected = [args.input_key] if args.input_key else []
        run(core_command(args, "node-export", args.node, args.era, request, proposal, *selected))
        value = {"domain": "rosen-monero/fcmp-candidate/v2" if backing else
                 "rosen-monero/fcmp-candidate/v1", "network": "regtest-fcmp-beta3",
                 "genesis": genesis, "intent": b2((args.era + "/" + directory.name).encode()).hex(),
                 "proposal": proposal.read_bytes().hex(), "request": request.read_bytes().hex()}
        if backing:
            value.update(backing_event=backing["event_origin"],
                         backing_ledger_id=backing["ledger_id"],
                         backing_credit_id=backing["credit_id"],
                         backing_credit_block_height=backing["credit_block_height"],
                         backing_credit_block_hash=backing["credit_block_hash"],
                         backing_credit_global_output_index=backing["credit_global_output_index"])
            match_backing(value, backing)
        text = canonical(value)
        cert = certificate(text, policy, private)
        publish_initial_bundle(candidate_path, directory / "certificate.json", intent,
                               text, cert, bytes.fromhex(value["intent"]))

    if args.input_key and request.read_bytes()[289:321] != unhex(args.input_key, 32):
        raise ValueError("candidate does not spend the required exact input")
    gate = Gate(str(directory / "gate.db"))
    try:
        digest = gate.admit(text, cert, policy)
        retained = gate.recover(digest)
        if retained[1] is None:
            if "backing_event" in value:
                match_backing(value, backing_observation(args, value.get("backing_ledger_id")))
            # Reconstruct and authorize the complete Core request before any
            # external SAL preprocessing, not merely after receiving a signature.
            run(core_command(args, "authorize", request, proposal))
            # A previous consumed attempt with no retained SAL refuses here.
            # There is no timeout-based reset or nonce reuse after a crash.
            gate.begin(digest)
            run([args.signer, request, response, digest])
            gate.retain_sal(digest, response.read_bytes())
        else:
            require_bytes(response, retained[1])
        if retained[2] is None:
            finalize_private(args, gate, digest, request, proposal, response, transaction, intent,
                             bytes.fromhex(value["intent"]))
        retained = gate.recover(digest)
        require_bytes(transaction, retained[2])
        require_bytes(Path(str(transaction) + ".receipt"), retained[5])
        require_bytes(Path(str(transaction) + ".intent"), bytes.fromhex(value["intent"]))

        # Reauthorize exact stored bytes. This performs no membership proving.
        gate.admit(text, cert, policy)
        audited = run(core_command(args, "audit-final", request, proposal, response, transaction,
                                   str(transaction) + ".receipt", intent))
        retained = gate.recover(digest)
        if (transaction.read_bytes(), txid_from_core(audited)) != retained[2:4]:
            raise ValueError("Core audit differs from retained finalized transaction")
        if getattr(args, "confirm", False):
            height, block_hash = confirmed_on_daemon(args.node, retained[3], retained[2])
            gate.confirm(digest, retained[2], retained[3], height, block_hash)
        if args.submit:
            # Reconcile acceptance before a fresh unspent check: a crash may
            # occur between daemon acceptance and durable submitted state.
            if retained_on_daemon(args.node, retained[3], retained[2]):
                print("recovered exact payment already present on daemon", flush=True)
            else:
                if "backing_event" in value:
                    if retained[4] == 1 and gate.confirmation(digest) is not None:
                        replay_backing_observation(args, value)
                    else:
                        match_backing(value, backing_observation(args,
                                                                value.get("backing_ledger_id")))
                # Confirmed returns may replay only while the deposit remains
                # at its certified anchor. Core and the daemon must still
                # accept the identical retained transaction bytes.
                run(core_command(args, "node-submit", args.node, transaction))
            gate.submitted(digest, retained[2], retained[3])
        print("retained_candidate=" + digest + " final_txid=" + retained[3], flush=True)
    finally:
        gate.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--core", required=True)
    parser.add_argument("--signer", required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--runtime", required=True)
    parser.add_argument("--era", choices=("legacy", "carrot"), required=True)
    parser.add_argument("--profile", choices=("vault", "user", "return"), default="vault")
    parser.add_argument("--input-key", help="require this exact scanned one-time input key")
    parser.add_argument("--deposit-observer", help="path to the independent deposit consumer")
    parser.add_argument("--deposit-runtime", help="persistent deposit ledger directory")
    parser.add_argument("--deposit-receipt", help="receipt for the exact credited input")
    parser.add_argument("--deposit-intent", help="receipt-bound deposit intent")
    parser.add_argument("--deposit-confirmations", type=int, default=10)
    parser.add_argument("--submit", action="store_true")
    parser.add_argument("--confirm", action="store_true",
                        help="retain a ten-block confirmation of the exact submitted payment")
    execute(parser.parse_args())
