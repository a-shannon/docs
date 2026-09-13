"""Bounded proof invocation; no wallet daemon or wallet database is involved."""
import hashlib, pathlib, subprocess, sys, json, os

configuration = json.loads(os.environ['ROUNDTRIP_PROOF_CONFIG'])
pins = {configuration['proofBinary']: configuration['proofBinarySha256'],
        configuration['proofLibrary']: configuration['proofLibrarySha256']}
try:
    if len(sys.argv) not in (3, 4) or sys.argv[1] not in ('produce', 'verify'):
        raise ValueError()
    if len(sys.argv) != (4 if sys.argv[1] == 'produce' else 3):
        raise ValueError()
    for path, digest in pins.items():
        if hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest() != digest:
            raise ValueError()
    result = subprocess.run([configuration['proofBinary'], *sys.argv[1:]],
                            capture_output=True, timeout=30)
    if result.returncode or len(result.stdout) > 100000:
        raise ValueError()
    sys.stdout.buffer.write(result.stdout)
except Exception:
    print('proof-invocation-refused', file=sys.stderr)
    sys.exit(1)
