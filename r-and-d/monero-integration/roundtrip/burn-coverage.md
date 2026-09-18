# Historical Monero failures: regression coverage

A. Shannon · 18 September 2026

The two reported incidents require three distinct mechanism checks. The current
Rust scanner and V2 credit ledger pass the bounded regressions below. The
historical-mechanism increment added tests without changing the runtime or
dependency. A subsequent watcher change adds credit-ledger novelty before event
publication, as described below. These checks do not replay either historical vulnerable wallet or establish
that every historical failure is covered in production.

## Mechanisms and source fixes

| Incident / mechanism | Failure and historical repair | Current invariant |
| --- | --- | --- |
| Multiple counting: repeated primary transaction key | Repeated scanning could duplicate a payment report. The first fix deduplicated primary keys: [58cceaad](https://github.com/monero-project/monero/commit/58cceaad7102c8e1c7130c47fa22cdb50eab97e8). | Each local transaction output contributes at most one receipt and its amount once. |
| Multiple counting: additional-key variant | A distinct dummy primary, valid indexed additional keys and the genuine primary bypassed primary-key deduplication. The later fix tracked already-found outputs: [58f28cad](https://github.com/monero-project/monero/commit/58f28cadf8318d7a0e0e8fd85f257acfef34f62e). | Deduplication must apply to the output across derivation paths, not merely equal transaction public keys. |
| Burning: repeated one-time output key across transactions | Several occurrences can represent the same spending key and key image. Treating each occurrence as new backing overstates spendable funds. The wallet receipt/accounting fix is [e350cc5a](https://github.com/monero-project/monero/commit/e350cc5ad557eba67790551f96bbbcfc97173480). | A new txid, occurrence or reported amount cannot create a second credit against an already claimed output key or associated image. |

Primary accounts: [Monero's multiple-counting postmortem](https://www.getmonero.org/2018/09/05/a-post-mortum-of-the-multiple-counting-bug-2018-09-05.html),
[disclosed additional-key report](https://hackerone.com/reports/379049), and
[burning postmortem](https://www.getmonero.org/2018/09/25/a-post-mortum-of-the-burning-bug.html).
Multiple counting affected payment reporting even when the wallet balance was
correct. Balance agreement alone is therefore an insufficient bridge check.

## What is executed

| Boundary and actual consumer | Positive control and negative/discriminating case | Evidence limit |
| --- | --- | --- |
| [`monero-wallet 0.2.0` scanner](../scanner-regression/src/lib.rs) | Six tests: one/two distinct equal-value outputs, repeated primary, genuine additional-only, and combined distinct-primary/additional layouts. Amount, output key and local/global indexes must match the baseline. | Pruned projections with synthetic hash/index anchors; no daemon acceptance. |
| [Native block scan](source/native/src/deposit_block.rs) → [observer and certificate replay](source/native/src/deposit_observer_tests.rs) | Each of the three varied key layouts admits one owned output with exact identity and amount; all layouts refuse two owned outputs under this profile. The certificate is rebuilt against the varied transaction and block bytes. | Complete serialized transaction/block parsing and genuine local holder certificates. Transaction extra is changed after signing; these transactions are not consensus-validity evidence. |
| [Fresh proof/receipt admission](source/consumer/freshDepositAdmission.test.mjs) → existing deposit policy | A payment report of 20,000 against the independently reported 10,000 output is refused. Restoring 10,000 admits exactly 9,880 after the fixture's 120 fees. | Real admission/policy functions with mocked native, daemon and proof ports; no cryptographic proof claim. |
| [V2 durable assignment](source/guard-service/src/db/moneroCreditAssignmentV2.test.mjs) | Later occurrences with the same output/image and amounts 500, 1,000 or 1,500 conflict with the retained 1,000 deposit, including after restart and invalidation. Each later descriptor is accepted in an empty control ledger. Existing tests isolate output-key and image uniqueness independently. | Actual SQLite custody and immutable claims; ownership, image association and source freshness remain caller prerequisites. |
| [Watcher novelty](source/ergo-node/watcher-novelty-runtime.test.mjs) → actual commitment/reveal jobs | Already claimed backing refuses observation; claims inserted after observation or during either broadcast pause stop publication. Queued restart repeats the check, while exact confirmed-event recovery returns the retained event. | Read-only local views of all four existing guard ledgers; atomic guard assignment still decides subsequent races. Production credit-state delivery remains an integration boundary. |

The scanner's additional-only control contains no genuine primary key. It forces
the indexed additional derivation; placing additional keys earlier in serialized
extra would not by itself force that path in the Rust implementation. Native
fixtures index additional keys over every transaction output, including change.

The bridge deliberately refuses a second obligation against claimed backing,
including a larger subsequent reported amount. This is stricter than adopting
wallet replacement-accounting behavior. An invalidated credit retains both its
economic claims and the existing destination liability.

The earlier admission helper alone did not consult credit custody: uniqueness
was checked by guards. The multiprocess watcher now performs that check before
event publication as well. Rust scanning, output/proof/intent association,
daemon unspent state and confirmations remain source-admission checks; guards
reconstruct the same committed output descriptor and repeat fresh verification.
See [the qualification report](adapter-qualification.md#output-novelty-before-watcher-publication)
for the implemented read-only view, retry behavior and validation limits.

Two scratch dependency mutations demonstrate sensitivity. Removing the scanner's
matched-output `break` causes three failures, with three controls passing.
Replacing it with primary-key-only deduplication leaves five tests passing but
fails the additional-key variant. The former four-test suite would miss that
replacement. See the [mutation recipe](../scanner-regression/README.md#historical-mechanism-coverage).

## Reproduction and results

Use the [prepared source dependencies](source/README.md). Keep Cargo build output
outside synchronized source directories. From each indicated directory:

```text
scanner-regression:
  cargo test --offline --locked

roundtrip/source/native:
  cargo test --offline --locked --features participant-host deposit_observer

roundtrip/source:
  node --import tsx --test consumer/freshDepositAdmission.test.mjs guard-service/src/db/moneroCreditAssignmentV2.test.mjs
```

Results: scanner **6 passed**; native observer **6 passed, 1 ignored**; admission
and V2 ledger **36 passed**. The ignored native case is an opt-in check of a
separately pinned participant binary, outside this test-only run. The two deliberate
dependency mutations fail as specified above. No daemon campaign or native
participant executable was rebuilt for this test-only change.

The [earlier copy-first roundtrips](copy-first-reproduction.md) remain actual-node
evidence for raw and decodable synthetic copied outputs in the older bridge
profile. They are not reclassified as a replay of both historical incidents or
as a V2 withdrawal qualification. The [multiprocess deposit qualification](adapter-qualification.md)
separately covers two watchers, four guards, source faults and persistent credit.

## Remaining decisions

Historical pre-fix/post-fix wallet replay and production endpoint/custody
qualification remain unperformed here. Final independent review of the Ergo
multisig hook is still pending; its [review packet](multisig-review.md) identifies
the exact candidate and replayable tests.

The [complete local V2 return](adapter-qualification.md#complete-local-v2-roundtrip)
now exercises exact V2 backing, a persistent single-withdrawal reservation,
fresh source checks by all four guards, and the recoverable native Monero payout.
This closes the local deposit-to-return composition; it does not expand the
historical vulnerability coverage claimed above. Production contracts, service
deployment and testnet rollout remain integration work for Rosen.
