# Local Monero–Ergo roundtrip source

Author: A. Shannon

The [deposit adapter qualification report](../adapter-qualification.md) covers
the newer scanner-to-watcher-to-guard path. It adds native block/output and retained
certificate replay, delayed evidence admission, and fresh verification immediately
before each native guard contribution. This candidate is not production qualified.

### Reproduce the deposit adapter candidate

Prepare the existing native, proof and Rosen prerequisites below. Additionally,
build the Monero extractor package from scanner commit
`2e0382d97a6e0a7bb6fb0e5927ad56af44d2f0ae` and the Ergo multisig package from
sign-protocols commit `2fdaf3af3897d9c2b1c7e5e6c7d57d0415d808b0`.
These changes are published in the `a-shannon/scanner` and
`a-shannon/sign-protocols` forks. Set `scannerAdapterRoot` to the former package's
root, set `scannerAdapterCommit` to the scanner commit above, and set
`contributionPackage` to `{root, sha256, commit}` for the latter package.
The runtime package digest is SHA-256 of the UTF-8 concatenation
`path + NUL + file SHA-256 + NUL + decimal byte length + LF`, in this fixed order:
`package.json`, `dist/const.js`, `dist/index.js`, `dist/multiSigHandler.js`,
`dist/multiSigUtils.js`, `dist/types.js`. The tested aggregate is
`ac1ff3995a4bf299dd2bccb28b8c03141ced9f0a34fb7e28f766a34435637282`.
Use the explicit LF checkout and locked build in the
[preparation recipe](tools/reproduction-prerequisites.md#build-the-two-adapter-packages).
Inline source maps include source line endings, so other checkout conventions
produce different runtime hashes despite equivalent TypeScript logic.
The loader checks the exact bytes and resolves external package dependencies
through the prepared Rosen distribution, including its shared WASM instance.

Use a new `runtimeDirectory` for each complete run and a funded, owned isolated
Ergo devnet. Existing deployments have consumed fixture funds and are not fresh
test inputs. The test manages its own two isolated Monero daemons; the operator
retains responsibility for the separately started Ergo node.

Set `processSimulation: true` in that external configuration, then use the frozen
launcher. It supplies the proof-helper environment and the adapter's module loader:

```text
node tools/launch-roundtrip.mjs --config <absolute-config-file> --manifest-sha256 <reviewed-manifest-sha256> --profile deposit-adapter
```

The launcher verifies original and copied inputs before and after execution and
keeps node, holder and proof material outside the source package. Both adapter
profiles support `--check-only true` and refuse `--collect-only true`.

For adapter profiles, the receipt binds 14 direct scanner/multisig runtime files
plus the installed dependency graphs, including CommonJS packages and the
TypeScript loader. It records source commits separately from built bytes and
checks package resolution targets, metadata, file sets and hashes before and
after execution. Runtime output cannot overlap those inputs. New runtime imports
must extend this declared closure; the qualification report records the observed
load comparison for the exercised profile. Operating-system shared libraries
remain part of the declared Windows/WSL environment.

Set `processSimulation: true` in that external configuration for the V2
[multiprocess campaign](consumer/processAdapterScenario.mjs). It starts two
watcher Node processes and four guard Node processes with separate SQLite stores,
proof inboxes and fixture keys. The parent relays the existing authenticated
multisig envelopes. It tests missing evidence, watcher queue/broadcast crashes,
lost messages, guard death before a partial signature, config-directory drift,
three-of-four signing with a non-coordinator offline, delayed duplicate messages,
and recovery of the same confirmed credit. The three-of-four trial uses the node's
transaction check endpoint without broadcasting; the final trial confirms one
credit. The external `adapter-*/process-result.json` records the result and PIDs.

The controller provisions the same four guard custody databases before starting
watchers. Each watcher reads all four through a read-only view before retaining a
new observation, queueing a commitment/reveal and submitting pending transactions.
An output key or associated key image already retained by any guard refuses a new
proposal, including after invalidation and restart. Missing, corrupt or rebound
custody fails closed. The guard's atomic assignment remains necessary for races
after a watcher read. Confirmed-event recovery returns the exact retained event;
it does not grant new eligibility. The older in-process transport refuses V2
observations and remains available only to older experiment profiles.

For focused replay, set `WATCHER_DEPENDENCY_ROOT` to the prepared Rosen root:

```text
node --experimental-vm-modules --test ergo-node/credit-custody.test.mjs ergo-node/watcher-credit-view.test.mjs ergo-node/watcher-novelty-runtime.test.mjs guard-service/src/db/moneroCreditNovelty.test.mjs
```

Also set `sourceResilience: true` to add the bounded source-fault campaign; this
option requires process simulation. It retries missing proof delivery for at least
10 seconds over five attempts, reopening the scanner/admission database once.
The controller first replaces equal-height suffixes on the two owned fakechain
daemons, checks disagreement refusal, and rolls back pending and accepted
candidates, deleting the accepted observation. It restores the exact original
blocks and transactions and checks readmission. The six-process campaign then
tests disagreement and agreed replacement before watcher and guard commitments,
and disagreement after signing before submission.

After the credit is confirmed, each guard can audit the retained backing using
its own source connection. Missing evidence or daemon disagreement returns
`held` without changing the claim. An agreed replacement of the selected block
permanently invalidates that claim while retaining its output/key-image
reservations. Restoring the original chain does not reactivate it. The audit and
signing session exclude each other in both directions. This explicit audit is
neither an autonomous monitor nor a global vault halt, and cannot undo an Ergo
credit. A production response to the outstanding liability remains a separate
integration decision. Both sources remain under one operator; this experiment
does not establish general reorg handling, finality or independent administration.

Focused source-audit checks:

```text
node --test ergo-node/credit-backing-audit.test.mjs consumer/moneroForkFixture.test.mjs
```

For the opt-in real fork-helper smoke, also set
`MONERO_FORK_FIXTURE_LOCAL_TEST=1`, an absolute fresh
`MONERO_FORK_FIXTURE_RUNTIME`, and the prepared `ROUNDTRIP_CONFIG`; run the helper
test with `node --import tsx --test consumer/moneroForkFixture.test.mjs`.

Focused process checks need no running chain:

```text
node --test tools/process-rpc.test.mjs tools/participant-config.test.mjs
```

This profile uses controlled child processes under one OS account. It does not
provide an autonomous production watcher/guard service, protected key custody,
independent source administration or rollback-resistant backups. A crash between
initial bootstrap-manifest creation and initial SQLite creation fails closed;
that initialization window is not a qualified automatic recovery path.

### Complete the V2 return

Set `v2Return: true`, `processSimulation: true`, and `sourceResilience: false`,
with a fresh external runtime directory, then run:

```text
node tools/launch-roundtrip.mjs --config <absolute-config-file> --manifest-sha256 <reviewed-manifest-sha256> --profile v2-roundtrip
```

The [return scenario](consumer/v2ReturnScenario.mjs) redeems the exact confirmed
recipient credit, starts two return watcher processes, confirms the return event,
and reopens those watchers without creating another event. All four guards bind
the original V2 assignment, confirmed credit, recipient redemption, return event,
native request and selected output before retaining one permanent withdrawal
reservation. Each fresh authorization reconstructs the same unspent Monero
backing; expiry of the initial deposit-delivery window does not erase an existing
credit liability. New deposit admission retains its expiry rules.

The existing Rust threshold CLSAG engine pays the recipient with two of four
holders. The campaign checks competing reservations, proof loss before approval,
lost submission replies and restart of all four guards after payout. Recovery
checks the retained settlement and existing native transaction; it cannot grant
a fresh withdrawal authorization for spent backing. Signing and submission must
each occur once. The external `adapter-*/v2-return-result.json` records the payout
and accounting at redemption, reservation, settlement and reward completion. Return watcher counters
in that report are sampled after restart, not during initial observation.

The return then uses the actual Rosen EventOrder and ErgoChain reward path.
All four guards bind the confirmed Monero payment to the retained withdrawal,
recheck its recipient, amount and confirmations, and atomically retain one reward
assignment in their SQLite ledgers. The owner persists the exact signed Ergo
transaction before submission. The campaign deliberately loses its submission
reply, restarts all four guards and recovers the same bytes without another
signature. Rosen's TransactionProcessor completes the reward transaction and
event. Ledger schema 3 is required; older schemas are refused without migration.

The minimum-fee reader reconstructs the configured NFT/asset fee box from complete
node pagination and applies its historical row at the source height. New
withdrawals use the maximum of declared, minimum and proportional fees before
approval. Underquoted deposits refuse rather than change their authenticated
intent. Reward recovery accepts a successor fee box only when the retained
historical fee policy remains identical. The live fixture exercises proportional
fees; historical fee-box succession has focused regression coverage.

Keep the source-reorganization campaign separate: `deposit-adapter` with
`sourceResilience: true` and `v2Return: false` tests permanent quarantine of a
credited liability. Quarantined backing cannot fund the successful payout case.

Focused V2 checks, from this source directory with prepared dependencies:

```text
node --import tsx --test consumer/freshDepositAdmission.test.mjs consumer/retainedBackingSource.test.mjs guard-service/src/db/moneroCreditSettlementV2.test.mjs
node --experimental-vm-modules --import ./ergo-node/deposit-register.mjs --test ergo-node/v2-withdrawal-authority.test.mjs consumer/v2AsyncCustody.test.mjs
node --experimental-vm-modules --import tsx --test ergo-node/watcher-return-runtime.test.mjs
```

Set `ROUNDTRIP_CONFIG` to the external configuration for the loader-dependent
checks and `WATCHER_DEPENDENCY_ROOT` to the prepared Rosen root for watcher tests.
The [qualification report](../adapter-qualification.md#complete-local-v2-roundtrip)
records exact transaction evidence and limitations. Fixture reserves subsidize
the miner fee; shared administration and production fee-token redemption remain
outside this local qualification. The [multisig review packet](../multisig-review.md)
records the completed independent local implementation review and its scope.

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
| `observerBinary`, `observerSha256` | Public-source reader executable and independent SHA-256, required for every non-baseline profile |
| `moneroDaemon`, `moneroDaemonSha256` | Daemon executable and independent SHA-256 |
| `ergoRuntime` | Existing external prepared Ergo runtime directory |
| `ergoRecipient` | Public address controlled by that runtime's recipient capability |
| `wslDistro` | Prepared WSL distribution name |
| `proofBinary`, `proofBinarySha256` | Absolute WSL helper path and independent SHA-256 |
| `proofLibrary`, `proofLibrarySha256` | Absolute WSL wallet library path and independent SHA-256 |
| `proofSharedLibraries` | Complete absolute-path/hash list of non-system shared libraries emitted by the proof build |
| `scannerAdapterRoot`, `scannerAdapterCommit`, `contributionPackage` | Adapter package root/source commit and multisig `{root, sha256, commit}` configuration described above; required for the adapter profiles |
| `processSimulation`, `v2Return`, `sourceResilience` | Explicit adapter modes described above; the successful V2 return and quarantine campaign are separate runs |

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
production view-key distribution scheme. In these older profiles, guard instances share one JS host;
Monero holders and fresh source readers use separate native processes. The
watcher host executes the upstream jobs with bounded SQLite/node ports, not the
complete autonomous watcher daemon. Missing guard custody refuses reopening;
valid old custody snapshots and safe committee rotation remain open deployment
requirements.

Use the same command with `--check-only true` for read-only pin validation. `--collect-only true` creates an external execution mirror and collects the roundtrip test without running it. These checks do not establish the complete roundtrip result.

## Output agreement

Earlier experiment profiles use `rosen-monero-output:v1:<sha256>` in the existing
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
The current V2 adapter uses `rosen-monero-output:v2:<sha256>` and commits its
native output receipt, holder-certificate digest and complete destination intent.
Its watcher novelty checks consult retained guard custody before publication;
the [adapter report](../adapter-qualification.md) describes that current contract.

## Earlier multiple-operation accounting profile

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
The current `v2-roundtrip` profile additionally completes one operation's reward
distribution and converts retained return fees into issued fee-token liabilities;
their required backing remains included in the reconciliation.

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
