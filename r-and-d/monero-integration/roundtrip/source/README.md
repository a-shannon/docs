# Local Monero–Ergo roundtrip source

Author: A. Shannon

This experimental source package joins an actual isolated Monero deposit and native transaction proof to a real local Ergo credit, redemption of that exact credited box, and a separate-holder Monero payout. The `baseline` profile retains the original local operator trigger fixture. The `watcher-authority` profile uses two independently checked observations and actual Rosen commitment/reveal transactions in both directions, plus four guard instances with separate permanent output-assignment ledgers and actual three-of-four Ergo signatures. Both profiles use isolated chains and fixture tokens.

The original signing and proof algorithms are retained. A public fixed-view native reader and the watcher/guard composition extend the baseline. `relocation-only-changes.json` records the historical baseline relocation; it does not describe these subsequent changes. `source-manifest.json` binds the current exact file set, sizes, and ordinal aggregate. Its SHA-256 must be obtained independently from the reviewed package.

## Prepared prerequisites

The supported environment is the exercised Windows Node.js/WSL arrangement with already prepared dependencies and separately supplied binaries. A fresh installation, cross-platform build, or independent reproducible binary build has not been established.

- Prepared Rosen workspace at Git commit `1edc2fb982de4560c5265e04e2ed8b93d00b40df`, matching package metadata and the distribution pins in `prepared-dependencies.json`. This includes ErgoChain 15.0.0, ergo-node-network 10.0.5 and rosen-extractor 12.1.1. Local deposit sources are included separately: fetching this Git commit does not provide them.
- Built `monero-participant` from the supplied `native` sources and locked dependencies. The build target is `cargo build --locked --features participant-host --bin monero-participant`; place build output outside this package. Supply and independently verify its executable SHA-256. Source and executable pins are distinct assurances.
- Monero 0.18.5.1 daemon binary, independently pinned. The harness starts only its isolated local fakechain process and retires that process.
- An already funded isolated Ergo 6.0.3 devnet on `127.0.0.1:19051`, zero peers, prepared genuine parameterized contracts and fixture token issuance. Supply the external Ergo runtime containing its deployment and local spending capabilities. The package does not create that runtime. Standard mining reward delay and transaction fees remain applicable.
- A supplied C++ proof helper built against the pinned Monero core wallet library in WSL, with independently checked binary and library SHA-256 values. `proof/tx-proof.cpp` is the exact source; `proof/run.py` validates the supplied helper and library before invocation. Building the helper requires the prepared Monero core build flags and linked libraries; a clean build recipe is not claimed here.

## Configuration and replay

Create a caller-owned JSON configuration outside the package with these fields:

| Field | Meaning |
| --- | --- |
| `rosenRoot` | Absolute prepared Rosen workspace path |
| `runtimeDirectory` | New, absent absolute output directory outside the package and prepared inputs |
| `nativeBinary`, `nativeSha256` | Participant executable and independent SHA-256 |
| `observerBinary`, `observerSha256` | Additional public-source reader executable and independent SHA-256, required for `watcher-authority` |
| `moneroDaemon`, `moneroDaemonSha256` | Daemon executable and independent SHA-256 |
| `ergoRuntime` | Existing external prepared Ergo runtime directory |
| `ergoRecipient` | Public address controlled by that runtime's recipient capability |
| `wslDistro` | Prepared WSL distribution name |
| `proofBinary`, `proofBinarySha256` | Absolute WSL helper path and independent SHA-256 |
| `proofLibrary`, `proofLibrarySha256` | Absolute WSL wallet library path and independent SHA-256 |

Run from this source directory, replacing the placeholders:

```text
node tools/launch-roundtrip.mjs --config <absolute-config-file> --manifest-sha256 <reviewed-manifest-sha256>
```

The launcher verifies source and prepared input pins, copies the package into the new external work directory, attaches prepared dependencies, and runs `consumer/roundtrip.spec.ts` with `roundtrip.config.ts`. It retains raw outputs and runtime custody externally. Its console output contains only exit status and source verification information. The harness keeps original Monero holders alive while retrying the same Ergo obligation; it never admits a replacement deposit to recover a lost submission reply.

For the watcher and distributed-credit successor, append `--profile watcher-authority`.
It runs `watcherAuthority.spec.ts` with the same pinned withdrawal engine. This
profile prepares fresh local fixture contracts and watcher identities using the
existing isolated Ergo funding/recipient capabilities. It checks exact signed
credit recovery against all four retained ledgers, and revalidates the return
trigger against primary Ergo state before approving the Monero payout.

The exercised participant binary remains the previously pinned baseline build;
the observer is a separately pinned build with `scan-source` support. The
observer uses the fixture's public view scalar and does not establish a general
production view-key distribution scheme. Guard instances share one JS host;
Monero holders and fresh source readers use separate native processes. The
watcher host executes the upstream jobs with bounded SQLite/node ports, not the
complete autonomous watcher daemon. Missing guard custody refuses reopening;
valid old custody snapshots and safe committee rotation remain open deployment
requirements.

Use the same command with `--check-only true` for read-only pin validation. `--collect-only true` creates an external execution mirror and collects the roundtrip test without running it. These checks do not establish the complete roundtrip result.

The package includes reusable consumer, deposit policy, funding selection and native tests. Some historical fixture tests exercise earlier native host modes; they require the corresponding prepared binary, and are not the supported roundtrip launch command. Runtime custody, node data, keys, donor proof material and compiled dependencies are not source-package inputs.
