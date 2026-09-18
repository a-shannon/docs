# Prepare a fresh Windows reproduction

Use Windows x64, Node.js 24.13.1, Rust 1.98.1 with the
`x86_64-pc-windows-msvc` linker toolchain, Java 17, Git and PowerShell 7.4 or later.
The dependency stage obtains npm 11.6.2 in its own cache. The proof-helper
stage separately uses WSL Ubuntu 22.04, GCC 11.4.0 and CMake 3.22.1, as described
in [the proof build recipe](../proof/README.md). System tools must already be
installed. Preparation requires public network access and at least 10 GiB free
space; native compiler outputs can grow beyond that minimum.

Obtain the reviewed SHA-256 of `source-manifest.json` independently. Preparation
checks that manifest, its exact file set, every member hash/size and its aggregate
before fetching dependencies or executing install/build commands.

Set `$ReviewedManifestSha256` to that digest and `$PreparedDirectory` to a new
absolute output path selected for this run. From the source package, run:

```powershell
pwsh -File .\tools\prepare-windows.ps1 -OutputDirectory $PreparedDirectory -ManifestSha256 $ReviewedManifestSha256
```

The output directory must be absent, outside the source package, and have an
existing parent. The script writes downloads, fresh source copies, build targets,
caches, logs and `prepared-windows.json` there. It does not start nodes or create
wallets. Failed output directories are retained for inspection; use a new absent
directory for a retry.

Independent stages can be prepared separately. Set `$RosenDirectory`,
`$NativeDirectory` and `$ArtifactDirectory` to distinct new absolute paths:

```powershell
pwsh -File .\tools\prepare-windows.ps1 -Stage Rosen -OutputDirectory $RosenDirectory -ManifestSha256 $ReviewedManifestSha256
pwsh -File .\tools\prepare-windows.ps1 -Stage Native -OutputDirectory $NativeDirectory -ManifestSha256 $ReviewedManifestSha256
pwsh -File .\tools\prepare-windows.ps1 -Stage Artifacts -OutputDirectory $ArtifactDirectory -ManifestSha256 $ReviewedManifestSha256
```

The Rosen stage clones public guard-service commit
`1edc2fb982de4560c5265e04e2ed8b93d00b40df`. Its only source overlay is the reviewed
root package/lock, `guard-service/package.json` mapped to
`services/guard-service/package.json`, and the 13 reviewed
`packages/monero-deposit/` files. Locked npm installation uses `--ignore-scripts`,
then explicitly runs both upstream `patch-package` patches and the ErgoChain
TypeScript build, which builds its referenced abstract-chain project. All 309
prepared distribution hashes must match before the stage succeeds.

The watcher store uses Node's built-in SQLite. TypeORM's extractor construction
also loads `sqlite3`, so preparation explicitly installs and verifies the official
sqlite3 5.1.7 Windows x64 N-API 6 driver and runs an in-memory query. The explicit
N-API target avoids the older installer's failure to infer it under Node 24.
Installation omits the upstream
Husky preparation and transitive lifecycle scripts for SWC, bcrypto, bdb,
esbuild, fsevents, goosig, secp256k1, unbound and protobufjs. The exercised
dependency closure loaded Ergo WASM, multisig, encryption, ErgoChain, Vitest and
tsx and transformed TypeScript through esbuild. This is not an installation
recipe for every autonomous upstream daemon.

The Native stage copies only reviewed source members into fresh external trees,
builds the participant and separate public-copy fixture with `cargo build
--locked`, and uses separate external target directories. The participant also
provides the public observer mode. Newly built executable hashes are recorded;
byte-identical builds across other toolchains or paths are not claimed.

The Artifacts stage verifies both the official Monero 0.18.5.1 archive and its
extracted daemon, the official Ergo 6.0.3 JAR, and the public devnet configuration
from Ergo commit `28ebb184b0c90ee9adebe1111eb6aa3244798ba9`. Versions, URLs and
SHA-256 values are fixed in the script. Downloaded executables are not launched.

## Build the two adapter packages

The adapter profiles also require the public scanner and sign-protocols forks.
Choose absent absolute `$scannerDirectory` and `$signDirectory` outside the
source and runtime directories. Use the same pinned npm version as above; the
commands below execute npm 11.6.2 explicitly. Select an absolute caller-owned
`$adapterBuildDirectory` and use a dedicated cache:

```powershell
$env:npm_config_cache = Join-Path $adapterBuildDirectory 'npm-cache'
npm exec --yes --package=npm@11.6.2 -- npm --version
git -c core.autocrlf=false clone --no-checkout https://github.com/a-shannon/scanner.git $scannerDirectory
git -C $scannerDirectory config core.autocrlf false
git -C $scannerDirectory checkout --detach 2e0382d97a6e0a7bb6fb0e5927ad56af44d2f0ae
Push-Location $scannerDirectory
npm exec --yes --package=npm@11.6.2 -- npm ci --ignore-scripts
npm exec --yes --package=npm@11.6.2 -- npm run build
Push-Location node_modules/sqlite3
node ../prebuild-install/bin.js -r napi -t 6
Pop-Location
npm exec --yes --package=npm@11.6.2 -- npm run test --workspace=@rosen-bridge/monero-observation-extractor -- tests/actions/candidateStore.spec.ts
Pop-Location

git -c core.autocrlf=false clone --no-checkout https://github.com/a-shannon/sign-protocols.git $signDirectory
git -C $signDirectory config core.autocrlf false
git -C $signDirectory checkout --detach 2fdaf3af3897d9c2b1c7e5e6c7d57d0415d808b0
Push-Location $signDirectory
npm exec --yes --package=npm@11.6.2 -- npm ci --ignore-scripts
node node_modules/patch-package/index.js
npm exec --yes --package=npm@11.6.2 -- npm run build --workspace=@rosen-bridge/communication
npm exec --yes --package=npm@11.6.2 -- npm run build --workspace=@rosen-bridge/detection
npm exec --yes --package=npm@11.6.2 -- npm run build --workspace=@rosen-bridge/encryption
npm exec --yes --package=npm@11.6.2 -- npm run build --workspace=@rosen-bridge/ergo-multi-sig
Pop-Location
```

Check each command's exit status before proceeding. The explicit winston patch
reports its upstream version-label mismatch against locked winston 3.19.0 but
applies successfully. The narrow sign-protocols build avoids the unrelated
TSS service's POSIX-only Go build command. LF is part of this byte-reproduction
recipe: inline TypeScript source maps otherwise change the emitted hashes.
The six-file multisig runtime aggregate must be
`ac1ff3995a4bf299dd2bccb28b8c03141ced9f0a34fb7e28f766a34435637282`,
using the [source README's digest recipe](../README.md#reproduce-the-deposit-adapter-candidate).

## Create the isolated Ergo funding runtime

Load `prepared-windows.json` into `$prepared` (combine the non-overlapping fields
if preparation used separate stages). Set `$ergoDirectory` to a new absent
external directory with an existing parent, and `$javaExecutable` to Java 17.
Ports 19051 and 19021 must be free.

```powershell
node .\ergo-node\bootstrap-devnet.mjs --runtime $ergoDirectory --rosen-root $prepared.rosenRoot --jar $prepared.ergoJar --java $javaExecutable --devnet-config $prepared.ergoDevnetConfig
$ready = Get-Content -LiteralPath (Join-Path $ergoDirectory 'bootstrap-ready.json') -Raw | ConvertFrom-Json
```

The bootstrap creates new wallet and recipient capabilities, mines until rewards
are mature, and confirms a 100 ERG plain EIP3 output that the fixture can select.
It leaves its Java process running after success and records its identity in
`process.json`. Startup failures retire only that owned process. Preserve failed
directories for diagnosis and select a new absent directory for a retry.

## Configure and run

Load the WSL build's `proof-artifacts.json` into `$proof`. Select `$distro`, an
absent external `$newRunDirectory`, and an external `$configurationFile` that
does not exist. Set `$manifestSha256` to the reviewed source-manifest digest.

```powershell
$configuration = @{
    rosenRoot = $prepared.rosenRoot
    runtimeDirectory = $newRunDirectory
    ergoRuntime = $ergoDirectory
    ergoRecipient = $ready.recipient
    wslDistro = $distro
    scannerAdapterRoot = Join-Path $scannerDirectory 'packages/observation-extractors/monero-observation-extractor'
    scannerAdapterCommit = '2e0382d97a6e0a7bb6fb0e5927ad56af44d2f0ae'
    contributionPackage = @{
        root = Join-Path $signDirectory 'packages/ergo-multi-sig'
        commit = '2fdaf3af3897d9c2b1c7e5e6c7d57d0415d808b0'
        sha256 = 'ac1ff3995a4bf299dd2bccb28b8c03141ced9f0a34fb7e28f766a34435637282'
    }
    processSimulation = $true
    v2Return = $true
    sourceResilience = $false
}
foreach ($name in @('nativeBinary','nativeSha256','observerBinary','observerSha256','moneroDaemon','moneroDaemonSha256')) {
    $configuration[$name] = $prepared.$name
}
foreach ($name in @('proofBinary','proofBinarySha256','proofLibrary','proofLibrarySha256','proofSharedLibraries')) {
    $configuration[$name] = $proof.$name
}
if (Test-Path -LiteralPath $configurationFile) { throw 'Choose an absent configuration file' }
$configuration | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $configurationFile -Encoding utf8NoBOM
node .\tools\launch-roundtrip.mjs --config $configurationFile --manifest-sha256 $manifestSha256 --profile v2-roundtrip --check-only true
node .\tools\launch-roundtrip.mjs --config $configurationFile --manifest-sha256 $manifestSha256 --profile v2-roundtrip
```

Both check-only and execution require clean scoped adapter sources at the
declared commits. The successful-return profile and source-quarantine profile
are separate campaigns; each needs a new output directory.

To reproduce a historical copy-first case instead, create a separate configuration
with the binary, proof and Ergo fields above, omit the three V2 mode fields,
add `collisionBinary` and `collisionSha256` from `$prepared`, and choose
`collisionExperiment: 'decodable-copy-first'` or `'raw-copy-first'`. Use
`--profile watcher-authority`. These historical runs are not prerequisites for
the current complete V2 campaign.

The launcher retains its execution status, unchanged-input result and test logs
outside the source package. The runtime includes private spending capabilities;
share the public qualification receipts rather than the runtime directory.

After testing, verify the PID, executable and exact start time in `process.json`
still identify the bootstrap's Java process. Use that runtime's API key to call
the loopback `/node/shutdown` endpoint and verify the owned process exits.
Do not stop unrelated Java or WSL processes. Preparation alone does not establish
a successful two-chain replay.
