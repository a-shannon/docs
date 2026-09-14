# Build the transaction-proof helper

The supported build profile is Windows x64 with WSL Ubuntu 22.04, GCC 11.4.0,
CMake 3.22.1 and Python 3.10 or later. Use a new output directory on the WSL
Linux filesystem, with at least 10 GiB free space. The wallet build uses up to
four compiler jobs; the exercised host had 24 GiB available RAM.

Install these Ubuntu development packages before running the recipe:

```text
build-essential cmake git pkg-config libboost-all-dev libssl-dev libzmq3-dev
libunbound-dev libsodium-dev libreadline-dev libhidapi-dev libusb-1.0-0-dev
libbsd-dev libunwind-dev
```

The script checks prerequisites and does not install system packages. The
package list supports this build profile; it is not a minimal dependency claim.
Git requires network access to fetch Monero and its pinned recursive submodules.

From WSL, invoke the published script, supplying an absent external directory
whose parent already exists. Paths containing spaces are not supported:

```sh
bash /path/to/source/proof/build-wsl.sh /work/proof-build
```

The script fetches Monero v0.18.5.1 at commit
`4f92268d7c16741cfb41e5bbe2aa46cc260a9ea5`, checks the supplied helper source
hash, builds the shared `wallet` target and links `tx-proof.cpp`. Tests, GUI
dependencies and Trezor support are disabled; the build uses `ARCH=default`.
Source changes, mismatched submodules, existing output paths, failed builds and
unexpected library locations refuse completion. A failed output directory is
retained with logs; select another absent directory for a retry.

Successful output includes `proof-artifacts.json` with the launcher fields
`proofBinary`, `proofBinarySha256`, `proofLibrary`, `proofLibrarySha256` and
`proofSharedLibraries`, plus the public source pin. Copy those five fields
unchanged into the caller-owned roundtrip configuration, together with the WSL
distribution name. `proofSharedLibraries` contains 1–64 unique
`{ "path": "/canonical/absolute/library.so", "sha256": "..." }` entries,
including the wallet library with its matching hash. Build logs and system
package versions remain in the output directory.

Keep the entire fresh shared-library build tree at its original location.
The helper and libraries embed RUNPATH entries into that tree; copying only
`tx-proof` and `libwallet.so` is insufficient. No `LD_LIBRARY_PATH` is required.
The launcher checks every declared artifact's canonical path and hash before
and after execution. The proof wrapper also checks those artifacts and the
`ldd` dependency list before and after each invocation, within one 30-second
deadline; a failed check prevents delivery of the proof result. Undeclared
libraries outside `/usr/lib` and `/lib`, missing declared libraries,
`LD_PRELOAD` and `LD_AUDIT` are refused. Distribution-owned libraries in those
system directories remain dependencies of the prepared operating system;
their bytes are not covered by the fresh-build library pins.

The build validates library resolution and the helper's invalid-invocation
response. Positive proof production and verification are established by the
subsequent roundtrip replay. Artifact hashes describe this build; identical
hashes across other paths or toolchains have not been established.
