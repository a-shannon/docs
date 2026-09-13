# Monero watcher and guard authority increment

A. Shannon — 13 September 2026

**The full local roundtrip passed with actual watcher commitment/reveal transactions in both directions and distributed credit authorization.** The frozen successor to revision `93d169f58f5d9671831a0f5f5a8a62ad959ba555` completed its linked test in 153.1 seconds. Its launcher verified the declared source, dependency, executable and configuration inputs before and after execution with no changes.

The [full receipt](evidence/watcher-authority-roundtrip.json) records the following local-chain transactions; they are not public explorer identifiers:

| Stage | Transaction |
| --- | --- |
| Monero deposit | `3e79f0a4458f4200df9df7ea9113906d0154bb88ae6e50c58c99222b6ee92549` |
| Ergo credit | `4cab3b3cd6643818a3ec13e4c782b4a3d5d5f9c058408cb8623219763fb8b150` |
| Exact credit-box redemption | `74d3a5b25fef5ceac0951a16ff68e2ab8a11a28f89ceda1a82d241541fc30f41` |
| Return watcher trigger | `886f7de56712d070c2ee477561b5128780f00b2c5eab3af8e8373e2875fcbfd9` |
| Monero payout | `96f11ec67f9ec72d41cd6de870ab8e15d3fa30be19652b4378e2244ab8eaeff6` |

Credit used four native Ergo commitments and three partial signatures, with all four guard instances completing identical transaction bytes. Eight fresh native reader calls checked the source, twice per guard. Reopening credit custody returned the same transaction with zero new commitments or reader calls. The Monero payout used one signing call, two original-holder shares and one submission, survived a lost submission reply and restart, and reached durable settlement. These are exercised local behaviors, not a general security or availability claim.

## Source verification and watcher transactions

Each watcher receives the raw deposit request and runs policy verification separately. Its receipt provider launches a fresh pinned native process that checks the supplied transaction bytes, canonical inclusion, output public key P, amount, maturity and output-key uniqueness across the complete local fixture history. Genesis and the frozen tip are checked around the scan. A nonce and a domain-separated digest bind the response to the exact public scan request, including its snapshot, transaction bytes and supplied key image. The existing native OutProofV2 checker remains a fresh verification call on the requested intent bytes.

This is a local fixture with a fixed public view profile. The public reader explicitly returns `imageAssociationVerified: false`: it checks the spent status of the supplied image but does not prove that image belongs to P. Two original Monero holders supply the separately checked image association. Neither a public-reader receipt nor a successful proof check replaces that holder responsibility. The implementation and strict response checks are in [the independent source provider](source/consumer/independentDepositSource.mjs) and [native reader](source/native/src/public_source_observer.rs).

[The watcher host](source/ergo-node/watcher-runtime.mjs) executes `CommitmentCreation.job` and `CommitmentReveal.job` from watcher version 6.3.2, pinned to `13b4c76ee7803bdf5f052e33cdc12b66acac2db0`. Two distinct WIDs create commitments by spending real Permit and WID boxes. The reveal transaction spends both commitment outputs and reads the actual RepoConfig and RWTRepo data boxes. The fixed repository formula requires two commitments, with ten RWT per commitment. The combined replay exercised this path in both directions.

Each watcher has its own durable host observation and signed-transaction journal. Signed bytes and transaction identity are retained before submission, so an ambiguous submission is reconciled against the retained candidate. This is a bounded host integration of actual watcher jobs. It does not establish integration with the complete upstream watcher daemon, its scanner database or its operational cache.

## Guard-owned credit authority

The committee fixes n = 4, q = 3 and f = 1. It enforces `2q > n + f`: two quorums intersect in enough members that at least one honest guard must occur in their intersection under the stated fault assumption. That argument depends on each honest guard retaining its assignment state and refusing a conflicting assignment; quorum arithmetic alone does not prevent double credit.

[Each guard's assignment ledger](source/guard-service/src/db/moneroCreditAssignment.mjs) binds the economic identity `(source network, P)` to one obligation and the exact credit transaction, source intent, trigger, policy and committee digests. The transaction locator is evidence, not the economic uniqueness key. Multiple outputs are claimed atomically, and a conflicting obligation cannot release a previously assigned P. Invalidation is terminal; transport cleanup and elapsed time do not free assignments.

[The signer mediator](source/guard-service/src/deposit/moneroCreditSigner.mjs) takes an exact snapshot before awaiting verification. Each guard independently rechecks the raw Monero request, primary Ergo input bytes and unspent state, the active GuardSign box and its four keys, threshold registers, the consumed trigger and WID digest, and the intended recipient, amount and rewards. It recomputes the Ergo reduction and checks [the complete output policy](source/ergo-node/credit-output-policy.mjs), including miner fee and permitted residual lock outputs. Final retained-assignment and authority-open checks precede both native commitment generation and partial signing. Fresh canonical source checks run during admission and before credit submission; the synchronous contribution gate checks retained authority and known invalidation, not a new chain scan at each prover call.

The four Ergo guards are separate JavaScript multisig instances with separate ledgers within one JavaScript host process. They should not be confused with the four Monero holder processes used by the existing participant ceremony and withdrawal path. This run does not demonstrate four independently administered guard machines.

## Recovery, return admission and validation

[Credit recovery](source/ergo-node/credit-recovery.mjs) observes all four retained assignments. An unconfirmed candidate needs fresh source and payment verification plus current assignments before the exact retained transaction is submitted. A transaction already confirmed after an invalidation can be identified, but its result is quarantined rather than treated as fresh authority. Missing or inconsistent guard custody fails closed.

[Return admission](source/ergo-node/return-authority.mjs) reconstructs the redemption from the primary Ergo node and checks the exact credit-box spend. It then verifies both watcher commitment transactions, their WIDs and digests, the trigger's commitment spends, full extracted source fields, canonical inclusion and current unspent trigger. A claimed watcher receipt does not itself authorize the return path.

The focused suites record 85 passing tests across the following boundaries. They include native, injected-port and controlled-ledger tests, as distinguished below; they are not 85 end-to-end executions or a bridge-security score.

| Producer → consumer | Preserved invariant | Evidence |
|---|---|---|
| Native reader → receipt policy | Exact nonce, source bytes, snapshot, P, amount and image nonclaim | 3 native + 4 provider checks |
| P assignment → native contribution | Atomic economic uniqueness, exact candidate and terminal state | 10 assignment + 7 signer checks |
| Guard verifier → Ergo multisig | Fixed committee and complete payment outputs | 4 committee + 11 output checks |
| Retained credit → recovery | All four assignments; no new authority from confirmed bytes alone | 11 recovery checks |
| Watcher jobs → return admission | Two distinct commitments, exact redemption and primary trigger | 4 watcher + 4 return + 5 return-authority checks |
| Launcher/diagnostic ports → owned runtime | Scoped execution, exact framing and bounded telemetry | 18 launcher + 4 proxy checks |

The successful combined replay is pinned to the [341-file manifest](source/source-manifest.json), SHA-256 `295620fd3591ff89fb29805b6963d18360d13a99931b9916ba5f0c82b32ef835`, aggregate source digest `2f7d21b4d892dea82092e4768dd1b9955a95d1aac3a4f929b8f95185aebaf918`. The [qualification record](evidence/watcher-authority-qualification.json) binds the run and component-source pins. The unchanged original native signing and withdrawal suites remain prior evidence; their new composed input path is exercised here.

## Remaining qualification

This remains a prototype and has not been merged upstream or qualified for production. Watcher cache integration, concurrent-request recovery and availability with an absent guard remain unqualified. Guard-ledger absence is rejected, but rollback to an older valid database is not detected. Committee rotation, general key management and FCMP++/Carrot migration require separate designs and evidence.

After settlement, the test used Monero's [`/pop_blocks` endpoint](https://docs.getmonero.org/rpc-library/monerod-rpc/#pop_blocks) to reduce local chain height from 160 to 97, removing the deposit's canonical block. Explicit invalidation then quarantined the already-confirmed Ergo credit, retained all four output claims and generated zero new commitments. This proves controlled history removal and retained liability. It does not implement automatic reorg detection, reverse an issued Ergo credit, or qualify competing network fork selection.

Amounts are fixture economics: 500,000,240 atomic units deposited, 500,000,120 credited and 500,000,000 delivered on return. The payout also consumes a mined fee-funding input; its miner fee is 2,599,200,000 atomic units. This is not a sustainable fee model or liquidity reconciliation demonstration. Deployment still needs operational fee funding, reconciliation, custody/recovery procedures, a qualified migration path and external security review.
