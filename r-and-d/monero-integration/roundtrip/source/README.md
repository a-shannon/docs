# Local Monero–Ergo roundtrip source

Author: A. Shannon

This experimental source package joins an actual isolated Monero deposit and native transaction proof to a real local Ergo credit, redemption of that exact credited box, and a separate-holder Monero payout. The `baseline` profile retains the original local operator trigger fixture. The `watcher-authority` profile uses two independently checked observations and actual Rosen commitment/reveal transactions in both directions, plus four guard instances with separate permanent output-assignment ledgers and actual three-of-four Ergo signatures. Both profiles use isolated chains and fixture tokens.

The original signing and proof algorithms are retained. A public fixed-view native reader and the watcher/guard composition extend the baseline. `relocation-only-changes.json` records the historical baseline relocation; it does not describe these subsequent changes. `source-manifest.json` binds the current exact file set, sizes, and ordinal aggregate. Its SHA-256 must be obtained independently from the reviewed package.

## Build and prepare

The reference environment is Windows x64 with Node.js 24.13.1, PowerShell 7.4 or later, Rust 1.98.1, Java 17 and WSL Ubuntu 22.04. Follow the [fresh preparation recipe](tools/reproduction-prerequisites.md) to reconstruct the dependencies and binaries from the public source package and initialize new isolated Ergo data and keys. System toolchains must already be installed. Other platforms and byte-identical binaries across different build paths are not qualified.

- Prepared Rosen workspace at Git commit `1edc2fb982de4560c5265e04e2ed8b93d00b40df`, matching package metadata and the distribution pins in `prepared-dependencies.json`. This includes ErgoChain 15.0.0, ergo-node-network 10.0.5 and rosen-extractor 12.1.1. Local deposit sources are included separately: fetching this Git commit does not provide them.
- Built `monero-participant` from the supplied `native` sources and locked dependencies. The build target is `cargo build --locked --features participant-host --bin monero-participant`; place build output outside this package. Supply and independently verify its executable SHA-256. Source and executable pins are distinct assurances.
- Monero 0.18.5.1 daemon binary, independently pinned. The harness starts only its isolated local fakechain process and retires that process.
- A funded isolated Ergo 6.0.3 devnet on `127.0.0.1:19051`, zero peers. `ergo-node/bootstrap-devnet.mjs` creates a new external runtime, initializes its wallet, waits for mature mining rewards, and confirms a plain EIP3 funding output used by the watcher fixture. It verifies the owned Java process and REST listener around every API call. Standard mining reward delay and transaction fees remain applicable. The watcher profile subsequently prepares its parameterized contracts and fixture tokens.
- A C++ proof helper built against the pinned public Monero core wallet sources in WSL. [The build recipe](proof/README.md) reconstructs the required shared-library closure. `proof/run.py` checks the helper, every declared non-system library and actual dynamic-library resolution before and after proof invocation. Operating-system libraries remain part of the declared Ubuntu environment.

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
| `proofSharedLibraries` | Complete absolute-path/hash list of non-system shared libraries emitted by the proof build |

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

The authenticated-backing successor uses a rebuilt participant/observer with
`scan-source` support. Its explicit profile reports raw key multiplicity while
retaining exact native source and unspent checks. The credit committee reserves
the authenticated occurrence and its key-image class permanently; the same
claim and settlement must reach selection, approval, signing, recovery and
submission. The legacy inspection profile still rejects duplicate raw keys.
Version-1 assignment databases are rejected, without implicit migration.

The optional `collisionExperiment` setting accepts `raw-before-credit`,
`decodable-before-credit`, `raw-after-credit`, `decodable-after-credit`,
`raw-copy-first` or `decodable-copy-first`.
These cases additionally require `collisionBinary` and `collisionSha256`, built
from the separate `test-fixtures/public-copy` package. Its patched wallet is
exclusive to the test generator; the participant build retains its original
dependency. The generator funds its own local wallet and receives only public
deposit facts. Before-credit source inspection takes a fresh snapshot which
both original holders and the public readers independently validate. The
launcher binds the additional executable before and after execution.

For copy-first cases, the original native holder prepares the honest transaction
without submitting it. The separate copier receives only its public bytes and
deposit metadata, funds its own wallet and includes the copy. The original holder
then submits its cached transaction once. The test checks actual block ordering,
distinct global indices, authenticated backing and spending of the honest
occurrence through the complete credit/redemption/payout path.

The
observer uses the fixture's public view scalar and does not establish a general
production view-key distribution scheme. Guard instances share one JS host;
Monero holders and fresh source readers use separate native processes. The
watcher host executes the upstream jobs with bounded SQLite/node ports, not the
complete autonomous watcher daemon. Missing guard custody refuses reopening;
valid old custody snapshots and safe committee rotation remain open deployment
requirements.

Use the same command with `--check-only true` for read-only pin validation. `--collect-only true` creates an external execution mirror and collects the roundtrip test without running it. These checks do not establish the complete roundtrip result.

## Output agreement

Monero deposit observations use `rosen-monero-output:v1:<sha256>` in the existing
`fromAddress` field. This is an origin descriptor, not a sender or refund address.
The digest commits the authenticated single-output backing: chain genesis,
vault, transaction and output indices, output key, associated key image, amount,
full intent hash and credited destination. Independent watchers and guards
recompute it after their source checks. The existing Rosen commitment, trigger
and guard comparison bind this field without changing the generic event layout.
The raw transaction ID and one qualifying output per transaction remain unchanged.

The source policy already determines a unique output in this profile. The
descriptor makes the complete backing and intent explicit in agreement; it is
not a replacement for proof verification, native key-image association,
confirmation/currentness checks or permanent output-key/image reservations.
Local reader names and snapshot handles do not change the shared descriptor.
All participants must use the same profile; old vault-address observations are
rejected before credit signing. This is not a production migration mechanism.

The [output-agreement results](../output-agreement.md) distinguish focused
structural tests, real Rosen commitment checks and complete local-chain runs.

## Multiple-operation accounting

The `economic-reconciliation` profile runs two separately backed, one-shot vault
operations on the same isolated chains. It credits and redeems the first deposit,
credits the second, then pays the first while the second credit remains unspent.
It finally redeems and pays the second. Redeeming the first credit recycles the
existing fixture tokens; the profile does not increase their issuance.

```text
node tools/launch-roundtrip.mjs --config <absolute-config-file> --manifest-sha256 <reviewed-manifest-sha256> --profile economic-reconciliation
node --test consumer/economicReconciliation.test.mjs
```

Use the watcher configuration, including the independent observer executable,
without a `collisionExperiment`. The external runtime retains the public
operations, intermediate accounting checkpoints, final report and transaction
evidence in `public-result.json`.

The pure `reconcileEconomicOperations` consumer checks exact identities and
integer conservation across deposit, credit, redemption, reservation and
settlement facts. Its caller must establish those facts; arithmetic alone does
not authenticate a chain observation. The integration profile obtains them from
the existing source, credit, return and native payment verifiers.

The report separates user credits, pending Monero payouts, deposit-fee tokens
already issued on Ergo, retained return fees, selected test reserve inputs,
confirmed Monero miner fees and change. A return event remains `pending-reward`;
its retained fees are not a completed reward distribution. The residual covers
only selected inputs under the fixture's 12-decimal, one-to-one backing model.
Unselected mining outputs and other possible vault claims are outside that sum.
Ergo operation fees are reported separately in nanoERG, and the sender's Monero
deposit fees separately from vault-funded withdrawal fees. Fixture deployment
and mining costs are excluded. Fee-coverage variance is not profitability.

This profile does not add reusable pooled vaults, fee-token redemption, return
reward distribution, global reserve accounting or production solvency checks.

The package includes reusable consumer, deposit policy, funding selection and native tests. Some historical fixture tests exercise earlier native host modes; they require the corresponding prepared binary, and are not the supported roundtrip launch command. Runtime custody, node data, keys, donor proof material and compiled dependencies are not source-package inputs.
## Deposit delivery experiment

The `deposit-delivery` launcher profile embeds a compact `RMD1` memo in an
ordinary Rust-wallet deposit transaction, discovers it from local chain blocks,
and retrieves the final intent/payment proof from a configured file directory.
It exercises two reader instances, the actual Rosen commitment/trigger path,
fresh guard verification and retained output-credit uniqueness. The readers use
one isolated Monero daemon; this does not qualify independent production nodes.

Use the same prepared configuration and reviewed source-manifest digest as the
other profiles, with a participant/observer binary built from this source:

```powershell
node tools/launch-roundtrip.mjs --config $Configuration --manifest-sha256 $ReviewedManifestSha256 --profile deposit-delivery
```

The experiment writes `<txid>.proof` in its own configured directory. Its exact
UTF-8 representation is a two-element JSON array containing the canonical full
intent encoded as lowercase hex and its `OutProofV2` string. Readers impose byte
limits and canonical encoding, match the intent to the on-transaction memo,
then independently verify proof, inclusion and output evidence. File presence
does not authorize credit. Missing, changed or invalid evidence prevents an
event or guard commitment; operators may retry when the correct proof becomes
available. No sender-supplied URL is fetched. The fixture tests fresh-process
file reload and reopening persisted guard credit state.

`RMD1` is an experimental single-output XMR-to-Ergo-testnet format, not an
assigned Rosen standard. It includes genesis, vault spend key and epoch, source
and destination network tags, destination asset/address, amount, both fees and
expiry. All integers are unsigned 64-bit big-endian values. The recipient is
length-prefixed ASCII, at most 110 bytes; the entire memo is at most 253 bytes,
within one wallet data field's 254-byte limit. The final txid and output identity
are added to the subsequently generated intent and payment proof, avoiding a
self-referential transaction hash. Memo contents are public, including recipient
and amount. A normal wallet-RPC transfer is not a supported depositor connector.

The guard requires memo verification and the delivery loader together; legacy
experiments use neither. The existing `fromAddress` output descriptor remains
opaque and cannot be used as a Monero refund address. Production proof retention,
redundant delivery, scanner checkpoint/reorg policy, depositor-wallet support and
maintainer agreement on this auxiliary proof channel remain separate work.
