# Offline Monero scanner regressions

A. Shannon · 18 September 2026

Six tests exercise the actual `monero-wallet = 0.2.0` scanner:

- one owned output has the expected amount and locator;
- a repeated primary transaction public key does not duplicate that output or amount;
- two equal-value owned outputs retain distinct one-time output keys and local/global indexes;
- repeating the primary key also preserves both distinct outputs;
- a dummy primary with genuine indexed additional keys exercises the additional-key path;
- distinct dummy/genuine primaries plus genuine additional keys still produce one receipt per output.

From this directory, run `cargo test --locked`. With the locked dependencies
already cached, `cargo test --offline --locked` runs without network access.
Use a machine-local `CARGO_TARGET_DIR` outside synchronized source directories.

## Fixture and evidence scope

The fixture data comes from the published `monero-wallet 0.2.0` crate at
[`src/tests/scan.rs` at `9e11f5c0f2b18ab821192efa427c863086b51379`](https://github.com/monero-oxide/monero-oxide/blob/9e11f5c0f2b18ab821192efa427c863086b51379/monero-oxide/wallet/src/tests/scan.rs).
The spend and view scalars are that dependency's public test data. The upstream
MIT notice is retained in [LICENSE](LICENSE).

These tests pass pruned transaction projections to `Scanner`. The single-output
projection truncates the second output and matching RingCT amount/commitment
arrays. The block projection uses hard fork 16 and a synthetic transaction hash
and global-index anchor. Those choices test scanner output accounting; they do
not establish consensus validity of modified transactions, verify an OutProofV2,
or execute the bridge's full native admission path.

The current native observer requires exactly one owned output in the selected
transaction and binds its amount, key and local/global indexes to the supplied
transaction and canonical block. The separate
[output-agreement report](../roundtrip/output-agreement.md) describes the
actual-node evidence. Passing these scanner tests does not establish
complete coverage of Monero's historical client vulnerabilities.

## Historical mechanism coverage

The [coverage matrix](../roundtrip/burn-coverage.md) separates repeated primary
keys, the additional-key multiple-counting variant, and repeated economic
backing across transactions. The additional-only control is essential: the
pinned Rust scanner visits all primaries before the indexed additional key,
irrespective of their serialized order.

Two isolated dependency mutations were checked against these six tests:

| Change to a scratch copy of `monero-wallet 0.2.0/src/scan.rs` | Result |
| --- | --- |
| Remove the `break` immediately after `res.push(WalletOutput { ... })` | Three failures: both repeated-primary cases and the combined primary/additional case; three controls pass. |
| Remove that `break` and deduplicate `tx_keys` by point equality before scanning | Only the combined primary/additional case fails; all four former tests and the additional-only control pass. |

The second mutation demonstrates the missing discriminator in the former suite.
For replay, copy this test crate and the locked dependency into a scratch tree,
add `[patch.crates-io] monero-wallet = { path = "wallet" }` to the scratch
manifest, and apply one change above to that copied dependency. Run
`cargo test --offline` once to resolve the local patch, then use
`cargo test --offline --locked`. Do not modify the registry cache or the normal
dependency. These mutations are sensitivity tests, not dependency findings.

## Additional audit

The deeper review of lab commit `6e60829bc6be552b89ba9861bbfd0ea294122b9d`
traced native output/image association, authenticated source and guard
consumers, permanent credit claims, recovery, and the retained approval-to-CLSAG
boundary. Two independent reviewers covered native admission and credit custody;
the coordinating review inspected source/guard and signing joins. No additional
externally reachable defect was demonstrated in those boundaries.

At that earlier checkpoint, the focused checks passed: 5 public-observer tests, 18 guard-mediator and complete
output-policy tests, 3 participant-I/O authority tests, 19 ledger tests, 11
credit-recovery tests, and these 4 scanner tests. The 56 existing checks ran
against unchanged published source. The scanner probe is a separate test crate;
it changes no bridge runtime or qualified participant executable.

As a sensitivity check, removing only the scanner's `break` after a matched
output made both repeated-key tests fail with output counts `2 != 1` and
`4 != 2`; both positive baselines still passed. The test uses the unchanged
published dependency in normal execution. This deliberate mutation is not a
finding against that dependency.

Two proposed counterexamples were rejected as exploit evidence after tracing
their consumers. Arbitrary ledger requests with contradictory output identities
do not pass the native source checks; the ledger deliberately delegates those
checks to its caller. A mocked submission inserted an extra asynchronous wait
that is absent before dispatch in the actual caller. Invalidation after dispatch
can quarantine a confirmed result, but cannot revoke signed transaction bytes.
Rollback to an older valid database, independent production endpoints and
concurrent operational recovery remain outside the qualified local profile.
