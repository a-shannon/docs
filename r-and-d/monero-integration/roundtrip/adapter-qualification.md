# Monero V2 adapter: local roundtrip qualification

A. Shannon · 18 September 2026

The V2 path connects a real isolated Monero deposit to Rosen scanner observations,
watcher commitment/reveal transactions, a four-guard Ergo credit, redemption of
that exact credit and a confirmed native Monero payout. Two watcher processes
run in each direction; four guard processes retain individual custody stores.
The complete local roundtrip, lost-reply recovery and post-payout guard restart
pass. The source is public and executable.
**Production qualification remains open.** The test hosts, custody bootstrap and
deployment profile are controlled fixtures.

## Review the code

- [Historical failure coverage](burn-coverage.md): separate repeated-primary, additional-key and duplicated-backing regressions, with their evidence limits.
- [Multisig review packet](multisig-review.md): exact five-file candidate diff, authorization points and focused replay commands.
- [Scanner and native reader](https://github.com/a-shannon/scanner/tree/2e0382d97a6e0a7bb6fb0e5927ad56af44d2f0ae/packages/observation-extractors/monero-observation-extractor): durable capture, separate admission leases, daemon agreement, original block anchoring and bounded native replay.
- [Optional multisig authorization hook](https://github.com/a-shannon/sign-protocols/commit/fd41b5df91d79bc0fc74373a397372edfd3efa84): revalidation before commitments and both partial-signature paths, with retained transaction, committee and turn checks. Final independent re-review of the last fixes is pending.
- [Rust output reconstruction](source/native/src/deposit_block.rs), [certificate replay](source/native/src/source_certificate.rs) and [offline observer](source/native/src/deposit_observer.rs): exact block/transaction bytes, selected local/global output index, amount, vault ownership and holder-authorized key image.
- [Fresh admission](source/consumer/freshDepositAdmission.mjs) and [guard join](source/ergo-node/authorized-credit.mjs): OutProofV2, on-chain memo, destination, output state, confirmations, watcher event, payment order and independent Ergo reduction.
- [Permanent ledger](source/guard-service/src/db/moneroCreditAssignment.mjs) and [native contribution gate](source/guard-service/src/deposit/moneroCreditSigner.mjs): full V2 backing retention, output/key-image uniqueness, one-use refresh permits and adjacent local invalidation checks.
- [Executable qualification case](source/consumer/depositAdapter.live.mjs), [six-process fault campaign](source/consumer/processAdapterScenario.mjs) and [reproduction instructions](source/README.md#reproduce-the-deposit-adapter-candidate).

The RCS documentation proposal remains separate from these implementation branches.
The existing CLSAG and Monero transaction-building source remains in the roundtrip
package. The V2 return composes that payment engine with the output-focused
deposit and persistent four-guard custody.

## What the path checks

Discovery parses complete canonical Monero transaction bytes and recognizes only
the configured RMD1 deposit profile. Unsupported on-chain metadata is skipped;
transaction/hash or native-process failures stop capture. A candidate is neither
proof of vault ownership nor authority to credit it.

Admission obtains the exact block packet from the configured daemons, replays a
holder certificate with native wallet view access, verifies the selected output
and payment proof, and checks current inclusion, unspent key image and maturity.
The complete backing descriptor is committed through the existing observation's
origin field. Late evidence retains the original block and height.

Each guard reconstructs that descriptor and the watcher event before accepting the
Ergo transaction. Each secret-bearing contribution refreshes the source again.
The native call consumes one permit for the same retained transaction, then
checks the durable assignment synchronously. Timeout, refusal or invalidation
does not release the economic output or key-image claim.

The retained ledger profile is `single-deposit-v2`, with no implicit V1 migration.
Its V2 return capability binds the four retained guard assignments to one exact
withdrawal reservation. New native authorization requires fresh source and
assignment checks; recovery after source spend can only verify the retained
settlement and existing payment. Older V1 evidence does not establish this join.

## Complete local V2 roundtrip

The [executable return](source/consumer/v2ReturnScenario.mjs) passed in 286.0
seconds including the deposit/credit process campaign. The frozen run verified
449 source files before and after execution: aggregate
`001ed9afe1c82dd7752853c5218246f0c4c48159943eb20c86e03358eaa6491f`,
manifest SHA-256
`36dc2e46000e55a9cc79808e70044e6a034fa7ed486090a5fd4cf966d4acff61`.
It exited zero with unchanged inputs. These are the execution snapshot pins;
the final package also includes the separately checked audit/launcher updates.

| Transition | Isolated-chain transaction ID |
| --- | --- |
| Monero deposit | `f938d77d66a031569cd017ad76d5dd43f7f3f4c64bc42db81818a6bb76a9e5e2` |
| Confirmed Ergo credit | `5dd57432e4fa576dfb6235e31464f4ad5b527a9df763cf67e71697918074d443` |
| Recipient redemption | `73a69ee5fc81ddf024338a553b3045f441873ca9c939ce4b924f63920666e09e` |
| Return watcher trigger | `d875e744e317201b80ccd271917a23af9b9509154420565328d5c4d4b1d250e4` |
| Confirmed Monero payout | `2c045d71f66881fb16c99b75e00fe83a68fecd5b26b63b12a7b43d95b69d31e4` |

Both directions retained two commitment transactions and one reveal. The return
watchers recovered the same event after restart. All four guards checked the
original credited occurrence, actual recipient redemption, return event, complete
withdrawal request and native selection. Two of four Rust holders produced the
native signature. Exactly one signing call and one submission occurred; a lost
submission reply and restart of all four guards recovered the same payment.
The selected deposit output was spent, settlement reached `settled`, and a fresh
authorization after spend was refused. Competing reservations and missing proof
before native approval were also refused. The preceding deposit campaign retained
its eight fault cases and the node-checked, unbroadcast three-of-four trial.

The [withdrawal verifier](source/ergo-node/v2-withdrawal-authority.mjs) checks
canonical signed and unsigned credit bytes against the original assignment,
the unique recipient box, the independently verified return and every request
source field. Its 72 focused tests include separately changed output locators,
destinations, amounts, fees, source fields and rehashed alternative requests.
[Settlement tests](source/guard-service/src/db/moneroCreditSettlementV2.test.mjs)
cover all six immutable reservation fields, exact retries, competing handles,
missing assignments, invalidation, corruption and restart (26 tests).
Fresh and retained source suites pass 80 tests; return/deposit watcher runtime
suites pass 33. The two [async custody regressions](source/consumer/v2AsyncCustody.test.mjs)
execute actual source and detect both delayed one-use reservation and premature
queue release after one guard rejects. Independent reviews of the V2 source,
authority, process, watcher and consumer joins found no unresolved findings.
This does not close the separate final multisig-package review.

Accounting reconciles one operation's selected inputs at redemption, reservation
and settlement. The payout inputs total `35183630595823` atomic units, split
into recipient `500000000`, miner fee `2599200000` and change `35180531395823`.
Outstanding user credit and pending payout are zero. Issued deposit-fee tokens
and retained return fees are `120` each; return rewards remain `pending-reward`.
The network-fee coverage variance is **-2599199960 atomic units**: fixture reserve
inputs subsidize the miner fee. This is not sustainable-fee, global-reserve,
pooled-vault or production-solvency evidence.

The external `v2-return-result.json` has SHA-256
`3ed29d85299834e773495de7ab5275fab007068b6ebc9445bd858b05e1d3edff`;
`process-result.json` has SHA-256
`07fbdca3dca8d63822782515fb0f964363eb7fe0c66dc0ee0a9cd2ac05731559`.
The hashes identify retained local reports, not a public chain explorer or an
independent execution attestation. The [reproduction recipe](source/README.md#complete-the-v2-return)
uses the frozen `v2-roundtrip` launcher profile.

## Validation and current limits

### Output novelty before watcher publication

The [watcher credit view](source/ergo-node/watcher-credit-view.mjs) reads the same
four guard custody databases that later authorize credit. They are provisioned
before watchers start; neither watchers nor restarting guards initialize missing
custody. Each read validates the complete retained ledger and tests the selected
output key and associated key image. Assigned and invalidated claims both refuse
a new observation. The roster, configuration and file identities are bound to
operator configuration, independently of deposit data.

The [watcher participant](source/ergo-node/watcher-runtime.mjs) checks novelty
before retaining an observation, queueing commitment/reveal transactions, and
submitting a pending transaction after an awaited pause. Retained backing is
bound to the exact observation. Queue recovery repeats the check; confirmed-event
recovery instead verifies the exact retained request and backing, confirmed
transaction inputs, immutable output bytes and event registers, returning that
event without a new submission. Node-added spend metadata may change after credit;
the serialized boxes and their computed IDs must remain identical.
The legacy in-process transport refuses V2 proposals.

Watchers retain per-guard revision and state-digest watermarks. An observed
revision decrease, a changed state at the same revision, changed configuration,
missing/corrupt custody or file replacement refuses progress. This is local
continuity evidence, not protection against coordinated rollback of all guard
and watcher stores. Reads do not reserve backing. The existing atomic guard
assignment still decides races between competing proposals.

The focused custody/view/ledger suites pass **53 tests**. The actual pinned
watcher runtime passes **14 tests** with real SQLite and mocked source/node ports,
including claims inserted after observation or during each broadcast pause,
queued restart, exact recovery and altered recovery data. The other affected
watcher/source/recovery/audit/signer suites pass **52 tests**. Independent review
of the integrated novelty delta and legacy V2 refusal found no blocking findings.
Three isolated removals of the observation, pre-broadcast and pre-trigger gates
are detected by the corresponding runtime regressions.

The updated real-node campaign passed in **496.6 seconds** with two watchers,
four guards and two isolated Monero daemons. Its **16 fault cases** include
refusing already-claimed backing before a new watcher event, again after watcher
restart. It confirmed one credit, retained exactly two commitment transactions
and one reveal, and recovered the same credit after all participants restarted.
Three of four guards also produced a transaction accepted by the node's check
endpoint without broadcast. Post-credit proof loss and source disagreement held
progress; an agreed source reorganization quarantined all four assignments while
retaining their claims across restart. The source suffix was restored exactly.

### Earlier qualification runs

The scanner package passes 69 tests, build, type checking and lint. The multisig
package passes 72 tests, build, type checking and lint; 15 targeted mutations of
the checks are detected. The earlier in-process path passed in 103.6 seconds using
the linked scanner and multisig commits. It confirmed one credit, two watcher
commitments and exact credit recovery after restart. Four guard instances made
8, 6, 5 and 6 fresh proof reads respectively in the same JavaScript host.

The same run removed the proof before the first contribution: no guard produced
a commitment or partial signature. Removing it after one commitment preserved
that commitment and produced no partial signature. Both attempts retained their
output/key-image claims across ledger reopen, left the trigger unspent and
created no settlement. Restoring valid evidence allowed the positive case;
replacing it with malformed evidence after credit made a fresh admission read
return `pending`.

The baseline multiprocess campaign passed in 141.0 seconds with six distinct
participant PIDs plus the controller. Each watcher reconstructs the source independently, executes
the pinned commitment/reveal jobs, and owns a durable observation/transaction
queue. Each guard loads its own provisioned key, constructs its own source readers,
and owns its permanent assignment database. Existing authenticated multisig
envelopes pass through a controlled IPC relay.
The final four-guard attempt generated four commitments and three native partial
signatures; all four participants obtained identical signed bytes. Their fresh
proof-read counts were 7, 7, 7 and 6 respectively.

| Local fault or transition | Observed result |
| --- | --- |
| One watcher's proof unavailable | Refused before commitment jobs started. |
| Watcher killed after durable queueing, before broadcast | Restart reused the same signed commitment. |
| Revealing watcher killed after broadcast, before saving confirmation | Restart recovered the same reveal; two commitment transactions and one reveal remained. |
| All signing messages dropped | Timed out with no partial signatures; all four output/key-image claims survived restart. |
| Guard killed before its native partial signature | Attempt stopped after commitments, with zero partials; claims survived restart. |
| One guard's proof unavailable | Refused before any native commitment. |
| Guard config changed to a fresh state directory | Restart refused the changed bytes before creating that directory; restoring the original config reopened the retained claim. |
| One non-coordinator guard offline | The other three completed signing; Ergo's transaction-check endpoint accepted the result without broadcast. |
| Delayed and duplicate relay messages | Four guards completed with identical signed bytes; the node confirmed one credit. |
| All six participants restarted after credit | Same reveal, same confirmed credit and unchanged permanent claims; no new credit submission. |

The process RPC suite passes 13 actual-child tests, including unexpected parent
disconnect with a hung cleanup hook. Participant-config tests pass 2 cases;
watcher runtime tests pass 5; affected credit-source, output-policy and recovery
tests pass 31. Independent review of the new process boundary found and corrected
unbound restart directories and missing shutdown after parent disconnect. That
review does not close the separately pending multisig re-review.

The exercised native executable has SHA-256
`89eeaee45c39ff7a46ece26ab04c5be5709d7d88e4fa9f4e729dd84cb8925067`.
The pinned multisig runtime aggregate and reproduction command are in the
[source instructions](source/README.md#reproduce-the-deposit-adapter-candidate).

| Boundary | Consumer and regression evidence | Consequence of relaxing it |
| --- | --- | --- |
| Canonical block, ordered transactions and selected output | Native reader; [block tests](source/native/src/deposit_block_tests.rs) separately change hashes, height, order, index presence and bounds. | The reported output can refer to different source bytes or an invalid locator. |
| Configured holders and exact output/key image | Native observer; [certificate tests](source/native/src/source_certificate_tests.rs) substitute committee, epoch, output, derived offset, envelopes and DLEQ context. | A supplied certificate can replace configured authority or attest another output. |
| Proof, intent, destination, source state and maturity | Observation admission; [admission tests](source/consumer/freshDepositAdmission.test.mjs) isolate changed proof/output/destination, spent image, confirmations and source anchoring. | A valid component can be reused for an unrelated or stale credit. |
| Stable watcher descriptor and configured reader identities | Guard transaction verification; [source tests](source/ergo-node/fresh-credit-source.test.mjs) change namespace, backing, reader array, method and scope. | Awaited work can install a different source authority or signing obligation. |
| Permanent economic claims | Signing and restart; [V2 ledger tests](source/guard-service/src/db/moneroCreditAssignmentV2.test.mjs) cover every retained descriptor field, output/key-image conflicts and atomic refusal. | Another transaction occurrence or failed attempt can release already assigned backing. |
| Fresh native contribution permission | Native signer; [fresh signer tests](source/guard-service/src/deposit/moneroCreditSignerFresh.test.mjs) cover missing/reused permits, removed proof, changed assignment and local invalidation. The live case exercises both proof-removal timings with the real multisig package. | Queueing or an earlier successful check can authorize a later contribution without current evidence. |
| Process/config identity and retained custody | [Config pins](source/tools/participant-config.mjs), child handshake and live changed-directory regression bind exact config bytes and resolved store path. | Restart can silently select an empty ledger. |
| Bounded IPC lifecycle | [Process RPC tests](source/tools/process-rpc.test.mjs) exercise deadlines, crashes, disconnect, duplicate identifiers and message bounds; the live campaign drops and duplicates real envelopes. | Failed sessions can leave active children or unbounded requests. |
| Exact V2 credit, return and native occurrence | [Withdrawal authority tests](source/ergo-node/v2-withdrawal-authority.test.mjs) mutate the credit, every event/request field and selected output independently, including coherent alternative digests. | Another credit, recipient or output can authorize the payout. |
| Permanent single settlement | [V2 settlement tests](source/guard-service/src/db/moneroCreditSettlementV2.test.mjs) isolate every tuple field and reopen/failure branch; the real campaign rejects a competing reservation. | Retry or restart can create another withdrawal against the same claim. |
| Asynchronous authority lifetime | [Actual-source race tests](source/consumer/v2AsyncCustody.test.mjs) detect both ordering mutants; native I/O consumers await fresh authority. | Two attempts enter one-use state, or a retry overlaps unfinished guard checks. |
| Retained recovery after payout | The real V2 campaign restarts four guards, recovers the existing payment and refuses fresh authorization after spend. Journal and authority tests cover immutable identity and retained-only observation. | A recovery exception can become authority for a new payment or block recovery of an already submitted one. |

| Evidence dimension | Status |
| --- | --- |
| Implementation | `focused_green`: the composed local path and focused negative cases pass. |
| Independent review | `pending`: component reviews completed; final multisig fixes require re-review. |
| CI | `not_run` for this composition. |
| Target runtime | Isolated-node path `verified`; production service deployment `not_run`. |
| Readiness claim | `draft_review`. |

The integration uses two separate local Monero databases with real block/transaction
replication and no public peers. It does not establish independent administration.
The watcher executes pinned upstream jobs with configured node/database ports;
the multiprocess campaign separates actor lifetimes, source readers and stores,
but does not deploy an autonomous watcher service. Processes share one OS account
and filesystem; fixture provisioning and the relay are controlled by the parent.
No production CI result or
deployment approval is claimed. Exact tested source files are bound by
`source/source-manifest.json`; executable hashes identify the exercised build,
not a reproducible-build attestation.

The native replay profile uses a two-of-four holder committee, standard
mainnet-format vault addresses, one ordinary owned output per selected transaction
and no additional timelock. It permits a 16 MiB packet and a 64 KiB retained
certificate; the certificate's embedded transaction is a tighter deposit limit
than the discovery parser's 1 MiB transaction bound. The integration destination
is Ergo testnet/devnet with fixture assets.

## Source continuity and post-credit quarantine

The optional `sourceResilience` qualification first exercises proof-delivery
retries across database reopening, two-daemon disagreement, pending/accepted
candidate rollback and exact block restoration in the controller. The six-process
campaign then injects disagreement and agreed replacement before watcher and
guard commitments, and disagreement after signing before submission.

The extended campaign passed in 445.0 seconds. It exercised 15 process/source
fault cases and ten replacement/restoration cycles over a 63-block suffix,
starting from a deposit at height 97 and restoring the exact original tip at 159.
The proof was unavailable for 10.126 seconds across five attempts and one database
reopen. Orphaned candidates could not be claimed; restoration readmitted exactly
one observation. The final signing attempt produced four commitments and three
partial signatures, with identical signed bytes at all four guards. Exactly one
credit was confirmed and retained through restart.

| Additional source transition | Observed result |
| --- | --- |
| Daemons disagree or agree on a replacement before watcher/guard commitments | Refused before the respective commitment jobs or native contributions; existing claims retained. |
| Daemons disagree after signing | Final source verification refused before submission; restoration allowed the positive credit. |
| One guard's proof disappears after credit | That guard reports `held`; the other three report `checked`; custody is unchanged. |
| Daemons disagree after credit | All four report `held`; custody is unchanged. |
| Daemons agree that the credited deposit block was replaced | All four claims become invalidated, retaining output/key-image reservations and the confirmed Ergo credit. |
| Original branch restored, then all guards restarted | All four remain quarantined; no automatic reactivation or new contribution. |
| Audit attempted during signing, or signing/another audit during an audit | Refused at the committee boundary. |

The new [backing audit](source/ergo-node/credit-backing-audit.mjs) operates on an
existing exact V2 claim. Each guard reads the selected height through its own
configured source connection. Unavailable evidence or disagreement returns
`held` without changing custody. An agreed different block hash permanently
invalidates the local claim; its output/key-image reservations and the confirmed
Ergo credit remain. Restoring the original source does not reactivate the claim.
A matching anchor still requires exact fresh backing reconstruction.

Audit and signing exclude each other in both directions. The returned status
and claim derive from one final custody observation. Independent review caught
both the inconsistent double-read result and the initially incomplete exclusion.
The audit suite passes 13 tests, and four isolated mutations are detected:
removing invalidation, the final observation, the anchor comparison or the
backing comparison. The affected source/output/recovery suites total 44 passing
tests. A primary-context audit also reran all 72 multisig tests successfully;
that does not replace its pending independent re-review.

The source check is explicitly invoked. It is not an autonomous monitoring
service, an atomic action across four ledgers, an on-chain revocation, or a
global vault halt. Guard startup now opens the exact retained custody without
creating a fresh admission verifier. Terminal invalidation can be reported without
proof reads; new signing and withdrawal authorization still require fresh source
verification. Opening a service does not establish source health or eligibility.
The experiment uses equal-height replacement branches under one operator and
does not establish general reorg handling, finality or independent administration.

The post-V2 regression passed in 468.3 seconds of test execution with all 16
process/source fault cases, ten replacement/restoration cycles and unchanged
frozen inputs. All four quarantined assignments survived restart; terminal audit
performed no additional proof reads. Source aggregate:
`2e16f27f3db02b7b42954be22f5e14cc5f976fac22632d11d26a42d9a771784d`;
manifest SHA-256:
`8a6222e76d3be8d1bbd2d6d452e5e8960ea6d18b3f96b736c1dabd0bdb29898e`.
Its external `process-result.json` hashes to
`73385637c7d79b6488c7dd8a9ae9769400dec052222bfe95142d851bb1153704`.
The final source manifest additionally includes the reproduction-document update;
the runtime files match this regression snapshot.

## Remaining production gates

| Gate | Evidence still required |
| --- | --- |
| Final review | Independent re-review of the last multisig turn, communication-key and rejection-handling fixes; maintainer review of the selected integration profile. |
| Persistent custody | Production holder enrollment, epoch/view-key custody, certificate production, backup/restore and rotation with rollback protection. Certificate export currently starts from the controlled participant fixture. |
| Deployment integration | Full watcher and guard service processes using a chosen production network/asset profile and independently administered Monero sources. |
| Recovery and operations | Deep source reorg handling after credit, old-backup recovery, delayed/expired or malformed deposits, monitored candidate retention and an operator recovery procedure. |
| Capacity and delivery | Representative historical catch-up and sustained-load tests, evidence availability and retention, certificate-size policy, OS-level custody isolation and protected executable custody. |
| Payout economics and rewards | A funded fee policy and reusable vault lifecycle, reserve-wide reconciliation, fee-token redemption and return reward distribution. The local V2 payment uses subsidized fixture reserves. |

The six-process campaign now covers these bounded source replacements and
delivery retries. Longer outages, retention under load, old-backup recovery and
operational handling of an already issued credit remain separate work.
Production qualification additionally needs persistent holder identities,
certificate delivery and independently administered source endpoints; the selected
services must replay these credit/refusal/recovery criteria.
Coordinated rollback of every guard and watcher store remains outside local
rollback detection, and a
crash during first-time custody initialization may require operator recovery.
