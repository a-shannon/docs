# Monero deposit adapter: qualification evidence

A. Shannon · 18 September 2026

The deposit path now connects real isolated Monero transactions to Rosen scanner
observations, actual watcher commitment/reveal transactions, and four fresh guard
verifiers signing an Ergo credit. The local multiprocess campaign runs two
watcher processes and four guard processes with individual persistent stores.
The source is public and executable.
**Production qualification remains open.** The test hosts, custody bootstrap and
deployment profile are controlled fixtures.

## Review the code

- [Scanner and native reader](https://github.com/a-shannon/scanner/tree/2e0382d97a6e0a7bb6fb0e5927ad56af44d2f0ae/packages/observation-extractors/monero-observation-extractor): durable capture, separate admission leases, daemon agreement, original block anchoring and bounded native replay.
- [Optional multisig authorization hook](https://github.com/a-shannon/sign-protocols/commit/fd41b5df91d79bc0fc74373a397372edfd3efa84): revalidation before commitments and both partial-signature paths, with retained transaction, committee and turn checks. Final independent re-review of the last fixes is pending.
- [Rust output reconstruction](source/native/src/deposit_block.rs), [certificate replay](source/native/src/source_certificate.rs) and [offline observer](source/native/src/deposit_observer.rs): exact block/transaction bytes, selected local/global output index, amount, vault ownership and holder-authorized key image.
- [Fresh admission](source/consumer/freshDepositAdmission.mjs) and [guard join](source/ergo-node/authorized-credit.mjs): OutProofV2, on-chain memo, destination, output state, confirmations, watcher event, payment order and independent Ergo reduction.
- [Permanent ledger](source/guard-service/src/db/moneroCreditAssignment.mjs) and [native contribution gate](source/guard-service/src/deposit/moneroCreditSigner.mjs): full V2 backing retention, output/key-image uniqueness, one-use refresh permits and adjacent local invalidation checks.
- [Executable qualification case](source/consumer/depositAdapter.live.mjs), [six-process fault campaign](source/consumer/processAdapterScenario.mjs) and [reproduction instructions](source/README.md#reproduce-the-deposit-adapter-candidate).

The RCS documentation proposal remains separate from these implementation branches.
The existing CLSAG and Monero transaction-building source remains in the roundtrip
package; this increment changes deposit admission and the Ergo credit boundary.

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

The fresh ledger profile is `single-deposit-v2`. It has no implicit V1 migration
and refuses withdrawal settlement methods. The older roundtrip's withdrawal
evidence does not qualify a V2 payout path.

## Validation and current limits

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

The final multiprocess campaign passed in 141.0 seconds with six distinct
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

## Gates before production qualification

| Gate | Evidence still required |
| --- | --- |
| Final review | Independent re-review of the last multisig turn, communication-key and rejection-handling fixes; maintainer review of the selected integration profile. |
| Persistent custody | Production holder enrollment, epoch/view-key custody, certificate production, backup/restore and rotation with rollback protection. Certificate export currently starts from the controlled participant fixture. |
| Deployment integration | Full watcher and guard service processes using a chosen production network/asset profile and independently administered Monero sources. |
| Recovery and operations | Deep source reorg handling after credit, old-backup recovery, delayed/expired or malformed deposits, monitored candidate retention and an operator recovery procedure. |
| Capacity and delivery | Representative historical catch-up and sustained-load tests, evidence availability and retention, certificate-size policy, OS-level custody isolation and protected executable custody. |

The six-process campaign closes a useful local integration step. Further local
work can exercise source reorgs, delivery retention and load before selecting the
production hosts. Production qualification additionally needs persistent holder
identities, certificate delivery and independently administered source endpoints;
the selected services must replay these credit/refusal/recovery criteria.
Valid old database snapshots remain outside local rollback detection, and a
crash during first-time custody initialization may require operator recovery.
