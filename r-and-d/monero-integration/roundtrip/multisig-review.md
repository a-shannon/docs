# Review packet: optional async multisig contribution authorization

## Scope and source pins

This packet requests review of the optional contribution-authorization change in
`@rosen-bridge/ergo-multi-sig`. It does not make a production-readiness claim.

- Upstream base: [`e8b6fb0`](https://github.com/rosen-bridge/sign-protocols/tree/e8b6fb0a0f6dda7813d885b142f0bd11c9578867) (`origin/dev`).
- Candidate: [`fd41b5d`](https://github.com/a-shannon/sign-protocols/commit/fd41b5df91d79bc0fc74373a397372edfd3efa84), branch `feat/async-contribution-validation`.
- [Exact candidate diff](https://github.com/a-shannon/sign-protocols/compare/e8b6fb0a0f6dda7813d885b142f0bd11c9578867...fd41b5df91d79bc0fc74373a397372edfd3efa84).

The candidate changes five files (+719 lines):

1. `.changeset/fresh-contribution-validation.md`
2. `packages/ergo-multi-sig/README.md`
3. `packages/ergo-multi-sig/lib/multiSigHandler.ts`
4. `packages/ergo-multi-sig/lib/types.ts`
5. `packages/ergo-multi-sig/tests/contributionValidation.spec.ts` (new)

## Public contract and execution points

`ErgoMultiSigConfig.beforeContribution` is an optional async callback. It receives
a frozen request with `txId`, `reducedHex`, and `kind`, where `kind` is one of
`commitment`, `coordinator-sign`, or `peer-sign`. The handler exposes
`contributionValidationVersion === 1` for feature detection.

- [Public request and configuration types](https://github.com/a-shannon/sign-protocols/blob/fd41b5df91d79bc0fc74373a397372edfd3efa84/packages/ergo-multi-sig/lib/types.ts#L111-L132)
- [Version marker](https://github.com/a-shannon/sign-protocols/blob/fd41b5df91d79bc0fc74373a397372edfd3efa84/packages/ergo-multi-sig/lib/multiSigHandler.ts#L24-L28)
- [Documented callback contract and caller responsibilities](https://github.com/a-shannon/sign-protocols/blob/fd41b5df91d79bc0fc74373a397372edfd3efa84/packages/ergo-multi-sig/README.md#L27-L42)

The callback is invoked at three native-contribution points:

1. Before commitment generation: [lines 378–389](https://github.com/a-shannon/sign-protocols/blob/fd41b5df91d79bc0fc74373a397372edfd3efa84/packages/ergo-multi-sig/lib/multiSigHandler.ts#L378-L389).
2. Before the coordinator’s partial signature: [lines 513–556](https://github.com/a-shannon/sign-protocols/blob/fd41b5df91d79bc0fc74373a397372edfd3efa84/packages/ergo-multi-sig/lib/multiSigHandler.ts#L513-L556).
3. Before a peer’s partial signature: [lines 690–703](https://github.com/a-shannon/sign-protocols/blob/fd41b5df91d79bc0fc74373a397372edfd3efa84/packages/ergo-multi-sig/lib/multiSigHandler.ts#L690-L703).

The post-await check retains the queued transaction identity, serialized reduced
transaction, secret/round state, signer threshold, input and data-input object
identity and serialized bytes, plus turn and communication/Ergo committee
membership. See [capture and revalidation](https://github.com/a-shannon/sign-protocols/blob/fd41b5df91d79bc0fc74373a397372edfd3efa84/packages/ergo-multi-sig/lib/multiSigHandler.ts#L65-L162) and [turn scheduling revalidation](https://github.com/a-shannon/sign-protocols/blob/fd41b5df91d79bc0fc74373a397372edfd3efa84/packages/ergo-multi-sig/lib/multiSigHandler.ts#L901-L935).

## Existing test and qualification record

The previous qualification records **72 multisig tests**, build, type checking,
and lint as passing, and reports **15 targeted mutations detected**. The focused
coverage is the new [contribution-validation test file](https://github.com/a-shannon/sign-protocols/blob/fd41b5df91d79bc0fc74373a397372edfd3efa84/packages/ergo-multi-sig/tests/contributionValidation.spec.ts#L139-L531). The qualification record also states that the final independent review of the multisig fixes remains pending.

- [Validation summary and pending review status](https://github.com/a-shannon/docs/blob/82f6e5200baeef1759c0874d76da73a59462c9a9/r-and-d/monero-integration/roundtrip/adapter-qualification.md#L49-L99)
- [Pinned package commit and aggregate instruction](https://github.com/a-shannon/docs/blob/82f6e5200baeef1759c0874d76da73a59462c9a9/r-and-d/monero-integration/roundtrip/source/README.md#L10-L25)

The exact PowerShell command below was rerun for this packet: **35 focused tests
passed**. The reported 15 mutations remain historical qualification evidence;
their individual patches and replay records are not included here. Use the
published tests as the directly reproducible evidence in this packet.

From the pinned sign-protocols checkout with its dependencies installed, the package declares `test`, `build`,
`type-check`, and `lint:check` scripts. For Windows PowerShell replay, set the
Node worker import before invoking Vitest:

```powershell
$env:NODE_OPTIONS = '--import tsx'
npm --workspace @rosen-bridge/ergo-multi-sig exec vitest -- --run tests/contributionValidation.spec.ts
npm --workspace @rosen-bridge/ergo-multi-sig run build
npm --workspace @rosen-bridge/ergo-multi-sig run type-check
npm --workspace @rosen-bridge/ergo-multi-sig run lint:check
```

The package's own `test` script is `NODE_OPTIONS='--import tsx' vitest`; the
direct Vitest invocation above is its PowerShell-compatible equivalent. Run the
complete package suite with the same environment variable and omit the test-file
argument.

## Qualification integration use

The roundtrip qualification pins this candidate’s built package by aggregate
SHA-256 `f0ddaf9e6b1a00557f55c239529e418f5d76f13b2a63c81ca5cbfd483a9effe1`.
Its guard participants load that pinned package, provide `beforeContribution`,
and require `contributionValidationVersion === 1`. The integration record is
useful context for the callback consumer, while review of this packet remains
limited to the published multisig candidate.

## Requested maintainer decision

Please complete the final independent review of `fd41b5d`, including the public
callback contract, the three authorization points, post-await revalidation, and
the focused regression coverage. Final independent multisig review is **pending**.
