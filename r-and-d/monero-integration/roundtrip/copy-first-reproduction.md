# Copy-first deposits and fresh public preparation

A. Shannon · 14 September 2026

The complete local Monero → Ergo → Monero bridge now succeeds when a third party
includes a copied output key before the honest deposit. Both a raw key copy and
a decodable copy pass through actual watcher transactions, authenticated credit,
redemption and payment from the selected honest occurrence. The public package
also provides a tested preparation recipe for new dependencies, binaries, keys
and local chain data on one reference environment.

## What the copy-first test does

The four original Monero holders establish their threshold vault. Its native
funding actor prepares the honest transaction, retaining its signed bytes and
private funding authority without submitting it. A separate copier receives
only public transaction bytes and deposit metadata. It funds its own wallet and
includes the copy while the honest transaction is still absent.

The original actor then accepts one exact transaction ID and submits its retained
bytes. Height, block hash and global output index come from actual inclusion.
An unrelated pending command, substituted ID, second submission or replacement
of the retained chain anchor retires the actor. A canonical extension is allowed.

The [authenticated-backing path](admission-backing.md) continues to verify the
original transaction proof and intent, reserve the output-key/key-image class,
and select the honest output. A decodable copy still does not become a separate
credit obligation. Both copy-first runs spend the authenticated occurrence,
recover a deliberately lost submission response and retain the four guards'
output, image and settlement claims after controlled source invalidation.

## Results

The [qualification record](evidence/copy-first-reproduction-qualification.json)
contains transaction identifiers, inclusion heights, source and executable pins,
test counts, recovery controls and preparation receipts.

| Case | Actual ordering | Complete bridge |
| --- | --- | --- |
| Decodable copy first | Copy block 175; honest deposit block 176 | Pass |
| Raw copy first | Copy block 175; honest deposit block 176 | Pass |
| Immediate honest deposit, then raw copy before credit, using the public recipe's new executables | Honest inclusion before copy | Pass |

The decodable copy reproduced the decoded amount of 500,000,240 atomic units.
The raw copy decoded as no payment. Each successful copy-first run nevertheless
selected the honest deposit, confirmed one Ergo credit, redeemed that exact box
and paid 500,000,000 atomic units on Monero. Payment used two original-holder
contributions, one signing call and one submission. Reopening did not create a
new credit or payment.

Focused validation totals 91 tests: 58 native unit tests, six actual pending-actor
cases, seven prepared-deposit/RPC tests, one copy-generator test, nine bootstrap
tests and ten proof-configuration/runtime tests. Independent development review
covered the changed boundaries and recomputed the exact 393-file source manifest.
It is separate from an external audit or an independent operator's reproduction.

## Reproduce from public inputs

Start with the [source package](source/README.md) and its
[preparation instructions](source/tools/reproduction-prerequisites.md).
The reference profile uses Windows x64, PowerShell 7.4 or later, Node 24.13.1,
npm 11.6.2, Rust 1.98.1, Java 17 and WSL Ubuntu 22.04 with GCC 11.4.0/CMake 3.22.1.

The exercised recipe clones the pinned Rosen commit, applies the included
overlay, installs 1,413 locked packages, applies the two upstream patches and
builds ErgoChain. All 309 declared distribution files match, including the
explicit sqlite3 5.1.7 N-API 6 driver required by TypeORM. Separate stages build
both Rust executables with a fresh Cargo cache and verify official Monero and
Ergo release downloads.

The C++ helper was rebuilt from untouched public Monero sources and the included
helper source. Its executable and all 23 fresh non-system shared libraries are
pinned. Actual loader resolution and all those hashes are checked before and
after proof invocation. Ubuntu system libraries remain environment dependencies;
byte-identical builds across other paths or toolchains are not established.

The Ergo bootstrap creates a new wallet, recipient and database. It checks its
own Java process and loopback listener around each API call, waits for mature
mining rewards and confirms a 100 ERG plain EIP3 funding output used by the
fixture. No previous wallet or chain database is a preparation input.

The current source manifest SHA-256 is
`299e289b2463493205559de58a0a2a9647fb748510bca9efa710c4511ef3078f`, with aggregate
`fe77d63f99927a43a63dfc6dc21c771156928ec3ca323c3f13dcb6dc7b789a82`.
The first decodable run used the immediately preceding manifest; the sole later
source change corrected the preparation script's dependency-count precheck.
Bridge, proof and bootstrap runtime sources were unchanged. Each run records
its own exact manifest.

## Remaining scope

These are isolated chains and fixture assets. Four credit guards share one
JavaScript host; the original Monero holders use separate processes. The watcher
host runs bounded upstream jobs with the fixture's public view scalar.

Multiple deposits, fee and liquidity reconciliation, permissionless admission,
refunds, committee rotation and independent custody operations remain open.
Controlled invalidation does not establish automatic reorg detection or
resistance to restoring an old valid database. FCMP++/Carrot migration is also
outside this qualification. The next useful increment is an explicit accounting
model exercised across several deposits and withdrawals, including fees.
