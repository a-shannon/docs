# Explicit Monero output and intent agreement

A. Shannon · 17 September 2026

In the pinned local experiment, the watcher observation commits the authenticated Monero output backing and
complete deposit intent through Rosen's existing event origin field. This makes
the intended agreement explicit without changing the generic register format,
raw transaction ID, request ID, or the one-output deposit profile.

This is a prospective agreement hardening. The investigation did not demonstrate
two different natively admissible outputs under the existing single-output
scanner policy. The previous projection did omit the complete intent, including
its expiry. Pure structural fixtures distinguish that omission from a working
native deposit or a demonstrated exploit.

## Producer and consumers

[`moneroCreditOrigin`](source/consumer/authenticatedDepositSource.mjs) requires a
registered, unchanged authenticated source. It compares every semantic field of
the independently recomputed decision with that source's decision, allowing only
reader-local verifier names to differ. Missing or additional semantic fields are
rejected.

The resulting `rosen-monero-output:v1:<sha256>` descriptor hashes the existing
typed canonical representation of the domain, version, source network and
immutable backing. The backing contains chain genesis, vault spend key/address,
intent hash, txid, local and global output indices, one-time output key,
associated key image, amount, destination network/asset/recipient and credited
amount. Local snapshot handles and reader names do not belong in shared
agreement; each reader still verifies current inclusion, confirmations, proof
and unspent state independently.

[`creditObservation`](source/ergo-node/authorized-credit.mjs) places the descriptor
in `fromAddress`. The pinned Rosen watcher commitment and EventTrigger writer
retain it. Each local credit-guard instance recomputes it from the source and compares it with
both the watcher observation and the decoded trigger before signing. The
descriptor is not a sendable address and does not support generic address-based
refunds.

| Invariant | Producer and consumer | Failure if relaxed | Focused evidence |
| --- | --- | --- | --- |
| Decision matches its authenticated source | Registered source and exact semantic comparison → watcher/guard observation | A separately supplied candidate could substitute amount, destination, output or intent while reusing the source | Every candidate field, missing/extra field, unregistered source and changed intent buffer are rejected independently |
| Shared origin includes backing and full intent | Typed canonical preimage → watcher commitment | Different selected backing, image or intent could receive the same observation origin | Coherent structural changes to local index, output key, global index, image, expiry and recipient change the origin |
| Equal facts are independent of local reader identity | Stable backing → independently reconstructed observations | Correct readers could disagree solely because of their names or local snapshot handles | Equal registered sources with different reader names/snapshot handles agree |
| Watcher commitment binds the descriptor | Actual pinned commitment checker → reveal | A commitment to one origin could authorize another | Legacy and changed descriptors fail while the matching descriptor succeeds |
| Trigger decoding preserves the descriptor | Actual pinned trigger writer and extractor → shared guard predicate | An output commitment could disappear or move during register serialization | A one-field R5[3] mutation changes only the decoded origin and is rejected by the shared guard predicate; each of its 14 compared fields is also mutated separately |
| Guard checks the source again | Fresh proof/native source checks → observation equality → signing | An altered observation could reach signing | Actual-node profile rejects legacy and changed origins at `Guard source event agreement`, before any guard commitment |

The extractor negative exercises the pinned writer and decoder directly and
calls [`verifyCreditEvent`](source/ergo-node/credit-event-policy.mjs), the same
function invoked by the local guard. It does not submit a forged trigger
transaction or independently exercise the whole guard call with that mutation.
The actual profile separately exercises guard rejection of altered observation
origins. The guard's invocation of this function was source-reviewed; removing
that invocation is not covered by the isolated predicate test.

## Retained source and accounting protections

The local source profile uses the Rust wallet to scan the intended transaction
and requires exactly one unlocked vault output. This is a restriction of this
profile, not a general restriction of the Rust wallet. The Core `wallet2` helper
creates and verifies `OutProofV2` against the transaction, vault and complete intent;
that transaction-level proof is composed with the independently reconstructed
output receipt. Original-holder DLEQ checks bind the associated key image to the
selected output before the daemon's unspent answer is used.

The [authenticated backing policy](admission-backing.md) and
[copy-first regression](copy-first-reproduction.md) remain applicable. The ledger
keeps economic uniqueness by output key and associated image across txids.
Restart does not erase a confirmed credit, and controlled removal of its backing
block quarantines the retained liability. The descriptor does not replace these
checks or establish coverage of every historical burn scenario.

The raw and decodable copy fixtures are two forms of copied-output behavior,
not two distinct historical incidents. Monero's
[2018 review](https://www.getmonero.org/2019/02/12/2018-year-in-review.html)
distinguishes the repeated-transaction-public-key multiple-counting bug from
the [burning bug](https://www.getmonero.org/2018/09/25/a-post-mortum-of-the-burning-bug.html).
The copied-output fixtures do not reproduce that separate multiple-counting
case or establish complete coverage of historical client vulnerabilities.

## Validation

The post-publication audit found that the original decoder negative repeated an
assertion inside the test instead of calling the guard's comparison. The
comparison already existed in the guard; the defect was regression coverage.
It is now shared with the test without changing its acceptance conditions.
A deliberate removal of its `fromAddress` check makes the corrected test fail.

The focused suite passes 16 tests with no skips, including the actual pinned
Rosen commitment checker and trigger writer/extractor. Five deliberate mutants
are rejected at the intended tests. The earlier results for constant origin,
omitted intent hash, omitted associated image and removed candidate comparison
remain applicable to their unchanged source and tests. The fifth removes the
origin comparison from the shared guard predicate and was run against this
corrected candidate. The source diff received an independent implementation
review; no blocking source defect was found in the final correction.

Corrected candidate: 398 source files, aggregate SHA-256
`e563554df703006f2eb78246d47725c6f460ccc6301290fa230ce0f5846a52b6`;
`source-manifest.json` SHA-256
`39b21829f2f30568ab361055f2bbd298c3451100edd741c00edae9c5d62bcad2`.
The [source README](source/README.md) gives the aggregate recipe and prepared
dependency, executable and configuration requirements.

All three actual-node profiles were rerun successfully against this corrected
398-file candidate. Each execution exited with code zero and passed its
declared-input postcheck:

| Profile | Result | Declared inputs after execution |
| --- | --- | --- |
| Raw copied output before the intended deposit | Complete watcher/credit/return/payout flow passed; both incorrect observation origins refused before signing; retained recovery and rollback quarantine passed | Unchanged |
| Decodable copied output before the intended deposit | Same complete flow and origin refusals passed with the decodable copy | Unchanged |
| Two-operation economic reconciliation | Two overlapping obligations credited and settled; 13 ordered accounting checkpoints; no outstanding user amount or pending payout at completion | Unchanged |

The corresponding execution IDs are `292bb80c-7315-4b4b-8d41-1a0f4ac7ef1a`
(raw copy), `90aa8bc1-54bd-4779-9148-2d5087fb6182` (decodable copy), and
`5ddb42e0-f270-4601-9b21-a3d9c80a8608` (economic reconciliation).

The economic run paid `1000000000` atomic units to recipients against
`1000000480` deposited units. Miner fees were separately funded from the selected
fixture reserve; fee coverage remained negative. Passing the accounting checks
does not establish self-financing fee policy.

An earlier attempt stopped before Monero startup with `spawn UNKNOWN` and failed
its post-run input check; it is not passing evidence. A restored daemon was
subsequently matched byte-for-byte to the official GPG-authenticated Monero
0.18.5.1 archive before the successful reruns.

The experiment uses isolated fakechain/devnet nodes and fixture assets. Native
source and executable inputs are unchanged from the preceding qualified build.
There is no new native build, CI result, independent-operator reproduction or
production deployment claim in this increment.
