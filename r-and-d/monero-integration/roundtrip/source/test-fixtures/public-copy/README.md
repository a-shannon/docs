# Public-output-copy test generator

This separate test binary constructs controlled duplicate-output-key cases on
Monero's isolated fakechain. It requires protocol 16, offline mode, no peers,
loopback RPC and unchanged genesis before every mutating RPC. Historical genesis
is parsed as version 1; subsequent blocks must use version 16.

Build with `cargo build --locked --bin pedpop-wallet-type-join`, using an external
`CARGO_TARGET_DIR`. The binary takes `copy-existing <public-input.json>`, whose
exact fields are `mode` (`raw` or `decodable`), `txHex`, `txid`, `vaultSpend`,
`outputIndex` (integer) and `port` (integer). It verifies the existing occurrence,
funds a fresh copier wallet and includes one copy using the copier's own input.
It receives neither the honest sender's transaction secret nor the vault's
spending secret. The public view scalar is one, as in the parent fixture.

The standalone arguments `<raw|decodable> <honest-first|copy-first>` exercise
inclusion ordering and spending the specifically selected honest occurrence.
Set `MONERO_LOCAL_RPC_PORT` to an already running isolated fixture daemon.
These standalone cases do not execute the Rosen credit or threshold withdrawal.

The vendored `monero-wallet 0.2.0` is derived from repository commit
`9e11f5c0f2b18ab821192efa427c863086b51379`, `monero-oxide/wallet`. Its unchanged
MIT license and upstream test sources are retained. Only three wallet source
files are modified: `send/mod.rs` decodes fixture public points, `send/tx.rs`
substitutes the raw output key, and `send/tx_keys.rs` substitutes the public
transaction key and corresponding public-view derivations. Those hooks are
exclusive to this test binary. The participant's separate dependency remains
unmodified.

The generator's own receipt establishes its observed inclusion and decoding
checks. The parent integration test separately checks the copy's canonical
inclusion, authenticated credit, retained assignment and authorized payout.
