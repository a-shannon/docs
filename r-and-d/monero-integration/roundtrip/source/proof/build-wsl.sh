#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
trap 'printf "Proof build failed at line %s; inspect the external build logs.\n" "$LINENO" >&2' ERR

readonly monero_commit=4f92268d7c16741cfb41e5bbe2aa46cc260a9ea5
readonly helper_sha256=3234c5227de6f55a0493c817b629c232159de165231c9fd567aebb7f122bb631
die() { printf '%s\n' "$*" >&2; exit 1; }
[[ $# == 1 ]] || die 'Usage: bash build-wsl.sh /absolute/new-output-directory'
[[ $1 =~ ^/[A-Za-z0-9_./-]+$ ]] || die 'Output must be an absolute path without spaces or shell metacharacters.'
[[ ! -e $1 && ! -L $1 ]] || die 'Output directory must be absent, including symlinks.'
for tool in git cmake c++ python3 sha256sum realpath df ldd dpkg-query; do
  command -v "$tool" >/dev/null || die "Required tool: $tool"
done
readonly script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
readonly source_root=$(realpath "$script_dir/..")
readonly output=$(realpath -m -- "$1")
[[ ! -e $output && ! -L $output ]] || die 'Output directory must be absent, including symlinks.'
[[ -d $(dirname -- "$output") ]] || die 'Output parent must already exist.'
[[ $output != "$source_root" && $output != "$source_root/"* ]] || die 'Output must be outside the source package.'
[[ $output != /mnt/* ]] || die 'Use the WSL Linux filesystem for build outputs.'
[[ $(uname -m) == x86_64 ]] || die 'This recipe supports Linux x86_64.'
. /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 22.04 ]] || die 'This recipe supports Ubuntu 22.04.'
[[ $(c++ -dumpfullversion) == 11.4.0 ]] || die 'This recipe requires GCC 11.4.0.'
[[ $(cmake --version | head -n1) == 'cmake version 3.22.1' ]] || die 'This recipe requires CMake 3.22.1.'
python3 -c 'import sys; assert sys.version_info >= (3, 10), "Python 3.10 or later is required"'
[[ $(df -PB1 "$(dirname -- "$output")" | awk 'NR==2 {print $4}') -ge 10737418240 ]] || die 'At least 10 GiB free disk space is required.'
printf '%s  %s\n' "$helper_sha256" "$script_dir/tx-proof.cpp" | sha256sum --check --status

packages=(build-essential cmake git pkg-config libboost-all-dev libssl-dev libzmq3-dev
  libunbound-dev libsodium-dev libreadline-dev libhidapi-dev libusb-1.0-0-dev
  libbsd-dev libunwind-dev)
for package in "${packages[@]}"; do
  [[ $(dpkg-query -W -f='${Status}' "$package" 2>/dev/null) == 'install ok installed' ]] || die "Required development package: $package"
done

mkdir -- "$output"
cd -- "$output"
unset LD_LIBRARY_PATH LIBRARY_PATH CPATH CPLUS_INCLUDE_PATH C_INCLUDE_PATH
dpkg-query -W "${packages[@]}" > system-prerequisites.txt
git clone --no-checkout https://github.com/monero-project/monero.git monero > clone.log 2>&1
git -C monero checkout --detach "$monero_commit" >> clone.log 2>&1
[[ $(git -C monero rev-parse HEAD) == "$monero_commit" ]] || die 'Monero source pin mismatch.'
git -C monero submodule update --init --recursive > submodules.log 2>&1
git -C monero submodule status --recursive > source-submodules.txt
! grep -Eq '^[-+U]' source-submodules.txt || die 'Submodule pin mismatch.'
[[ -z $(git -C monero status --porcelain --untracked-files=all) ]] || die 'Monero source is not clean.'
cp -- "$script_dir/tx-proof.cpp" tx-proof.cpp
printf '%s  tx-proof.cpp\n' "$helper_sha256" | sha256sum --check --status

cmake -S monero -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON \
  -DBUILD_TESTS=OFF -DBUILD_GUI_DEPS=OFF -DUSE_CCACHE=OFF -DARCH=default \
  -DUSE_DEVICE_TREZOR=OFF -DCMAKE_EXPORT_COMPILE_COMMANDS=ON > configure.log 2>&1
cmake --build build --target wallet --parallel 4 > wallet-build.log 2>&1
c++ -std=c++14 -O2 -pthread -DBOOST_NO_AUTO_PTR -DBOOST_UUID_DISABLE_ALIGNMENT \
  -DBUILD_SHARED_LIBS -I monero/src -I monero/contrib/epee/include \
  -I monero/external -I monero/external/easylogging++ -I monero/external/rapidjson/include \
  -I monero/external/supercop/include -I build/generated_include \
  -c tx-proof.cpp -o tx-proof.o > helper-compile.log 2>&1
c++ -pthread tx-proof.o -o tx-proof -L build/src/wallet -L build/src/cryptonote_basic \
  -L build/src/crypto -L build/contrib/epee/src -L build/src/net \
  -lwallet -lcryptonote_basic -lcryptonote_format_utils_basic -lcncrypto -lepee -lnet \
  -lboost_serialization -lboost_system -lssl -lcrypto \
  "-Wl,-rpath,$output/build/src/wallet:$output/build/src/cryptonote_basic:$output/build/src/crypto:$output/build/contrib/epee/src:$output/build/src/net" \
  > helper-link.log 2>&1
[[ $(git -C monero rev-parse HEAD) == "$monero_commit" ]] || die 'Monero source pin changed.'
[[ -z $(git -C monero status --porcelain --untracked-files=all) ]] || die 'Monero source changed during build.'
printf '%s  tx-proof.cpp\n' "$helper_sha256" | sha256sum --check --status
ldd ./tx-proof > helper-ldd.txt
python3 - "$output" "$monero_commit" "$helper_sha256" <<'PY'
import hashlib, json, pathlib, re, subprocess, sys
root = pathlib.Path(sys.argv[1]).resolve()
build = root / 'build'
loaded = []
text = (root / 'helper-ldd.txt').read_text()
if 'not found' in text:
    raise SystemExit('Unresolved shared library')
for line in text.splitlines():
    match = re.search(r'=> (/\S+)\s+\(', line)
    if not match:
        continue
    path = pathlib.Path(match.group(1)).resolve(strict=True)
    if build in path.parents:
        loaded.append(path)
    elif not (path.is_relative_to('/usr/lib') or path.is_relative_to('/lib')):
        raise SystemExit('Shared library outside fresh build or system directories')
wallet = build / 'src/wallet/libwallet.so'
if wallet.resolve() not in loaded:
    raise SystemExit('Fresh wallet library was not resolved')
if not 1 <= len(set(loaded)) <= 64:
    raise SystemExit('Fresh shared-library closure bound')
result = subprocess.run([str(root / 'tx-proof')], capture_output=True, timeout=30)
if (result.returncode, result.stdout, result.stderr) != (1, b'', b'proof-error:32\n'):
    raise SystemExit('Helper loader/refusal smoke failed')
def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()
pins = dict(moneroCommit=sys.argv[2], helperSourceSha256=sys.argv[3],
            proofBinary=str((root / 'tx-proof').resolve(strict=True)), proofBinarySha256=sha(root / 'tx-proof'),
            proofLibrary=str(wallet.resolve(strict=True)), proofLibrarySha256=sha(wallet),
            proofSharedLibraries=[dict(path=str(p), sha256=sha(p))
                                  for p in sorted(set(loaded))])
encoded = json.dumps(pins, indent=2) + '\n'
with (root / 'proof-artifacts.json').open('x') as stream:
    stream.write(encoded)
print(encoded, end='')
PY
