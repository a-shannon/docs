# Monero → Ergo → Monero: local integration experiment

A. Shannon · 18 September 2026

**Complete local V2 roundtrip:** the scanner, native output/certificate reader,
watcher jobs and fresh guard authorization connect deposit, credit, redemption,
Monero payout and confirmed Ergo reward distribution.
Read the [adapter qualification report](adapter-qualification.md) for the code,
validation and remaining production gates. Production qualification is still open.

The [historical failure coverage](burn-coverage.md) distinguishes both
multiple-counting mechanisms from repeated economic backing. The
[multisig review packet](multisig-review.md) records the completed independent
local review of the optional contribution hook and the corrected overlap case.

**Latest increment: fees, reward custody and completion.** The V2 path reads the
configured on-chain fee policy, applies proportional withdrawal fees, retains
one reward assignment per withdrawal and recovers the confirmed reward after a
lost reply and four-guard restart. See the
[current qualification](adapter-qualification.md#complete-local-v2-roundtrip).

**Explicit output and intent agreement.** Read the
[output agreement report](output-agreement.md) for the watcher/guard binding,
isolated negative tests and exact replay results.

**Two-operation economic reconciliation.** Read the
[economic report](economic-reconciliation.md) for cumulative obligations,
confirmed payments, selected reserve consumption and separately measured fees.

**Complete copy-first bridge tests and fresh public preparation:**
Read the [copy-first and reproduction report](copy-first-reproduction.md) for the
new ordering tests and the public preparation recipe.

**Authenticated deposit backing despite copied output keys:**
Read the [admission and backing report](admission-backing.md) for the mitigation,
the qualification matrix and the distinction between complete bridge runs and
Monero-only copy-first tests.

The [watcher and guard authority report](watcher-authority.md) records the earlier
roundtrip with actual watcher transactions in both directions, four independently
checking credit-guard instances, credit restart and post-rollback quarantine.

The earlier linked roundtrip also passed on both actual local nodes. Its observed
return uses one signing call, two original-holder contributions and one Monero
submission. It recovers a deliberately lost submission reply and reaches durable
settlement after the configured confirmation depth.

The [replay package](source/README.md) provides the source, exact prerequisites
and launcher. The qualification report distinguishes current evidence from the
earlier frozen campaigns and their narrower declared input sets.

This experiment connects the current Monero protocol to Rosen's Ergo credit and payment workflow on controlled local nodes. Its source package contains the separate Monero participants, deposit policy, durable accounting, Rosen integration, actual Ergo transactions and recovery checks.

The experiment addresses a more demanding question than whether a multisignature transaction can be produced: can one particular XMR deposit fund an Ergo credit, can that exact credited box be redeemed, and can the resulting instruction authorize a single recoverable Monero payment?

Read the [technical report](technical-report.md) for the execution path, security boundaries, evidence and remaining work. The [source package](source/README.md) documents its prepared prerequisites and replay command. The [earlier preliminary study](../preliminary-study/README.md) remains the design and migration background.

The scope is a local integration prototype. The original baseline uses local operator triggers; V2 runs pinned watcher jobs in two processes per direction and four guard processes with separate stores. Four Monero holders use separate native processes with a two-holder signing threshold. The three-of-four Ergo signing threshold is a separate control. Assets are fixture tokens. A successful run does not establish autonomous production-service deployment, independently operated custody, permissionless deposit submission, pooled-vault solvency, sustainable fee pricing or FCMP++/Carrot migration.
