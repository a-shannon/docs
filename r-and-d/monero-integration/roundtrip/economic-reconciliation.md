# Two-operation economic reconciliation

A. Shannon · 14 September 2026

The bridge experiment now reconciles two separately backed operations on the
same isolated Monero and Ergo chains. The first Monero payment settles while
the second user's Ergo credit and its Monero backing remain unspent. The second
credit is then redeemed and paid. Both payments recover a deliberately lost
submission reply with one signing call and one submission each.

The [source package](source/README.md#multiple-operation-accounting) contains the
executable profile, pure accounting consumer and regression tests. The
[qualification record](evidence/economic-reconciliation-qualification.json)
contains the exact source identity, operation facts, intermediate reports,
transaction references and observed costs.

## What the profile exercises

Each deposit uses a distinct one-shot vault with four original native holders
and a two-holder Monero threshold. Both operations use the same fixture asset.
The sequence is credit A, redeem A, credit B, settle A, redeem B, settle B.
Redeeming A recycles the existing fixture tokens before B's credit; the profile
does not increase their issuance. Before the first payment, one Monero payout
and one user credit coexist as separate obligations.

Thirteen accounting checkpoints cover deposits, credits, redemptions, native
reservations and confirmed settlements. They are derived from the authenticated
deposit, confirmed Ergo outputs, exact redeemed credit box, native input
selection and confirmed payment scan. The pure consumer checks their identities
and integer conservation; it cannot authenticate arbitrary caller-supplied data.
It rejects reused deposits, vaults, credit boxes, selected inputs, reservations
and payments. Within each chain, it also rejects a settlement transaction used
as an input creator and a redemption transaction used as a credit transaction.

The accounting callback receives data copied from the existing verified
selection and settlement. Signing capabilities remain with their existing
owners. Settling A is checked against B's unchanged facts, its live Ergo credit
box and its unspent Monero source key image.

## Amounts and fee ownership

All XMR quantities below are atomic units under the fixture's 12-decimal,
one-to-one backing model. Per operation:

| Quantity | Atomic units |
| --- | ---: |
| Authenticated deposit D | 500000240 |
| User credit U | 500000120 |
| Deposit fees fd | 120 |
| Return fees fr | 120 |
| Monero recipient P | 500000000 |

The deposit credit already issues fd as fixture tokens to the funding address.
Those tokens remain circulating backing liabilities. The return event remains
`pending-reward`: fr is a retained entitlement, not a completed reward
distribution. Neither amount is counted as free reserve.

For selected test reserve R, observed miner fee F and confirmed change C:

```text
D = U + fd
P = U - fr
R + D = P + F + C
selected residual = C - fd - fr = R - F
```

This residual describes the two selected native inputs. Unselected mining
outputs and any other vault claims are outside its scope. The consumer preserves
a negative residual when otherwise valid arithmetic reveals a deficit.

## Validation and reproduction

The final frozen-source run passed in 280202 ms with all declared inputs
unchanged. Its two-operation totals are:

| Quantity | Observed total |
| --- | ---: |
| Deposited principal | 1000000480 atomic XMR |
| Confirmed recipient payments | 1000000000 atomic XMR |
| Outstanding user credit / pending payout | 0 / 0 |
| Issued deposit-fee tokens / retained return fees | 240 / 240 atomic XMR equivalent |
| Selected test reserve | 70355727038566 atomic XMR |
| Confirmed withdrawal miner fees | 5200800000 atomic XMR (0.0052008 XMR) |
| Charged network fees, both directions | 80 atomic XMR |
| Selected residual after fee backing | 70350526238566 atomic XMR |
| Ergo miner fees, 16 operation transactions | 17600000 nanoERG (0.0176 ERG) |
| Deposit sender's Monero miner fees | 3618000000 atomic XMR |

The configured network charges fall short of withdrawal miner costs by
5200799920 atomic XMR. These small fixture charges were not a cost-covering fee
quote; the selected test reserves fund the difference. Even the total 480
atomic units allocated as bridge and network fees are far below those costs.
This measurement is specific to the isolated fixture, not a mainnet fee estimate
or a profitability result. Ergo costs are not converted into XMR, and fixture
deployment and mining costs are excluded.

The pure suite has 13 passing test groups, including individually falsifiable
amount, identity, stage, shape and integer-boundary cases. Seven isolated
guard-removal mutants fail their intended tests: credit conservation, withdrawal
conservation, each final recipient/fee/change binding, final/source transaction
aliasing and redemption/credit transaction aliasing. Independent development
review checked the producer-to-consumer joins and independently recomputed the
397-file source manifest. This is not an external audit.

Use the [prepared prerequisites](copy-first-reproduction.md) and the watcher
configuration without a collision experiment:

```text
node tools/launch-roundtrip.mjs --config <absolute-config-file> --manifest-sha256 3d2e1696648900065f3dcdc745c00b0966f6a77237545662cb2cd40d7dad5040 --profile economic-reconciliation
node --test consumer/economicReconciliation.test.mjs
```

The native executables, proof helper, shared libraries and Rosen dependencies
reuse the previous public preparation. The launcher checks their declared pins
and the source package before and after execution. This increment does not
claim a new build or an independent operator's reproduction. A reused Ergo
devnet must have an unlocked funded wallet and advancing blocks before launch.
A pre-qualification attempt timed out on an Ergo setup transaction after a
restart left that wallet locked. Unlocking it restored mining; the subsequent
two-operation run passed, followed by this final run after review corrections.
The earlier run is not substituted for the final source's result.

The profile has no public-chain deployment. Four credit guards share one
JavaScript host; watcher jobs use bounded node/database ports. Reusable pooled
vaults, global reserve accounting, fee-token redemption, return reward
distribution, sustainable pricing, automatic reorg handling and committee
rotation remain separate work. The next economic boundary is to turn observed
costs into an explicit fee budget and refusal rule before authorizing a payment.
