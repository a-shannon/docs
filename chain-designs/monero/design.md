# Monero integration into Rosen Bridge

A. Shannon · 18 October 2026 · Design proposal for discussion

The proposed asset is native XMR, represented by a wrapped asset on Ergo. Monero
holds the reserve through threshold signing; Watchers and Guards agree on the
specific received output, its destination intent and its continued spendability.
This document follows [RCS-003](https://github.com/rosen-bridge/rcs/blob/f829337a3eb842bdb888c46249a85167648e5c88/rcs-003/README.md),
with the applicable [RCS-001 tests](https://github.com/rosen-bridge/rcs/blob/f829337a3eb842bdb888c46249a85167648e5c88/rcs-001.md)
and [RCS-002 contribution conventions](https://github.com/rosen-bridge/rcs/blob/f829337a3eb842bdb888c46249a85167648e5c88/rcs-002.md).
All three were rechecked at that revision on 18 October. RCS-001/002 are unchanged
from the earlier pin; section 5.3 reflects the updated RCS-003 UI/wallet requirements.

**Submitted for design discussion; not approved for implementation or activation.**
Following Rosen's requested sequence, review starts with this Monero design;
code PRs and other chain proposals remain on hold pending design agreement.
Open dependencies are review inputs, not reasons to defer this design submission.
The [CLSAG signing walkthrough](signing.md) is supporting material tied to its
stated source snapshot, not evidence that the service integration is complete.

The remaining
feasibility gates include a released wallet that creates and meaningfully
approves the exact lock metadata, public-network deposit examples, and remaining
endpoint history/relay qualification. Three public sources passed the stated
read methods over validated TLS on 8 October; this is bounded historical
feasibility evidence, not a fresh endpoint qualification.
Uncredited-deposit disposition,
pre-signing restart and post-settlement payout monitoring are also incomplete.
The contributor owns those checks and the technical repairs proposed below.
Successful local roundtrips do not close them. The finality, custody and recovery
proposals below are concrete review inputs, not deployed or accepted policies.

Four integration gaps need particular review:

| Gap | Proposed disposition and evidence boundary |
| --- | --- |
| Received deposit without a timely claim, or claim invalidated before credit | Keep the reserve-held funds as an uncredited liability; propose exclusive re-anchoring or an authorized refund, with explicit beneficiary/payer entitlement. Neither disposition has been demonstrated. See section 3.3. |
| Crash before signing and partial Guard settlement | Roll partial durable settlement forward under one assignment and reconstruct the native vault without reusing signing material. Lost-commit-acknowledgment and ledger-level retry tests do not demonstrate native process recovery. See section 3.4. |
| Permanently absent Guard | Bind admission to one canonical assignment certificate and qualify real 3/4 custody and rejoin reconciliation. Current three-approval tests first require four durable claims; native custody is 2/4. See section 1.1. |
| Payout removed after settlement/reward | Propose separate 60/60 deposit/payout depths for qualification, continued observation and a durable incident/replay/compensation path. The lab stops at two payout confirmations; production depth and post-reward recovery are unqualified. See section 3.5. |

The last complete native CLSAG bridge roundtrip predates the recent V2 fixes.
Those fixes have focused tests, not a new complete native run. Section 6 separates
that evidence from the standalone FCMP++/CARROT experiment and proposed service joins.

## 1. Base requirements

### 1.1 Multiple signers and reserve custody

Monero payments use its own Edwards25519-based input authorization, not ordinary
secp256k1 ECDSA signatures. The candidate imports the Rust wallet's threshold
CLSAG machine; the separate FCMP++ experiment imports threshold SAL and uses
Core for membership-proof construction and transaction finalization. Existing
Rosen ECDSA approval can authenticate the payment decision, but cannot be used
as a Monero transaction signature or directly converted into a Monero spend key.

**Proposed custody:** each selected Guard holds its own Monero secret share;
the Monero signing threshold matches the approved reserve-custody threshold.
For a four-participant qualification profile, propose three spend shares,
rather than retaining the experiment's two-share custody. A fresh, authenticated
Monero DKG ceremony creates the group spend key and binds participant identities,
epoch and network. Reuse Rosen's approval, transport and lifecycle extension
points wherever their installed interfaces fit. A coordinator routes approved
messages and aggregates public contributions; it has no complete spend secret
and no authority to change the approved payment. The exact transport attachment
and custody deployment remain design-review items.

**Implemented locally:** four native holder processes run the imported DKG and
select two spend signers. Separate software approval uses three of four Rosen
votes. Two colluding holders can bypass that software approval; this is explicitly
2-of-4 custody, not 3-of-4 custody. The newer local process experiment additionally
requires four durable claims before three approval participants proceed; it does
not demonstrate progress with one permanently absent Guard. Merely reducing the
claim count to three would not establish exclusive assignment or safe recovery.
In the current mechanism all four Guards must durably record the identical
assignment before any native signing material is generated. Production operation
with a permanently absent Guard is a separate, unproven protocol extension.
Our proposed direction for that extension is admission bound to the existing
Rosen canonical event/assignment and its approved quorum, with durable receipts
and reconciliation before an absent Guard rejoins. It must not start a competing
assignment from an empty local ledger. A concrete assignment certificate and
exclusive recovery rule, aligned with Rosen's lifecycle, need agreement and
validation alongside genuine 3/4 Monero custody. Until permanent-absence, restart
and conflicting-assignment cases pass, retain the current 4/4 dependency;
changing a count or roster is not the repair. This extension is not implemented
or accepted.
Backup, authenticated
production ceremony, arbitrary production roster, rotation and share recovery
are not qualified. They remain contributor work after design agreement.

The reserve address uses the group public spend key B and public view key A=aG.
For a standard address, encode network/type prefix, B, A and the four-byte
Keccak checksum with Monero block Base58. A separate view secret a permits
scanning, not spending; distribute it only under the agreed monitoring model.
The local funding fixture uses a public view scalar of one. It is not a
production view-key generation procedure. Monero does not inherit Bitcoin's
BIP32 path or Rosen's ECDSA address derivation.

### 1.2 Lock transaction and on-chain data

The currently executed profile accepts one qualifying, unlocked reserve output
per transaction, with native XMR as source and Ergo testnet as destination.
Production chain identifiers and the mainnet destination tag are not assigned
by the experimental format. A production revision must preserve the agreed
Rosen identifiers and cannot silently interpret the testnet tag as mainnet.

| Component | Exact interpretation in the CLSAG experiment |
| --- | --- |
| Inputs | One or more spendable wallet outputs, their key images and selected ring members. The wallet selects actual inputs and decoys; a public daemon cannot report a private address balance or the true input amounts. |
| Reserve output | The gross deposit amount to the configured reserve address, represented on chain by its one-time output key and RingCT data. Reconstruct ownership and amount using the view wallet and authenticated receipt. Do not assume its local output index is always zero. |
| Change | Wallet-owned change from input selection. It is not bridge collateral or another deposit merely because it appears in the same transaction. The single qualifying reserve-output rule is checked after reconstruction. |
| Miner fee | Native transaction fee, separate from the quoted Rosen bridge/network charges in the memo. Authenticate the selected input/recipient/change/fee conservation. |
| Extra | Normal transaction public-key fields plus exactly one recognized arbitrary-data nonce carrying RMD1. Reject malformed, duplicated, ambiguous or unsupported bridge data; unrelated data does not become a bridge event. |
| Final identity | Compute the actual final Monero txid from complete transaction bytes. The final intent references that txid and selected output; a proposal identifier is not the final transaction identity. |

The [implemented encoder](https://github.com/a-shannon/docs/blob/b5d4441b73bcd4eb565643c4977362f1d8804637/r-and-d/monero-integration/roundtrip/source/consumer/depositDelivery.mjs)
uses the following RMD1 byte layout. Offsets refer to the memo, not the full
transaction. Integers are unsigned 64-bit big-endian; hashes/keys are 32 raw bytes.

| Offset | Length | Field |
| --- | --- | --- |
| 0 | 4 | ASCII `RMD1`, hex `524d4431` |
| 4 | 1 | Source network: mainnet=0, testnet=1, stagenet=2 |
| 5 | 1 | Destination profile=1, currently only `ergo-testnet` |
| 6 | 32 | Source genesis hash |
| 38 | 32 | Reserve public spend key |
| 70 | 32 | Destination asset identifier |
| 102 | 8 | Reserve epoch, positive |
| 110 | 8 | Gross deposit amount, atomic XMR |
| 118 | 8 | Requested bridge fee, atomic XMR |
| 126 | 8 | Requested network fee, atomic XMR |
| 134 | 8 | Monero-height intent expiry |
| 142 | 1 | Recipient ASCII byte length L, 1–110 |
| 143 | L | Recipient bytes, printable non-space ASCII |

Memo length is 143+L: a 52-byte address gives 195 bytes, a 60-byte address gives
203, and the implemented maximum is 253. The pinned Rust wallet permits 254
arbitrary-data bytes per field and 1,060 total extra bytes. Its nonce field is
`02 || varint(1+memo_length) || 7f || memo`; for L=60 it starts `02cc017f`
and occupies 207 bytes. Normal public-key fields also consume extra space.
These are Monero extra/relay constraints and local admission bounds, not a
Bitcoin OP_RETURN limit. The full transaction size and fee are obtained from
actual construction, not from memo length alone.

After finalization, construct the canonical version-2 intent with txid, selected
local output index/key/amount, reserve/network/epoch, destination and fee fields.
Every overlapping memo/intent field must agree. A transaction-level OutProofV2
is composed with independently reconstructed output evidence and a holder
certificate associating the same output with its key image. OutProofV2 alone
does not prove a unique selected output. Embedding the final txid into the
transaction being hashed would be self-referential, so the final proof bundle
is delivered separately, addressed by immutable digest/txid.

The lab uses a configured file inbox, not a released public delivery service.
Missing, conflicting, expired or invalid bundles remain non-creditable pending
candidates. Each Guard retrieves and verifies the bundle itself. A redundant,
retained and authenticated availability contract remains to be qualified by the
contributor and agreed with Rosen. Public metadata discloses destination, amount
and fees, and links them to the Monero transaction; the wallet must explain this
before approval. The bridge cannot promise ordinary Monero payment privacy for
this explicitly disclosed metadata.

**Public examples remain missing.** The existing deposit/replay transactions
are isolated fakechain examples, not public testnet or stagenet deposits.
Offline vectors in Appendix A verify encoding only. Before extractor agreement,
the contributor must retain a representative public non-mainnet lock and a
maximum-payload lock: exact raw transaction and extra bytes, txid, block/hash,
output index, amount/proof evidence, submission response, independent relay
retrieval and an explorer link where available. Include a valid 60-byte target
address if supported by the selected target codec, and separately the largest
admitted destination. A 60-byte arbitrary string is not a valid destination.
No public signing or submission was performed for this revision.

### 1.3 Independent public node endpoints

Our contributor feasibility target is at least three independently administered
public nodes usable by both Watchers and Guards. [RCS-003 requires multiple
independent endpoints](https://github.com/rosen-bridge/rcs/blob/f829337a3eb842bdb888c46249a85167648e5c88/rcs-003/README.md#L52-L54)
without fixing their number at three. The numeric target is our qualification
choice, not a Monero-specific RCS obligation or recorded Rosen agreement.

These URLs use one proposed `MoneroRpcNetwork` provider implementation with
independent endpoint configuration. They are not three different RCS network
modules. A later explorer or materially different API would follow the separate
[additional-network procedure](https://github.com/rosen-bridge/rcs/blob/f829337a3eb842bdb888c46249a85167648e5c88/rcs-003/new-network.md).

| Operator and ownership evidence | Public endpoint | Transport observed on 8 October |
| --- | --- | --- |
| Cake Technologies, [official node list](https://github.com/cake-tech/cake_wallet/blob/e2b3507134371487e923662142863c2a59a4e9c0/assets/node_list.yml) | `https://xmr-node.cakewallet.com:18081` | TLS 1.3 and public certificate validate. |
| plowsof / MoneroDevs, [operator registry](https://github.com/feather-wallet/feather-nodes/blob/5a1bd38a0a34c4de02ea034a2c4ed224005d2bbe/hosts.yaml) and [endpoint mapping](https://github.com/feather-wallet/feather-nodes/blob/5a1bd38a0a34c4de02ea034a2c4ed224005d2bbe/nodes.yaml), with [operator participation](https://github.com/feather-wallet/feather-nodes/commit/5197a3eb21606ec3552f9fd62de9a7f654a2d24c) | `https://node.monerodevs.org:18089` | TLS 1.3 and public certificate validate. |
| xmr.pub Infrastructure Group, [own endpoint page](https://xmr.pub/) and [operator's submission](https://github.com/feather-wallet/feather/issues/309) | `https://node.xmr.pub:443` | TLS 1.3 and public certificate validate. The Feather submission remains open, not an accepted registry entry. |

These sources provide distinct operator attributions and observed hosting.
Cake has first-party endpoint evidence; MoneroDevs has registry attribution and
participation by that operator; xmr.pub is self-identified. This supports the
feasibility shortlist, not proof of an absence of undisclosed common control.
Domain/IP diversity alone would not establish independence. Cake's multiple IPs
count as one operator. Production access/retention arrangements need operator
evidence where the consumer depends on them.

Read-only probes on 8 October, 17:26–17:29 UTC, returned OK over validated TLS
on all three for
`get_info`, `get_version`, `get_block_header_by_height`, `/get_transactions`,
`get_fee_estimate`, `get_output_histogram`, `get_output_distribution`,
`/is_key_image_spent`, and valid Epee requests to `/get_o_indexes.bin`,
`/get_outs.bin` and `/get_output_distribution.bin`. These public restricted-RPC
reads need no client credentials. A zero-image query establishes availability,
not spendability of a real bridge output. No broadcast method was invoked.

The same post-RingCT transaction
`68e5f43857649162462ca417083158dd00e8ffaa3d80c81751f3518b8a6d6885`
at block 2,300,001 was returned by all three with `prune:false`: 1,972 full
transaction bytes, 337 base bytes, 1,635 actual prunable bytes and output indices
27,478,215 and 27,478,216. Split base+prunable bytes exactly reproduce the
unsplit transaction; all three decoded byte strings have SHA-256
`60a82ab22be383a46b17c10a2a148b1146276ac2c665a7af360cef997a8067bd`.
This is an archive integrity hash, not Monero's transaction-ID algorithm.
Cake and xmr.pub also returned non-coinbase RingCT types 4 and 6 at heights
2,000,001 and 3,779,600. Only the type-5 sample was compared across all three.
These samples check formats affected by pruning, not complete archival coverage:
a pruned node can retain sampled stripes. Restricted RPC hides pruning status
and binary release; observed packed interface version 196624 is RPC 3.0.16,
not a daemon release. A full node need not be an unpruned archive node.

The contributor still must qualify full historical retrieval across required
formats/heights, rate limits, rescan and reorg behavior, exact supported daemon
releases where obtainable from operators, and retained history sufficient for
the actual rescan consumer. TLS is established for this shortlist; retain
certificate validation. Test independent submission/relay with an
authorized non-mainnet transaction. Operator identity, retention promises and
access arrangements require operator evidence, not a Rosen implementation choice.

Proposed consumption, once at least three sources are qualified: configure them
for both Watchers and Guards; each contribution requires two matching current canonical views
and no known conflicting third view. An unavailable third view remains visible
and does not become an agreeing vote. Propose a maximum five-block tip lag and
15-minute last-observed-tip age; stop when these bounds or source consistency
cannot be established. These are contributor policy proposals to validate,
not implemented or accepted finality guarantees. The current Guard adapter
does not yet supply this multi-source production path.

## 2. Additional requirements

### 2.1 Supported assets

Native XMR only. There is no Monero token contract or proposal to issue ERG or
other Rosen assets on Monero. On Ergo, use a Rosen-issued wrapped-XMR token and
configured token map. Proposed production mapping is one piconero to one
wrapped-XMR atomic unit, with 12 display decimals and no rounding. This mapping
must match Rosen's issued token/configuration; the fixture's identifiers are not
production values. Any different decimal mapping needs explicit lossless
conversion/remainder handling, not implicit truncation. Rosen owns token issuance
and deployed contract configuration.

Parse and calculate amounts with BigInt. Monero's unsigned-u64 memo range is
not Ergo's positive signed-Long range. Before durable admission, validate each
projected Ergo recipient and combined-fee asset output within `1..2^63-1`, and
apply that bound to every amount or required sum serialized as an Ergo Long.
Zero fees omit the corresponding asset output; they do not create a zero-valued
one. Intermediate sums must never pass through JavaScript Number. The latest
V2 source has focused tests of recipient/combined-fee rejection at this join,
not a new complete native roundtrip.

### 2.2 Released wallet and user journey

**This requirement is not satisfied by the surveyed paths.** The 8 October
source survey examined released Monero GUI/CLI/wallet-rpc
0.18.5.3, Cake Wallet 6.4.6, Stack Wallet 2.7.1, Feather 2.8.1 and monero-ts
0.11.20 at their transaction-producing callers. None supplies
the complete required RMD1 construction and metadata-aware approval journey.
This is a result for the surveyed versions, not proof that Monero cannot
support such a wallet.

The official [wallet-rpc transfer schema](https://github.com/monero-project/monero/blob/22578c3f7d7b4b6dd85ff7daa42a827d97cc53d0/src/wallet/wallet_rpc_server_commands_defs.h#L596-L626)
has destinations, amounts, priority, unlock time and payment ID, but no arbitrary
extra argument. `get_tx_metadata` requests a result; it is not input metadata.
`describe_transfer`, `sign_transfer` and `submit_transfer` can consume an already
constructed unsigned set but do not create RMD1 or explain its destination/fee
commitment to the user. A local note or an 8-byte payment ID is not the
195–253-byte bridge memo.

| Released option | Actual producer boundary checked |
| --- | --- |
| [Monero GUI 0.18.5.3](https://github.com/monero-project/monero-gui/blob/v0.18.5.3/src/libwalletqt/Wallet.cpp#L663-L701) | Transaction call exposes destinations, amounts, payment ID and fee controls; no RMD1 constructor. |
| [Cake 6.4.6](https://github.com/cake-tech/cake_wallet/blob/v6.4.6/cw_monero/lib/monero_wallet.dart#L458-L498) | Actual send caller passes address/amount and empty payment ID; no arbitrary extra. |
| [Stack 2.7.1](https://github.com/cypherstack/stack_wallet/blob/build_316/lib/wallets/wallet/intermediate/lib_monero_wallet.dart#L1313-L1431) | Recipient/address/amount and fee/input selection reach the transaction builder; no RMD1 producer/approval. |
| [Feather 2.8.1](https://github.com/feather-wallet/feather/blob/2.8.1/src/libwalletqt/Wallet.cpp#L891-L928) | Wallet API uses address/amount/payment ID; description is local cache data, not lock data. |
| [monero-ts 0.11.20](https://github.com/woodser/monero-ts/blob/v0.11.20/src/main/ts/wallet/model/MoneroTxConfig.ts#L9-L60) | Released Node/browser/WASM/RPC library has no arbitrary-extra field in its transaction request. Reading extra later does not construct it. |

Required closure is a named public wallet release and supported connector/method
that takes the user's funded state, creates exact reserve output plus metadata,
displays reserve address/gross amount/miner fee/Ergo recipient/bridge charges and
privacy disclosure, binds approval to those exact bytes, signs, broadcasts,
then creates and delivers the matching output intent/proof. The contributor
must demonstrate this entire journey and provide the public lock examples.
A private bridge companion does not satisfy it. The next contributor step is
to resolve a released wallet integration with that capability before expanding
the UI or claiming a supported deposit path.

**Concrete candidate route, not implemented or released:** extend official
`monero-wallet-cli` along its existing funded watch-only wallet -> unsigned
transaction file -> offline `sign_transfer` -> online `submit_transfer` path.
The pinned [CLI producer](https://github.com/monero-project/monero/blob/22578c3f7d7b4b6dd85ff7daa42a827d97cc53d0/src/simplewallet/simplewallet.cpp#L6718)
currently constructs payment-ID extra. The existing wallet2 builder already
accepts extra, preserves it in construction data and [reuses it after the
pre-signing acceptance callback](https://github.com/monero-project/monero/blob/7778a369afdb788af245ba5ac4d5b17d5a2cc4c5/src/wallet/wallet2.cpp#L8050).
The missing joins are an application-memo constructor and meaningful approval;
no new consensus format or wallet2 signing primitive is inferred to be needed.

Propose one bounded application-nonce argument, passed through Core's existing
nonce helper. Do not accept caller-supplied complete `tx.extra` or transaction
public keys. A shared strict RMD1 decoder must run during construction, offline
approval and signed-file submission. Refuse malformed, duplicate, unknown or
ambiguous application nonces, wrong network/epoch, payment-ID conflicts and
unsupported addresses. Refuse transaction splitting: exactly one transaction
and one qualifying non-change reserve output must result, with its actual amount
equal to the memo's gross amount. Copying one memo onto several split payments
would not implement the admitted deposit profile.

Approval must compare the full reserve address, including both spend and view
keys, against an independently trusted network/epoch profile. RMD1's spend-key
field alone cannot distinguish the same spend key with a different view key.
Decode the actual unsigned construction data and actual recipients; display
reserve address, gross XMR, miner fee, Ergo destination, bridge/network charges,
expiry, memo version/length/hash and the public-linkability warning before
signing. Change is excluded from the qualifying deposit amount. The existing
Core payment-proof facility supplies OutProofV2 afterwards; it does not replace
this approval or the output-specific receipt.

The minimum acceptance campaign follows save -> offline sign -> signed-file
load/submit with exact memo preservation. Independently mutate the view key,
gross amount, destination, nonce multiplicity/version, payment ID and stored
unsigned/signed bytes; exercise split and multi-recipient results. Each must
refuse at its intended boundary before unauthorized signing or submission.
Signed-file submission must decode the application nonce from the actual
finalized `pending_tx.tx.extra` and compare its exact RMD field/digest to the
approved unsigned value, not merely redisplay `construction_data.extra`.
Core's [signed-file acceptance](https://github.com/monero-project/monero/blob/22578c3f7d7b4b6dd85ff7daa42a827d97cc53d0/src/simplewallet/simplewallet.cpp#L8049)
uses construction data; [generic final-extra validation](https://github.com/monero-project/monero/blob/7778a369afdb788af245ba5ac4d5b17d5a2cc4c5/src/wallet/pending_tx_validation.cpp#L342)
is not this application-specific binding. Include a cryptographically valid
signed fixture with a different final RMD field, and require rejection before
`commit_or_save`. Random file corruption would not exercise that predicate.
Those checks are planned, not executed. A CLI interface accepted and shipped in
a named wallet release would close this route; a local Core fork would not.
Another released normal-user wallet can satisfy the same contract. First agree
the wallet-facing interface with its maintainers, then implement and execute it;
the Rosen browser-wallet connection still needs its own supported method.

### 2.3 Chaining and parallel requests

Propose no unconfirmed transaction chaining for the first release. Reserve
disjoint confirmed wallet outputs before construction; serialize conflicting
requests and retain reservations for prepared, signing, signed and uncertain
payments. Unlock age, ring selection and change availability can delay later
payments. This trades throughput for simpler attribution/recovery and must be
presented as a scope choice. A changed fee or timeout cannot free an input for
another payment while an earlier signed spend may still be relayed.

### 2.4 Event distinguishability and output checks

Use `(genesis, txid, local_output_index)` to locate the deposit and retain the
raw txid separately. Reconstruct the one-time output key and amount, then bind
the complete intent and credited destination through the event-origin descriptor
`rosen-monero-output:v1:<sha256>`. This descriptor is not a spendable/refund
address. Its interpretation in Rosen's `fromAddress` requires agreement.

Before credit, both Watcher and Guard must independently check: matching
output/destination proof composition; output-key novelty in the durable credit
ledger; authenticated association of this output with the queried key image;
daemon unspent status; canonical inclusion, unlock state and confirmations.
Each Guard durably claims the same backing before contributing. Preserve
output-key and key-image uniqueness across txids, not only the raw txid.
Copied outputs and repeated transaction public-key scanning errors are distinct
failure families; the [coverage map](https://github.com/a-shannon/docs/blob/9466cf2fadd266f20e927da938e074b8ef60dacf/r-and-d/monero-integration/roundtrip/burn-coverage.md)
does not establish universal historical or future burn-bug coverage.

Local claims do not create a globally agreed winner when requests race. The
contributor must specify deterministic assignment and recovery before production;
no timeout or earlier trigger may override a possibly signed payment. Shared
permit-return/cleanup changes require separate Rosen agreement.

### 2.5 Transaction and Rosen fees

Separate the miner fee F from the requested Rosen bridge fee Bq and network fee
Nq. Following the existing [EventOrder calculation](https://github.com/a-shannon/docs/blob/b5d4441b73bcd4eb565643c4977362f1d8804637/r-and-d/monero-integration/roundtrip/source/guard-service/src/event/eventOrder.ts),
effective charges are:

`B = max(Bq, minimumBridgeFee, floor(gross * feeRatio / feeRatioDivisor))`

`N = max(Nq, minimumNetworkFee)` and `recipient = gross - B - N`.

Read minima/ratios from the configured minimum-fee NFT and bind the applicable
historical policy. Use exact integer arithmetic, the configured divisor and
positive recipient/output bounds. In particular, validate the recipient and
combined-fee Ergo outputs against the signed-i64 boundary in section 2.1 before
admission; individually valid unsigned-u64 fee fields do not prove a valid sum.
The local intent binds exact fees: if the
effective policy changes those fees, that intent cannot silently authorize a
different net credit. Proposed production alignment is an intent that
authenticates the effective calculation/policy, fee ceiling and minimum net
amount; that format/consent change is not implemented or agreed. The current
exact-fee refusal is not claimed equivalent to RCS's automatic minimum-fee
adjustment. Existing admitted credits are never repriced.

For the Monero miner fee, obtain `get_fee_estimate`, use the wallet's actual
weight/priority rule and round to `quantization_mask`; do not equate byte size
with transaction weight. Bind the selected fee and ceiling before approval.
Propose re-estimation before the first signing attempt, never mutation of an
approved or signed payment. A higher required relay fee after signing creates
an explicitly retained pending liability; Monero supplies no generic Bitcoin
RBF or timer-based cancellation guarantee.

Require `gross > B+N` for deposit credit; quote a minimum transfer from actual
fees and target-chain output costs, not a copied dust constant. A positive
one-atomic-unit arithmetic remainder is not an economically viable minimum.
The lab checks operation-level conservation, but its pre-funded reserve can
subsidize miner fees. Contributor work remains to quote sustainable charges,
account for fee liabilities/change, and qualify reserve-wide backing. Rosen
retains its fee/reward distribution configuration; no contributor surcharge
is introduced by this proposal.

## 3. Monero-specific information and lifecycle

### 3.1 Network, addresses, units and node resources

| Topic | Chain fact and proposed admission |
| --- | --- |
| Block interval | Target 120 seconds; actual arrival is variable. There is probabilistic PoW finality, not a deterministic-finality checkpoint. |
| Confirmations | Provisional test proposal: 60 canonical confirmations for deposit credit and separately 60 for payout settlement/reward eligibility, about two hours each at target interval, plus independent-source freshness checks. These exceed the laboratory's 10/12 deposit and two-confirmation payout settings but are not quantified production risk thresholds. Deposit depth protects newly issued Ergo liabilities; payout depth protects outstanding redemption/reward liabilities. Propose initial 60/60 conservatively, with accepted exposure limits, detection/pause latency and funded loss capacity recorded before activation. Neither RCS nor unlock age proves that 60 is safe. Map these to existing Rosen configuration and retain monitoring as in section 3.5. |
| Spendability | Current Core enforces ordinary input age of 10 blocks at the applicable fork and coinbase unlock height of creation height+60. Check actual unlock state as well as bridge confirmation depth; these are different predicates. |
| Units/supply | 12 decimals, 1 XMR=10^12 atomic units. No fixed maximum supply: tail emission is up to 0.6 XMR per block, reduced by applicable block-weight penalties. |
| Standard addresses | 95-character Monero Base58 encoding of prefix+32-byte spend key+32-byte view key+checksum. Mainnet/testnet/stagenet standard prefixes are 18/53/24. |
| Other address types | Subaddress prefixes 42/63/36; integrated prefixes 19/54/25. Proposed initial reserve and payout admission is standard addresses only. Subaddresses/integrated addresses and their payment-ID/additional-key handling need separate qualification, not silent conversion. Wrong network/checksum, unsupported type and new CARROT address forms refuse. |
| Coinbase deposits | Exclude from the initial bridge profile. Although a reserve can receive spendable coinbase outputs after the chain unlock, that receipt lacks the demonstrated user intent/payment-proof path. Receiving is not credit eligibility. |
| Stable release examined on 8 October | Official Core/GUI/CLI 0.18.5.3; source commit `22578c3f7d7b4b6dd85ff7daa42a827d97cc53d0`. Historical bridge replay uses its retained older pinned runtime, not an execution of this release. This is a dated reference, not a claim about the latest release. |
| FCMP++ reference | Separate Core beta3 `d816367cb1aa405bfa68a20ac3e034d0759d968e` with pinned imported Rust. No mainnet fork height/date or production support is inferred from that experiment. |
| Node provisioning | Official January-2026 guide: at least 4 GB RAM and 625 GiB available SSD for full node, or 250 GiB for pruned. Proposed initial service budget is 4 CPU cores/8 GiB RAM plus at least that full-node SSD headroom, separate ledger/proof/log storage and growth monitoring. CPU/RAM/latency at Rosen load remain unmeasured; pruned-only deployment is not qualified. |

Sources: pinned [Core configuration](https://github.com/monero-project/monero/blob/22578c3f7d7b4b6dd85ff7daa42a827d97cc53d0/src/cryptonote_config.h),
[input-age/coinbase checks](https://github.com/monero-project/monero/blob/22578c3f7d7b4b6dd85ff7daa42a827d97cc53d0/src/cryptonote_core/blockchain.cpp),
[tail emission](https://www.getmonero.org/resources/moneropedia/tail-emission.html),
[address format](https://docs.getmonero.org/public-address/standard-address/),
and [node guide](https://docs.getmonero.org/running-node/monerod-systemd/).

### 3.2 Expiry, delayed signing and protocol upgrades

A Monero input has no account nonce, recent blockhash or automatic transaction
expiry equivalent to Solana. The memo's Monero-height expiry limits application
admission; it does not invalidate signed Monero bytes, release a reservation or
refund a deposit. Custom `unlock_time` is not an expiry field. The proposal uses
zero custom unlock time and checks actual spendability. The [announced FCMP++
deprecation](https://www.getmonero.org/2026/05/10/deprecating-unlock-time.html)
must be handled by the version-specific parser, not by treating an old relay
restriction as timeless consensus.

Propose a fresh intent window of 720 Monero blocks, roughly 24 hours, with fee
quote validity of 60 minutes before deposit approval. The contributor must
qualify how these clocks interact with source depth, proof availability and
Rosen's pending-payment/cleanup clocks. After a durable admission, retained
recovery checks the exact historical claim and current source state rather than
inventing a new authorization because a timer passed. There is no claim that
the proposed windows have been exercised as production settings.

Before any activation changing transaction/address formats, test old-output
migration, new deposits, already-approved unsigned proposals, retained signed
bytes, spentness, event decoding and recovery across the actual fork schedule.
If old signed bytes cease to be admissible, do not simply replace/re-sign them:
preserve their identity/liability and require a mutually exclusive, newly
authorized transition proven for that fork. Never assume a mempool absence
establishes cancellation. Unsupported formats stop scanning/releases visibly.

Contributor release proposal: prepare the compatibility candidate 30 days before
an announced activation, publish verified operator binaries at least 14 days
before it, and stop new affected deposits seven days before activation if
qualification remains open. A shorter notice period triggers an earlier pause;
it is not authority to waive qualification. These are proposed operational
deadlines, not a Monero fork announcement.

### 3.3 Rejected deposits, custody and reorganizations

An uncredited payment can still create an output controlled by the reserve
spend key. While it remains canonical and unlocked, the reserve holders can
spend it. It is not automatically returned, isolated into a different wallet,
or destroyed. If its source transaction is removed from the canonical chain,
that occurrence supplies no currently spendable reserve funds. The current lab
does not demonstrate disposition for either an expired deposit with no Guard
claim or a pre-credit claim invalidated by reorganization; in the latter case
the output reservation can remain retained. These are our integration's custody
and availability gaps.

| Condition | Funds and required response |
| --- | --- |
| No memo, wrong destination, malformed/unsupported metadata or missing proof | No credit. Reserve ownership/spendability are determined from the output itself. A missing user intent is not a refund instruction; Monero does not expose a reliable sender refund address. |
| Low fee quote or expired intent with no Guard claim | A received canonical output remains reserve-controlled, with no demonstrated re-anchor or refund. Proposed repair: retain an uncredited custody liability and exclude it from freely available backing until an authenticated, exclusive credit-or-refund disposition completes. A low quote cannot authorize an unconsented net change. |
| Source rollback before a claim | Invalidate that occurrence and rescan. If the same output reappears, require current canonical evidence/depth and valid admission authorization. Absence is not a completed refund. |
| Source rollback after a pre-credit claim | The lab invalidates the claim but may retain its reservation without a supported recovery path. Proposed repair: a suspended disposition record and a versioned re-anchor of the same deposit identity only after old claims, credits and possible signatures have been reconciled. |
| Source rollback after credit or possible signing | Retain uniqueness, reservations, exact signed bytes and liability; suspend affected releases pending reconciliation. A new block anchor does not authorize another payment or undo an Ergo credit. |
| Confirmed payout later removed | The lab's terminal observation stops. Proposed continuous monitoring, incident handling and exact-payment reconciliation are specified in section 3.5; they are not implemented. |

**Proposed disposition mechanism, not implemented:** record every reconstructed
reserve receipt durably before deciding credit eligibility, with deposit identity,
output key/image evidence, amount, canonical anchor, intent digest, reservations
and outstanding liability. Record one mutually exclusive economic outcome,
credit or refund; retries and re-anchors preserve the same output uniqueness and
do not create a second credit. Use the agreed Guard authorization threshold and
canonical assignment for every transition, including its restart reconciliation.
This requires a supported custody record for unclaimed receipts, not only the
current credit ledger.

If an unclaimed deposit expires, offer renewed user authorization for credit or
an authenticated refund. For a reappearing, pre-credit invalidated claim, propose
a new anchor generation under that same deposit identity after full depth,
proof/output/image checks and reconciliation of every old obligation. An expired
intent needs renewed consent; do not silently extend expiry or reprice it. If the
output never reappears, retain an unresolved missing-source record; there is no
output from that occurrence to spend or refund. After credit or possible target
signing, hold the liability for incident resolution rather than fresh admission.

Refunds need an authenticated beneficiary and fee consent. Two possible
entitlement profiles require an explicit choice; neither is implemented.
RMD1 already commits the Ergo destination. If that destination is admitted as
P2PK and the intended Ergo beneficiary is entitled to the refund, a later
domain-separated proof by that key could bind the exact receipt, Monero refund
address, amount, fee ceiling, fresh nonce, expiry, network, audience and action.
This avoids an additional on-chain refund key, but changes entitlement from the
Monero payer to the intended Ergo beneficiary. It needs explicit funding-time
consent, Rosen agreement and a demonstrated released Ergo-wallet authorization
flow. P2S, multisig and general Ergo addresses do not inherit this P2PK route.
An invalid or unsupported destination remains held for reviewed entitlement.

If instead entitlement stays with the Monero payer, RMD1 has no dedicated
payer-refund commitment and insufficient spare room for the proposed key/address.
One alternative is RMD2, retaining fields at offsets 4..141 but replacing magic with
ASCII `RMD2` (`524d4432`), placing a 32-byte refund-contract digest at offset 142,
recipient length at 174 and recipient bytes at 175. Limit L to 1..78: memo length
is 175+L, still at most 253 bytes. A 60-byte recipient gives 235 memo bytes and a
239-byte complete nonce field, prefix `02ec017f`. RMD1's 110-byte recipient
limit does not carry over. Distinct decoders must reject unknown versions and
must not reinterpret RMD1 as having a refund contract.

Proposed refund-contract binary encoding, in order: version 1 (u8), source
network (u8), genesis (32 bytes), reserve spend key (32), epoch (u64 big-endian),
fresh deposit nonce (32), dedicated user-controlled Ed25519 authorization public
key (32), refund-address length (u8), standard same-network Monero address
(95 ASCII bytes), and maximum refund miner fee (u64 big-endian atomic XMR).
This payload is 242 bytes. The committed digest is SHA-256 over ASCII
`rosen-monero-refund-contract:v1`, a zero byte, then that exact payload.
Validate network/address checksum, key, epoch and all overlapping context before
admission; deliver and retain the payload alongside the output bundle. Wallet
approval must include this commitment before funding. A later Ed25519-signed
refund request binds the exact deposit receipt, committed contract, beneficiary,
amount and fee within that ceiling. An unbound late bundle proves no initial
authorization.

RMD2 is only a design proposal: no encoder/decoder, released-wallet approval,
refund signature flow, compatibility test or public maximum-payload transaction
has been demonstrated. The sizes above are encoding arithmetic, not relay
evidence. Agreement and those contributor checks are required before use.
Do not infer refund entitlement from an arbitrary supplied address,
the event-origin descriptor, knowledge of a txid, or OutProofV2 alone. Existing
deposits without that authorization require reviewed evidence of entitlement;
there is no automatic refund path for an unauthenticated claimant. Before refund
signing, prove exclusive disposition and reconcile any possible prior credit or
payment; retain final bytes/reservations through confirmation and incident
monitoring. Timeout never deletes claims or proves that signatures do not exist.

For Watcher permits, distinguish unmerged commitments from merged triggers.
The [29 September operator feedback](https://github.com/rosen-bridge/docs/pull/1#issuecomment-5890465995)
reports punitive cleanup of rejected triggers left unspent. A non-punitive
terminal path, fault attribution and recovery when Guards are unavailable need
Rosen's shared contract/lifecycle agreement. A refusal label alone proves no
fault and creates no refund authorization. Do not activate the Monero-specific
refusal paths before their permit/accounting consequences are resolved.

### 3.4 Restart before signature and partial Guard settlement

The newer V2 correction handles lost acknowledgments after a reservation or
prepared-journal commit within the live attempt: exact durable readback permits
continuation, while divergent/signing records refuse a second signing call.
Its three focused tests use real SQLite reservation/journal classes with
simulated native holders and authority. Separately, the existing [partial
committee settlement regression](https://github.com/a-shannon/docs/blob/ed150060b4cc11285eb74226e71bde399402cb71/r-and-d/monero-integration/roundtrip/source/consumer/backingClaim.test.mjs#L34-L49)
exercises a two-of-four persisted backing settlement, SQLite reopen, conflicting
anchor refusal and exact-anchor roll-forward to all four. That ledger-level
retry is not missing. The [native caller](https://github.com/a-shannon/docs/blob/ed150060b4cc11285eb74226e71bde399402cb71/r-and-d/monero-integration/roundtrip/source/consumer/distributedIssuer.ts#L54-L120)
consumes/prepares the vault before reserving that backing settlement and before
approval/finalization. Full process recovery through partial settlement and
rehydration of the consumed real vault remain undemonstrated. Fail-closed refusal
can still leave the payout unavailable; this is not complete crash recovery.

**Proposed repair:** persist the exact operation/assignment, participant epoch,
authorization, input reservations, public construction data and preparation
state before consuming a vault or dispatching native work. Each holder needs
recoverable authenticated inventory and an idempotent preparation receipt;
restart must reconcile partially persisted Guard states under that same
assignment before advancing. Preserve two additive record stages. The
preparation/backing-settlement receipt binds assignment/operation, authority and
request, reservation/selection and exact input/key-image set, descriptor, binding
and expectation digests. Once finalization succeeds, append a finalization
receipt with final txid, exact bytes/hash and dispatch state; it cannot replace
the preparation identity. Extend the existing exact-anchor ledger retry through
the actual recovered native consumer. Apply identical stage receipts to lagging
Guards monotonically and idempotently. Never roll back an already recorded
stage, clear its operation or authorize fresh signing from a missing finalization
receipt. Missing/conflicting anchors keep the operation held; an existing
backing-settlement receipt is not evidence of native finalization.
Rebuild the identical unsigned proposal only when
durable holder state establishes that no signing material was generated or
dispatched. Add a supported native-vault reconstruction/checkpoint interface
and validate it with real holders; serialized JavaScript state alone cannot
rehydrate today's vault.

Persist a write-ahead signing/dispatch state before any native nonce/share
operation. A lost reply or crash then becomes an uncertain signing operation,
not permission to prepare or sign afresh. If library-supported recovery cannot
preserve signing-state safety, retain the reservations and require the explicit
incident procedure; never reuse signing nonces or discard an uncertain attempt.
Retain exact finalized bytes before relay and recover those bytes where present.
Required proof is a native process kill/restart at preparation, partial Guard
settlement and dispatch boundaries, with one economic payout and no second
signing transition for an uncertain attempt. No such latest-source complete
native proof exists yet. This interface and recovery implementation remain
contributor work after design agreement.

### 3.5 Payout settlement, continued observation and disappearance

**Current behavior:** the laboratory marks the Monero payment, its inputs and
event settled after two confirmations and stops observing that payment. Once
the Ergo reward is confirmed, reopening reward settlement returns without a
fresh Monero source check. A deeper payout reorganization can therefore remove
the payment without a demonstrated incident or recovery transition. None of
the recent lost-commit-ack tests repairs that terminal-state behavior.

**Proposed production behavior:** first qualify separate deposit and payout
risk budgets as specified in section 3.1; 60 is a provisional test depth,
not a production threshold already justified by this document. Reuse existing
configuration: Watcher [`observation.confirmation`](https://github.com/rosen-bridge/watcher/blob/4552b29b95dd48947f85406857641b1ecb2e5490/src/config/config.ts#L242)
and Guard [`confirmations.observation`](https://github.com/rosen-bridge/guard-service/blob/d138ca7581f2e50f7d7797a39d3f147f35e83358/packages/abstract-chain/lib/types.ts#L1)
gate deposit credit; Guard `confirmations.payment` gates the Monero payout.
Keep Ergo's own reward
confirmation depth separate. Gate reward eligibility on the Monero payout
depth; do not substitute deposit or Ergo depth for it. Persist final txid/bytes, consumed
key images, payout order/authorization, inclusion block/hash and Ergo reward
identity. Continue tracking canonical inclusion for settled payments for the
lifetime of the reserve, with a durable common-ancestor cursor and restart
rescan. Process every retained settlement affected by a fork; a deeper-than-cache
fork requires historical rescan, not forgetting completed records. Incomplete
history or contradictory sources suspend affected releases and raise an incident.
Sixty confirmations changes the waiting policy, not this monitoring obligation.

Place chain-specific canonicality/reconciliation logic in the Monero network/
chain package, with thin Guard registration. Reuse stored signed bytes and
event linkage; add durable Monero inclusion anchors, cursor, image evidence and
incident state. The current [Guard processor](https://github.com/rosen-bridge/guard-service/blob/d138ca7581f2e50f7d7797a39d3f147f35e83358/services/guard-service/src/transaction/transactionProcessor.ts#L243)
completes the external payment and makes its event eligible for reward. A
terminal Monero reconciler must therefore retain completed payouts, and its
incident state must reach the actual release/signing and unpaid-reward gates.
A health warning alone does not inhibit a payment. Any necessary shared
lifecycle extension belongs in a separate agreed change, with existing chains
covered; do not put Monero RPC algorithms into the shared processor.

If an included payout disappears, move it to an incident state, retain its
input reservations and payout liability, and pause dependent unpaid rewards and
conflicting reserve spends. An already confirmed Ergo reward is not automatically
reversed. Reconcile whether the exact payment is included elsewhere or pending,
and the canonical spentness of every associated image, using independent current
sources. If it is relay-valid and those inputs remain unspent, retry only its
retained exact signed bytes under the original authorization and follow them
to reconfirmation. Absence from one mempool is not cancellation. A conflicting
spend, missing bytes, unresolved source state or invalid old format stays held
for explicit incident authorization and funded compensation/replacement design;
do not automatically sign a new payout. Record any realized reserve shortfall.
This path and post-reward/deep-reorg tests are contributor-owned activation gates,
not implemented recovery. Rosen agreement is needed for shared incident/reward
lifecycle behavior and the accepted exposure/compensation policy.

Before activation, record the accepted deposit/payout depths, per-event and
aggregate wrapped liability limits, payout/reward exposure during detection and
pause, funded loss capacity, endpoint quorum/freshness/cadence and the authority
to pause, replay, replace, compensate and resume. The contributor supplies
parameterized configuration, persistence and fixtures; Rosen/operators supply
their actual limits, operational authority and shared lifecycle agreement.

The decisive post-agreement local campaign uses unequal deposit/payout depths
(for example 3/5) to expose swapped configuration: no credit at 2, one at 3; no
reward eligibility at payout depth 4, one at 5. After the Ergo reward confirms,
test a controlled deeper reorg that removes the payout, with split endpoint
views and Guard restart: restore the incident/reservations, inhibit conflicting
spends, record realized exposure and follow the agreed compensation policy;
the paid reward is not reversible. A separate case removes the payout while its
reward is still unpaid, proving inhibition before reward authorization/dispatch
and reconciliation of any already signed reward bytes. Exercise exact-byte
payout replay when inputs are unspent and a held conflict when an input is spent
differently. Explicit reconciliation and authorized resume must create no second
credit, payout signature or reward. This full campaign has not run; current
focused tests are not its substitute.

### 3.6 TypeScript/Node and native options

| Responsibility | Available path and qualification |
| --- | --- |
| RPC, retry/backoff, blocks, persistence and Rosen wiring | TypeScript/Node with existing Rosen clients and database conventions. These do not intrinsically require a native executable. |
| Public wallet library | monero-ts 0.11.20 offers real Node/browser/WASM/RPC wallet functionality; its present request schema does not construct RMD1. It remains a possible integration base, not a proven unsupported platform. |
| CLSAG construction/scanning/threshold machine | [Rust monero-wallet 0.2.0](https://docs.rs/crate/monero-wallet/0.2.0/source/README.md) supplies arbitrary-data construction and scanning. It explicitly omits complete wallet state, output selection and background operation. The lab supplies those consumers. |
| Payment proof | Core wallet2 OutProofV2 helper is the existing native proof implementation; an equivalent reviewed Node/WASM implementation has not been demonstrated. No claim of TypeScript impossibility is made. |
| FCMP++/CARROT | Separate pinned Core/Rust adapter; no released full-CARROT user journey or Rosen service integration is qualified. |

If native code is retained, the integration contributor owns reproducible build
recipes, dependency pins, signed/checksummed releases and ongoing compatibility
maintenance. Propose Linux x86_64 as the first server support target, with pinned
container/runtime ABI and a documented operator install/rollback recipe.
Windows/macOS/ARM production releases remain unqualified; existing source or a
local Linux/WSL binary is not a published multi-platform product. Rosen owns
acceptance into its deployment/release process. Generic signer callbacks or
shared-library improvements remain separate contributions.

## 4. Modules, in RCS order

Paths below are repository-qualified. They are proposed module
placements, not a claim that all corresponding packages are implemented.

| RCS module | Monero design and producer/consumer responsibility |
| --- | --- |
| Scanner, `scanner/packages/scanners/monero-scanner` | `MoneroRpcNetwork` extends `AbstractNetworkConnector`; `MoneroRpcScanner` extends `GeneralScanner`. Read canonical blocks and full tx bytes, retaining txid/height/hash/indices; discover memos without assuming every transaction is a deposit. Rollback persists before advancing; incomplete history or resource refusal blocks visibly without skipping valid events. |
| Address codec, `utils/packages/address-codec/lib` | Add chain constants, encoder, decoder and validator. Encode raw prefix/keys/checksum bytes as hex without `0x`; distinguish those address bytes from the output-origin descriptor. Validate network, checksum, point/address type and admitted profile. |
| Network Rosen extractor, `utils/packages/rosen-extractor/lib/getRosenData/monero` | `MoneroRpcRosenExtractor` reconstructs raw lock fields. Locally define the exact scanner transaction shape, rather than importing its package. Join matching proof/output evidence before an admissible observation; memo discovery alone is not credit authority. Add supported-chain registration. |
| Observation extractor, `scanner/packages/observation-extractors/monero-observation-extractor` | `MoneroRpcObservationExtractor` follows `AbstractObservationExtractor`, importing scanner type. Persist pending bundle acquisition, exact accepted fields and rollback state. The lab's custom extractor is preparation, not an approved substitution for this extension point. |
| Rosen Chain bases, `guard-service/packages/chains/monero` | `MoneroChain` with `AbstractMoneroNetwork`; propose direct `AbstractChain` because the actual spendable output inventory is view-wallet/custody data, not publicly enumerable address UTXOs. Still define `BoxType` for authenticated output inventory as required by the UTXO design; direct inheritance does not remove input/reservation responsibilities. |
| Universal Rosen extractor, Utils Monero directory | `MoneroRosenExtractor` accepts `string`, the canonical JSON TxType, with its equivalent type defined locally. Reproduce exactly the network extractor's fields and output agreement. The lab lacks this completed upstream join. |
| Chain implementation | Construction, approval, native signature validation, exact-final-ID resolution, retained broadcast/recovery and conservation use the method contract below. No inherited stub/refusal counts as complete support. |
| Network, `guard-service/packages/networks/monero-rpc` | `MoneroRpcNetwork` extends `AbstractMoneroNetwork`. Public daemon reads/submission are separated from private inventory, proof and signing-share transport. Rate-limit through `@rosen-clients/rate-limited-axios`. |
| Asset health, `health-check/packages/asset-check/lib/monero` | Native-only `MoneroRpcAssetHealthCheckParam` queries authenticated reserve inventory and separates spendable/reserved/suspended balances. Public address RPC cannot supply it. Register scanner-sync health separately in Watcher/Rosen Service. |

Canonical TxType must contain network/genesis, version/hard-fork context,
complete transaction bytes and independently computed final txid, inclusion
anchor, identified outputs, memo and immutable evidence digests. Represent
unsigned proposals and finalized payments as distinct states; retain their
mapping rather than calling a proposal hash the transaction ID. BoxType retains
txid/index, output key, amount, global index, unlock state, associated image
evidence and reservation owner; secret shares are never serialized into either.
Its exact schema remains a proposal to agree before package implementation.

| AbstractChain method group | Planned mechanism |
| --- | --- |
| `serializeTx`, `PaymentTransactionFromJson`, `rawTxToPaymentTransaction`, `verifyPaymentTransaction` | Canonical versioned TxType; recompute native identity, conservation and intent/order before accepting serialized fields. Unsupported/mismatched states refuse. |
| `generateTransaction`, `generateMultipleTransactions` | Native wallet selects authenticated unlocked outputs excluding ongoing unsigned/signed Rosen inputs and durable reservations. First profile produces one non-chained payment or refuses an unsupported order. |
| `getTransactionAssets`, `extractTransactionOrder`, `verifyNoTokenBurned` | Reconstruct recipient/change/native fee and input amounts through authenticated wallet evidence. Enforce BigInt XMR conservation, explicit lossless wrapped-unit conversion and positive signed-i64 bounds for every projected Ergo asset output/serialized Long. Empty token lists are not a burn check. |
| `verifyTransactionFee`, `getMinimumNativeToken` | Apply exact Rosen historical policy and actual Monero weight/quantization; check positive net and approved miner-fee ceiling. Return a chain-derived minimum, not another chain's dust threshold. |
| `verifyEvent`, `verifyLockTransactionExtraConditions` | Verify memo/intent/payment proof/output-image association, novelty, canonical source/unlock/depth and same event descriptor. Transaction-level totals do not replace output agreement. |
| `verifyTransactionExtraConditions`, `isTxValid` | Check durable authorization/reservation, current source and the signing-state-specific path. Retained recovery is not fresh admission. |
| `signTransaction`, `isTransactionInSign` | Approve exact proposal before native nonce/share generation; status comes from durable journal/native terminal records. A missing process is not proof that signing did not occur. |
| `submitTransaction`, `getActualTxId`, mempool/confirmation methods | Persist final bytes/txid before dispatch; submit/reconcile those bytes. Lost replies query the actual final txid. Unknown/conflicting mappings stop rather than authorizing another signature. |
| Balance/address/token metadata helpers | Query view-wallet-owned XMR inventory and configured reserve/cold addresses; separate available/reserved/suspended. Native metadata is 12 decimals; unsupported assets/address types refuse. |
| Height/block/transaction/network methods | Require canonical anchors/full bytes and explicit unavailable-history errors; do not advance on truncated data. Query output indices, distribution/decoys, fee and image state using the API surface in section 1.3. |
| RWT/config/required-confirmation helpers | Use Rosen-issued IDs, installed token map and separately configured source/payout depths; fixture constants are not deployment configuration. |

## 5. Integration into services and contracts

### 5.1 Watcher

Register chain/API/initial height in configuration/defaults; initialize the scanner
and observation extractor through existing jobs. Persist discovery, proof-wait,
admission and rollback with the supported database. Before commitments,
revalidate the same output/intent/current source and credit novelty. Expose
scan lag, unsupported protocol, endpoint disagreement, missing proof, stale
claim state and suspended/rejected events through existing health/API surfaces.
A healthy daemon does not imply a ready Watcher. No new shared UI component is
assumed; any new interaction needs the team's contract first.

### 5.2 Guard

Register Monero configuration, chain/provider, universal/trigger/commitment
extractors, token metadata, asset health and package references using current
Guard structure. BalanceHandler's `tokensPerIteration` follows the existing
9999 default unless qualified endpoint rate limits require lower. Each Guard
independently verifies backing and order, durably authorizes before its secret
contribution, records final bytes before submission and reconciles restart.
Chain code cannot bypass those steps through a standalone helper or shared
chain-specific branch. Prove disabled-Monero startup still works for an existing
chain, including eager imports/native availability.

### 5.3 UI, wallet and Rosen Service

Network reads, lock construction, fee estimation and chain algorithms belong
in the Monero network package. Wallet connection, address/session handling,
approval, signing and transfer belong in the wallet package. Rosen App only
connects them through existing interfaces. Rosen Service exposes metadata,
asset/calculator/scanner registrations and accurate availability. The released
wallet gap blocks a supported user flow; a private companion is not a completed
wallet package. Keep this integration document outside the UI repository.

| RCS UI order | Monero mechanism and current status |
| --- | --- |
| 1. Base data: icons, constants, Utils, network bases and app wiring | Proposed: monochrome chain-key icon; network/token identifiers in constants/types and `NETWORKS.hasTokenSupport: false` for native-only XMR; transaction explorer URL helpers and explicit unsupported address/native-token explorer links rather than fabricated public balance pages. Initialize `@rosen-network/monero` implementing `Network` from `@rosen-network/base`, with its network-package `build.sh` entry. In `apps/rosen/src/networks/monero/`, `client.ts` configures that package's instance, `index.ts` re-exports it and `server.ts` supplies constructor server actions. Declare the API environment variable in both `apps/rosen/.env.example` and `apps/rosen/src/env.ts`, and import the client through `apps/rosen/src/networks/index.ts`. Keep this base-data group in one scoped PR when implementation resumes. Production IDs/URLs and a completed consumer remain pending. |
| 2. Asset calculator | Proposed Monero `AbstractCalculator` implementation and chain interface, registered in the existing calculator. Consume authenticated view-wallet inventory; distinguish spendable, reserved and suspended XMR, fee liabilities and atomic conversion. A public address-balance request cannot implement it. Standard package join remains incomplete. |
| 3. Rosen Service, `apps/rosen-service` | Proposed chain configuration, reserve/RWT/API parameters, calculator constructor configuration, scanner, observation and trigger registrations and scan intervals. Add scanner warning/critical configuration keys and the existing scanner-sync health registration. Wire unsupported-format, unavailable proof/inventory and endpoint inconsistency into existing availability surfaces. Full startup/persistence/recovery consumer validation remains pending. |
| 4. Complete network package | Implement `getHeight`, `calculateFee`, `getMinTransfer`, `getMaxTransfer`, exact lock construction and parameter validation using the admitted address/metadata version, actual wallet input/change/fee state and output bounds. Native library support alone does not close these methods. Construction is blocked by the supported wallet/connector decision and RMD2 requires its own agreement/fixtures. |
| 5. Wallet package | At least one named released wallet/version and supported connection protocol. Its class extends `Wallet` from `@rosen-ui/wallet-api` and supplies connect **and disconnect**, connection-status checking, address/balance retrieval, transfer, availability, supported chains and information including name, label and link; keep its SVG icon in a separate TypeScript file. Review exact metadata/refund commitment, fees and privacy before signing and deliver the final bundle afterwards. This end-user journey is not demonstrated; no private companion is substituted. |
| 6. Wallet registration in Rosen App | In `apps/rosen/src/wallets/<wallet>.ts`, configure the selected wallet instance with existing server actions; export it through `apps/rosen/src/wallets/index.ts`. Rebuild dependencies in normal monorepo order. No chain algorithm in app/shared hooks and no new shared component assumed. Blocked until a supported wallet exists; no browser completion is claimed. |

These placements follow the pinned [RCS-003 UI and wallet sequence](https://github.com/rosen-bridge/rcs/blob/f829337a3eb842bdb888c46249a85167648e5c88/rcs-003/README.md#L448-L593).

Use the pinned [Doge/MyDoge or Firo wallet structure](https://github.com/rosen-bridge/ui/tree/289d6d7bd1f09f8a6b1e3c5d88286e3d8e5f454d)
as the UI placement precedent. For chain lifecycle, the [existing final-txid
mapping change](https://github.com/rosen-bridge/guard-service/commit/88b86ef61bc620688d6dd677ba4d460786e8d2f6)
and [Doge input reservations](https://github.com/rosen-bridge/guard-service/blob/efa1a4ca3fb2f4078a9ed067ec3da44dfc9ea6bf/packages/chains/doge/lib/DogeChain.ts)
inform identity/reservation responsibilities. They do not transfer transparent
Bitcoin parsing or ECDSA signing into Monero. Read the exact installed interfaces
again when implementation is permitted; this is not an exhaustive comparator audit.

### 5.4 Contracts, packages and release sequence

Rosen supplies the accepted contracts/configuration, wrapped-XMR issuance,
RWT/fee/token identifiers and production activation authority. The contributor
prepares parameterized token/contract/network configuration, funding/fee budgets,
deployment checks and recovery acceptance steps. An output-origin descriptor
and non-punitive refused-trigger disposition need explicit schema/lifecycle
agreement; a string fitting an existing field is not contract acceptance.

Publish producer packages before dependent consumer review: scanner and Utils
codecs/extractors, observation extractor, chain/network/health packages, then
Watcher/Guard/UI/Rosen Service consumers as their dependency graph permits.
Use repository Node/npm/kodegen conventions, new packages at 0.0.0 with an
initialization minor changeset, and the current RCS major Guard integration
changeset. Regenerate normal locks and execute clean install/build against
released versions. Private tarballs/local links or ignored install scripts are
preparation, not published dependency closure.

RCS-001 applies to TypeScript/ErgoScript unit tests: mirrored Vitest specs,
documented target/scenario/dependencies/expected results, shared testData/testUtils,
appropriate mocks and lifecycle ownership. Unit network calls are mocked;
native/daemon/database campaigns remain separately classified. RCS-002 adds
JSDoc, arrow functions with justified exceptions, meaningful non-secret logging,
changesets and focused diffs. Split independent shared fixes into separate PRs;
do not mix optimizations, equivalent rewrites or other chains into Monero.

## 6. Evidence boundary and remaining closure

| Surface | Implemented and actually executed | Public/submitted/agreed |
| --- | --- | --- |
| CLSAG bridge roundtrip | Isolated Monero deposit, Ergo credit/redemption, Monero payout and Ergo rewards at the retained `9466cf2` source. Later V2 source corrections have focused evidence but no complete native replay of the latest bytes. | [Public source/replay](https://github.com/a-shannon/docs/tree/9466cf2fadd266f20e927da938e074b8ef60dacf/r-and-d/monero-integration/roundtrip); newer [fork source draft](https://github.com/a-shannon/docs/pull/2) at `ed150060b4cc11285eb74226e71bde399402cb71` when checked. Neither is accepted production integration. |
| V2 lost-commit acknowledgments and partial settlement | Three focused tests of exact SQLite reservation/prepared-journal readback in a live attempt; native holders/authority are simulated. An existing separate SQLite regression covers partial backing-settlement reopen/exact-anchor roll-forward. Full native-holder/pre-signing process recovery, including reconstruction of the consumed vault, remains open. | Published fork source and ledger-level retry are not a new complete native roundtrip or demonstrated general restart recovery. |
| Guard availability | Focused claim/permit tests cover three approval participants after four durable claims. Native custody still uses two spend shares. | No latest-source native scenario with a permanently absent Guard; neither 3/4 availability nor 3/4 custody is established. Proposed repair: section 1.1. |
| Uncredited custody and terminal payout | Source-mapped expiry/pre-credit invalidation and stopped observation after two-confirmation settlement; a synthetic SQLite invalidation transition supplements the source trace. | No demonstrated refund/re-anchor, pre-signing recovery or post-reward deep-reorg recovery. Contributor proposals are in sections 3.3–3.5; not implemented or accepted. |
| FCMP++/CARROT | Separate old-output migration, CARROT deposit/return, exact-byte recovery and controlled reorg/reintroduction on fakechain; no Ergo credit/redemption/reward leg. Legacy address hierarchy, custom RCR1 receipt, public fixture keys and separate 2/4 SAL versus synthetic 3/4 approval. | [Fork draft](https://github.com/a-shannon/docs/pull/1) at `5a460f10f0a9dda275d39de9d8fd2b774781f55d`; new CARROT addresses, production proof/custody and Rosen service joins not qualified. |
| Public node feasibility | Three operator-attributed endpoints passed the stated read surface over validated TLS, with identical full/base/prunable type-5 transaction bytes. Cake/xmr.pub additionally supplied type-4/6 samples. No public submission; required historical coverage, rescan/rate behavior and operator release/retention arrangements remain open. | Section 1.3 names endpoints, primary attribution and exact sample. Neither sample success nor an open registry submission is an operator SLA or Rosen approval. |
| Released-wallet lock | Native library supports arbitrary data; surveyed released user-wallet paths do not construct/approve RMD1. A concrete Core CLI producer/approval interface and acceptance campaign are proposed in section 2.2. | The proposed wallet extension is not implemented, released or agreed. No supported browser connector or complete normal-user journey is demonstrated. Contributor feasibility blocker. |
| Public lock examples | Offline encoded vectors and prior local-node examples only. | Representative/max-size public non-mainnet deposits, valid destination and relay/inclusion evidence still missing. |
| RCS modules/services/release | Partial local adaptations and proposed method contracts; incomplete universal extractor, standard observation/health/UI/dependency and terminal recovery joins. | This [document PR](https://github.com/rosen-bridge/docs/pull/1) submits the design for discussion in Rosen's requested structure. Code PRs remain on hold; submission does not establish design agreement or activation authority. |

Immediate contributor work is to agree a viable wallet-facing producer/approval
interface with its maintainers, qualify the remaining endpoint version/history/
relay behavior and obtain
the exact public non-mainnet deposit examples after specific execution authority
and the necessary wallet capability exist. Close the technical designs in
sections 1.1 and 3.3–3.5 for exclusive disposition, absent-Guard assignment,
native pre-signing restart and continued payout observation, together with fee
consent. After design agreement permits implementation, implement and exercise
those joins and replay the actual accepted service path on the exact new source.
These are not delegated to Rosen merely because production acceptance is theirs.

Precise Rosen decisions are agreement on this integration design and its necessary
deviations: output descriptor/event representation, auxiliary proof contract,
Monero share custody/transport, refund entitlement (committed P2PK beneficiary or
separately authorized payer), effective-fee consent, configured finality/exposure
limits and the shared permit-return and incident/reward lifecycle. Rosen also controls deployed contract/token issuance and
activation. Required endpoint and wallet facts remain contributor evidence,
not questions asking the team to research Monero for us.

## Appendix A. Offline encoding vectors

These vectors use synthetic genesis/spend/asset bytes `11`/`22`/`33` repeated
32 times, source testnet tag1, destination tag1, epoch1, gross500000240,
bridgeFee100, networkFee20 and expiry1000. They are not a funded transaction,
public submission, payment proof or consensus/relay demonstration.

| Recipient vector | L | Memo bytes | Complete nonce field bytes | Memo SHA-256 |
| --- | --- | --- | --- | --- |
| `3WwfGbtNEMusQ91apEz1k7EQFQuK1e1FZVD3ouZj9xdt1byEQ8st` | 52 | 195 | 199 | `61ff344c25e4c2ae20970ba9088782f9c46b8ecc7e4cd96d6be0134173ce7e55` |
| ASCII `a` repeated60 | 60 | 203 | 207 | `c199cbbfc2b3373f7f5207a762e372bf13f611779281724e3ca568dc0cfac462` |
| ASCII `a` repeated110 | 110 | 253 | 257 | `4f713bc8a4dfc9933988625117ec482899b764b054d7f38d8f44d5c16a8eb1fa` |

Roundtrip encode/decode, length/offset/u64 checks and rejection of L=111 were
executed on the pinned encoder; source SHA-256
`c44d95239fdb97776150d794355c075dfc4189e0c9de4af51121547726d50caa`.
Repeated-a strings exercise transport lengths only and are not valid checked
Ergo destinations. The 52-byte string is an existing codec fixture, not a public
deposit or evidence of current ownership.

Exact representative memo bytes, in hex:

```text
524d443101011111111111111111111111111111111111111111111111111111111111111111222222222222222222222222222222222222222222222222222222222222222233333333333333333333333333333333333333333333333333333333333333330000000000000001000000001dcd65f00000000000000064000000000000001400000000000003e834335777664762744e454d75735139316170457a316b3745514651754b316531465a5644336f755a6a397864743162794551387374
```

The corresponding extra field prefixes these bytes with `02c4017f`. Full lock
transaction bytes, real proof/receipt and inclusion evidence remain the separate
public-example gate in section 1.2.
