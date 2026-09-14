#Requires -Version 7.4
[CmdletBinding()]
param(
    [string]$SourceRoot = (Split-Path -Parent $PSScriptRoot),
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [Parameter(Mandatory = $true)][string]$ManifestSha256,
    [ValidateSet('Rosen', 'Native', 'Artifacts', 'All')][string]$Stage = 'All'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Fail([string]$Message) { throw $Message }
function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function CheckHash([string]$Path, [string]$Expected) {
    if ($Expected -cnotmatch '^[0-9a-f]{64}$' -or (Hash $Path) -cne $Expected) { Fail "SHA-256 mismatch: $Path" }
}
function CheckSpace([string]$Path) {
    $drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($Path))
    if ($drive.AvailableFreeSpace -lt 10GB) { Fail 'At least 10 GiB free space is required.' }
}
function Run([string]$Executable, [string[]]$Arguments, [string]$Log) {
    & $Executable @Arguments 2>&1 | Tee-Object -FilePath $Log | Out-Host
    if ($LASTEXITCODE -ne 0) { Fail "Command failed ($LASTEXITCODE); see $Log" }
}
function CopyMembers([string]$Prefix, [string]$Destination) {
    $members = @($script:manifest.files | Where-Object { $_.path.StartsWith($Prefix, [StringComparison]::Ordinal) })
    if ($members.Count -eq 0) { Fail "No reviewed source members: $Prefix" }
    foreach ($entry in $members) {
        $target = Join-Path $Destination $entry.path.Substring($Prefix.Length)
        [System.IO.Directory]::CreateDirectory((Split-Path -Parent $target)) | Out-Null
        Copy-Item -LiteralPath (Join-Path $script:source $entry.path) -Destination $target
        CheckHash $target $entry.sha256
    }
}
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { Fail 'Windows x64 is required.' }
if ($ManifestSha256 -cnotmatch '^[0-9a-f]{64}$') { Fail 'An independently reviewed lowercase manifest SHA-256 is required.' }
if ($OutputDirectory -notmatch '^[A-Za-z]:[\\/]') { Fail 'OutputDirectory must be an absolute local drive path.' }
$script:source = [System.IO.Path]::GetFullPath($SourceRoot).TrimEnd('\', '/')
$output = [System.IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\', '/')
if ($source -match '^[A-Za-z]:$' -or $output -match '^[A-Za-z]:$') { Fail 'SourceRoot and OutputDirectory must not be drive roots.' }
if (Test-Path -LiteralPath $output) { Fail 'OutputDirectory must be absent; use a new directory for each stage or retry.' }
if ($output.Equals($source, [StringComparison]::OrdinalIgnoreCase) -or $output.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase)) { Fail 'OutputDirectory must be outside SourceRoot.' }
$parent = Split-Path -Parent $output
if (-not (Test-Path -LiteralPath $parent -PathType Container)) { Fail 'OutputDirectory parent must already exist.' }
foreach ($path in @($source, $parent)) {
    $cursor = Get-Item -LiteralPath $path
    while ($null -ne $cursor) {
        if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail 'Source and output parent must not traverse reparse points.' }
        $cursor = $cursor.Parent
    }
}
CheckSpace $output
$manifestPath = Join-Path $source 'source-manifest.json'
CheckHash $manifestPath $ManifestSha256
$script:manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.algorithm -cne 'sha256' -or $manifest.aggregateRecipe -cne 'UTF-8: path + NUL + sha256 + NUL + decimal bytes + LF; ordinal path order' -or $manifest.fileCount -ne $manifest.files.Count -or $manifest.files.Count -gt 1024) { Fail 'Manifest schema mismatch.' }
$seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$names = [Collections.Generic.List[string]]::new()
$recipe = [Text.StringBuilder]::new()
foreach ($entry in $manifest.files) {
    if ($entry.path -cnotmatch '^[A-Za-z0-9_./-]+$' -or $entry.path.StartsWith('/') -or @($entry.path.Split('/') | Where-Object { $_ -in @('', '.', '..') }).Count -gt 0 -or -not $seen.Add($entry.path)) { Fail 'Invalid or duplicate manifest path.' }
    $file = Join-Path $source $entry.path
    CheckHash $file $entry.sha256
    if ((Get-Item -LiteralPath $file).Length -ne $entry.bytes) { Fail "Source size mismatch: $($entry.path)" }
    $names.Add($entry.path)
    [void]$recipe.Append($entry.path).Append([char]0).Append($entry.sha256).Append([char]0).Append([string]$entry.bytes).Append("`n")
}
$sorted = $names.ToArray(); [Array]::Sort($sorted, [StringComparer]::Ordinal)
if (($sorted -join "`0") -cne ($names -join "`0")) { Fail 'Manifest paths are not in ordinal order.' }
$tree = @(Get-ChildItem -LiteralPath $source -Recurse -Force)
if (@($tree | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { Fail 'Source contains a reparse point.' }
[string[]]$actual = @($tree | Where-Object { -not $_.PSIsContainer } | ForEach-Object { $_.FullName.Substring($source.Length + 1).Replace('\', '/') } | Where-Object { $_ -cne 'source-manifest.json' })
[Array]::Sort($actual, [StringComparer]::Ordinal)
if (($actual -join "`0") -cne ($sorted -join "`0")) { Fail 'Exact source file set mismatch.' }
$digest = [Security.Cryptography.SHA256]::Create()
try { $aggregate = ([BitConverter]::ToString($digest.ComputeHash([Text.Encoding]::UTF8.GetBytes($recipe.ToString())))).Replace('-', '').ToLowerInvariant() } finally { $digest.Dispose() }
if ($aggregate -cne $manifest.aggregateSha256) { Fail 'Manifest aggregate mismatch.' }

$rosenStage = $Stage -in @('Rosen', 'All')
$nativeStage = $Stage -in @('Native', 'All')
$artifactStage = $Stage -in @('Artifacts', 'All')
if ($rosenStage) {
    $dependencies = Get-Content -LiteralPath (Join-Path $source 'prepared-dependencies.json') -Raw | ConvertFrom-Json
    if ($dependencies.baseline -cne '1edc2fb982de4560c5265e04e2ed8b93d00b40df' -or $dependencies.workspaceDistributionFiles.Count -ne 309) { Fail 'Prepared dependency profile mismatch.' }
    foreach ($tool in @('node.exe', 'npm.cmd', 'git.exe')) { Get-Command $tool -ErrorAction Stop | Out-Null }
    if ((& node.exe --version) -cne 'v24.13.1') { Fail 'This profile requires Node.js 24.13.1.' }
}
if ($nativeStage) {
    foreach ($tool in @('rustc.exe', 'cargo.exe')) { Get-Command $tool -ErrorAction Stop | Out-Null }
    if ((& rustc.exe --version) -notmatch '^rustc 1\.98\.1 ') { Fail 'This profile requires Rust 1.98.1.' }
    if ((& rustc.exe -vV | Out-String) -notmatch 'host: x86_64-pc-windows-msvc') { Fail 'Rust must target x86_64-pc-windows-msvc with its C++ linker installed.' }
}
if ($artifactStage) {
    Get-Command java.exe -ErrorAction Stop | Out-Null
    if ((& java.exe -version 2>&1 | Out-String) -notmatch 'version "17[.\"]') { Fail 'This profile requires Java 17.' }
}
[IO.Directory]::CreateDirectory($output) | Out-Null
$oldCache = $env:npm_config_cache
$oldCargoTarget = $env:CARGO_TARGET_DIR
$oldCargoHome = $env:CARGO_HOME
$result = [ordered]@{ stage = $Stage; manifestSha256 = $ManifestSha256; sourceAggregateSha256 = $aggregate }
try {
    if ($rosenStage) {
        $rosen = Join-Path $output 'rosen'
        Run 'git.exe' @('clone', '--no-checkout', 'https://github.com/rosen-bridge/guard-service.git', $rosen) (Join-Path $output 'clone.log')
        Run 'git.exe' @('-C', $rosen, 'checkout', '--detach', '1edc2fb982de4560c5265e04e2ed8b93d00b40df') (Join-Path $output 'checkout.log')
        if ((& git.exe -C $rosen rev-parse HEAD) -cne '1edc2fb982de4560c5265e04e2ed8b93d00b40df') { Fail 'Rosen source pin mismatch.' }
        foreach ($relative in @('package.json', 'package-lock.json')) {
            Copy-Item -LiteralPath (Join-Path $source $relative) -Destination (Join-Path $rosen $relative)
            CheckHash (Join-Path $rosen $relative) ($manifest.files | Where-Object path -CEQ $relative).sha256
        }
        Copy-Item -LiteralPath (Join-Path $source 'guard-service/package.json') -Destination (Join-Path $rosen 'services/guard-service/package.json')
        CheckHash (Join-Path $rosen 'services/guard-service/package.json') ($manifest.files | Where-Object path -CEQ 'guard-service/package.json').sha256
        CopyMembers 'packages/monero-deposit/' (Join-Path $rosen 'packages/monero-deposit')
        $env:npm_config_cache = Join-Path $output 'npm-cache'
        Push-Location $rosen
        try {
            Run 'npm.cmd' @('exec', '--yes', '--package=npm@11.6.2', '--', 'npm', '--version') (Join-Path $output 'npm-version.log')
            if (@(Get-Content -LiteralPath (Join-Path $output 'npm-version.log') | Where-Object { $_ -ceq '11.6.2' }).Count -ne 1) { Fail 'Pinned npm version check failed.' }
            Run 'npm.cmd' @('exec', '--yes', '--package=npm@11.6.2', '--', 'npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund') (Join-Path $output 'npm-ci.log')
            Run 'node.exe' @('node_modules/patch-package/index.js') (Join-Path $output 'patch-package.log')
            Run 'node.exe' @('node_modules/typescript/bin/tsc', '--build', 'packages/chains/ergo/tsconfig.build.json') (Join-Path $output 'rosen-build.log')
            Push-Location (Join-Path $rosen 'node_modules/sqlite3')
            try {
                Run 'node.exe' @('../prebuild-install/bin.js', '--runtime=napi', '--target=6') (Join-Path $output 'sqlite-prebuild.log')
            } finally { Pop-Location }
            CheckHash (Join-Path $rosen 'node_modules/sqlite3/build/Release/node_sqlite3.node') 'f806f89dc41dde00ca7124dc1e649bdc9b08ff2eff5c891b764f3e5aefa9548c'
            Run 'node.exe' @('-e', 'const sqlite=require("sqlite3"); const db=new sqlite.Database(":memory:"); db.get("select 1 as ok",(e,row)=>{if(e||row.ok!==1)process.exitCode=1;db.close();});') (Join-Path $output 'sqlite-smoke.log')
        } finally { Pop-Location }
        foreach ($entry in $dependencies.workspaceDistributionFiles) {
            if ($entry.path -cnotmatch '^[A-Za-z0-9_@./-]+$' -or $entry.path.StartsWith('/') -or @($entry.path.Split('/') | Where-Object { $_ -in @('', '.', '..') }).Count) { Fail 'Invalid dependency path.' }
            CheckHash (Join-Path $rosen $entry.path) $entry.sha256
        }
        foreach ($relative in @('package.json', 'package-lock.json')) { CheckHash (Join-Path $rosen $relative) ($manifest.files | Where-Object path -CEQ $relative).sha256 }
        $result.rosenRoot = $rosen
        $result.preparedDistributionFilesVerified = $dependencies.workspaceDistributionFiles.Count
    }
    if ($nativeStage) {
        $native = Join-Path $output 'native-source'; CopyMembers 'native/' $native
        $copy = Join-Path $output 'copy-source'; CopyMembers 'test-fixtures/public-copy/' $copy
        $env:CARGO_HOME = Join-Path $output 'cargo-cache'
        $env:CARGO_TARGET_DIR = Join-Path $output 'participant-target'
        Run 'cargo.exe' @('build', '--locked', '--jobs', '4', '--manifest-path', (Join-Path $native 'Cargo.toml'), '--features', 'participant-host', '--bin', 'monero-participant') (Join-Path $output 'participant-build.log')
        $participant = Join-Path $env:CARGO_TARGET_DIR 'debug/monero-participant.exe'
        $env:CARGO_TARGET_DIR = Join-Path $output 'copy-target'
        Run 'cargo.exe' @('build', '--locked', '--jobs', '4', '--manifest-path', (Join-Path $copy 'Cargo.toml'), '--bin', 'pedpop-wallet-type-join') (Join-Path $output 'copy-build.log')
        $copier = Join-Path $env:CARGO_TARGET_DIR 'debug/pedpop-wallet-type-join.exe'
        $result.nativeBinary = $participant; $result.nativeSha256 = Hash $participant
        $result.observerBinary = $participant; $result.observerSha256 = $result.nativeSha256
        $result.collisionBinary = $copier; $result.collisionSha256 = Hash $copier
    }
    if ($artifactStage) {
        $downloads = Join-Path $output 'downloads'; [IO.Directory]::CreateDirectory($downloads) | Out-Null
        $artifacts = @(
            @('ergo-6.0.3.jar', 'https://github.com/ergoplatform/ergo/releases/download/v6.0.3/ergo-6.0.3.jar', '4802cde3550623e639a5d09f45d257922e01815c5b1fe64bdafd2ebc69ec67c7'),
            @('devnet.conf', 'https://raw.githubusercontent.com/ergoplatform/ergo/28ebb184b0c90ee9adebe1111eb6aa3244798ba9/src/main/resources/devnet.conf', '369db106107fca0bb0d22bbff96c3ef29339844ccc562726d738ff08db4f4eab'),
            @('monero-win-x64-v0.18.5.1.zip', 'https://downloads.getmonero.org/cli/monero-win-x64-v0.18.5.1.zip', 'cf2ae8273977697d9ef2031c7337b781e6e5936578f602444b2990a173a2437d')
        )
        foreach ($artifact in $artifacts) {
            CheckSpace $output
            $file = Join-Path $downloads $artifact[0]
            Invoke-WebRequest -Uri $artifact[1] -OutFile $file -UseBasicParsing
            CheckHash $file $artifact[2]
        }
        $unpacked = Join-Path $output 'monero'
        Expand-Archive -LiteralPath (Join-Path $downloads 'monero-win-x64-v0.18.5.1.zip') -DestinationPath $unpacked
        $daemons = @(Get-ChildItem -LiteralPath $unpacked -Recurse -File -Filter monerod.exe)
        if ($daemons.Count -ne 1) { Fail 'Expected exactly one official monerod executable.' }
        CheckHash $daemons[0].FullName 'e69bf239e0acad637fc1bc257ba68661133fca77727f2ff6f25c8db917cfee42'
        $result.moneroDaemon = $daemons[0].FullName
        $result.moneroDaemonSha256 = Hash $daemons[0].FullName
        $result.ergoJar = Join-Path $downloads 'ergo-6.0.3.jar'; $result.ergoJarSha256 = $artifacts[0][2]
        $result.ergoDevnetConfig = Join-Path $downloads 'devnet.conf'; $result.ergoDevnetConfigSha256 = $artifacts[1][2]
    }
    CheckHash $manifestPath $ManifestSha256
    foreach ($entry in $manifest.files) {
        CheckHash (Join-Path $source $entry.path) $entry.sha256
        if ((Get-Item -LiteralPath (Join-Path $source $entry.path)).Length -ne $entry.bytes) { Fail 'Source size changed during preparation.' }
    }
    $finalTree = @(Get-ChildItem -LiteralPath $source -Recurse -Force)
    if (@($finalTree | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { Fail 'Source reparse point appeared during preparation.' }
    [string[]]$finalNames = @($finalTree | Where-Object { -not $_.PSIsContainer } | ForEach-Object { $_.FullName.Substring($source.Length + 1).Replace('\', '/') } | Where-Object { $_ -cne 'source-manifest.json' })
    [Array]::Sort($finalNames, [StringComparer]::Ordinal)
    if (($finalNames -join "`0") -cne ($sorted -join "`0")) { Fail 'Source file set changed during preparation.' }
    $json = $result | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText((Join-Path $output 'prepared-windows.json'), $json + "`n", [Text.UTF8Encoding]::new($false))
    Write-Output $json
} finally {
    $env:npm_config_cache = $oldCache
    $env:CARGO_TARGET_DIR = $oldCargoTarget
    $env:CARGO_HOME = $oldCargoHome
}
