# Monero integration into Rosen

A. Shannon · Updated 29 September 2026 · Draft integration document — RCS-003

The proposed first adapter connects native XMR to Ergo using output-specific
deposit verification and the Rust wallet's threshold CLSAG signing path. A
runnable local experiment exercises the deposit, Rosen credit, redemption,
Monero payment and Ergo reward distribution on isolated nodes. Adopting it as a production Rosen network
requires decisions on deposit-proof delivery and output agreement, followed by
adapter and operational qualification.

The demonstrated custody profile is **2-of-4 Monero holders**, with a separate
**3-of-4 Rosen guard approval** enforced by the participant software. Two
colluding holders can bypass that software check; this is not 3-of-4 custody.
Both thresholds and their fault assumptions require Rosen approval. The profile
is pre-FCMP++/Carrot; retaining old vault outputs does not establish that its
signer can spend them after a protocol upgrade.

This is the single integration document for the RCS requirements review.
[CLSAG signing and transaction construction](monero-signing.md) is its detailed
mechanism reference. The [published implementation and reproduction instructions](https://github.com/a-shannon/docs/tree/9466cf2fadd266f20e927da938e074b8ef60dacf/r-and-d/monero-integration/roundtrip)
and [V2 qualification report](https://github.com/a-shannon/docs/blob/9466cf2fadd266f20e927da938e074b8ef60dacf/r-and-d/monero-integration/roundtrip/adapter-qualification.md)
provide the evidence for the local results below. The signing walkthrough retains
its own exact source pin; later adapter results do not replace that review scope.

**Current RCS stage: requirements and integration-design review; Rosen acceptance
is pending.** The laboratory demonstrates candidate mechanisms. It does not
establish approval of the integration or completion of the upstream module and
service contributions. The existing [sign-protocols draft](https://github.com/rosen-bridge/sign-protocols/pull/2)
is a proposed reusable authorization hook, not acceptance of this Monero design.

**Implementation status:** further implementation is paused pending Rosen's
review of this RCS document and agreement on the next scope. The proposal below
incorporates the operator-review corrections and separates existing experimental
evidence from unresolved design choices. Existing candidate code is retained for
review; its presence does not imply an accepted implementation direction.
The contribution sequence and qualification tests below are conditional future
work; current work is limited to documentation for this review.

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
| Fee handling | Read the configured minimum-fee NFT and historical policy, apply Rosen's effective bridge/network charges including minima and proportional bridge fees, and bind the resulting recipient amount and miner-fee ceiling before signing. An uncertain signed payment retains its inputs and liability; a changed fee estimate must not silently authorize another payment. The local V2 run exercises the proportional branch and completes return rewards. Its reserves subsidize miner fees; sustainable pricing and reserve-wide accounting remain unqualified. |

One deposit-policy decision remains: the current intent authenticates exact fees
and credited amount. If its quote is below the applicable Rosen minimum, this
profile must refuse admission rather than change that authenticated amount.
Ordinary RCS processing can instead raise effective fees and reduce the payment.
Rosen should approve either that refusal policy or a revised intent that
authorizes the effective-fee calculation. The present proof profile does not
establish equivalent automatic adjustment; existing credits must never be
repriced. Withdrawal construction can use the ordinary effective-fee calculation
before its payment request is approved.

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
   credit ledger. Each guard must atomically reserve that backing in its own store
   before contributing to credit and recheck source facts at its pre-signing
   boundary. Local atomicity does not choose a common winner across guards.

The [published local watcher credit view](https://github.com/a-shannon/docs/blob/9466cf2fadd266f20e927da938e074b8ef60dacf/r-and-d/monero-integration/roundtrip/source/ergo-node/watcher-credit-view.mjs)
reads all four configured custody stores from files and refuses an existing claim
or an unavailable store. Guards retain atomic local assignments; the all-store
read itself neither reserves backing nor closes concurrent admission races.
Independent operators need an authenticated
ledger-view delivery contract; direct access to local files is the published
experiment's transport.

Separately, an unpublished local candidate replaces those file reads with four
authenticated HTTP endpoints. Its uncommitted source trees have base commits
`rosen-bridge/utils@f1e1c6ea4cd796beed11d4cfc35bf4cffb73458d`,
`rosen-bridge/watcher@13b4c76ee7803bdf5f052e33cdc12b66acac2db0` and
`rosen-bridge/guard-service@25bea1bc89f299bc897991123745b162c106e66f`;
the commits identify repository bases, not the unpublished HTTP implementation.
A Node 22 integration test starts four actual Fastify routes over four real SQLite
ledgers, signs each response with the installed Rosen guard ECDSA implementation,
and drives the real HTTP client through fresh, assigned and invalidated states.
That test captures the checkpoints delivered to its retention callback. A
separate bounded five-process run connects those actual route, ledger and signer
implementations to the real HTTP client, watcher SQLite watermark and signing
gate. It rejects one corrupt guard signature, changes source state only after a
guard signer reports that the request is pending, rejects fresh guard stores at
revision 0 after retaining revision 2 and reopening the watermark, then accepts
the same revision-2 state after another guard-worker restart. The source
inspection remains a fixture and the watcher process itself is not restarted;
the services also share locally controlled keys and data. This qualifies the
local producer-to-consumer and persisted rollback joins, not an independently
operated deployment.

### Credit-view filtering and reservation safety

The credit view is preflight filtering to reduce watcher commitments that guards
would later refuse. Ergo contracts do not verify these HTTP responses or store
checkpoints. The experimental signed response binds the queried backing and a
random request nonce, guard/store identity, claim state, configuration digest,
revision and state digest under its configured key. The client checks signatures,
scope, request binding and retained revision floors, within a local request
timeout. This proves response origin and request binding, not ledger currency,
completeness or operator honesty. The response has no authenticated issuance
time, expiry or source-tip anchor.

Every configured store must respond with unclaimed backing. One missing or
refusing store blocks admission, so the least available store has a liveness veto
and can selectively deny service. A majority-of-available fallback would change
the policy. Production acceptance must explicitly accept this availability cost
and require persistent per-store diagnostics: identity, request digest, received
time, authenticated checkpoint when available, and distinct unavailable, invalid,
claimed, rollback, conflicting and policy-stale outcomes. The current client
returns aggregate refusal categories; it does not provide that diagnostic history.
An unavailable response alone cannot distinguish deliberate denial from failure.

The local assignment is first-arrival-wins at each guard, with no global winner
rule. A bounded check against four real SQLite assignment stores starts with four
`new` responses, then delivers conflicting candidates in opposite orders: two
stores reserve A, two reserve B, and all refuse the other candidate. This proves
divergent reservations and loss of progress, not two released credits.

In the coordinated service candidate, Monero-to-Ergo credit requires 3-of-4
Ergo guard contributions, with assignment checked before each contribution. Two
conflicting sets of three guards intersect in at least two guards. With at most
one Byzantine guard, a fixed committee, durable non-rollbackable honest
reservations and active contribution hooks, an honest intersecting guard must
refuse the second credit. These are necessary assumptions, not a distributed
reservation implementation or a completed service qualification. The local
installed `ergo-multi-sig` 3.0.1 lacks the required hook and is rejected by the
candidate's version gate; the coordinated hook remains a separate draft.

The 2-of-4 Monero custody threshold concerns withdrawals, not issuance of credit
on Ergo. The tested withdrawal service fixes participants 1 and 2; it does not
implement arbitrary disjoint signer subsets. Two colluding holders can still
spend outside that software policy. Rosen must choose either an explicit halt
and reconciliation policy for reservation divergence or a reviewed inter-guard
agreement mechanism. Local sorting, timeout or invalidation cannot justify
automatically freeing a claim. The next service test must carry opposite-order
reservations through the actual Ergo contribution hooks and demonstrate the
absence of two conflicting 3-of-4 authorizations, including the blocked 2/2 case.

### Enrollment, equivocation and freshness

The SQLite watermark only protects history that a watcher has retained. An empty
watcher starts with no revision floor and accepts its first otherwise valid
signed snapshot. Opening a missing existing database already fails closed;
deleting the volume and explicitly bootstrapping again loses that history.
It needs an independently trusted enrollment checkpoint and a
defined store identity/incarnation and recovery policy before production use;
durability alone is not bootstrap trust. Key provisioning, rotation, endpoint
ownership and protected transport remain unqualified. Watchers must not receive
custody databases, spend shares or signing keys.

A watcher rejects a changed state digest at an equal retained revision. Two
watchers shown different signed states at that revision do not compare them in
the current implementation. Cross-watcher equivocation detection needs an
accepted receipt exchange, audit or transparency mechanism, with evidence
retention and an operator response. A larger revision is not proof of a current
snapshot, and a fresh nonce does not stop an operator signing an old state again.

The clocks currently have different authorities and starting points:

| Boundary | Clock and current rule | Limit |
| --- | --- | --- |
| Deposit intent admission | Authenticated `expiry_height`, interpreted as Monero height; admission checks `current tip + 1 <= expiry_height`. | Not a wall-clock deadline or an Ergo refund rule. |
| Credit-view request | Local elapsed request timeout and nonce binding. | No authenticated age or expiry of the returned ledger snapshot. |
| Guard pending-payment timeout | For events in `pendingPayment`, wall-clock timeout defaults to 24 hours from `firstTry`. | Not a deadline shared by all event states or derived from intent expiry or watcher commitment time. |
| Unmerged commitment redemption | Watcher policy uses Ergo confirmations, configured as 1,440; observation absence has its own invalid-commitment path. | The contract's WID-authorized self-redeem branch does not itself impose this timeout. |
| Trigger cleanup eligibility | Contract configuration uses 21,600 Ergo blocks from trigger creation, approximately 30 days at nominal spacing. | Enables the punitive cleanup branch, not automatic return of permits. |

No common deadline invariant connects these clocks. Production policy must choose
authenticated freshness anchors and age/skew limits, a source-tip agreement rule,
and an admission margin that leaves time for guard processing before the intent
expires. Watchers must not create commitments after the accepted processing
window has closed. Timeout or expiry must not release an existing reservation or
erase a signed/settled liability. Those policies and their cross-chain boundary
tests are acceptance gates, not implied by the present local timeout checks.

### Event identity and diagnostic receipts

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

The descriptor does not currently bind the proof-bundle bytes or store
checkpoints. For refusal diagnosis, the proposed service should retain an
authenticated sidecar receipt linking the event descriptor, immutable bundle
digest, request digest and each signed store response. That receipt is not yet
implemented. Store revisions must not simply be added to the common event hash:
honest watchers querying at different times can see different revisions for the
same unclaimed output. Any event-level proof-bundle commitment needs an accepted
canonical bundle schema and migration, distinct from per-reader diagnostics.

The existing watcher commitment and EventTrigger serialization include this
field; the guard compares the reconstructed descriptor with both the observation
and decoded trigger. This avoids changing the generic event/register format for
the experiment. **This overload needs Rosen's explicit schema approval:** RCS
defines `fromAddress` as the source address. Monero does not expose a dependable
sender address to reconstruct. The proposal is to accept the typed descriptor
and audit every consumer, including watcher UI/API, third-party monitors, displays
and refund paths; alternatively Rosen can
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

For the proposed service contract, observing a memo creates a durable pending
candidate, not an admissible event. Readers must obtain and validate the complete
matching intent, proof and holder-certificate bundle before producing any
commitment. Missing or late components leave it pending with a visible
`proof-unavailable` state and bounded retry/backoff until its authenticated
expiry; expired or invalid evidence cannot commit. Retrieval must address an
immutable, digest-bound bundle rather than silently replacing bytes under a txid.
The holder certificate must bind the same output and intent; mixing versions or
conflicting valid bundles for one candidate must stop admission and raise an
alert. A watcher with all valid evidence may advance while another waits;
arrival times and local retrieval identifiers must not enter the event hash.
Every eventual commitment must reconstruct the same descriptor, while each
reader rechecks current canonical state, expiry and novelty. Unavailable readers
can therefore stall the quorum; availability is not solved by determinism.
Local source/proof tests cover reversed endpoint completion order, missing or
faulty evidence, expiry, restart and a source reorg while admission waits. A
separate two-database test runs two real admission consumers, two observation
extractors/candidate stores and four SQLite connections. Opposite availability
of the atomic intent/proof envelope and certificate produces no observation;
after completion in reversed order, both stores persist the same 16 observation
fields without duplication. Evidence completed after expiry still produces no
observation and does not invoke proof verification. The network, native observer
and proof-verifier ports use existing synthetic fixtures, and the current API
carries intent and proof together in one envelope. This therefore does not prove
three independently arriving components, HTTP/node compatibility, cryptographic
proof validity, independently operated watchers or equal signed event bytes.
Production acceptance still needs that service-level two-watcher exercise,
including a missing reader and conflicting delivery, demonstrating equal
commitments or no commitment as appropriate.

Copied output keys are not resolved by globally blacklisting every repeated
key: that could let an unrelated copied output disable an authenticated deposit.
The selected backing policy verifies the intended receipt and tracks one
economic claim. The lab tests both raw and decodable copies, including the copy
appearing first. The [historical-failure coverage map](https://github.com/a-shannon/docs/blob/9466cf2fadd266f20e927da938e074b8ef60dacf/r-and-d/monero-integration/roundtrip/burn-coverage.md)
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

### Confirmation and reorg policy

Ten confirmations are a fixture setting, not economic finality. The
[first-party reorg archive](https://github.com/WeebDataHoarder/Monero-Timeline-Sep14/tree/5fc8a5b9b43e4ba6e446728048a9973c4da167e1)
records 18 orphaned blocks on 14 September 2025 and 10 on 18 September 2025.
Choosing a number above those observations would still not guarantee finality.
Rosen must select a risk-based production depth, exposure limits and emergency
pause/recovery ownership separately from Monero's output unlock rules.

The service integration must distinguish these cases:

| Source reorg timing | Required response |
| --- | --- |
| Candidate only | Invalidate the removed occurrence and rescan. Reinclusion requires fresh canonical evidence and the full confirmation policy. |
| Unmerged watcher commitment, no credit released | Stop advancement and reject the stale descriptor. After deletion of the observation, the existing watcher invalid-commitment path can self-redeem the unmerged commitment using its WID. Source rollback alone does not spend it. |
| Trigger exists, no credit released | Stop advancement and reject the stale descriptor. RWT already merged into the trigger remains locked until that trigger is spent. There is no autonomous expiry-and-return branch. The reported cleanup behavior is punitive; the proposed non-punitive resolution below remains an RCS decision and qualification gate. Unmerged commitments remain a separate case. |
| Credit already released, or signed destination payment exists | Retain the liability and permanent output-key/image uniqueness claims, quarantine affected backing and pause affected releases pending reconciliation. Do not assume source rollback reverses destination settlement or authorizes another payment. |

At [contract `d451b36`](https://github.com/rosen-bridge/contract/blob/d451b367ea87efa4c8f770c5af8f3a75b5629848/src/main/scala/rosen/bridge/scripts/EventTrigger.es#L16),
the trigger can return permits with a guard-authorized Lock input or create Fraud
boxes after the cleanup delay. [Lock](https://github.com/rosen-bridge/contract/blob/d451b367ea87efa4c8f770c5af8f3a75b5629848/src/main/scala/rosen/bridge/scripts/Lock.es#L1)
requires the guard quorum; it does not itself prove an external payment. Thus a
non-punitive guard-authorized return may fit the existing permit branch, but no
service workflow for refusing a Monero trigger that way is qualified here.
[Commitment self-redemption](https://github.com/rosen-bridge/contract/blob/d451b367ea87efa4c8f770c5af8f3a75b5629848/src/main/scala/rosen/bridge/scripts/Commitment.es#L102)
does not require the trigger to have been spent; the
[watcher policy](https://github.com/rosen-bridge/watcher/blob/f478f6c07cfebde0a51053c33c484235ba9d0c11/src/utils/watcherUtils.ts#L432)
treats a missing observation as an invalid commitment.

Cleanup creates Fraud boxes before a separate slash transaction removes the RSN
backing the returned RWT; this is not a refund guarantee or immediate destruction
of every watcher's entire collateral. The public cleanup service at
[`3b3cdb5`](https://github.com/rosen-bridge/cleanup-service/blob/3b3cdb596516abc1ffaa53e0c6c6925fbc87ee39/src/main/scala/rosen/cleanup/Procedures.scala#L29)
attempts cleanup based on age without classifying source reorg versus fraud.
Its embedded register and transaction-input layouts predate `d451b36`, so that
source alone does not establish compatible or deployed cleanup behavior.
In his [29 September operator follow-up](https://github.com/rosen-bridge/docs/pull/1#issuecomment-5890465995),
Odiseus reports the Rosen team's Telegram clarification: a guard-rejected trigger
remains unspent and, if still unspent at cleanup-confirm, is fraud-spent without
re-verifying the event. This is reported operational behavior, distinct from a
verified deployment/version pin. It makes punitive cleanup of a rejected trigger
an explicit operator exposure; rejection does not itself establish watcher fault.
Activation still needs the actual cleanup version/configuration and an accepted
resolution policy. Neither a depth above the observed 18-block orphan nor a future
cleanup timer resolves that decision by itself.

### Operator proposal for refused triggers and reservation stalls

The same follow-up recommends making non-punitive terminal return a precondition
for Monero activation. It proposes distinguishing attributable watcher fraud from
source reorg after a valid commitment, guard-side reservation/store refusal,
proof expiry after a timely valid commitment, and guard unavailability. The latter
cases would return merged permits without slashing. This is an operator proposal
for Rosen's review, not an accepted protocol or implemented recovery mechanism.
It requires evidence of validity at commitment and attributable fault; a published
refusal label or an event missing from a current source view is not that evidence.

The proposed return window is substantially shorter than cleanup-confirm, with
its relationship to the guard's pending-payment timeout made explicit. A stall
before commitment has no on-chain permit lock from that candidate; a stall after
trigger creation exposes merged permits to both lock-up and punitive cleanup.
A deadline can make a return eligible, but cannot guarantee execution when its
required guard quorum is unavailable or the chain is not progressing. Rosen must
accept an authorization and recovery path for those conditions. Any terminal
return must exclude subsequent payment or punitive cleanup of the same trigger,
reconcile already-produced signatures and preserve outstanding liabilities.

For competing reservations, Odiseus proposes the earliest eligible Ergo trigger
for the same backing, ordered by height and a fixed tie-break such as box ID.
This option needs a common canonical view, accepted finality, complete visibility
of competing triggers, and shared backing identity and eligibility rules.
Ordering alone supplies none of those guarantees. Replacing a reservation with
an earlier winner must not invalidate the honest durable-claim assumption of the
3-of-4 credit argument: no timeout or newly discovered trigger authorizes freeing
backing after a contribution, signature or uncertain settlement. A losing trigger
would need the same qualified non-punitive terminal path, not a local database
reset. The proposal remains unimplemented while RCS review is pending.

As an interim operator measure for existing chains, the follow-up suggests
withholding automatic fraud spends for recorded guard-side refusals. That is a
policy for Rosen to assess, not an instruction to change live cleanup. Indefinite
withholding leaves permits locked and permits accumulation/capacity attacks;
any accepted measure needs bounded escalation, an owner and explicit manual
resolution and resumption rules. Trigger-level visibility should distinguish
paid, refused with reason, return pending/completed and cleanup scheduled, with
blocks remaining to cleanup-confirm. A status label is diagnostic evidence,
not proof that recovery or fault attribution has been completed.

Reinclusion changes the occurrence's block anchor; it must not create a second
economic credit. The pinned lab exercises source replacement and post-credit
quarantine, but production watcher commitment/trigger cleanup, a reorg racing
release and reserve-wide recovery still need qualification through the actual
services. A short fakechain reorg demonstrates the transition, not resilience
to every public-network attack depth.

### Node access and operator visibility

The proposed first deployment requires **two independent daemon views per
watcher**, not necessarily two locally hosted daemons. One operator-owned
`monerod` plus a second independently administered daemon is a possible topology;
two URLs backed by one node or operator do not establish independence. Neither
endpoint may be silently dropped on disagreement or outage. Endpoint ownership,
historical availability and failover policy need acceptance and a live trial.

Agreement on a block is not proof that either daemon is current. Two views can
agree on a stale fork, and the current guard source adapter revalidates through
its single configured connector. Its block/tip consistency checks do not establish
independent chain agreement or a freshness bound. Before qualification, select
the independent reference views, acceptable tip age/lag and disagreement rules,
then bind and recheck that accepted source context at each release contribution.
Exercise two agreeing stale views, one lagging/unavailable view, and a reorg
during authorization. Depth-only acceptance cannot pass those cases.

Use restricted RPC bound to loopback for local watcher access. Remote comparison
access requires an authenticated private tunnel or equivalent protected channel
to the remote restricted interface; do not expose an unrestricted daemon RPC.
Qualify every required RPC under that restriction, including historical
transaction/output retrieval and key-image spentness, rather than relaxing the
restriction to make the adapter run.

A pruned daemon still validates the chain and retains its transaction history,
but removes most old ring-signature data ([Monero pruning documentation](https://www.getmonero.org/resources/moneropedia/pruning.html)).
That is not yet proof that this adapter's complete historical replay works on
pruned responses. Qualify scanning, output indices, proof verification,
spentness, restart/rescan and reorg recovery on genuinely pruned old data; if
any consumer needs unavailable full bytes, require an archival source explicitly.
Pruned-only deployment remains unqualified until that check passes.

For initial budgeting, the [official node guide](https://docs.getmonero.org/running-node/monerod-systemd/#assumptions)
recommends 4 GB or more RAM and available SSD capacity of 625 GiB or more for a
full node, or 250 GiB or more for a pruned node. Its measured chain sizes are
dated 20 January 2026; these are provisioning references, not measured Rosen
requirements or a forecast for FCMP++/Carrot. Budget each hosted node separately,
plus watcher databases, proof retention, logs, growth and rescan headroom; record
peak RAM, disk and catch-up time against the actual deployment version.

Watcher sync health must ship with the first service join. Report source tip and
scan lag, last agreed block, endpoint disagreement/unavailability, missing or
invalid proof, unavailable/stale credit view, reorg quarantine and unsupported
protocol as separate degraded or blocked states. Surface them in the watcher
API/UI and monitoring integration; a healthy daemon or reserve balance must not
hide blocked admission. Display the 2-of-4 holder / 3-of-4 approval distinction
and render the origin descriptor as non-sendable in operator and user views.

### FCMP++/Carrot migration gate

The [signing note's protocol boundary](monero-signing.md#protocol-upgrade-boundary)
identifies the upstream work and the missing integration. At upstream
`monero-oxide` commit
[`77788c368145127f2dde2ac3e2ddce919f3ddd01`](https://github.com/monero-oxide/monero-oxide/tree/77788c368145127f2dde2ac3e2ddce919f3ddd01),
the modern and legacy SAL threshold primitive tests both pass under the locked
`multisig` feature. Those tests exercise the two signing/verification primitive
paths; they do not qualify a post-fork wallet spend engine. The pinned wallet/send path
still constructs and completes CLSAG transactions and has not demonstrated a
node-accepted FCMP++/Carrot transaction, including for an old vault output.
Before any deployment, assign an upgrade owner and a halt/drain plan that leaves
time to stop new deposits and settle outstanding liabilities while the qualified
spend path remains valid.
If a replacement is unavailable, remain paused; keeping old outputs is not a
migration strategy. Production certificate and event formats must bind an
explicit protocol/profile version, with unknown versions refused and accepted
legacy verification rules preserved for reconciliation. Adding a field alone
does not migrate existing certificates, key images, uniqueness records or keys.

## Decisions requested for RCS review

The requested review is acceptance or correction of this integration profile:

1. Public lock metadata plus an auxiliary payment-proof and holder-certificate
   channel, including its provisioning, retention and retrieval authority.
2. One selected output per deposit, with the origin descriptor preserved through
   extraction, agreement, API/display and credit consumers.
3. Rust threshold CLSAG custody, including the guard-to-holder mapping,
   cryptographic threshold, fault assumptions and recovery ownership above.
4. Effective-fee and confirmation policies, post-commitment reorg handling,
   including whether non-punitive terminal return is an activation precondition,
   supported wallet/address forms and independently administered source endpoints.
5. Authenticated watcher credit-view delivery, immutable proof-bundle timing,
   including enrollment anchors, cross-watcher equivocation evidence, per-store
   visibility, explicit clock/freshness rules and a reservation-divergence policy;
   the operator's Ergo-ordering proposal remains subject to the boundaries above.
6. Node/pruning qualification, current independent source agreement at guard
   contribution, and an owned FCMP++/Carrot migration or halt plan.

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
Monero payout and confirmed Ergo reward distribution with two watcher processes
in each direction and four guard processes. The actual Rosen processor records
the reward transaction and return event as `completed`. Lost replies and four-guard
restart recover the retained signed bytes without signing another payout or
reward. The selected reserve subsidizes miner fees; one-operation
reconciliation does not establish reserve-wide solvency. The [multisig review packet](https://github.com/a-shannon/docs/blob/9466cf2fadd266f20e927da938e074b8ef60dacf/r-and-d/monero-integration/roundtrip/multisig-review.md)
records the completed independent local implementation review, exact code and
replay scope. It does not constitute a commissioned cryptographic audit or Rosen
acceptance of the integration.

The present experiment fixes one qualifying output per deposit transaction,
local fakechain/devnet nodes, fixture assets, a local ceremony, a selected signer
pair and deterministic rings. It does not qualify public-network operation,
pooled-vault solvency, production decoy selection, fee autonomy, committee
rotation or FCMP++/Carrot migration. The public code is available for review and
reproduction while those integration decisions remain open.
