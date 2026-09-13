# Monero deposit candidates

This private prototype workspace implements a versioned instruction codec and a
stateless deposit policy. It produces a candidate and an explicit projection
proposal. It does not reserve outputs, authorize distributed credit, sign or
submit transactions, or connect to a node.

## Profiles and bytes

`encodeIntent`, `decodeIntent` and `intentHash` share one schema. Instructions are
bounded to 4096 ASCII UTF-8 bytes, with sorted JSON object keys, compact separators,
unique decoded member names and no unknown members. Hashing is SHA-256 over the
exact accepted bytes. Noncanonical JSON is rejected rather than normalized.

- Version 1 preserves the historical single-output experiment. Amounts and fees
  are decimal uint64 strings; `expiry_height` is a JSON uint64 integer. The public
  TypeScript representation uses `bigint`, including heights beyond 2^53. The
  original synthetic fixture and source hashes are in
  `tests/fixtures/legacy-v1.json`. Its domain is `rosen-monero-experiment`.
- Version 2 is a new multi-output proposal, exercised with the domain
  `rosen-monero-deposit`. It uses a decimal string for `expiry_height` on the wire
  and adds `outputs`: objects with decimal `output_index`, lower-case 32-byte
  `output_public_key`, and decimal `amount`. Outputs have positive amounts,
  distinct indices and keys, increasing indices, and an exact uint64 aggregate.
  The maximum is 16 outputs as a codec resource bound, unrelated to custody
  committee size. This profile is not claimed to be deployed or upstream accepted.

The configuration selects one exact domain and version; there is no automatic
V1-to-V2 migration. The decoder's integer reader preserves lexemes before any
JavaScript Number conversion. All monetary arithmetic uses `bigint`. Explicit
fee policy fixes the two fees, Monero's 12 decimals, destination precision
(0–18), and whether a conversion remainder is rejected or reported as retained
Monero atomic units. Destination amounts must also fit uint64 and be nonzero.

## Verification boundary

`verifyDeposit(bytes, proof, receiptEvidence, config, feePolicy, providers)`
returns `accepted`, `rejected`, or `indeterminate`. A shape-correct OutProofV2 is
only a parser prerequisite. The function calls three configured interfaces:

1. `proof.verify`: verify the actual outgoing proof for the exact network, txid,
   vault address and message bytes using the pinned native implementation, and
   return the normalized call/result association.
2. `receipt.reconstruct`: independently reconstruct the complete qualifying
   vault-output set and its ownership, amounts, canonical inclusion, maturity,
   justified spent state and canonical-history key occurrence counts.
3. `addresses.verify`: validate vault and recipient encodings against the exact
   source/destination networks and asset policy. This package does not implement
   Monero or Ergo address cryptography.

The providers and their identities are trusted application composition, not
depositor data. The package cannot authenticate a dishonest implementation that
labels itself independent. A caller's `verified: true` in receipt evidence is
never accepted as a verifier. Missing providers, unavailable evidence, provider
exceptions, unknown spent state or inconsistent snapshots prevent acceptance.
All bundled providers are test fixtures; their synthetic proof is not a native
proof. Any fixture provider makes the resulting candidate `evidenceMode: fixture`.

Each verified response must contain the complete typed observation before its
values are interpreted. Missing or malformed fields return `indeterminate`;
explicit observations such as a false proof verdict, unowned or spent output,
duplicate key, or a valid but mismatched amount remain `rejected`. A verified
empty output list is an explicit zero receipt, unlike an absent output list.

The native proof pin is Monero
`4f92268d7c16741cfb41e5bbe2aa46cc260a9ea5`. A production provider must implement
the contracts above and qualify its own source/runtime. Merely returning a
normalized object does not implement those contracts.

The configuration supplies an independently established canonical snapshot,
current policy and advisory assigned-identity sets. `chainHeight` is the daemon
block count; confirmations equal `chainHeight - blockHeight`. Acceptance records
the snapshot, verification height and expiry. Recheck currentness at durable
commitment: an earlier candidate is not indefinitely valid.

## Identities and consumers

The candidate preserves three separate identities:

- deposit: `monero:deposit:<network>:<txid>`;
- locator: the deposit identity followed by `:<output index>`;
- economic output: `monero:output-key:<network>:<public key>`.

Epoch, block occurrence and output locator cannot make the same economic key
available again. Duplicate keys/indices within a receipt and reused identities
in the supplied credit view are rejected. This function does not mutate that
view: concurrent calls may both produce candidates. The durable registry and
real credit consumer must atomically claim the deposit, economic keys and
obligation, and reconcile every retry, reorganization and final settlement.

`toRosenObservation` accepts only a candidate produced in this process and keeps
the authority label, fixture marker, economic identities and explicit units.
Its `fromAddress = intent:sha256:<hash>` is a proposed authority reference, not a
recovered Monero sender. It is not the activated Rosen observation ABI: `amount`
and fees remain Monero atomic units, with destination amount and retained
remainder separate. Downstream work must qualify token conversion, commitment
encoding, trigger decoding and unique economic settlement together. Putting
proof data only in Rosen's `rawData` does not bind it into the current commitment.

## Checks and boundaries

From this package, `npm test -- --run`, `npm run type-check`, and `npm run build`
use the repository's locked tools. Baseline: guard-service
`1edc2fb982de4560c5265e04e2ed8b93d00b40df`, npm 11.6.2, TypeScript 5.9.3,
Vitest 3.1.4. No native wallet, node, database or scanner runtime is required.
The `coverage` and `lint:check` scripts participate in the root workspace CI
commands; `lint:check` also invokes `prettify:check`.

| Invariant                           | Producer → consumer                                          | Deciding negative                                                                                   |
| ----------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Exact instruction bytes             | decoder → native proof request/result → candidate hash       | duplicate/unknown keys, noncanonical integer, changed message                                       |
| Configured authority                | intent/config → policy → candidate destination               | coordinated domain, network, epoch, vault, asset, txid or fee substitution                          |
| Independently reconstructed receipt | receipt provider → policy → accepted output list             | snapshot, ownership, amount, index, key, maturity or spent-state mismatch                           |
| Explicit native result              | native provider → policy                                     | wrong pin/context/proof, false/nonboolean result, unavailable provider                              |
| Monetary conservation               | uint64/fees/precision → net and destination amounts          | overflow, consumed deposit, redistributed outputs, unhandled remainder                              |
| Economic identity                   | verified key → candidate/projection → future atomic registry | same key under another txid/index or epoch with an assigned-key view                                |
| Limited authority                   | providers and stateless policy → projection                  | fixture labels retained, fabricated candidate rejected, concurrent old-view calls remain candidates |

The codec and policy predicates are tested with isolated mutations. These tests
exercise the codec and policy with synthetic provider results; they do not prove
distributed non-equivocation, authenticated key-image production, native proof
verification, solvency, or an integrated Monero–Rosen transfer.
