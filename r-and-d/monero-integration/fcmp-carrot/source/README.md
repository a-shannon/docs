# Rosen Monero FCMP++ adapter

This directory is a local replay adapter for the pinned Monero FCMP++/CARROT
join. It keeps Core transaction construction and validation in the pinned
Monero tree and uses the pinned monero-oxide Rust crate for the SAL fixture
signer.

## Pinned inputs

- Monero Core: `d816367cb1aa405bfa68a20ac3e034d0759d968e` from
  `seraphis-migration`, tag `v0.19.0.0-beta.3.0`.
- monero-oxide: `31c26d96eaadbba910ffe3613ad8b4cf9c598a93`.
- Rust dependency versions and the oxide revision are fixed in `rust/Cargo.toml`
  and `rust/Cargo.lock`.

The expected sibling layout is `upstream/`, optional `oxide-nodepin/`, and
`adapter/`. Cargo fetches the exact `monero-oxide` Git revision; the sibling
checkout is only useful for source review. The portable hook supplied by the
surrounding checkout is `adapter/monero_hook.cmake`.

If `../upstream` is absent, run this from the adapter root:

```sh
git clone https://github.com/seraphis-migration/monero.git ../upstream
git -C ../upstream checkout --detach d816367cb1aa405bfa68a20ac3e034d0759d968e
git -C ../upstream submodule update --init --recursive
```

## Replay recipe

Run these commands from the adapter root. CMake 3.19 or newer is required by
the hook. Keep build and Cargo output outside the source tree. Configure the
pinned Core tree with the adapter hook, then build the four local targets:

```sh
cmake -S ../upstream -B /outside/source/build \
  -DCMAKE_PROJECT_monero_INCLUDE=/absolute/path/to/adapter/monero_hook.cmake
cmake --build /outside/source/build --target \
  daemon fcmp_adapter_fixture legacy_node_fixture rosen_carrot_receipt_tests
```

The pinned Core build follows the official [Monero build instructions](https://github.com/seraphis-migration/monero/blob/d816367cb1aa405bfa68a20ac3e034d0759d968e/README.md#compiling-monero-from-source).

Build the disposable Rust signer with Python 3.10 or newer available for the
replay scripts, the `cryptography` Python package installed, and an external
target directory. The adapter declares Rust 1.89 or newer; the
known Linux replay used Rust 1.98.1, GCC 11.4, and CMake 3.22.1:

```sh
cargo build --manifest-path rust/Cargo.toml --locked \
  --features fixture-cli --bin fixture-sign \
  --target-dir /outside/source/rust-target
```

The replay runner requires a Linux or WSL environment. Its runtime directory
must be a new absolute path outside the adapter source tree.

The signer accepts exactly:

```text
fixture-sign REQUEST RESPONSE [CONTEXT_HEX32]
```

It admits only the synthetic account scalars 7 and 17. The C++ fixture exposes
the corresponding disposable key set 7/11 and 17/19; these values are test
vectors only and must never be used for production funds or authorization.

The C++ fixture command forms are:

```text
[user|return] export legacy|carrot REQUEST PROPOSAL
[user|return] authorize REQUEST PROPOSAL
[user|return] verify REQUEST PROPOSAL RESPONSE [TX [INTENT]]
[user|return] node-export URL legacy|carrot REQUEST PROPOSAL [INPUT_KO]
[user|return] node-verify URL REQUEST PROPOSAL RESPONSE TX [INTENT]
[user|return] verify-receipt TX RECEIPT INTENT
[user|return] audit-final REQUEST PROPOSAL RESPONSE TX RECEIPT INTENT
[user|return] node-submit URL TX
[user|return] addresses
```

`local_campaign.py` binds admission to the retained candidate, exact input,
Core validation, SAL response, final transaction, receipt, and intent. A
deposit-backed run must provide all four independent consumer hooks:

```sh
python admission/local_campaign.py \
  --core /outside/source/build/fcmp_adapter_fixture \
  --signer /outside/source/rust-target/debug/fixture-sign \
  --node http://127.0.0.1:PORT \
  --runtime /outside/campaign \
  --era carrot --profile return \
  --deposit-observer /path/to/deposit_observer.py \
  --deposit-runtime /outside/deposit-ledger \
  --deposit-receipt /outside/deposit.receipt \
  --deposit-intent /outside/deposit.intent
```

Use `--profile vault`, `--profile user`, or `--profile return` as appropriate;
the default is `vault`. Add `--input-key` to require an exact scanned input,
`--deposit-confirmations N` to change the positive confirmation threshold, or
`--submit` only for the isolated fixture workflow. The observer command used by
the deposit hook is:

```text
deposit_observer.py node URL CORE RUNTIME RECEIPT INTENT [--min-confirmations N]
```

For a complete fresh replay from the adapter root:

```sh
python admission/replay_roundtrip.py \
  --node-fixture /outside/source/build/legacy_node_fixture \
  --core /outside/source/build/fcmp_adapter_fixture \
  --signer /outside/source/rust-target/debug/fixture-sign \
  --runtime /outside/new-replay \
  --rpc-port 58381 --p2p-port 58380
```

The fresh `replay-01` run completed the real Core path: an HF16 input
migration under FCMP++ (`6d65733718a0bfff0a1225e2948ad14675aa12731404791399a8aada910b7b46`),
CARROT user-to-vault 0.2 (`98ee3d3042ed39abe9bdc556a3e7977eb797398c198698e85059b9f215e8d212`),
and the same credited output to user 0.1 (`0e1c86eddec3f1b111fba7767425a2487b035449d0bf7f0e6d829615717c4d9d`).
Two readers observed 12 confirmations through one endpoint. Seven retained
files recovered exactly with one attempt; after spend, 24-block reorg, and the
same deposit reintroduction, `credit_count` remained 1 and the credited
deposit remained suspended.

Focused checks from the adapter root are:

```sh
python -m unittest discover -s admission -p 'test_*.py'
python -m unittest discover -s deposit -p 'test_*.py'
cargo test --manifest-path rust/Cargo.toml --locked \
  --target-dir /outside/source/rust-target
/outside/source/build/rosen_carrot_receipt_tests
```

These checks supplement the actual end-to-end `replay_roundtrip.py` runner;
that runner is authoritative for the fresh Core/node/admission replay.

Node validation is restricted to the offline IPv4-loopback fakechain. The
deposit observer and campaign reject non-fakechain, online, or non-loopback
RPC endpoints.

## Scope and limits

The adapter covers admission, view-capable legacy address hierarchy, CARROT
outputs, and the real Core FCMP++ legacy-SAL join for ordinary two-output
transfers. The modern SAL primitive is present, but the actual Core join
remains on the legacy hierarchy. The new CARROT address hierarchy is not
supported. The custom RCR1 receipt is local and is not upstream OutProofV2 or
production-qualified. Core's daemon supplies consensus and BP+/membership
validation, so this README does not claim a full proof audit. There is no
Rosen service integration or production readiness/acceptance claim.
