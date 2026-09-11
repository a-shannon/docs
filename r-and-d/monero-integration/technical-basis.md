# Monero integration — technical basis and evidence

A. Shannon · 11 September 2026

This appendix supports the [integration RFC](../monero-integration-plan.md). It separates observed software behaviour, proposed protocol obligations and the theoretical alternative for robust progress. Source links refer to the examined revisions, not to a claim about currently deployed binaries.

<a id="native-validation"></a>

## 1. Bounded native experiments

Two separate scenarios were executed locally against the official Monero Windows v0.18.5.1 binaries, associated with source revision `4f92268d7c16741cfb41e5bbe2aa46cc260a9ea5`. The release archive SHA-256 was `cf2ae8273977697d9ef2031c7337b781e6e5936578f602444b2990a173a2437d`. The daemon reported `fakechain`, offline operation and zero peers. No real XMR was used.

The [execution record](native-results.json) is supplied unchanged, SHA-256 `70c24cddbd9668de9cdfb439b0242095c72e48c0104313f53f5a3f90b4f6cc81`. It records observations from that run; it is not a complete independently replayable environment or an end-to-end Rosen test.

| Scenario | Observed result | Boundary |
|---|---|---|
| Outgoing transaction proof | Monero verified the original message and rejected a modified message | This establishes the tested proof/message binding, not durable credit authority |
| Incoming proof from a view-only wallet | Monero accepted the proof; the proposed outgoing-only admission policy rejected it | Cryptographic validity alone does not select the correct authority for a bridge instruction |
| Receipt admission | Mempool and locked-output candidates were rejected; an exact mature unspent receipt at 11 confirmations was accepted | Receipt and proof were checked in the local experiment; adversarial output duplication and reorgs were not exercised |
| Policy negatives | Wrong vault, changed amount and an already-credited receipt supplied to the policy were rejected | These modified policy inputs were not adversarial transactions on chain |
| Native 2-of-4 multisig | Four wallets completed setup/synchronization; two signed the payment | This does not show operation when only two participants are available throughout |
| Multisig refusals | Own-only and insufficient imports, submission with only the creator contribution, and signing a frozen input were refused | These specific observations do not establish all failure/recovery cases |
| Payment inspection and conservation | A second signing wallet inspected the payment; 0.1 XMR input = 0.05 payment + 0.0018084 fee + 0.0481916 change | The second wallet used the same machine and daemon; it was not an independent operator/infrastructure test |

The successful sequence took about 72 seconds, excluding environment preparation and diagnosis. This was one local observation, not a throughput benchmark. The record contains 26 logging events, not 26 independent tests. Its `duplicate_peer_import` event has `tested:false`; the inherited 3-of-5 wording is obsolete. Neither duplicate-peer rejection nor a 3-of-5 scenario was executed.

An initial run stopped before the scenarios because of the synthetic hard-fork schedule. The harness was aligned with the official functional-test use of `--allow-mismatched-daemon-version`, confined to the verified fakechain environment. This initialization error has no cryptographic implication. The separate local policy/parsing suite recorded 29 passing tests; those tests do not execute the native daemon themselves.

Primary reference paths: [native multisig functional tests](https://github.com/monero-project/monero/blob/4f92268d7c16741cfb41e5bbe2aa46cc260a9ea5/tests/functional_tests/multisig.py), [functional-test RPC runner](https://github.com/monero-project/monero/blob/4f92268d7c16741cfb41e5bbe2aa46cc260a9ea5/tests/functional_tests/functional_tests_rpc.py#L53), and [wallet proof routines](https://github.com/monero-project/monero/blob/4f92268d7c16741cfb41e5bbe2aa46cc260a9ea5/src/wallet/wallet2.cpp#L13079).

<a id="protocol"></a>

## 2. Economic identity and protocol obligations

The proposed economic identifiers and transition rules are specified in RFC sections 4 and 10. Deposit identity is `(Monero network, txid)`; output identity is `(Monero network, one-time public output key)`. Inclusion blocks and vault epochs do not reset consumed identities.

Unique credit requires one ordered, durable assignment and an idempotent destination consumer. A unique database row alone does not prove that its external credit effect occurs once. A withdrawal must extinguish or immobilize the source claim, retain its debt while execution is uncertain, and reserve the actual inputs before authorization becomes executable.

For fixed genuine input key images, two payments cannot both settle in one accepted canonical Monero history. This supports the proposed single-plan and payment-family invariants. It does not permit a new payment from independent inputs after a timeout. The available reserve and fee budget must cover all outstanding claims without counting the same value twice.

These are proposed composition obligations. Their concrete Rosen consumers must be validated before the model can describe the integrated implementation. A finite confirmation count also cannot guarantee coverage against arbitrarily deep source-chain reorgs after irreversible destination credit; the accepted-history and loss-treatment assumptions remain explicit.

<a id="rosen"></a>

## 3. Existing Rosen interfaces

Rosen already supplies event verification, comparison with expected payment orders, agreement over transaction contents, persistent transaction status and recovery paths. The integration extends these boundaries rather than assuming that agreement is absent.

| Boundary | Examined source |
|---|---|
| Source-event extraction and rollback | [AbstractObservationExtractor](https://github.com/rosen-bridge/scanner/blob/7d008b2dc9e2deeea830a890643e2edc82896114/packages/abstract-observation-extractor/lib/extractor/abstractObservationExtractor.ts#L63) |
| Independent source-event verification | [EventVerifier](https://github.com/rosen-bridge/guard-service/blob/1edc2fb982de4560c5265e04e2ed8b93d00b40df/services/guard-service/src/verification/eventVerifier.ts#L15), [AbstractChain.verifyEvent](https://github.com/rosen-bridge/guard-service/blob/1edc2fb982de4560c5265e04e2ed8b93d00b40df/packages/abstract-chain/lib/abstractChain.ts#L164) |
| Payment inspection and agreement | [TransactionVerifier](https://github.com/rosen-bridge/guard-service/blob/1edc2fb982de4560c5265e04e2ed8b93d00b40df/services/guard-service/src/verification/transactionVerifier.ts#L83), [transaction hash](https://github.com/rosen-bridge/guard-service/blob/1edc2fb982de4560c5265e04e2ed8b93d00b40df/services/guard-service/src/transaction/transactionSerializer.ts#L25), [TxAgreement](https://github.com/rosen-bridge/guard-service/blob/1edc2fb982de4560c5265e04e2ed8b93d00b40df/services/guard-service/src/agreement/txAgreement.ts) |
| Entry into signing and uncertain outcomes | [TransactionProcessor](https://github.com/rosen-bridge/guard-service/blob/1edc2fb982de4560c5265e04e2ed8b93d00b40df/services/guard-service/src/transaction/transactionProcessor.ts#L31), [validity/signing contracts](https://github.com/rosen-bridge/guard-service/blob/1edc2fb982de4560c5265e04e2ed8b93d00b40df/packages/abstract-chain/lib/abstractChain.ts#L281) |
| Settlement synchronization | [EventSynchronization](https://github.com/rosen-bridge/guard-service/blob/1edc2fb982de4560c5265e04e2ed8b93d00b40df/services/guard-service/src/synchronization/eventSynchronization.ts#L366) |
| Distinct authorities and thresholds | [GuardPkHandler](https://github.com/rosen-bridge/guard-service/blob/1edc2fb982de4560c5265e04e2ed8b93d00b40df/services/guard-service/src/handlers/guardPkHandler.ts#L40), [Ergo parameters](https://github.com/rosen-bridge/guard-service/blob/1edc2fb982de4560c5265e04e2ed8b93d00b40df/packages/chains/ergo/lib/ergoChain.ts#L1023), [external threshold conversion](https://github.com/rosen-bridge/sign-protocols/blob/e8b6fb0a0f6dda7813d885b142f0bd11c9578867/packages/tss/lib/tss/tssSigner.ts#L69) |

The proposed additions include durable reservations before exposed approvals, conditional ownership of the current signing candidate, an explicit uncertain execution state, and the verified relationship between authorized payment, signed bytes and native settlement hash. These are requirements to implement or establish in the selected code base, not guarantees inferred from the interface names.

<a id="ki"></a>

## 4. Output–key-image construction

RFC section 5 gives the proposed component DLEQ construction. The native mapping uses the post-aggregation scalar components and the output derivation term. Every component proof and the exact public sum must be checked; custody and availability additionally require authenticated setup and participant assignments.

Primary native paths: [aggregation coefficients and component keys](https://github.com/monero-project/monero/blob/4f92268d7c16741cfb41e5bbe2aa46cc260a9ea5/src/multisig/multisig_account_kex_impl.cpp), [partial key-image generation](https://github.com/monero-project/monero/blob/4f92268d7c16741cfb41e5bbe2aa46cc260a9ea5/src/multisig/multisig.cpp), [output derivation](https://github.com/monero-project/monero/blob/4f92268d7c16741cfb41e5bbe2aa46cc260a9ea5/src/cryptonote_basic/cryptonote_format_utils.cpp), and [native hash-to-point and key-image routines](https://github.com/monero-project/monero/blob/4f92268d7c16741cfb41e5bbe2aa46cc260a9ea5/src/crypto/crypto.cpp#L611).

Proof references: [Chaum–Pedersen, Wallet Databases with Observers, §3.2](https://chaum.com/wp-content/uploads/2021/12/Wallet_Databases.pdf), [RFC 9497, §§2.1–2.2](https://www.rfc-editor.org/rfc/rfc9497.html), and [RFC 8235, §5](https://www.rfc-editor.org/rfc/rfc8235.html). RFC 9497 is a reference for the DLEQ structure, not a drop-in Monero group suite.

This construction and its source mapping have been reviewed conceptually. The proposed distributed proof producer, canonical verifier and checks through imported state, construction sources and `vin.k_image` have not been implemented or executed as an integrated adapter.

<a id="preparation"></a>

## 5. Native preparation and restoration

The examined [wallet construction path](https://github.com/monero-project/monero/blob/4f92268d7c16741cfb41e5bbe2aa46cc260a9ea5/src/wallet/wallet2.cpp#L10312) reaches the creator's initial contribution before returning a multisig transfer. The proposed separation is therefore a native extension, not an interpretation of `do_not_relay` as unsigned preparation.

The relevant implementation boundaries are [multisig_tx_builder_ringct.cpp](https://github.com/monero-project/monero/blob/4f92268d7c16741cfb41e5bbe2aa46cc260a9ea5/src/multisig/multisig_tx_builder_ringct.cpp) and [multisig_clsag_context.cpp](https://github.com/monero-project/monero/blob/4f92268d7c16741cfb41e5bbe2aa46cc260a9ea5/src/multisig/multisig_clsag_context.cpp). The proposed private capsule preserves the exact prepared context and random choices, followed by typed reconstruction and verified authorization before contribution.

The native first-contribution calculation can be followed in these sources. This does not mean that a persistent capsule API, restoration differential or crash-safe wrapper exists. The detailed producer/consumer contract and its validation tasks are in RFC sections 6, 9 and 11.

<a id="journal"></a>

## 6. Durable results, nonces and recovery

RFC section 6 specifies private durable result R, durable nonce retirement W, durable release authorization A, then exposure of R. The native source establishes why persistence must be checked at the actual boundary: [clear_multisig_k_and_store](https://github.com/monero-project/monero/blob/4f92268d7c16741cfb41e5bbe2aa46cc260a9ea5/src/wallet/wallet2.cpp#L15208) writes conditionally on in-memory changes, while [multisig export](https://github.com/monero-project/monero/blob/4f92268d7c16741cfb41e5bbe2aa46cc260a9ea5/src/wallet/wallet2.cpp#L15286) renews wallet-wide nonce material.

A failed store after clearing memory cannot be treated as successful retirement merely because another conditional clear call returns. A private result also must not become accessible to other participants through a shared view-key encryption envelope before A. Freshness, worker exclusion, reservations and recovery ownership must be enforced across the application/native join.

No integrated journal, capsule restoration or crash-injection campaign has been executed. Under the native route, loss of the sole usable creator state can still suspend a payment indefinitely. Safe suspension is distinct from guaranteed progress.

<a id="robust"></a>

## 7. Robust alternative and conditional existence

RFC section 7 describes a different construction: ordered economic authorization, a robust distributed vault computation and payment families with fixed authentic inputs. Fresh sessions may produce new members of the same family; the native exact-result retry rule is not reused for that route.

Agreement with safe recovery has a primary reference in [Castro–Liskov, Practical Byzantine Fault Tolerance](https://www.usenix.org/conference/osdi-99/practical-byzantine-fault-tolerance). The computation witness uses [Asharov–Lindell, the corrected full BGW proof, revision 5 of 12 June 2022](https://eccc.weizmann.ac.il/report/2011/036/revision/5/download), theorem 1 and §8: static malicious faults below one third, synchronous private channels and robust output delivery under the specified model.

For the four-party/one-fault witness, the degree-one sharing reconstructs from two correct shares; an economic quorum of three does not turn it into 3-of-4 custody. A secure-with-abort implementation would not establish the required output delivery. The concrete Monero computation, costs, stateful composition and operational fault profile remain implementation gates.

The theoretical result supports feasibility under these hypotheses. It does not remove chain-inclusion assumptions, finite liquidity and fee budgets, key/state preservation requirements or the accepted finality model.
