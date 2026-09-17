# Delayed deposit evidence and the scanner cursor

A. Shannon · 18 September 2026

A Monero deposit's auxiliary proof may arrive after its block is scanned. The
existing scanner's block-level success flag alone cannot both retain that
candidate and keep scanning unrelated deposits. This probe makes that tradeoff
executable before implementing a production observation extractor.

## Reproduce

Use the prepared Rosen dependency workspace from the
[roundtrip recipe](../roundtrip/source/README.md), based on Guard Service commit
`1edc2fb982de4560c5265e04e2ed8b93d00b40df`. Set `ROSEN_WORKSPACE` to its absolute
directory. From this directory in PowerShell:

```powershell
$loaderUrl = ([Uri][IO.Path]::GetFullPath("$env:ROSEN_WORKSPACE/node_modules/tsx/dist/loader.mjs")).AbsoluteUri
node --import $loaderUrl --test ./delivery-cursor.test.mjs
```

The probe uses `@rosen-bridge/abstract-scanner 2.0.3`,
`@rosen-bridge/abstract-extractor 3.2.3`, `@rosen-bridge/extended-typeorm 1.1.0`,
`sqlite3 5.1.7` and `tsx 4.21.0`; it was run with Node 24.13.1. It checks the
scanner version and SHA-256 of the three deciding scanner/database modules
before importing them. The real `GeneralScanner.update`, `BlockDbAction` and
SQLite entities run against an in-memory database. Network responses and the
proposed delivery-aware extractor are test doubles. No daemon, wallet, signer,
proof helper, network request or runtime configuration is needed to run it once
these dependencies are installed.

## Three observed results

| Extractor behavior | Observed scanner result |
| --- | --- |
| Return `false` while a proof is missing | The persisted completed-block cursor remains before that block; repeated updates retry it and do not scan the later valid deposit. Supplying the proof allows both deposits to progress. |
| Omit the unproved candidate and return `true` | The cursor advances and the later candidate progresses. Making the earlier proof available does not cause normal incremental updates to revisit its transaction. |
| Produce an effect for one transaction, then return `false` for another in the same block | The next update repeats the first transaction's extractor effect. Extractor idempotency is not supplied by the block-level boolean. |

All three tests pass. They demonstrate the pinned scanner contract, not a defect
in an existing Monero adapter: no production Monero scanner/extractor is
implemented here. The repeated effect is a test-double append, not an observed
double credit. Existing credit-ledger checks are unchanged.

## Consequence for the next contribution

Separate candidate capture from proof admission. Persist the candidate with its
chain/vault context, transaction identity and origin block before allowing the
scanner cursor to advance; retry its proof independently. A missing proof must
neither authorize credit nor indefinitely stop unrelated block scanning.

That pending workflow must close crash/replay idempotency, reorg invalidation,
fresh proof/source verification, bounded scheduling and storage, and expiry
semantics before handing an accepted event to the existing observation path.
An unavailable proof and a permanently invalid candidate need distinct handling.
Returning `true` is justified only once the candidate is durably captured or
conclusively irrelevant. The workflow is a proposed next implementation, not a
capability established by this probe.

The existing [delivery experiment](../roundtrip/deposit-delivery.md) remains
valid within its stated scope. This probe changes neither its source snapshot
nor its metadata format, CLSAG signer, guard ledger or event encoding. Acceptance
of the public memo, auxiliary proof channel and origin descriptor remains the
upstream integration decision.
