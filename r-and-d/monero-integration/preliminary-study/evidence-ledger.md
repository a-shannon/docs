# Evidence ledger and preliminary-study completion

A. Shannon · 13 September 2026

## How to read the evidence

The results below are scoped observations from the investigation. Counts are
per recorded checkpoint and often overlap through inherited tests. **Do not add
them into a total number of independent tests.** A test name does not establish
that a fault reached the intended boundary; deciding observations and reviews
matter more than the count.

An independent replay means a separate review session executed the selected
case against its stated source closure. It is not an upstream maintainer
endorsement, an external professional audit, a second cryptographic implementation
or production certification. Some rows have source/evidence review without
independent runtime replay; those limits are explicit.

This publication is the findings and evidence inventory. Detailed working
artifacts were retained separately; the original source/RPC exploration is
available in the [existing RFC](https://github.com/rosen-bridge/docs/pull/1).
The full subsequent fixture suite is not distributed with this document. Thus
local experiment results remain reported results until a portable, sanitized
source/fixture package is published and readers replay it. Hashes identify
retained artifacts; they are not proof of execution or public availability.

## Representative native and engine results

| Checkpoint | Executed result | Evidence ceiling / remaining work |
| --- | --- | --- |
| N0 | Pinned native Monero build; 29 selected multisig tests | Current-protocol component baseline, not service integration |
| N1 | Initial signer state destroyed/restored; contribution reproduced; final native verification. Recorded 29 core cases, 25 isolated state mutations and eight code mutants | Same-session native recovery relation; not arbitrary fresh-worker or distributed recovery |
| N2b2a-03 | Four native storage scenarios, 49 storage assertions, 64 inherited capsule assertions, four external signal-9 stops, actual LMDB-full failure and 18 mutants | Executed allocation profile 24, not source maximum 96. Freshness authority synthetic; managed wallet/signing release not fully joined |
| K1a-02 | Component DLEQ validation, exact output/setup association and reconstructed key image; 16 unit cases and 13 mutants | Independent source/evidence review, not independent native replay. No chain/maturity/amount/spentness authority follows from algebra alone |
| Q0 | Published PedPoP Ed25519 keys compile into selected wallet signing types under a coherent lock; two failed dependency candidates retained | Independent source/lock review; compilation not replayed by reviewer. No signing result at this checkpoint |
| Q1a | Real modeled four-party 2-of-4 Ed25519 ceremony; two disjoint subsets generate valid CLSAGs. Six author and six independent tests | Four-member synthetic ring; completion agreement modeled, not distributed service consensus |
| Q1b | Ordinary encrypted funding scanned into the threshold wallet; full current-protocol transaction, controlled 16-member ring, direct proofs and receiver/change/fee checks. Nine corrected author and nine independent tests | Synthetic funding/chain/decoys. Not Rosen authorization, canonical submission or burning-resistant ordinary scanning |
| Q1c | Actual completed transaction persisted and recovered in a new process to a simulated broadcaster, byte-identically without resigning. Seventeen tests in author and independent runs, four forced stops, three mutants | Completed-byte recovery; no live-nonce restoration, power-loss/rollback proof or real settlement |

N and Q are distinct engine investigations. A result about native wallet2 state
does not transfer automatically to the Rust wallet's state model. A successful
Rust threshold transaction does not close the unjoined native managed-wallet
release boundary.

## Deposits, accounting and Rosen consumers

| Checkpoint | Executed result | Evidence ceiling / remaining work |
| --- | --- | --- |
| D1 | Canonical instruction and acceptance-policy tests, 189 recorded cases | Frozen evidence/profile contract, not all native facts initially produced |
| D1b / D1b02 | Native receipt and OutProofV2 checks, independently opened amounts, maturity/spent observations and duplicate-P occurrences reach the consumer. Corrected address-profile selection: 91 cases per profile, 182 executions | Complete accepted fixture history only; trusted FAKECHAIN acquisition, not authoritative live history |
| D2b | Durable delivery, retained reservations and exact acknowledgement, 108 tests | Local persistence and delivery semantics; distributed event agreement separate |
| D3b3-02 | Native-signed Ergo transaction reaches one seeded local UTXO effect and the acknowledgement consumed by delivery. 289 selected tests, seven mutants, three independent probes | Seeded SQLite Ergo ledger; not actual canonical-chain settlement |
| D1c-01 | Native deposit facts joined through durable admission, Ergo signing, local effect and source acknowledgement. 319 selected executions and independent exact-expiry recovery | Deposit authority and target ledger remain synthetic. Does not close distributed credit or a two-chain roundtrip |
| C1a | Actual Rosen authenticated collection across processes, 19 tests and targeted mutation controls | Below quorum; certificate/value authorization not established by collection alone |
| C1b correction05 | Actual candidate/certificate agreement paths with immutable captured data; 12 cases and seven mutants, corrected execution evidence reviewed | Synthetic event inputs. Final approval row does not confer native Monero authority. Historical full project type/build debt remains |
| W1a | Actual EventOrder → captured unapproved withdrawal request; 110 tests and independent large-integer fee control | Not authenticated chain event, native signing or reserved retained ownership |
| W1b | W1a request reaches real native construction; recipient/amount/change/fee semantics checked. 58 TypeScript and 41 native cases, targeted mutations | Unapproved intent destroyed at completion; selected standard-vault profile and synthetic inputs |
| W1c / W1c2 | Native-scanned output reservation, then complete input sets up to 16; atomic exclusion, migration of populated registry and fault recovery. W1c 79 tests; W1c2 61 new tests plus retained predecessor checks | Construction receipt and private local fence, not approval or live retained signer |
| W1f | Private retained custody and same native restoration under a surviving local supervisor; 50 TypeScript and one native test in both author/reviewer, additional native controls | Cold-supervisor restart, hostile rollback, confidentiality and distributed recovery unproved |
| W1g | Complete common-vault native/image/preprocess join; two inputs across six subsets/both roles and 1/16 input endpoints | Local ceremony/context delivery, no authorization-to-signing consumer |
| W1h-A | Actual unsigned body, message and private semantics bound to original native and consuming seal; receiver/change/zero-change Scanner controls. 25 author and 25 independent tests | Candidate ownership, not approval or signing |
| W1hb-B | Retained native host → private immutable candidate → original Rosen serializer and four common predicates. Final author/reviewer each 41 tests in 11 cases; native malformed/lifecycle and actual-holder Drop controls | Fixed synthetic request; no real request/reservation/certificate/signing join. Strict owned TS passes; full integration has 124 unchanged diagnostics, not a green entire project |

The latest B consumer cases comprise 21 codec tests, 10 transport tests, two
actual-host integration tests, five predicate cases and three lifecycle cases.
Its native review includes one focused request unit, 21 malformed process
requests, three real terminal lifecycles and the holder-lifetime differential.
Do not confuse native request rejection before fixture creation with a completed
native signing experiment.

## What changed the confidence assessment

Several failed assumptions produced useful corrections rather than being
removed from the record:

- A compiled DKG/signing type join did not establish the actual wallet path;
  Q1a and Q1b supplied the missing executed operations under bounded fixtures.
- One alleged common-vault fixture changed the view key between funding batches.
  Correcting the full wallet identity changed which tests supported that claim.
- Process liveness did not prove the native transaction holders still existed.
  A reviewer-only Drop probe and early-drop mutant discriminated these states.
- Generic transport rejection tests passed even when the hostile producer did
  not run. Final qualification requires observed producer/received-byte identity
  and the intended rejection stage, rather than pre-spawn fault markers.
- Removing a correlation guard caused rejection at a later frame gate. That is
  not unsafe admission; the evidence records the actual result.
- Global PID traces mixed executions or were overwritten after PID reuse.
  Final evidence uses run/case/process-instance identities and captures transient
  generated input preimages. Observed Vite plugin-stage bytes are not described
  as the final VM representation.
- Earlier caught process exits were not external crashes. Corrected crash
  evidence used an actual external kill. Storage/process results remain narrower
  than power-loss or adversarial backup-rollback assurance.

In D3b3, selected mutants admitted conflicting preparation or an invalid proof;
they did not demonstrate a second economic effect. In B, the zero-change extra
condition positive does not claim a new actual zero-change host issuance. These
qualifications are necessary to preserve what was really tested.

## Source identities and retained checkpoint pins

| Source | Version or immutable revision |
| --- | --- |
| Historical Monero native baseline | [v0.18.5.1 source](https://github.com/monero-project/monero/tree/4f92268d7c16741cfb41e5bbe2aa46cc260a9ea5) |
| Rosen guard-service baseline | [1edc2fb982de4560c5265e04e2ed8b93d00b40df](https://github.com/rosen-bridge/guard-service/tree/1edc2fb982de4560c5265e04e2ed8b93d00b40df) |
| Rosen scanner baseline | [7d008b2dc9e2deeea830a890643e2edc82896114](https://github.com/rosen-bridge/scanner/tree/7d008b2dc9e2deeea830a890643e2edc82896114) |
| Rosen contracts baseline | [1b892c43f2d45eb6916f35e2edbb7560a4569f8e](https://github.com/rosen-bridge/contract/tree/1b892c43f2d45eb6916f35e2edbb7560a4569f8e) |
| Published wallet | monero-wallet 0.2.0; package VCS `9e11f5c0f2b18ab821192efa427c863086b51379`; archive SHA256 `b8d9a2431255db4deaf39671646e17f79bfb4ceadfffc9bb52e0f3fb0d29c75e` |
| Published DKG | dkg-pedpop 0.6.0; archive SHA256 `4e30819c61e4650ef7b06aef4a20d3537101cba424f06b04e582b41f06833479` |
| FCMP++/Carrot stressnet beta 2.0 | [8ed2f782517db08bd6069517b7dcc2959b816e69](https://github.com/seraphis-migration/monero/tree/8ed2f782517db08bd6069517b7dcc2959b816e69), release 27 May 2026 |
| Previously inspected future staging | [8836273dcb7ffc661ebddbbd2c3f3f6c9558897b](https://github.com/seraphis-migration/monero/tree/8836273dcb7ffc661ebddbbd2c3f3f6c9558897b) |
| Native future multisig candidate | [89067f94e36b093b9a301004a986ea6a466698e1](https://github.com/UkoeHB/monero/tree/89067f94e36b093b9a301004a986ea6a466698e1) |
| Rust future signing primitives | [31c26d96eaadbba910ffe3613ad8b4cf9c598a93](https://github.com/monero-oxide/monero-oxide/tree/31c26d96eaadbba910ffe3613ad8b4cf9c598a93) |

These future branch pins are not a single compatible dependency closure. The
native future candidate uses its own Rust dependency, rather than automatically
using the separately listed Rust branch. Its previously observed API compilation
failure is a candidate-specific limitation, not an assertion that every newer
multisig implementation fails. The beta release was rechecked for this report;
the earlier branch investigations are retained at their exact historical pins.

Selected local artifact identities:

| Artifact | SHA256 |
| --- | --- |
| W1h-A source13 aggregate | `5fe16a531d169209c912c6c15b71e40b8663c31d447033374085576a58e5fba3` |
| W1hb native15 aggregate | `7a8d3d130b344643571cc8e1b9a9bea0e839463277baddca6a9437bb33bfe1e6` |
| W1hb author consumer27 aggregate | `5cff3822f2c19ca9e43521307b23017b88c849cd9432f205576b9f1964f10ecf` |
| W1hb reviewer consumer27 aggregate | `4c1f20a0dbaf9a56478145c38d83b45eeff41b51573839772a28dddb987a35bb` |
| W1hb independent consumer review | `b8e90146c8033a1f5a31de2097286b138d58be54efbf315823780243fef7cdb9` |
| W1hb independent replay receipt | `cb88e966a4b1eef0883c6949f1f5cd34a25d54bb30f8c22cfc262647fb247137` |
| W1hb retained archive | `587642943950bb0a9ed06d891f095528145ac40fb77fe2ba6f5a5f6fb72bc372` |

Native aggregates hash UTF8/no-BOM records ordered by ordinal ASCII relative
path, with path, decimal byte size and lowercase SHA256 separated by tabs and
terminated by LF. Consumer aggregates hash compact UTF8 JSON arrays of
ordinal-path-sorted `{path,bytes,sha256}` records, without a terminal newline.
Author/reviewer consumer setup paths differ; the native executable bytes match.
The native build toolchain was Rust/Cargo 1.98.1; final B Node execution was
24.19.0. No independent compiler/linker reproducible-build claim is made.

## Preliminary conclusion versus implementation acceptance

| Question | Preliminary-study answer | Required stronger evidence |
| --- | --- | --- |
| Is there a real current-protocol threshold wallet path? | Yes, executed in bounded synthetic fixtures | Selected production committee, transport, custody and capacity qualification |
| Can actual Rosen consumers inspect an actual native candidate? | Yes, locally with retained ownership | Same request/reservation/approval/signing path end to end |
| Is there a focused answer to duplicate-output accounting? | Yes, conservative identity/exclusion policy and native fixture refusals | Canonical history, post-credit conflict and reorg reconciliation |
| Does experimental multisig prove impossibility? | No | Select and qualify exact implementation against service requirements |
| Is post-fork support already demonstrated? | No; concrete candidate mechanisms exist | Compatible wallet/proof release and historical-reserve redemption at threshold |
| Does this justify publishing research now? | Yes, as a bounded preliminary study | Portable fixture release/replay would strengthen public reproducibility |
| Is the complete bridge ready? | No | Integrated roundtrip, recovery, economics, migration and deployment review |

G0–G8 remain implementation/launch acceptance gates: compatible committee and
engine; attribution/uniqueness; authentic inputs; signing authority; failure and
concurrency recovery; settlement; capacity/roundtrip; final candidate review;
and protocol-transition redemption. Local successes support parts of these
gates and must not be relabelled as all of them passing.

W1hc is a prepared plan and wire contract only. It is deliberately not included
in the executed-results tables. The preliminary-study decision is complete;
the prototype and launch program are separate unfinished work.
