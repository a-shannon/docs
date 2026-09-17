# Monero deposit metadata and proof delivery

A. Shannon · 17 September 2026 · Experimental integration proposal

The proposed deposit transport places the pre-transaction destination and fee
data on the Monero lock transaction, then supplies the final output-bound intent
and payment proof separately. This avoids putting a final transaction ID into
the transaction whose hash it determines. It addresses the concrete data-writing
requirement in [RCS-003](https://github.com/rosen-bridge/rcs/blob/7b9784dae9d8d5b66b80de7a6043d1ba36a3a4bf/rcs-003/README.md#L44-L50);
acceptance of the additional proof-delivery channel remains a Rosen integration
decision.

## Contract and implementation

1. Before signing, create one canonical `RMD1` memo with genesis, vault spend
   key/epoch, source and destination networks, destination asset/address, amount,
   bridge fee, network fee and expiry height. Final txid and output fields are
   absent at this stage. The current profile is native XMR to Ergo testnet with
   one qualifying unlocked vault output.
2. Pass the memo to the existing Rust wallet transaction constructor's `data`
   argument. The profile uses one field, at most 253 bytes; the pinned wallet
   permits [254 bytes per field and 1,060 bytes of total extra](https://github.com/monero-oxide/monero-oxide/blob/9e11f5c0f2b18ab821192efa427c863086b51379/monero-oxide/wallet/src/send/mod.rs#L375-L384).
   Neither the wallet library nor CLSAG is patched for this transport.
3. Once the final transaction exists, derive its txid and selected output and
   construct the existing version-2 deposit intent. Every overlapping field
   must equal the on-transaction memo. The Core helper produces `OutProofV2` over
   that complete intent. Proof generation [incorporates the final transaction
   hash](https://github.com/monero-project/monero/blob/4f92268d7c16741cfb41e5bbe2aa46cc260a9ea5/src/wallet/wallet2.cpp#L12969-L12980).
4. Readers discover transactions from blocks, decode the exact transaction bytes
   with the native parser, and retrieve the intent/proof by txid from a configured
   delivery source. The experiment uses a fixed file directory. Canonical framing,
   byte limits, memo/intent equality and the existing cryptographic proof/source
   verification are required. Delivery does not supply inclusion or ownership
   authority. Missing evidence produces no accepted observation.
5. Each guard reloads the delivery and rechecks the memo, proof, selected output,
   associated image, unspent state, confirmations and event before its signing
   commitment. The existing ledger permanently reserves the output key and
   associated image. Retrying the same confirmed credit recovers the same
   transaction; it does not allocate fresh backing.

The native decoder consumes every extra field and requires byte-exact
reserialization. It does not inherit the wallet convenience parser's partial
parsing behavior. Unrelated arbitrary data is not a bridge memo; recognized
unsupported versions, malformed encoding or more than one data field in a bridge
memo transaction are refused by this profile.

The existing `fromAddress` descriptor remains
`rosen-monero-output:v1:<sha256>`. Pinned watcher commitments, EventTrigger encoding
and extraction retain it, and guards compare it exactly. It represents backing
and intent, not a sendable or refund address. Production extractors must reproduce
it; API string compatibility alone does not establish address/refund semantics.

## Review and reproduction

The source is in [depositDelivery.mjs](source/consumer/depositDelivery.mjs),
[the actual-node fixture](source/consumer/depositDelivery.spec.ts),
[independent readers](source/consumer/independentDepositSource.mjs) and
[the guard](source/ergo-node/authorized-credit.mjs). The native parser and optional
funding input are in [participant.rs](source/native/src/participant.rs); the wallet
constructor call is in [node_funding.rs](source/native/src/node_funding.rs).
Run the `deposit-delivery` profile using the [source recipe](source/README.md#deposit-delivery-experiment).

The local-node run passed in 117,100 ms with unchanged frozen inputs:

| Check | Result |
| --- | --- |
| On-transaction metadata | 195-byte memo in the confirmed Monero deposit |
| Two readers | Each scans blocks, retrieves the delivered proof and independently reconstructs the same event; two distinct native observer nonces |
| Rosen transport and credit | Actual watcher commitments and confirmed trigger; confirmed Ergo credit |
| Missing proof, changed destination, invalid proof | Each guard scenario refuses before any signing commitment or partial signature |
| Permanent output uniqueness | Four reopened guard ledgers refuse a second obligation using the same authenticated backing; each retains one output claim |
| Delivery and credit recovery | A fresh Node process reloads exact envelope bytes; reopened credit recovers the same confirmed transaction without new signing commitments |
| Legacy profile regression | The same rebuilt executable and source pass the existing no-memo deposit/credit/redemption/Monero-payment roundtrip, including retained recovery and controlled rollback quarantine, in 118,654 ms |
| Focused regression checks | 35 Node tests and 60 Rust tests pass; the Rust count includes the two new native data/parser tests |
| Isolated mutations | Removing recipient equality or memo/delivery mode coupling causes the intended unit-test failure |

The source snapshot has 402 files, aggregate SHA-256
`0c0adbb91f24722373ec69c6fc29166d5e204a57e7c5f8986d5098b0f44d260c`;
the manifest SHA-256 is
`19b45cf5f72fbedb9c174dfaa0dfdb48856a219bc84e49c30e20c67cc20579d8`.
The tested participant/observer executable SHA-256 is
`dcccfe1a701f484c2e4a2beed4f0a4f2b8000a44086d54f4b1de442243b9c082`.
Source and binary pins are separate; cross-machine byte-identical builds are not
claimed. The run ID is `363cf49b-7b99-4aa3-9fd4-f92532da0e55`.
The legacy regression run is `e90c297d-e2ad-47b0-9faa-a2dbb3875610`, also with
unchanged frozen inputs.

Independent review found no blocker in the 14 changed runtime/README files and
independently replayed the six delivery tests and two native tests. The complete
native suite and actual-node run above were executed by the author. The review
aggregate is `3af9c8034c6aa5e2963cbc66b8ea27aa7ffb9fdd6297bbc6293eb12a22ed0d9c`,
using ordinal source-relative paths and `path + NUL + sha256 + NUL + bytes + LF`.
No CI execution or production endpoint qualification is claimed.

## Remaining integration decision

The requested maintainer decision is whether Monero may supply explicit lock
metadata on chain and retrieve the additional payment evidence through a
separate channel, while preserving the output descriptor through Rosen consumers.
The memo format is experimental; network tags and the eventual package interface
have not been assigned as Rosen standards.

The memo is public and reveals its destination, amount and fees. This disclosure
and a supported depositor wallet need an explicit product decision. The file
transport is a reproducible availability fixture, not a deployed relay service.
Production work must define retention, redundant retrieval, size/rate limits,
pending-proof retries, scanner checkpoints and reorg handling. If proof is lost,
the deposit cannot be credited through this path; no automatic refund is offered.
Independent production endpoints, operator separation and fee/custody policies
remain separate qualification work.
