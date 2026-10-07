"""Disposable regtest consumer of retained approval -> Rust SAL -> Core finalizer.

This fixture creates synthetic Rosen votes locally. It is not a Rosen service,
key ceremony, endpoint qualification or production signer. Resume consumes the
stored candidate and transaction; it never rebuilds a finalized transaction.
"""
import argparse
import json
import re
import subprocess
import sys
import urllib.request
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


def txid_from_core(output):
    ids = re.findall(r"txid=<?([0-9a-f]{64})>?", output)
    if not ids or len(set(ids)) != 1:
        raise ValueError("Core did not identify exactly one final transaction")
    return ids[0]


def require_bytes(path, expected):
    if path.exists() and path.read_bytes() != expected:
        raise ValueError("retained file differs from database: " + path.name)
    if not path.exists():
        path.write_bytes(expected)


def backing_observation(args):
    output = run([sys.executable, args.deposit_observer, "node", args.node, args.core,
                  args.deposit_runtime, args.deposit_receipt, args.deposit_intent,
                  "--min-confirmations", str(args.deposit_confirmations)])
    value = strict_json(output.strip())
    if value.get("decision") not in ("credited", "idempotent"):
        raise ValueError("deposit backing is not active")
    for field in ("event_origin", "genesis", "K_o", "key_image"):
        unhex(value[field], 32)
    return value


def match_backing(value, observed):
    request = bytes.fromhex(value["request"])
    if (value.get("backing_event") != observed["event_origin"]
            or value["genesis"] != observed["genesis"]
            or request[289:321].hex() != observed["K_o"]
            or request[449:481].hex() != observed["key_image"]):
        raise ValueError("withdrawal candidate differs from independently reconstructed deposit")


def execute(args):
    supplied = (args.deposit_observer, args.deposit_runtime, args.deposit_receipt, args.deposit_intent)
    if any(supplied) and not all(supplied):
        raise ValueError("all four deposit consumer arguments are required")
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
        require_bytes(request, bytes.fromhex(value["request"]))
        require_bytes(proposal, bytes.fromhex(value["proposal"]))
        require_bytes(intent, bytes.fromhex(value["intent"]))
    else:
        backing = backing_observation(args) if all(supplied) else None
        if backing:
            if args.input_key and args.input_key != backing["K_o"]:
                raise ValueError("requested input differs from deposit event")
            args.input_key = backing["K_o"]
        selected = [args.input_key] if args.input_key else []
        run(core_command(args, "node-export", args.node, args.era, request, proposal, *selected))
        value = {"domain": "rosen-monero/fcmp-candidate/v1", "network": "regtest-fcmp-beta3",
                 "genesis": genesis, "intent": b2((args.era + "/" + directory.name).encode()).hex(),
                 "proposal": proposal.read_bytes().hex(), "request": request.read_bytes().hex()}
        if backing:
            value["backing_event"] = backing["event_origin"]
            match_backing(value, backing)
        text = canonical(value)
        cert = certificate(text, policy, private)
        candidate_path.write_text(text)
        (directory / "certificate.json").write_text(canonical(cert))
        intent.write_bytes(bytes.fromhex(value["intent"]))

    if args.input_key and request.read_bytes()[289:321] != unhex(args.input_key, 32):
        raise ValueError("candidate does not spend the required exact input")
    gate = Gate(str(directory / "gate.db"))
    try:
        digest = gate.admit(text, cert, policy)
        retained = gate.recover(digest)
        if retained[1] is None:
            if "backing_event" in value:
                if not all(supplied):
                    raise ValueError("deposit-bound signing requires its independent consumer")
                match_backing(value, backing_observation(args))
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
            output = run(core_command(args, "node-verify", args.node, request, proposal,
                                      response, transaction, intent))
            gate.finalize(digest, transaction.read_bytes(), txid_from_core(output),
                          Path(str(transaction) + ".receipt").read_bytes())
        else:
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
        if args.submit:
            # Reconcile acceptance before a fresh unspent check: a crash may
            # occur between daemon acceptance and durable submitted state.
            if retained_on_daemon(args.node, retained[3], retained[2]):
                print("recovered exact payment already present on daemon", flush=True)
            else:
                if "backing_event" in value:
                    if not all(supplied):
                        raise ValueError("first submission requires the deposit consumer")
                    match_backing(value, backing_observation(args))
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
    execute(parser.parse_args())
