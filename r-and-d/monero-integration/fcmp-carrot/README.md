# FCMP++ / CARROT local adapter

This experiment composes Monero Core beta3 transaction construction with the
imported Rust threshold SAL machinery. It demonstrates an old-output spend,
a CARROT deposit and a withdrawal from that exact credited output on a real
offline fakechain. It is separate from the earlier CLSAG bridge roundtrip and
does not replace the submitted Rosen service implementation.

## Source and replay

The [complete source](source/) includes the C++ spend-device adapter, Rust SAL
wrapper, receipt composition, observer, admission journal and replay runner.
The [25-file manifest](source-manifest.json) binds the reviewed source with
aggregate SHA256 `019a8a70fbf1094429c69299db2cab81c008ecc0e4290fc199157519af265bfb`.
Core is pinned to `d816367cb1aa405bfa68a20ac3e034d0759d968e`; Rust uses the
node's `monero-oxide` revision `31c26d96eaadbba910ffe3613ad8b4cf9c598a93`.

Copy `source/` into a separate working directory named `adapter`, outside this
documentation checkout. Follow its [build and replay recipe](source/README.md):
the pinned Core checkout must be its sibling `upstream/`, while build output,
Cargo output and fresh runtime data stay outside the source trees. The replay
runner creates and stops its own offline fakechain. It refuses existing runtime
directories and non-loopback, online or non-fakechain node endpoints.

## Executed result

The 7 October replay accepted and confirmed these exact transactions:

| Path | XMR | Transaction ID |
| --- | --- | --- |
| Actual HF16 output spent under FCMP++, vault to user | 0.4 | `6d65733718a0bfff0a1225e2948ad14675aa12731404791399a8aada910b7b46` |
| CARROT deposit, user to vault | 0.2 | `98ee3d3042ed39abe9bdc556a3e7977eb797398c198698e85059b9f215e8d212` |
| Withdrawal from that exact credited output, vault to user | 0.1 | `0e1c86eddec3f1b111fba7767425a2487b035449d0bf7f0e6d829615717c4d9d` |

Two reader processes reconstruct the same output/event at 12 confirmations
through one daemon. The withdrawal candidate binds that event and exact output
key/image; Core reconstructs and authorizes the request before SAL preprocessing.
The final transaction, fee/body, key image, SAL and output receipt are checked
again before submission. Core daemon consensus validates membership and BP+.

Removing seven derived files after payment acceptance and resetting the fixture
submission marker recovers identical files with one signing attempt. Spending
the backing suspends its credit. A 24-block rollback removes the deposit; after
the identical deposit is submitted and confirmed again, the credit remains
suspended with `credit_count = 1`.

Focused checks cover Rust SAL composition, authenticated candidate fields,
consumed-attempt persistence, retained-byte reconciliation, output uniqueness,
receipt parsing, reorg suspension and process cleanup. The scoped source received
an independent local implementation review. These checks are not an independent
cryptographic audit or an independently operated deployment.

## Earlier 8 October correction and replay

The corrected observer accepts canonical tip growth while retaining reorg
suspension, and permits an uncredited deposit to receive its first credit after
valid reinclusion. Admission keeps a candidate's backed or unbacked mode fixed,
finalizes into private output files, and restores only the SQLite-retained final
bytes. A backed candidate is checked against its deposit before new signing and
before first submission. Recovery of an exact payment already on the daemon
does not require the now-spent backing to appear unspent again.

A second fresh offline fakechain replay with the corrected Python sources and
the unchanged pinned Core/Rust binaries completed the old-output spend, CARROT
deposit and exact-output return. Its transaction IDs were respectively
`03d34de7fb0b412d63e15ea85771a250019d04b1a5ce63b991c4284cf04162d9`,
`18a10f90226757f65ee8683ea4fffe5d9ea84a6c93e8350639806b960bd91696`
and `069d382bd6ac31048da9a98bbe4d411bfd5944082e2c7d3e8f2eb34f0f4b9cce`.
Both readers credited the deposit at 12 confirmations. Recovery restored the
seven exact files with one signing attempt; spending, a 24-block rollback and
reintroduction left `credit_count = 1` and the original credit suspended.
Focused Python checks passed 15 admission tests (three process tests skipped on
Windows) and 19 deposit tests. The healthy-tip interleaving and two-finalizer
arbitration were exercised as isolated regressions; the complete replay did not
force those two races.

## Restart and return-only reorg correction

The current backed candidate certifies the deposit ledger, credit identity and
original block/output anchor. On process interruption, the candidate marker is
published only after its certificate and intent sidecars. Submission and
ten-block return confirmation
have separate retained states. After a return-only reorg, exact return replay
requires the prior confirmation and a fresh, unspent deposit at its original
anchor; a later confirmation preserves the first inclusion record.

The current admission suite ran 27 tests: 24 passed and three Linux-only cases
were skipped on Windows; the deposit suite passed 26. A fresh offline fakechain
run completed
the normal deposit/return and 24-block deposit rollback/reintroduction with one
suspended credit. A separate fresh run removed only the confirmed return while
the deposit remained, resubmitted identical return bytes with one signing
attempt, and reconfirmed them 12 blocks deep. Both use the pinned Core/Rust
binaries and one local endpoint. Neither run includes Ergo settlement.

## Remaining boundaries

- The executed Core join uses the legacy address hierarchy with CARROT outputs.
  The new CARROT address hierarchy is not supported end to end; modern SAL has
  primitive tests only.
- RCR1 is a bounded custom two-output receipt composed from Core primitives.
  It is not upstream `OutProofV2` or a qualified production proof contract.
- Public synthetic fixture keys, a locally controlled 2-of-4 SAL signer and
  synthetic 3-of-4 approval votes make replay possible. The approval votes do
  not increase the cryptographic custody threshold. These are not production custody, DKG transport
  or independently operated Rosen Guards. A certificate uses Rosen's real
  encoding, but this replay does not obtain approval from live Guards.
- This replay has no Ergo credit/redemption/reward leg, production service wiring,
  independent endpoints, persistent cross-operator agreement or activation policy.
  The earlier CLSAG bridge experiment remains separate evidence for those local
  bridge legs. Combining the reports does not establish an upgraded Rosen bridge.

Rosen's integration-document review and the production proof, custody, fee,
finality, refusal/reconciliation and release decisions remain open.
