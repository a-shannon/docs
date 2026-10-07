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
aggregate SHA256 `39b4d7ba284e7bfcc032cdb57ba8591783b50a5d0b1966d67fa1696ece14c992`.
Core is pinned to `d816367cb1aa405bfa68a20ac3e034d0759d968e`; Rust uses the
node's `monero-oxide` revision `31c26d96eaadbba910ffe3613ad8b4cf9c598a93`.

Copy `source/` into a separate working directory named `adapter`, outside this
documentation checkout. Follow its [build and replay recipe](source/README.md):
the pinned Core checkout must be its sibling `upstream/`, while build output,
Cargo output and fresh runtime data stay outside the source trees. The replay
runner creates and stops its own offline fakechain. It refuses existing runtime
directories and non-loopback, online or non-fakechain node endpoints.

## Executed result

The fresh replay accepted and confirmed these exact transactions:

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

## Remaining boundaries

- The executed Core join uses the legacy address hierarchy with CARROT outputs.
  The new CARROT address hierarchy is not supported end to end; modern SAL has
  primitive tests only.
- RCR1 is a bounded custom two-output receipt composed from Core primitives.
  It is not upstream `OutProofV2` or a qualified production proof contract.
- Public synthetic fixture keys and a locally controlled threshold signer/vote
  generator make replay possible. They are not production custody, DKG transport
  or independently operated Rosen Guards. A certificate uses Rosen's real
  encoding, but this replay does not obtain approval from live Guards.
- This replay has no Ergo credit/redemption/reward leg, production service wiring,
  independent endpoints, persistent cross-operator agreement or activation policy.
  The earlier CLSAG bridge experiment remains separate evidence for those local
  bridge legs. Combining the reports does not establish an upgraded Rosen bridge.

Rosen's integration-document review and the production proof, custody, fee,
finality, refusal/reconciliation and release decisions remain open.
