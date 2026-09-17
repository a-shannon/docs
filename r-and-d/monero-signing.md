# CLSAG threshold signing and Monero transaction construction

This note explains the native withdrawal path in the source snapshot published at
commit `60bc88a585e5bc8bcd230c69652cf12ac1fb4ec7`, for maintainers deciding which
part can become a narrow Monero adapter and which parts are harness or custody code.

## What is imported and what is local

The implementation uses published Rust crates without modifying their source:

| Component | Pinned version | Role used here |
| --- | --- | --- |
| `monero-wallet` | `0.2.0` with `multisig` | Monero addresses, scanning, fee rates, `SignableTransaction`, unsigned transaction generation, transaction serialization, and the multisignature transaction state machine. |
| `monero-clsag` | `0.1.0` with `multisig` | CLSAG types and the signing/verification implementation used by the wallet state machine. The final Monero witnesses are CLSAGs. |
| `modular-frost` | `0.11.1`, Ed25519 | Threshold key, participant, preprocessing, signing-machine, share-decoding, and completion abstractions consumed by `monero-wallet`/`monero-clsag`. This does not make the final witness a standalone FROST signature. |

The direct pins are in [`native/Cargo.toml`](https://github.com/a-shannon/docs/blob/60bc88a585e5bc8bcd230c69652cf12ac1fb4ec7/r-and-d/monero-integration/roundtrip/source/native/Cargo.toml);
[`native/Cargo.lock`](https://github.com/a-shannon/docs/blob/60bc88a585e5bc8bcd230c69652cf12ac1fb4ec7/r-and-d/monero-integration/roundtrip/source/native/Cargo.lock)
records the crates.io checksums and that `monero-wallet 0.2.0` depends on both
`monero-clsag 0.1.0` and `modular-frost 0.11.1`.

The repository's own code supplies the integration boundary around those crates:

- closed request decoding, source-output and ring admission, fee ceilings, and
  construction of an unapproved native intent;
- the DLEQ-backed association between each scanned source output and its threshold
  key-image shares;
- exact unsigned-candidate framing and semantic binding;
- authenticated participant envelopes and the fixed 2-of-4 local signing profile;
- Rosen approval-certificate verification before entering the wallet signing call;
- one-shot state transitions, durable expectation/final records, recovery, and
  the outer reservation and settlement journal;
- isolated node submission and post-inclusion observation in the test profile.

The local code does not reimplement Monero serialization, Bulletproof+, or CLSAG
equations. It constrains when imported machines run and checks their inputs and outputs.

## Inputs admitted by the native path

The request is a nine-line `WMNI1` frame decoded by
[`native/src/lib.rs`](https://github.com/a-shannon/docs/blob/60bc88a585e5bc8bcd230c69652cf12ac1fb4ec7/r-and-d/monero-integration/roundtrip/source/native/src/lib.rs#L17-L108).
It contains four 32-byte identifiers, network, canonical recipient address, positive
atomic amount, and maximum miner fee; it is newline-terminated ASCII, at most 2,048 bytes.

Each spend input is a pair:

1. a `WalletOutput` returned by the imported scanner; and
2. an `OutputWithDecoys` containing the same output data and a 16-member ring.

[`bound_inputs`](https://github.com/a-shannon/docs/blob/60bc88a585e5bc8bcd230c69652cf12ac1fb4ec7/r-and-d/monero-integration/roundtrip/source/native/src/lib.rs#L164-L208)
rejects duplicate transaction/output identities, global indices, or output keys. It
also requires exact key, key-offset, commitment mask/amount/commitment, signer slot,
global position, and real ring member equality. The current profile rejects
subaddresses and checks that the output key is the threshold group spend point plus
the scanner-derived key offset.

The local-node adapter independently checks an offline fakechain node at hard fork
16, rereads canonical blocks and transaction bytes, rescans outputs, obtains the
ring members from `get_outs`, and pins the daemon fee estimate. Its deterministic
ring selection is explicitly fixture policy, not production decoy selection:
[`native/src/node_funding.rs`](https://github.com/a-shannon/docs/blob/60bc88a585e5bc8bcd230c69652cf12ac1fb4ec7/r-and-d/monero-integration/roundtrip/source/native/src/node_funding.rs#L1-L118)
and [`participant_scan_inner`](https://github.com/a-shannon/docs/blob/60bc88a585e5bc8bcd230c69652cf12ac1fb4ec7/r-and-d/monero-integration/roundtrip/source/native/src/node_funding.rs#L275-L321).

The generic construction boundary permits one to sixteen inputs. The exercised
participant-signing profile is narrower: exactly two inputs, ring size 16, a 2-of-4
original roster, and selected participants 1 and 2.

## State machine

The participant process moves through these consuming states:

| State | Accepted input | Output and next state |
| --- | --- | --- |
| `Images` | the other participant's two authenticated DLEQ rows | verified images and local wallet preprocess → `Preprocess` |
| `Preprocess` | the other participant's canonical wallet preprocess | sealed candidate owner and approval descriptor → `Descriptor` |
| `Descriptor` | the identical descriptor from the other participant | durable expectation and public candidate → `Approval` |
| `Approval` | matching expectation digest plus a valid Rosen certificate | one local CLSAG share → `Shares` |
| `Shares` | the other participant's canonical 64-byte share | verified final transaction, durably committed → `Complete` |

Any message accepted in the wrong state fails. Each successful transition consumes
the prior state through `mem::replace`; replay does not recreate it. See
[`ActorSigning`](https://github.com/a-shannon/docs/blob/60bc88a585e5bc8bcd230c69652cf12ac1fb4ec7/r-and-d/monero-integration/roundtrip/source/native/src/participant_signing.rs#L129-L149)
and [its transition body](https://github.com/a-shannon/docs/blob/60bc88a585e5bc8bcd230c69652cf12ac1fb4ec7/r-and-d/monero-integration/roundtrip/source/native/src/participant_signing.rs#L397-L516).

Outside the process, the withdrawal journal advances `prepared → signing → completed`
or `quarantined`. It binds the native directory, reservation, request, descriptor,
binding and expectation digests, and the final transaction record. State changes use
SQLite `BEGIN IMMEDIATE`, exact predecessor states, immutable rows, and readback:
[`consumer/withdrawalJournal.ts`](https://github.com/a-shannon/docs/blob/60bc88a585e5bc8bcd230c69652cf12ac1fb4ec7/r-and-d/monero-integration/roundtrip/source/consumer/withdrawalJournal.ts#L181-L221).

## Exact authenticated transcript and bytes

### 1. Key-image proof transcript

[`LocalImageSession`](https://github.com/a-shannon/docs/blob/60bc88a585e5bc8bcd230c69652cf12ac1fb4ec7/r-and-d/monero-integration/roundtrip/source/native/src/key_image.rs#L103-L201)
uses domain `rosen-monero-local-key-image/v1`. Its session binding includes the
profile string, purpose, network genesis, epoch, epoch-manifest identifier, attempt,
retained-intent identifier, group key, threshold, original roster, selected subset,
and ordered source identities. A source identity contains transaction hash,
transaction output index, global chain index, and one-time output key.

For each input and participant, the DLEQ transcript additionally includes the input
ordinal, complete scanner-output identity, output key, and participant identifier.
Verification checks each proof against that participant's original verification
share and the point derived from the source output key.

The verified aggregate key image is constructed from the selected shares with the
library interpolation factors and the scanner-derived key offset. The code then
retains the image together with its exact source identity and participant shares.
This is the critical output-to-key-image association; a free-standing image is not
accepted as evidence for an arbitrary source output.

### 2. Authenticated peer envelopes

Rounds 5–8 carry image proofs, wallet preprocesses, descriptors, and signature
shares. Each JSON envelope is signed under domain
`rosen-monero/local-sign-envelope/v1` and binds ceremony, epoch, roster digest,
genesis, local configuration binding, attempt, selected set `[1,2]`, sender,
recipient, round, sequence, and payload. The receiver checks the closed field set,
exact context, expected round, peer identity, and signature before decoding the
payload:
[`participant_signing.rs`](https://github.com/a-shannon/docs/blob/60bc88a585e5bc8bcd230c69652cf12ac1fb4ec7/r-and-d/monero-integration/roundtrip/source/native/src/participant_signing.rs#L345-L396).

### 3. Unsigned candidate

`monero-wallet` first constructs a `ClsagBulletproofPlus` `SignableTransaction` with
the admitted inputs, one recipient payment, standard change to the vault, no extra
data, and the pinned daemon fee rate. Local code round-trips the private serialized
intent through the library decoder, extracts the payment and change by their native
tags, and checks the necessary fee against the request ceiling:
[`construct`](https://github.com/a-shannon/docs/blob/60bc88a585e5bc8bcd230c69652cf12ac1fb4ec7/r-and-d/monero-integration/roundtrip/source/native/src/lib.rs#L330-L378).

After key images are available, `unsigned_transaction` produces the actual Monero
prefix and RingCT base plus Bulletproof+, with the CLSAG and pseudo-output vectors
still empty. The public `W1HC` candidate frame contains:

- profile/version bytes;
- local owner identifier;
- event, instruction, and request digests;
- bounded unsigned body length and exact serialized body;
- `Transaction::signature_hash()` as the 32-byte signing message; and
- a domain-separated SHA-256 proposal digest over all preceding frame bytes.

The proposal digest is used as the Rosen-side candidate `txId`; it is not the final
Monero transaction hash. The candidate decoder and constructor are in
[`native/src/candidate.rs`](https://github.com/a-shannon/docs/blob/60bc88a585e5bc8bcd230c69652cf12ac1fb4ec7/r-and-d/monero-integration/roundtrip/source/native/src/candidate.rs#L47-L130).

The wallet orders transaction inputs by descending compressed key image. Local code
sorts each key image together with its ring, verifies the transaction's key image and
offset vector in that order, and captures the same association in `SealedSnapshot`.
Final CLSAG verification later reuses that exact ordered tuple.

### 4. Descriptor, expectation, and Rosen approval

The `WMAD1` approval descriptor binds five model-context digests, the private
candidate identity, threshold, full participant roster, selected participants,
every original verification share, and the group key. Both selected owners must
derive the same descriptor. The descriptor format and comparison are in
[`native/src/authorized_signing.rs`](https://github.com/a-shannon/docs/blob/60bc88a585e5bc8bcd230c69652cf12ac1fb4ec7/r-and-d/monero-integration/roundtrip/source/native/src/authorized_signing.rs#L20-L157).

The `WMEX2` expectation contains the preparation record, descriptor, exact candidate,
and, for both inputs, the key image, offset vector, and all 16 ring key/commitment
pairs. Its SHA-256 digest is stored independently in the withdrawal journal before
signing. Decoding canonicalizes and rechecks every association:
[`Expectation`](https://github.com/a-shannon/docs/blob/60bc88a585e5bc8bcd230c69652cf12ac1fb4ec7/r-and-d/monero-integration/roundtrip/source/native/src/authorized_signing.rs#L195-L302).

The candidate exposed to Rosen is canonical JSON containing `eventId`, `network`,
the complete `W1HC` candidate bytes, the proposal digest as `txId`, and `txType`.
`txDataHash` is Blake2b-256 of those exact JSON bytes. Approval requires the exact
ordered four-key authority profile, protocol version `1.0.0`, configured timestamp,
`requiredSign = 3`, and at least three distinct valid low-`s` ECDSA signatures.
Each signature covers Blake2b-256 of the codec-produced `{"txDataHash": ...}` JSON,
timestamp, its own public-key string, and protocol version. See
[`VotePolicy`](https://github.com/a-shannon/docs/blob/60bc88a585e5bc8bcd230c69652cf12ac1fb4ec7/r-and-d/monero-integration/roundtrip/source/native/src/participant_signing.rs#L22-L126)
and the Rosen differential fixture
[`rosen-vote-vectors.json`](https://github.com/a-shannon/docs/blob/60bc88a585e5bc8bcd230c69652cf12ac1fb4ec7/r-and-d/monero-integration/roundtrip/source/evidence/rosen-vote-vectors.json).

Only successful certificate verification constructs `VerifiedApproval`. That
non-serializable capability must match both the descriptor identity and expectation
digest at the wallet-sign entry.

## Signing, final verification, custody, and broadcast

After approval, each participant enters the imported wallet machine exactly once.
`sign_single` calls the retained `TransactionSignMachine`, producing one canonical
64-byte share. The peer share is decoded by that same machine and completion returns
a full Monero transaction:
[`sign_single`](https://github.com/a-shannon/docs/blob/60bc88a585e5bc8bcd230c69652cf12ac1fb4ec7/r-and-d/monero-integration/roundtrip/source/native/src/authorized_signing.rs#L331-L343)
and [`finish_single`](https://github.com/a-shannon/docs/blob/60bc88a585e5bc8bcd230c69652cf12ac1fb4ec7/r-and-d/monero-integration/roundtrip/source/native/src/terminal_custody.rs#L60-L75).

The final verifier requires the original unsigned body as an exact byte prefix, the
same signature hash, exactly two CLSAGs and two pseudo-outs, and no base pseudo-outs.
Each CLSAG is verified by the imported implementation against its associated ring,
key image, pseudo-out, and original message. Removing the CLSAGs and pseudo-outs must
reproduce the original unsigned body byte-for-byte. Only then are the Monero txid and
SHA-256 byte digest accepted.

Before signing, `expectation.private` is written with create-new semantics, synced,
read back, and decoded. Each participant then creates and syncs `consumed.private`
before the irreversible nonce-machine transition. The verified final is written to
create-new `terminal.private`, synced, read back, and reverified. The exposed `W1HDF1`
frame contains expectation digest, binding, final Monero txid, byte digest, and exact
transaction bytes:
[`native/src/terminal_custody.rs`](https://github.com/a-shannon/docs/blob/60bc88a585e5bc8bcd230c69652cf12ac1fb4ec7/r-and-d/monero-integration/roundtrip/source/native/src/terminal_custody.rs#L20-L117).

Broadcast is deliberately outside the native signer. The payment lifecycle rereads
the settlement authority, submits only the recovered exact final bytes to the owned
offline node, and treats a lost RPC reply as an observation/recovery problem rather
than permission to sign again:
[`consumer/roundtripPayment.ts`](https://github.com/a-shannon/docs/blob/60bc88a585e5bc8bcd230c69652cf12ac1fb4ec7/r-and-d/monero-integration/roundtrip/source/consumer/roundtripPayment.ts#L30-L77)
and [`consumer/localMonero.ts`](https://github.com/a-shannon/docs/blob/60bc88a585e5bc8bcd230c69652cf12ac1fb4ec7/r-and-d/monero-integration/roundtrip/source/consumer/localMonero.ts#L22-L64).

Post-inclusion observation compares node-returned bytes with the final, checks the
canonical block twice, rescans one recipient and one change output, enforces fee and
amount conservation, and rebinds the observed semantics to the original candidate
identity.

## Recovery and refusal behavior

Recovery never constructs a candidate, enters a signing machine, or produces a new
share. It requires the independently retained expectation digest, reloads both
immutable files under size bounds, redecodes the complete expectation, rechecks the
final transaction and every CLSAG, syncs both files, and returns the same final bytes.
The outer consumer also pins the participant executable hash and records zero wallet
sign calls on recovery:
[`recover`](https://github.com/a-shannon/docs/blob/60bc88a585e5bc8bcd230c69652cf12ac1fb4ec7/r-and-d/monero-integration/roundtrip/source/native/src/terminal_custody.rs#L157-L176)
and [`recoverParticipantFinal`](https://github.com/a-shannon/docs/blob/60bc88a585e5bc8bcd230c69652cf12ac1fb4ec7/r-and-d/monero-integration/roundtrip/source/consumer/participantSigning.mjs#L160-L175).

The path fails closed on malformed or oversized frames; duplicate or substituted
inputs; source/genesis/block drift; wrong rings or signer positions; unsupported key
tweaks/subaddresses; roster, subset, attempt, sender, round, or DLEQ mismatch;
noncanonical preprocess/share bytes; candidate or private-semantic drift; fee ceiling
or conservation failure; changed Rosen authority/provenance/certificate; missing or
replayed approval; file collision, short write, failed sync, or readback mismatch;
final-body/message/ring/image/CLSAG mismatch; node rejection; and inconsistent
post-inclusion bytes, block, recipient, change, fee, or total.

Tests that exercise these boundaries include:

- [`common_owner_tests.rs`](https://github.com/a-shannon/docs/blob/60bc88a585e5bc8bcd230c69652cf12ac1fb4ec7/r-and-d/monero-integration/roundtrip/source/native/src/common_owner_tests.rs#L39-L214) for subsets, preprocess binding, rings, key images, and terminal rejection;
- [`candidate_tests.rs`](https://github.com/a-shannon/docs/blob/60bc88a585e5bc8bcd230c69652cf12ac1fb4ec7/r-and-d/monero-integration/roundtrip/source/native/src/candidate_tests.rs#L26-L154) for candidate framing, semantic drift, count bounds, fee, and conservation;
- [`authorized_signing.rs` tests](https://github.com/a-shannon/docs/blob/60bc88a585e5bc8bcd230c69652cf12ac1fb4ec7/r-and-d/monero-integration/roundtrip/source/native/src/authorized_signing.rs#L410-L640) for descriptor equality, exact final verification, durable recovery, and commit failures;
- [`participant_signing.rs` tests](https://github.com/a-shannon/docs/blob/60bc88a585e5bc8bcd230c69652cf12ac1fb4ec7/r-and-d/monero-integration/roundtrip/source/native/src/participant_signing.rs#L519-L648) for exact Rosen vote and certificate policy;
- [`participantSigningFaults.spec.ts`](https://github.com/a-shannon/docs/blob/60bc88a585e5bc8bcd230c69652cf12ac1fb4ec7/r-and-d/monero-integration/roundtrip/source/consumer/participantSigningFaults.spec.ts) and [`distributedWithdrawal.spec.ts`](https://github.com/a-shannon/docs/blob/60bc88a585e5bc8bcd230c69652cf12ac1fb4ec7/r-and-d/monero-integration/roundtrip/source/consumer/distributedWithdrawal.spec.ts) for authenticated process exchange, interruption, replay, recovery, and single use;
- [`nodeWithdrawal.spec.ts`](https://github.com/a-shannon/docs/blob/60bc88a585e5bc8bcd230c69652cf12ac1fb4ec7/r-and-d/monero-integration/roundtrip/source/consumer/nodeWithdrawal.spec.ts) for exact-byte submission, altered-byte rejection, and node observation.

## Limitations

This is a bounded, offline fakechain qualification profile. It fixes hard fork 16,
testnet-form transaction construction, two inputs, ring size 16, a 2-of-4 roster,
selected participants 1 and 2, and deterministic fixture rings. The ceremony
bootstrap and process environment remain locally controlled. There is no production
transport, production decoy policy, mainnet qualification, independent operator
reproduction, committee rotation, or FCMP++/Carrot transaction engine here.

Recovery covers a durably committed final after a lost response; it cannot reconstruct
an in-flight nonce machine after interruption between share creation and terminal
commit. The create-new consumed marker intentionally prevents that retry from becoming
a second signing attempt. Power-loss durability, rollback to older storage, and
production database/service operations require separate qualification.
