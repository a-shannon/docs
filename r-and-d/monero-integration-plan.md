# Monero integration into Rosen

A. Shannon · 17 September 2026 · Draft integration proposal

The proposed first adapter connects native XMR to Ergo using output-specific
deposit verification and the Rust wallet's threshold CLSAG signing path. A
runnable local experiment exercises the deposit, Rosen credit, redemption and
Monero payment on isolated nodes. Adopting it as a production Rosen network
requires decisions on deposit-proof delivery and output agreement, followed by
adapter and operational qualification.

The review has two entry points: this RCS requirements and component map, and
[CLSAG signing and transaction construction](monero-signing.md). The complete
[implementation, tests and reproduction instructions](https://github.com/a-shannon/docs/tree/4a11e2818031552bd38a1dcb997e9a15ae56648d/r-and-d/monero-integration/roundtrip)
remain available in the experimental branch. Its generated execution evidence
and standalone harness are separate from the proposed documentation change.

## RCS requirements

This mapping follows [Rosen Contribution Standards](https://github.com/rosen-bridge/rcs/tree/7b9784dae9d8d5b66b80de7a6043d1ba36a3a4bf).
It identifies both implemented experimental behavior and integration gaps.

| Requirement | Monero approach and present limit |
| --- | --- |
| Multi-signer transactions | `monero-wallet 0.2.0` with `multisig` uses the imported CLSAG threshold machinery. The experiment has four holder processes and selects two signers. Ceremony, operator independence, rotation and production transport remain to be qualified. |
| Data on the lock transaction | The `deposit-delivery` experiment places destination, amount, fees and source/vault context in a compact memo on the Monero transaction. The final output-bound intent and `OutProofV2` follow separately. This addresses the metadata requirement in the local profile; production acceptance, retention and availability of the auxiliary proof channel remain open. |
| Sufficient endpoints | Deposits and payouts are checked against an isolated Monero daemon. Independent production node providers, disagreement handling and availability have not been qualified. |
| Token support | Native XMR only. There is no Monero token-issuance adapter or proposal to issue other Rosen assets on Monero. |
| Wallet/dApp connector | A depositor must create the exact intent and supply the matching payment proof. The experiment provides that path through its harness; a supported user-wallet connector and delivery interface remain open. |
| Transaction chaining | The initial adapter can wait for confirmed source state. Chained transactions and parallel spending from a shared vault are outside the tested profile. |
| Event distinguishability | One qualifying unlocked vault output is accepted per deposit transaction. Keep the raw txid and existing request ID; additionally commit the selected output and full intent in the event's origin descriptor. Separate ledger uniqueness checks cover output keys and associated key images across txids. |
| Fee handling | Existing Rosen fee-policy concepts remain applicable. The experiment accounts for its selected reserve and measures fees, but fixed fixture reserves and thresholds do not establish sustainable production pricing. |

## Deposit: agree on one output before credit

A transaction-level amount or wallet balance is insufficient authority for an
XMR credit. The source verifier must reconstruct the selected output and tie it
to the same intent that watchers and guards are accepting.

1. Locate the transaction on the configured chain and the selected local output
   index. Reconstruct its one-time output key, amount, global output index and
   vault ownership with the Rust scanner.
2. Verify the payment proof against that transaction, vault and complete intent.
   The intent includes the selected output, recipient, destination asset, fees
   and expiry. `OutProofV2` is a transaction-level payment proof; the explicit
   output binding comes from composing it with the independently reconstructed
   source receipt, rather than treating the proof as a native per-output proof.
3. Associate the key image with the same output through original-holder
   contributions and their DLEQ checks. Query the daemon for its unspent state.
   A daemon's answer about an arbitrary supplied key image is insufficient.
4. Require canonical inclusion, confirmations and current policy; reserve the
   output key and associated image in the credit ledger before release. Recheck
   those source facts at the guard's pre-signing boundary.

The identity has two uses. `(txid, local output index)` locates the intended
receipt. The output key and associated image prevent a second economic claim
under another txid. A different locator does not by itself create new backing.

The experiment commits stable backing and the full intent as
`rosen-monero-output:v1:<sha256>` in the existing Rosen `fromAddress` field. This
is an **origin descriptor**, not a sendable Monero address. Its preimage contains
the chain genesis/network, vault, intent hash, txid, local/global indices,
output key, associated image, amount and credited destination/amount. Local
reader names and snapshot handles are excluded so independent readers can
agree. Each reader still checks its own current source snapshot.

The existing watcher commitment and EventTrigger serialization include this
field; the guard compares the reconstructed descriptor with both the observation
and decoded trigger. This avoids changing the generic event/register format for
the experiment. Production adoption must preserve the field through the chosen
extractors, API and displays; generic address-based refunds are unsupported for
this descriptor.

### Proposed metadata and proof delivery

The [delivery contract and validation report](https://github.com/a-shannon/docs/blob/4a11e2818031552bd38a1dcb997e9a15ae56648d/r-and-d/monero-integration/roundtrip/deposit-delivery.md)
provide the runnable proposal and its remaining integration decisions.

The `deposit-delivery` profile uses a single bounded Rust-wallet data field.
Its pre-transaction memo contains the destination and fee data required by RCS,
plus amount, expiry and source/vault context. The final txid and output identity
enter the later intent and payment proof; embedding the final intent in its own
transaction would make the hash self-referential. Every overlapping memo/intent
field must match. Memo contents, including destination and amount, are public.

Readers discover the memo from chain transaction bytes and retrieve the proof by
txid. The experiment uses a configured file directory, canonical bounded bytes
and fresh guard retrieval. Missing or invalid delivery cannot authorize credit.
The transport is untrusted; native proof, output, image-association and source
checks remain necessary. Production retention, redundant retrieval, retries and
wallet support remain to be defined. The experimental format and network tags
are not assigned Rosen standards.

Copied output keys are not resolved by globally blacklisting every repeated
key: that could let an unrelated copied output disable an authenticated deposit.
The selected backing policy verifies the intended receipt and tracks one
economic claim. The lab tests both raw and decodable copies, including the copy
appearing first. These bounded cases do not establish that every historical
Monero burn scenario, wallet behavior or future protocol is covered.

## Components to integrate

| Rosen surface | Required Monero behavior |
| --- | --- |
| Scanner and network readers | Discover delivered intents/proofs, locate exact outputs, reconstruct ownership and amounts, expose canonical block/confirmation state, and compare independent endpoint results. |
| Network utilities and codecs | Canonical transaction/output identity, atomic XMR amounts, network/address validation, and a clearly typed origin descriptor. Reuse existing interfaces where their semantics fit. |
| Rosen-data and observation extractors | Reconstruct the same intent/output event across readers; retain the raw txid and exact origin descriptor. Reject incomplete or ambiguous source evidence. |
| Guard chain/network implementation | Freshly verify proof, source, image association and unspent state; enforce ledger uniqueness; build and inspect the approved Monero payment; recover exact submitted bytes. |
| Health checks and operator interface | Surface endpoint disagreement, stale confirmations, missing proof/source data, custody availability and retained obligations. Production policies remain to be defined. |
| User interface, where required | Obtain the canonical intent/proof and show deposit/output status. Do not present the origin descriptor as a refund address or infer spendable backing from a balance. |

Implement these as narrow changes in the appropriate Rosen packages, using their
existing conventions, tests and changesets. The experimental bundle copies
pinned dependencies to make local replay possible; it is not proposed as a new
parallel framework inside the production Rosen repositories.

## Withdrawal and recovery

The withdrawal path uses Rust `monero-wallet`, `monero-clsag` and
`modular-frost`. It does not use the official wallet-RPC multisig workflow. A
small Core `wallet2` helper in the deposit experiment creates and verifies `OutProofV2`;
replacing that proof implementation is a separate compatibility question.

The [mechanism review](monero-signing.md) describes the exact imported machines,
input/ring admission, key-image exchange, unsigned transaction, Rosen approval,
share transition, final CLSAG verification and durable recovery. Rosen guard
agreement and Monero threshold signing are distinct layers: the experiment uses
three of four Rosen ECDSA guard signatures and two of four Monero holders.

An exact committed final can be recovered after a lost submission reply without
signing again. Interrupted in-flight nonce machines are not reconstructed; the
consumed marker prevents a second use. A confirmed credit is retained across
restart. Removing its backing block quarantines the liability rather than
erasing the credit or issuing a replacement. These are bounded local checks,
not a claim about production storage failure or network fork selection.

## Scope for the next implementation contribution

The next decision is acceptance of on-transaction lock metadata with an auxiliary
payment-proof channel, together with preservation of the output origin descriptor
through existing event consumers. The local delivery experiment provides a
concrete candidate; it does not define production availability. Then implement
the smallest production scanner/extractor join and qualify independent node
readers and a supported depositor wallet, keeping the signer independently
reviewable.

The present experiment fixes one qualifying output per deposit transaction,
local fakechain/devnet nodes, fixture assets, a local ceremony, a selected signer
pair and deterministic rings. It does not qualify public-network operation,
pooled-vault solvency, production decoy selection, fee autonomy, committee
rotation or FCMP++/Carrot migration. The public code is available for review and
reproduction while those integration decisions remain open.
