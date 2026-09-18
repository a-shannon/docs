# Monero integration into Rosen

A. Shannon · 18 September 2026 · Draft integration document — RCS-003

The proposed first adapter connects native XMR to Ergo using output-specific
deposit verification and the Rust wallet's threshold CLSAG signing path. A
runnable local experiment exercises the deposit, Rosen credit, redemption and
Monero payment on isolated nodes. Adopting it as a production Rosen network
requires decisions on deposit-proof delivery and output agreement, followed by
adapter and operational qualification.

This is the single integration document for the RCS requirements review.
[CLSAG signing and transaction construction](monero-signing.md) is its detailed
mechanism reference. The [published implementation and reproduction instructions](https://github.com/a-shannon/docs/tree/f5b41ca7b65caec0d0afd8ef916d86d23a617970/r-and-d/monero-integration/roundtrip)
and [V2 qualification report](https://github.com/a-shannon/docs/blob/f5b41ca7b65caec0d0afd8ef916d86d23a617970/r-and-d/monero-integration/roundtrip/adapter-qualification.md)
provide the evidence for the local results below. The signing walkthrough retains
its own exact source pin; later adapter results do not replace that review scope.

**Current RCS stage: requirements and integration-design review; Rosen acceptance
is pending.** The laboratory demonstrates candidate mechanisms. It does not
establish approval of the integration or completion of the upstream module and
service contributions. The existing [sign-protocols draft](https://github.com/rosen-bridge/sign-protocols/pull/2)
is a proposed reusable authorization hook, not acceptance of this Monero design.

## RCS requirements

This mapping follows [Rosen Contribution Standards](https://github.com/rosen-bridge/rcs/tree/7b9784dae9d8d5b66b80de7a6043d1ba36a3a4bf).
It identifies both implemented experimental behavior and integration gaps.

| Requirement | Monero approach and present limit |
| --- | --- |
| Multi-signer transactions | `monero-wallet 0.2.0` with `multisig` uses the imported CLSAG threshold machinery. The experiment has four holder processes and selects two signers. The local mechanism is demonstrated; production custody remains open until Rosen accepts the guard-to-holder mapping, threshold, ceremony, recovery and rotation. |
| Data on the lock transaction | The `deposit-delivery` experiment places destination, amount, fees and source/vault context in a compact memo on the Monero transaction. The final output-bound intent and `OutProofV2` follow separately. This addresses the metadata requirement in the local profile; production acceptance, retention and availability of the auxiliary proof channel remain open. |
| Sufficient endpoints | The V2 deposit reader checks two separately stored local daemon histories. The fault campaign rejects disagreement and tests replacement/restoration of the credited block. Both daemons remain under one operator; independently administered production endpoints and availability are unqualified. The published payout experiment uses its local payout daemon. |
| Token support | Native XMR only. There is no Monero token-issuance adapter or proposal to issue other Rosen assets on Monero. |
| Wallet/dApp connector | A depositor must create the exact intent and supply the matching payment proof. The experiment provides that path through its harness; a supported user-wallet connector and delivery interface remain open. |
| Transaction chaining | The initial adapter can wait for confirmed source state. Chained transactions and parallel spending from a shared vault are outside the tested profile. |
| Event distinguishability | One qualifying unlocked vault output is accepted per deposit transaction. Keep the raw txid and existing request ID; additionally commit the selected output and full intent in the event's origin descriptor. Separate ledger uniqueness checks cover output keys and associated key images across txids. |
| Fee handling | Use Rosen's effective bridge/network charges, including configured minima and proportional bridge fees, and bind the resulting recipient amount and miner-fee ceiling before signing. An uncertain signed payment retains its inputs and liability; a changed fee estimate must not silently authorize another payment. The published V2 run uses fixed fixture charges and subsidized reserves; authoritative fee-box integration, completed return rewards and sustainable pricing are not established by that run. |

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
4. Require canonical inclusion, confirmations and current policy. Before watcher
   commitments, check that the output key and associated image are new to the
   credit ledger. Each guard must atomically reserve that backing before release
   and recheck source facts at its pre-signing boundary.

The [local watcher credit view](https://github.com/a-shannon/docs/blob/f5b41ca7b65caec0d0afd8ef916d86d23a617970/r-and-d/monero-integration/roundtrip/source/ergo-node/watcher-credit-view.mjs)
reads all four configured custody stores and refuses an existing claim or an
unavailable store. Guards retain the atomic assignment that closes concurrent
admission races. Independent operators need an authenticated ledger-view delivery
contract; direct access to local files is the experiment's transport.

The identity has two uses. `(txid, local output index)` locates the intended
receipt. The output key and associated image prevent a second economic claim
under another txid. A different locator does not by itself create new backing.

The published V2 profile commits stable backing and the full intent as
`rosen-monero-output:v2:<sha256>` in the existing Rosen `fromAddress` field. This
is an **origin descriptor**, not a sendable Monero address. Its preimage contains
the chain genesis, committee digest, vault, intent hash, txid, original block
hash/height, local/global output indices, output key, associated image, amount
and credited destination/amount. Local reader names and snapshot handles are
excluded so independent readers can agree. Each reader still checks its own
current source snapshot. Reinclusion changes the occurrence descriptor without
freeing the permanent economic claim. The earlier delivery profile used V1;
its evidence does not imply a V1-to-V2 custody migration.

The existing watcher commitment and EventTrigger serialization include this
field; the guard compares the reconstructed descriptor with both the observation
and decoded trigger. This avoids changing the generic event/register format for
the experiment. **This overload needs Rosen's explicit schema approval:** RCS
defines `fromAddress` as the source address. Monero does not expose a dependable
sender address to reconstruct. The proposal is to accept the typed descriptor
and audit every consumer, API, display and refund path; alternatively Rosen can
select a separate origin field and its encoding. A refund destination needs
separate authorization in either case. Generic address-based refunds cannot
consume this descriptor. The experiment does not settle that schema decision.

The extractor mapping for this proposal is:

| RCS field | Monero value |
| --- | --- |
| `toChain` | `ergo` in the first profile. |
| `toAddress` | The destination authenticated by the memo and complete intent. |
| `bridgeFee`, `networkFee` | User-quoted atomic amounts; effective charges are a separate policy calculation. |
| `fromAddress` | Proposed output-origin descriptor above; schema acceptance pending. |
| `sourceChainTokenId` | `XMR` in the local profile; production asset identifier to be configured. |
| `amount` | The independently decoded selected output amount in atomic units. |
| `targetChainTokenId` | The configured wrapped-XMR Ergo asset. |
| `sourceTxId` | The raw Monero transaction ID, retained separately from output identity. |

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
txid. The V2 source adapter uses a configured file directory and holder certificate,
canonical bounded bytes and fresh guard retrieval. Native replay independently
checks the certificate against the configured holder roster and exact source
output. Missing or invalid delivery cannot authorize credit. The transport is
untrusted; proof, output, image-association and source checks remain necessary.
Bounded local retries and database reopening have been exercised; production
certificate provisioning, retention, redundant retrieval and wallet support
remain open. The experimental format and network tags are not assigned Rosen
standards.

Copied output keys are not resolved by globally blacklisting every repeated
key: that could let an unrelated copied output disable an authenticated deposit.
The selected backing policy verifies the intended receipt and tracks one
economic claim. The lab tests both raw and decodable copies, including the copy
appearing first. The [historical-failure coverage map](https://github.com/a-shannon/docs/blob/f5b41ca7b65caec0d0afd8ef916d86d23a617970/r-and-d/monero-integration/roundtrip/burn-coverage.md)
separately records repeated-primary-key, additional-key and duplicated-backing
regressions. These bounded cases do not establish that every historical Monero
burn scenario, wallet behavior or future protocol is covered.

## Module contributions, in RCS order

The following is the proposed contribution sequence after acceptance of the
requirements above. Each row is an upstream review boundary; a laboratory
implementation is not a completed package integration.

| Step and Rosen surface | Monero deliverable and acceptance check |
| --- | --- |
| 1. Scanner | Add the Monero network connector and scanner in `scanner/packages/scanners/monero-scanner`, following the `AbstractNetworkConnector` / `GeneralScanner` contracts. Discover lock metadata from canonical transaction bytes, preserve source anchors and support rollback. Exercise transport errors with mocked endpoints; separately qualify independent live sources. |
| 2. Address codec | Extend `utils/packages/address-codec` encoding, decoding and validation. Distinguish actual network-checked destination addresses from the typed origin descriptor. Verify canonical round trips and reject wrong-network or unsupported address forms. |
| 3. Network Rosen extractor | Extend `utils/packages/rosen-extractor` using `AbstractRosenDataExtractor`. Supply an example lock transaction before implementing the extractor. Decode its quoted fees and destination, then compose the proof and exact output receipt; reject missing, conflicting or ambiguous evidence. |
| 4. Observation extractor | Integrate `scanner/packages/observation-extractors/monero-observation-extractor`. The [published candidate](https://github.com/a-shannon/scanner/tree/2e0382d97a6e0a7bb6fb0e5927ad56af44d2f0ae/packages/observation-extractors/monero-observation-extractor) supplies durable candidate/admission separation and native source replay. Preserve raw txid, output agreement and rollback semantics through the actual watcher event. |
| 5. Rosen Chain | In `guard-service`, deliver the chain types/base, universal extractor, chain implementation and network implementation in that order. The laboratory uses `AbstractChain<unknown>`; the proposed package `@rosen-chains/monero` must replace `unknown` with a canonical `TxType`. Propose retaining `AbstractChain` with output inventory owned by the native wallet, rather than assuming public Ergo-style `BoxType` data. The first proposed network is daemon JSON-RPC, `@rosen-chains/monero-rpc`. Review each entry point, durable reservations, exact-payment agreement and recovery against that choice before package implementation. |
| 6. Health check | Extend `health-check/packages/asset-check` with spendable XMR and fee-reserve checks, distinguishing available, reserved and quarantined backing. Watcher scanner-sync health is registered separately below. Endpoint disagreement and unavailable proof/custody evidence need explicit degraded states, not a healthy balance result. |
| 7. Lock-transaction UI | Add network metadata, lock-transaction construction and a supported wallet connection in the RCS UI order. Produce the same memo and later proof consumed above, display effective charges and disclose the public destination/amount. Verify against the example transaction and negative input cases. |

Implement these as narrow changes in the appropriate Rosen packages, using their
existing conventions, tests and changesets. The experimental bundle copies
pinned dependencies to make local replay possible; it is not proposed as a new
parallel framework inside the production Rosen repositories.

After these modules, integrate all four service surfaces:

| Service surface | Required join |
| --- | --- |
| Watcher | Chain/API/start-height configuration, scanner and extractor initialization, update jobs, sync health checks and protected view/proof-source configuration. The current separate watcher processes execute pinned jobs; they are not a deployed autonomous watcher service. |
| Guard | Chain configuration and registration, trigger/commitment extractors, asset health checks, native-asset identifiers, custody transport and persistent recovery. Every guard must reconstruct the same output agreement before its own secret-bearing contribution. |
| Rosen app | Network/asset selection, supported wallet, deposit construction, proof delivery and status/error handling using the accepted profile. |
| Contracts — Rosen team | Mint/configure the wrapped-XMR asset and required chain configuration tokens on Ergo, and review deployment parameters. The local path executes fixture Ergo contracts; unchanged generic register encoding does not qualify real deployment parameters or prove that no contract adaptation is needed. |

Package PRs follow the [RCS contribution recipe](https://github.com/rosen-bridge/rcs/blob/7b9784dae9d8d5b66b80de7a6043d1ba36a3a4bf/rcs-003/README.md#integration-notes):
changesets, package versions, tests and hooks. New packages start at `0.0.0` with
the prescribed initialization changeset; the guard-service integration has its
own major-version requirement. Do not edit changelogs by hand, bypass hooks or
include unrelated dependency/formatting changes. Module acceptance and service
deployment are separate milestones.

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

For production, the proposal is that enrolled Rosen guards operate the Monero
share holders, with their mapping fixed in the vault configuration. Rosen must
select both thresholds and own enrollment, backup/recovery and rotation policy.
The laboratory's two-holder cryptographic threshold must not be described as
three-of-four custody: two colluding holders could bypass the software approval
check. Acceptance therefore requires an explicit holder fault assumption and a
threshold consistent with Rosen's custody policy. The four processes on one
machine do not demonstrate independent operators or protected share custody.

An exact committed final can be recovered after a lost submission reply without
signing again. Interrupted in-flight nonce machines are not reconstructed; the
consumed marker prevents a second use. A confirmed credit is retained across
restart. Removing its backing block quarantines the liability rather than
erasing the credit or issuing a replacement. These are bounded local checks,
not a claim about production storage failure or network fork selection.

## Scope for the next implementation contribution

The requested review is acceptance or correction of this integration profile:

1. Public lock metadata plus an auxiliary payment-proof and holder-certificate
   channel, including its provisioning, retention and retrieval authority.
2. One selected output per deposit, with the origin descriptor preserved through
   extraction, agreement, API/display and credit consumers.
3. Rust threshold CLSAG custody, including the guard-to-holder mapping,
   cryptographic threshold, fault assumptions and recovery ownership above.
4. Effective-fee and confirmation policies, supported wallet/address forms and
   independently administered source endpoints for the first deployment.

After that review, take the module contributions in the sequence above and then
close their service joins. Existing experiments and the signer draft are evidence
for those decisions. The next upstream implementation step follows the accepted
profile; no acceptance is inferred from local test results.

## Local profile and evidence limits

The V2 admission fixture requires ten source confirmations and checks canonical
inclusion and an unspent, output-associated key image again before contributions.
That fixture value is not a selected mainnet finality policy. Amounts are integer
XMR atomic units (12 decimals). The current replay profile uses standard
mainnet-format vault addresses on isolated fakechain and Ergo testnet-format
addresses on devnet; neither address prefix alone identifies the configured
chain. Actual genesis and configured source context are also checked. Production
key derivation, address coverage and full-node resource sizing remain deployment
qualification inputs.

The published V2 evidence covers deposit, Ergo credit, recipient redemption,
Monero payout and retained recovery with two watcher processes in each direction
and four guard processes. Its return event remains `pending-reward`; it is not a
completed reward-distribution or reserve-wide accounting result. The selected
reserve subsidizes miner fees. The [multisig review packet](https://github.com/a-shannon/docs/blob/f5b41ca7b65caec0d0afd8ef916d86d23a617970/r-and-d/monero-integration/roundtrip/multisig-review.md)
states its exact review scope and remaining gate. Later unpublished fee/reward
changes are not evidence for this document.

The present experiment fixes one qualifying output per deposit transaction,
local fakechain/devnet nodes, fixture assets, a local ceremony, a selected signer
pair and deterministic rings. It does not qualify public-network operation,
pooled-vault solvency, production decoy selection, fee autonomy, committee
rotation or FCMP++/Carrot migration. The public code is available for review and
reproduction while those integration decisions remain open.
