"""Bounded proof invocation with a pinned non-system dynamic-library closure."""
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import time


def canonical_path(value):
    if not isinstance(value, str) or not 1 < len(value) <= 4096:
        raise ValueError('proof path')
    if not value.startswith('/') or value.startswith('//') or value.endswith('/'):
        raise ValueError('proof path')
    if re.search(r'[\x00-\x1f\x7f\\]', value) or str(pathlib.PurePosixPath(value)) != value or '..' in value.split('/'):
        raise ValueError('proof path')
    return value


def digest(value):
    if not isinstance(value, str) or not re.fullmatch('[0-9a-f]{64}', value):
        raise ValueError('proof digest')
    return value


def capture_pins(configuration):
    if not isinstance(configuration, dict) or set(configuration) != {
            'proofBinary', 'proofBinarySha256', 'proofLibrary', 'proofLibrarySha256', 'proofSharedLibraries'}:
        raise ValueError('proof configuration')
    binary = canonical_path(configuration['proofBinary'])
    wallet = canonical_path(configuration['proofLibrary'])
    pins = {binary: digest(configuration['proofBinarySha256'])}
    wallet_digest = digest(configuration['proofLibrarySha256'])
    libraries = configuration['proofSharedLibraries']
    if not isinstance(libraries, list) or not 1 <= len(libraries) <= 64:
        raise ValueError('proof library closure')
    for row in libraries:
        if not isinstance(row, dict) or set(row) != {'path', 'sha256'}:
            raise ValueError('proof library entry')
        name = canonical_path(row['path'])
        if name in pins:
            raise ValueError('duplicate proof artifact')
        pins[name] = digest(row['sha256'])
    if wallet == binary or pins.get(wallet) != wallet_digest:
        raise ValueError('wallet closure binding')
    return pins


def remaining(deadline):
    duration = deadline - time.monotonic()
    if duration <= 0:
        raise TimeoutError('proof deadline')
    return duration


def verify_pins(pins, deadline):
    for name, expected in pins.items():
        remaining(deadline)
        path = pathlib.Path(name)
        if str(path.resolve(strict=True)) != name or not path.is_file():
            raise ValueError('proof canonical artifact')
        calculated = hashlib.sha256()
        with path.open('rb') as stream:
            while chunk := stream.read(1024 * 1024):
                remaining(deadline)
                calculated.update(chunk)
        if calculated.hexdigest() != expected:
            raise ValueError('proof artifact drift')


def check_loaded_libraries(text, libraries):
    loaded = set()
    for row in text.splitlines():
        row = row.strip()
        if re.fullmatch(r'linux-vdso\.so\.\d+ \(0x[0-9a-fA-F]+\)', row):
            continue
        match = re.fullmatch(r'(?:\S+ => )?(/.+?) \(0x[0-9a-fA-F]+\)', row)
        if not match:
            raise ValueError('unresolved dynamic library')
        resolved = pathlib.Path(match[1]).resolve(strict=True)
        name = str(resolved)
        loaded.add(name)
        # Distribution-owned OS libraries remain an explicit environmental
        # dependency; every resolved library outside these roots must be pinned.
        system = resolved.is_relative_to('/usr/lib') or resolved.is_relative_to('/lib')
        if not system and name not in libraries:
            raise ValueError('unpinned dynamic library')
    if not set(libraries).issubset(loaded):
        raise ValueError('declared library not loaded')


def verify_loaded(configuration, deadline, run=subprocess.run):
    result = run(['/usr/bin/ldd', configuration['proofBinary']], capture_output=True, timeout=remaining(deadline))
    if result.returncode or len(result.stdout) > 100000 or len(result.stderr) > 100000:
        raise ValueError('dynamic loader inspection')
    check_loaded_libraries(result.stdout.decode('utf8'), [row['path'] for row in configuration['proofSharedLibraries']])


def invoke(configuration, arguments, run=subprocess.run):
    deadline = time.monotonic() + 30
    pins = capture_pins(configuration)
    if len(arguments) not in (2, 3) or arguments[0] not in ('produce', 'verify'):
        raise ValueError('proof arguments')
    if len(arguments) != (3 if arguments[0] == 'produce' else 2):
        raise ValueError('proof arguments')
    if os.environ.get('LD_PRELOAD') or os.environ.get('LD_AUDIT'):
        raise ValueError('injected dynamic loader')
    verify_pins(pins, deadline)
    verify_loaded(configuration, deadline, run)
    result = run([configuration['proofBinary'], *arguments], capture_output=True, timeout=remaining(deadline))
    verify_pins(pins, deadline)
    verify_loaded(configuration, deadline, run)
    remaining(deadline)
    if result.returncode or len(result.stdout) > 100000 or len(result.stderr) > 100000:
        raise ValueError('proof invocation')
    return result.stdout


if __name__ == '__main__':
    try:
        configuration = json.loads(os.environ['ROUNDTRIP_PROOF_CONFIG'])
        sys.stdout.buffer.write(invoke(configuration, sys.argv[1:]))
    except Exception:
        print('proof-invocation-refused', file=sys.stderr)
        sys.exit(1)
