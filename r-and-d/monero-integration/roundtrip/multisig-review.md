# Review packet: optional async multisig contribution authorization

## Scope and source pins

The independent local implementation review is closed for the optional
contribution hook and its overlapping-request correction. Rosen's design and
maintainer reviews remain open. This packet does not claim a third-party
cryptographic audit or production qualification.

- Upstream base: [`e8b6fb0`](https://github.com/rosen-bridge/sign-protocols/tree/e8b6fb0a0f6dda7813d885b142f0bd11c9578867).
- Reviewed laboratory candidate: [`2fdaf3a`](https://github.com/a-shannon/sign-protocols/commit/2fdaf3af3897d9c2b1c7e5e6c7d57d0415d808b0), branch `feat/monero-reviewed-runtime`.
- [Exact candidate diff](https://github.com/a-shannon/sign-protocols/compare/e8b6fb0a0f6dda7813d885b142f0bd11c9578867...2fdaf3af3897d9c2b1c7e5e6c7d57d0415d808b0).
- The existing [upstream draft](https://github.com/rosen-bridge/sign-protocols/pull/2) remains at `fd41b5df91d79bc0fc74373a397372edfd3efa84` while the RCS integration document is reviewed.

The candidate changes five files, adding 825 lines: the changeset, package
README, `multiSigHandler.ts`, `types.ts`, and the contribution-validation tests.
It changes authorization around Ergo multisig contributions. Monero threshold
CLSAG construction remains in the separate Rust implementation.

## Contract and native contribution points

`ErgoMultiSigConfig.beforeContribution` is an optional async callback receiving
a frozen `{txId, reducedHex, kind}` request. Its three kinds are `commitment`,
`coordinator-sign` and `peer-sign`. The public feature marker is
`contributionValidationVersion === 1`.

- [Types](https://github.com/a-shannon/sign-protocols/blob/2fdaf3af3897d9c2b1c7e5e6c7d57d0415d808b0/packages/ergo-multi-sig/lib/types.ts#L111) and [caller responsibilities](https://github.com/a-shannon/sign-protocols/blob/2fdaf3af3897d9c2b1c7e5e6c7d57d0415d808b0/packages/ergo-multi-sig/README.md#L27).
- [Capture and post-await checks](https://github.com/a-shannon/sign-protocols/blob/2fdaf3af3897d9c2b1c7e5e6c7d57d0415d808b0/packages/ergo-multi-sig/lib/multiSigHandler.ts#L102).
- [Overlapping requests](https://github.com/a-shannon/sign-protocols/blob/2fdaf3af3897d9c2b1c7e5e6c7d57d0415d808b0/packages/ergo-multi-sig/lib/multiSigHandler.ts#L360), [commitment authorization](https://github.com/a-shannon/sign-protocols/blob/2fdaf3af3897d9c2b1c7e5e6c7d57d0415d808b0/packages/ergo-multi-sig/lib/multiSigHandler.ts#L407), [coordinator signature](https://github.com/a-shannon/sign-protocols/blob/2fdaf3af3897d9c2b1c7e5e6c7d57d0415d808b0/packages/ergo-multi-sig/lib/multiSigHandler.ts#L542), and [peer signature](https://github.com/a-shannon/sign-protocols/blob/2fdaf3af3897d9c2b1c7e5e6c7d57d0415d808b0/packages/ergo-multi-sig/lib/multiSigHandler.ts#L719).

After authorization, the handler rechecks retained transaction identity, reduced
bytes, input/data-input identity and bytes, secret/round state, threshold, turn
and communication/Ergo committee membership. The caller supplies chain validation,
permanent economic custody and I/O deadlines.

## Local review and regression evidence

The final review reproduced a liveness defect missed by sequential retry tests:
two simultaneous requests for the same queued entry and coordinator could both
authorize. The first commitment made the second snapshot stale and poisoned the
successful entry. The correction shares one pending operation only for that
exact identity. Later requests authorize again; genuine transaction, coordinator,
turn and committee conflicts still refuse.

The focused suite passes **40 tests**, and the complete package suite passes
**77 tests**. Build, type checking, ESLint and formatting of changed files pass.
The repository-wide formatter reports pre-existing formatting differences in 25
untouched files. The independent
overlap reproduction and post-fix review are closed. Earlier reports of 15 detected
mutations concern the preceding snapshot; their individual mutation artifacts
are not bundled here as current replay evidence.

From the exact public checkout with locked dependencies installed:

```powershell
$env:NODE_OPTIONS = '--import tsx'
npm --workspace @rosen-bridge/ergo-multi-sig exec vitest -- --run tests/contributionValidation.spec.ts
npm --workspace @rosen-bridge/ergo-multi-sig exec vitest -- --run
npm --workspace @rosen-bridge/ergo-multi-sig run build
npm --workspace @rosen-bridge/ergo-multi-sig run type-check
```

## Integration binding

The six-file runtime aggregate from a clean LF checkout of `2fdaf3a` is
`ac1ff3995a4bf299dd2bccb28b8c03141ced9f0a34fb7e28f766a34435637282`.
The first reward campaign used
`a2f22f7a1aa1936f4a0ea2ae685d51368a4740202f9b59e70fba4ac25e3d3e37`;
its inline source maps encoded a mixed-line-ending working copy. The clean-build
recipe fixes the checkout convention rather than relying on that incidental state.
[The source recipe](source/README.md#reproduce-the-deposit-adapter-candidate)
defines its files and digest encoding. Guard participants load that exact
package, require its feature marker and supply independently reconstructed
credit or reward checks immediately before contributions.

The [adapter report](adapter-qualification.md) records the separate end-to-end
evidence. Persistent holder enrollment, protected custody, production service
integration and the accepted RCS profile remain deployment decisions.
