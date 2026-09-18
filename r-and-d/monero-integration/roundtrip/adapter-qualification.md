# Monero V2 adapter: local roundtrip qualification

A. Shannon · 18 September 2026

The V2 path connects a real isolated Monero deposit to Rosen scanner observations,
watcher commitment/reveal transactions, a four-guard Ergo credit, redemption of
that exact credit, a confirmed native Monero payout and Ergo reward distribution. Two watcher processes
run in each direction; four guard processes retain individual custody stores.
The complete local roundtrip, lost-reply recovery and post-payout guard restart
pass. The source is public and executable.
**Production qualification remains open.** The test hosts, custody bootstrap and
deployment profile are controlled fixtures.

## Review the code

- [Historical failure coverage](burn-coverage.md): separate repeated-primary, additional-key and duplicated-backing regressions, with their evidence limits.
- [Multisig review packet](multisig-review.md): exact five-file candidate diff, authorization points and focused replay commands.
- [Scanner and native reader](https://github.com/a-shannon/scanner/tree/2e0382d97a6e0a7bb6fb0e5927ad56af44d2f0ae/packages/observation-extractors/monero-observation-extractor): durable capture, separate admission leases, daemon agreement, original block anchoring and bounded native replay.
- [Optional multisig authorization hook](https://github.com/a-shannon/sign-protocols/commit/2fdaf3af3897d9c2b1c7e5e6c7d57d0415d808b0): revalidation before commitments and both partial-signature paths, with retained transaction, committee and turn checks. Independent local review is complete; see the packet for the concurrent-commitment correction and limits.
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

The retained ledger profile is `single-deposit-v2`, now using schema 3 for atomic
reward custody. Older schemas are refused without implicit migration.
Its V2 return capability binds the four retained guard assignments to one exact
withdrawal reservation. New native authorization requires fresh source and
assignment checks; recovery after source spend can only verify the retained
settlement and existing payment. Older V1 evidence does not establish this join.

## Complete local V2 roundtrip

The current path adds independently reconstructed fees, actual reward distribution
and completed Rosen transaction/event state. The main integration test passed in
320.6 seconds (325.2 seconds for the test runner), with 468 frozen source files (aggregate
`822dd3b0db9ea76d93320b3fb5c0177d854842e7a665f5948f525ff8d6068568`,
manifest SHA-256
`da0e4cacd0bba8455461850d1324d0efc02f80fbd3f680996e7247335b570dbd`).
The external runtime closure is
`79efb8cb78fc38d5239d8768ee4f98ecc2bc5552ced827d26161401f9374dad2`;
the launcher verified that the declared source and external inputs stayed unchanged
through execution (exit code 0).

| Transition | Isolated-chain transaction ID |
| --- | --- |
| Monero deposit | `e80ac95c3cadcfc721d56dbb667518c2ff76dab5b2b90b3d5eece4b38fdcda4f` |
| Confirmed Ergo credit | `685824fc5e1d39bc864249270d8551caaa42c1599a871b39fc58350fc743f820` |
| Recipient redemption | `406a7ee32d5bd1b3bd031600ec118eb32cdcf16f056b894971a33c00530188cb` |
| Return watcher trigger | `9b27a347fb6e2f506eb97c846d0f4d0cdd56b9c55e7278c1ff0b3978f8e44136` |
| Confirmed Monero payout | `21369cf7c51dd43ce9e915603ad4d028fd74c3f1ded24935a8daa19f234f86c5` |
| Confirmed Ergo reward | `c82d35fea873d456e33961a329fb1478d030ca62003b6b0b53ebced122af7bcb` |

The native payout and Ergo reward each require one signing call and one
submission. Lost submission replies are recovered; all four guards restart and
retain the same assignments. Confirmed reward recovery uses identical signed
bytes and never signs again. The actual Rosen TransactionProcessor records both
transaction and event as `completed`, including idempotent replay.

The configured minimum-fee NFT and asset select a canonical unspent fee box.
Complete successful pagination is required before uniqueness can be inferred.
New withdrawal approval binds the historical row and effective charges. This run
charges a proportional bridge fee of `50000`, above the configured minimum `101`,
plus network fee `21`, and pays `499950099` atomic units to the recipient.
Underquoted deposits refuse without changing their authenticated intent.
Reward recovery preserves the retained terms and accepts fee-box succession
only when the same historical policy remains valid; succession is covered by
focused tests, not a live rotation campaign.

Reward construction uses the actual EventOrder, ErgoChain and native Ergo
reduction. All guards recheck the same return/withdrawal and confirmed Monero
payment before reserving reward custody. Schema-3 SQLite stores the reward row
and settlement marker atomically. Missing rows, conflicting assignments,
invalidation and reopening fail closed. Unconfirmed recovery refreshes payment
evidence and checks custody adjacent to transmission. Confirmed recovery checks
canonical transaction bytes and retained assignments without rebuilding a payout.

Focused evidence: 47 fee-reader cases; 42 deposit-source cases; 111 fee/withdrawal/
reward-authority cases; 88 affected ledger/consumer cases; 26 reward-settlement
cases; two asynchronous custody regressions; 14 actual lifecycle/SQLite cases;
16 economic cases. These groups overlap and are not an additive test total.
Independent reviews closed the fee, custody, settlement and lifecycle changes.
An additional 65-case fee closure includes the real-selector regression for
fixture funding: registered fee-policy boxes are excluded from both funding
discovery routes, and insufficient ordinary funds refuse. The final run retained
the fee box and all six registers through deployment on the reused devnet.

Accounting now reaches `rewarded`: return fee tokens issued `50021`, retained
return fees `0`, deposit fee tokens issued `120`, outstanding user credit and
pending payout both `0`. Distribution leaves the fee backing requirement at
`50141`; issuing tokens does not extinguish their liability. Miner fees remain
`2599200000`; the network-fee coverage variance is **-2599199959 atomic units**.
This is one operation's selected-input accounting, with subsidized fixture
reserves, not pooled-vault solvency or sustainable fee pricing.

The final run's retained `v2-return-result.json` SHA-256 is
`8b6eded5d2a5193c8f9a1fd28a419e2da3ad8081cfa184bae380801ee39478ba`;
`process-result.json` SHA-256 is
`184dcfb7327718998e0c1dae2ef01e78b6448de656303799e157d4f6c669ec8d`.
These identify local execution reports, not an independent execution attestation.

### Historical payout-only campaign

The earlier 286.0-second campaign confirmed the payout and recovered its lost
reply, but left rewards at `pending-reward`. Its 449-file source aggregate was
`001ed9afe1c82dd7752853c5218246f0c4c48159943eb20c86e03358eaa6491f`.
[The frozen report](https://github.com/a-shannon/docs/blob/f5b41ca7b65caec0d0afd8ef916d86d23a617970/r-and-d/monero-integration/roundtrip/adapter-qualification.md#complete-local-v2-roundtrip)
retains its transaction IDs, manifest, receipt hashes and test counts. It is
historical evidence for payout recovery, not reward completion.

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
review was separate from the subsequently completed multisig re-review.

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
| Complete fee authority and effective charges | [Fee reader](source/ergo-node/minimum-fee-authority.test.mjs), [deposit admission](source/ergo-node/process-source-fees.test.mjs) and [withdrawal tests](source/ergo-node/v2-withdrawal-authority.test.mjs) isolate pagination failure, NFT/asset/script, canonical inclusion, activation boundary, policy and effective amount; the live run exercises the proportional branch. | Partial enumeration can falsely establish uniqueness, or signed amounts can omit required charges. |
| Fixture funding preserves protocol state | [Actual selector regression](source/ergo-node/funding-candidates.test.mjs) places registered fee state before ordinary funds, tests each register and malformed maps, and refuses an ordinary-fund shortage. Both candidate discovery routes apply the filter. | A shared funding address/token can cause setup to spend the fee-policy box and strip its registers. |
| Payment-to-return binding and permanent reward custody | [Reward contribution](source/ergo-node/reward-contribution.test.mjs) and [SQLite reward tests](source/guard-service/src/db/moneroCreditRewardV2.test.mjs) reject another return's payment, each changed assignment field, deleted/orphaned rows and failed atomic writes. | A valid payout can justify unrelated rewards or a missing journal can permit another distribution. |
| Exact reward and fresh recovery | [Builder](source/ergo-node/return-reward.test.mjs), [payment authority](source/ergo-node/reward-payment-authority.test.mjs) and [settlement tests](source/ergo-node/reward-settlement.test.mjs) isolate output order/conservation, policy succession, payment identity/currentness, signed-byte changes and invalidation during awaited node checks. | Recovery can change recipients, rely on stale payment evidence or broadcast after authority was revoked. |
| Confirmed lifecycle and fee-token liability | [Actual processor tests](source/consumer/rewardLifecycle.spec.ts) interrupt each durable write and reorg branch; [accounting tests](source/consumer/economicReconciliation.test.mjs) reject status-only completion, receipt splicing and duplicate reward use. | Partial DB updates can remain unrecoverable, or fee-token issuance can incorrectly erase backing obligations. |
| Declared runtime dependency closure | [External adapter tests](source/tools/external-adapter-inputs.test.mjs) and [launcher guards](source/tools/launcher-guards.test.mjs) change direct files, installed scanner/TypeScript/contribution dependencies, file sets, nested resolution and workspace junctions. Source commits, installed bytes and runtime output separation are checked independently. | An unchanged-input receipt can omit changed code that actually executes. |

| Evidence dimension | Status |
| --- | --- |
| Implementation | `focused_green`: the composed local path and focused negative cases pass. |
| Independent review | `complete` for the local component, multisig and launcher changes; Rosen acceptance and any commissioned cryptographic audit remain separate. |
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

The final launcher regression passes 37 tests. Its declared external input set
contains 39,764 unique files, including the 14 direct adapter runtime files and
installed dependency graphs (scanner: 256 packages; Rosen: 601 packages), plus
tracked locks and metadata. Comparison against 3,836 distinct external module
loads from the preceding behavioral campaign found no missing file. This is a
profile-specific declaration, not discovery of every possible future code path.
It includes CommonJS dependency trees and the TypeScript loader; operating-system
shared libraries remain environmental inputs. The clean public scanner and
sign-protocols builds, with Node 24.13.1 and npm 11.6.2, and the scanner's 12
SQLite-store tests also pass. The reproduction recipe fixes LF checkout because
inline source-map contents affect the multisig runtime hash.
Compiled dependencies are stored outside the source package but remain bound
execution inputs for these adapter profiles.

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
that was not a substitute for the subsequently completed independent re-review.

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
That historical publication also included a reproduction-document update; its
runtime files matched this source-resilience snapshot. Fee/reward changes in the
current candidate have their separate qualification above.

## Remaining production gates

| Gate | Evidence still required |
| --- | --- |
| RCS acceptance and final review | Rosen review and acceptance of the integration document, selected origin/proof/fee profile, and implementation; any independently commissioned cryptographic review. The local multisig implementation review is complete. |
| Persistent custody | Production holder enrollment, epoch/view-key custody, certificate production, backup/restore and rotation with rollback protection. Certificate export currently starts from the controlled participant fixture. |
| Deployment integration | Full watcher and guard service processes using a chosen production network/asset profile and independently administered Monero sources. |
| Recovery and operations | Deep source reorg handling after credit, old-backup recovery, delayed/expired or malformed deposits, monitored candidate retention and an operator recovery procedure. |
| Capacity and delivery | Representative historical catch-up and sustained-load tests, evidence availability and retention, certificate-size policy, OS-level custody isolation and protected executable custody. |
| Payout economics and rewards | A funded fee policy and reusable vault lifecycle, reserve-wide reconciliation and fee-token redemption. Return reward distribution passes locally with two merged watchers and zero RSN ratio; other reward profiles remain unqualified. The local V2 payment uses subsidized fixture reserves. |

The six-process campaign now covers these bounded source replacements and
delivery retries. Longer outages, retention under load, old-backup recovery and
operational handling of an already issued credit remain separate work.
Production qualification additionally needs persistent holder identities,
certificate delivery and independently administered source endpoints; the selected
services must replay these credit/refusal/recovery criteria.
Coordinated rollback of every guard and watcher store remains outside local
rollback detection, and a
crash during first-time custody initialization may require operator recovery.
