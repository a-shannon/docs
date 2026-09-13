# Monero integration with Rosen: preliminary feasibility findings

A. Shannon · 13 September 2026

**Implementation follow-up:** the [linked local roundtrip](../roundtrip/README.md)
now demonstrates an actual Monero deposit, Ergo credit and exact-box redemption,
then an authorized Monero payout and durable settlement. Its source package and
report distinguish those node results from the remaining production watcher,
custody and migration work. The study below remains the earlier decision basis.

**Verdict: a technically credible, threshold-preserving integration path exists,
supported by targeted native and Rosen experiments. Proceed to a bounded
integration prototype. Complete bridge feasibility, production readiness and
FCMP++/Carrot redemption continuity have not been demonstrated.**

The study does not establish that waiting for FCMP++/Carrot activation is
necessary. Current-protocol integration can proceed while compatibility with
the future engine is investigated and tested on candidate versions. Choosing
when to launch requires both the remaining validations and an assessment of
the operating and migration work involved.

This study follows the [original Rosen proposal](https://docs.rosen.tech/rosen/r-and-d/bringing-monero)
and the [architecture RFC](https://github.com/rosen-bridge/docs/pull/1). Its main
contribution is identifying which pieces can actually be composed, testing
several difficult boundaries, and turning remaining uncertainty into explicit
implementation and launch conditions. Existing cryptographic constructions and
libraries remain the work of their upstream authors.

Read the [technical report](technical-report.md) for the architecture, solutions,
counterexamples, migration options and work order. The [evidence ledger](evidence-ledger.md)
records version scope, representative results and their limits. Neither test
counts nor a successful isolated signature should be read as an end-to-end
bridge demonstration.

A bounded [migration preflight](technical-report.md#bounded-rust-migration-preflight)
now identifies the selected Rust candidate's missing wallet connection. Existing
threshold-share interfaces are encouraging, but that revision's wallet still
produces CLSAG transactions. A complete FCMP++ migration experiment first needs
an integrated future transaction path. This is a source finding, not a migration
test result or an absence claim about every newer branch.

The recent [FCMP++/Carrot beta 2.0 release](https://github.com/seraphis-migration/monero/releases/tag/v0.19.0.0-beta.2.0)
is encouraging development evidence. It is a stressnet release dated 27 May
2026, and explicitly lists multisig, transaction proofs and watch-only/cold
wallets as nonfunctional in that release. Separate candidate branches already
contain future signing work. This distinction supports continued engineering,
while leaving the compatible wallet and migration gates open.

A [developer working plan](https://github.com/jeffro256/fcmp-carrot-plan/blob/85c4998f96233b47031d231a27f7e76cc2d9cdf0/README.md),
revised on 21 August 2026, targets multisig integration and initial compatible
binaries during autumn 2026, followed by activation in early March 2027. It is
explicitly non-binding. The technical report distinguishes these targets from
observed progress and Rosen readiness.

The preliminary study is complete as a decision document. The retained owner,
Rosen approval consumption and local signing/settlement milestones are now
covered by the [implementation follow-up](../roundtrip/technical-report.md).
