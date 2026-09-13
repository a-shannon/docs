# Authenticated backing despite copied Monero output keys

A. Shannon · 14 September 2026

The local prototype now reserves an authenticated deposit's spend capacity and
carries that reservation from Ergo credit through Monero withdrawal. A copied
output key is reported as a duplicate; it no longer causes unconditional rejection
of the honest deposit in the explicit `authenticated-backing-v1` profile.

This increment builds on [the watcher authority baseline](watcher-authority.md)
at `9cfa50e73707627f594b28f70337bdaf6eea8b69`. It is a bounded mitigation for the
ordinary-transaction fixture, not a production bridge qualification.

## What authenticates the admitted deposit

An observed output key is insufficient. The existing native OutProofV2 check
binds the transaction and exact deposit intent. Native inspection reconstructs
the canonical transaction and checks its selected output, amount, maturity and
unspent state. Two original Monero holders independently verify the association
between output key P and key image I. The public reader continues to report
`imageAssociationVerified: false`; it cannot replace those holders.

A third party that copies public output data does not thereby acquire the
original sender's transaction secret or a proof for a different transaction and
intent. Proof verification alone still cannot prevent a sender who holds that
secret from authorizing conflicting requests. Durable accounting must reject the
second obligation even when its proof is valid.

The new profile preserves these checks while accepting a reported raw
multiplicity of at least one. Before-credit inspection obtains a fresh snapshot
checked by the original holders and public readers. The default legacy profile
still requires one raw occurrence. No fabricated uniqueness result is passed to
the deposit policy.

## One spend capacity, one obligation

The [guard ledger](source/guard-service/src/db/moneroCreditAssignment.mjs)
permanently reserves both `(source network, P)` and
`(genesis, vault spend key, I)`. Its complete backing descriptor identifies the
admitted transaction, output and global index, amount and authenticated intent.
An output alias cannot become independent bridge backing. Assignment happens
before any native credit contribution. Invalidation retains the claims, and
version-1 databases are refused without an implicit migration.

After confirmed credit, [the credit host](source/ergo-node/authorized-credit.mjs)
can issue a private in-process backing capability only against the same source
producer and matching custody in all four guards. Object-shaped substitutes do
not supply that authority. This protects composition inside a trusted host; it
does not isolate malicious modules running within that host.

[The withdrawal consumer](source/consumer/backingClaim.mjs) requires the exact
admitted occurrence, including its global index, as the backing input. Its
separate fee input and change must not reuse P. The backing digest accompanies
the existing redemption and return authorization through selection, approval,
signing, retained journal recovery and submission. A permanent settlement binds
the same obligation to the selected spend. A partial guard-ledger settlement
reservation can be retried only with the exact original settlement record.

Authority is rechecked around asynchronous participant I/O as well as at the
outer signing boundary. Invalidation prevents subsequent sends and share relay;
it cannot revoke bytes already issued. No refund branch or pooled-vault
allocation policy is introduced.

## Qualification matrix

The [qualification record](evidence/authenticated-backing-qualification.json)
collects public local-chain receipts and exact source and executable pins. Raw
copies repeat P but are not decoded as the copied payment; decodable copies also
reproduce the public data needed for that decoding. The generator receives
public deposit facts and funds its own isolated wallet.

| Scenario | Exercised scope | Result |
| --- | --- | --- |
| Raw copy after honest inclusion, before credit | Both watcher directions, credit and threshold withdrawal | Pass |
| Decodable copy after honest inclusion, before credit | Both watcher directions, credit and threshold withdrawal | Pass |
| Raw copy after credit | Both watcher directions, credit and threshold withdrawal | Pass |
| Decodable copy after credit | Both watcher directions, credit and threshold withdrawal | Pass |
| Raw copy included before the honest deposit | Monero inclusion and spending the selected honest occurrence | Pass |
| Decodable copy included before the honest deposit | Monero inclusion and spending the selected honest occurrence | Pass |

The copy-first tests are Monero-only. They do not establish the complete bridge
path when the copy precedes honest inclusion. The complete bridge cases test
both credit timing boundaries after honest inclusion.

Each passing complete run observes two raw occurrences, confirms one authorized
Ergo credit, redeems that exact box, and spends the authenticated Monero output.
The return uses one signing call and one submission, survives a lost submission
reply and restart, and reaches durable settlement. Subsequent controlled chain
history removal and explicit invalidation quarantine the credit while all four
guards retain their P, I and settlement claims with zero new credit commitments.
This is controlled invalidation, not automatic reorganization detection.

The affected component checks total 303: 71 admission/custody tests, 156 deposit
policy tests, six consumer recovery tests, 14 journal tests and 56 native tests.
They cover conflicting identities and obligations, altered backing fields,
forged capabilities, invalidation during awaits, partial storage failure and
retained-state recovery. These counts are component tests, not end-to-end runs.
The native run initially lacked one public vote-vector file; restoring its exact
bytes and rerunning that test closed the failure without changing the other 55
tests' input closure.

Independent development review checked the changed authority path, regression
tests and the exact 379-file manifest. Its signing-I/O finding was corrected and
tested before freezing. Manifest SHA-256 is
`c6917a48a49d9b6fb3e9b55daf7b357839ff9b82d3f61dc236cf058b829151a2`;
aggregate source SHA-256 is
`16d0ecd2d1a9ee3a4cdaf60675a27d5bdcbf989326d9f5a85bf5b8d1e99a25f0`.
The [replay instructions](source/README.md) specify prepared dependencies and
separate executable pins. This is not an external audit or an independently
reproduced binary build.

## Remaining limits

The fixture uses Monero 0.18.5.1, local Ergo 6.0.3, a fixed public view profile,
four credit guards in one JavaScript host and separate Monero holder processes.
Each bridge run deposits 500,000,240 atomic units, credits 500,000,120 and pays
500,000,000. The payout consumes a separate mined fee input. Those amounts do not
establish sustainable fees or complete liquidity reconciliation.

Full watcher-daemon integration, independently operated guard custody, rollback
to a valid older database, committee rotation, automatic reorg handling, general
refunds and FCMP++/Carrot migration remain unqualified. The evidence supports
reviewing this authenticated admission-to-spend design and its local mitigation;
it does not establish protection against every copied-output ordering or a
production deployment decision.
