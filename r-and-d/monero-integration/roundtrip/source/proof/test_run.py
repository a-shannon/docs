"""Linux/WSL standard-library tests; no real proof helper or chain is invoked."""
import copy
import hashlib
import importlib.util
import os
import pathlib
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('proof_run', pathlib.Path(__file__).with_name('run.py'))
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


class ProofClosureTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='proof-closure-')
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name).resolve()
        self.paths = [self.root / name for name in ('tx-proof', 'libwallet.so', 'libcrypto.so')]
        for index, path in enumerate(self.paths):
            path.write_bytes(f'fixture artifact {index}'.encode())
        pins = [{'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()} for path in self.paths]
        self.config = dict(proofBinary=pins[0]['path'], proofBinarySha256=pins[0]['sha256'],
                           proofLibrary=pins[1]['path'], proofLibrarySha256=pins[1]['sha256'], proofSharedLibraries=pins[1:])
        self.calls = []

    def runner(self, arguments, **options):
        self.calls.append((arguments, options))
        self.assertGreater(options['timeout'], 0)
        self.assertLessEqual(options['timeout'], 30)
        output = ('\n'.join(f'{path.name} => {path} (0x1234)' for path in self.paths[1:]) + '\n').encode()
        return SimpleNamespace(returncode=0, stdout=output if arguments[0] == '/usr/bin/ldd' else b'public-proof', stderr=b'')

    def test_positive_closes_all_files_before_and_after_helper(self):
        self.assertEqual(proof.invoke(self.config, ['verify', 'unused-public-fixture'], self.runner), b'public-proof')
        self.assertEqual([call[0][0] for call in self.calls], ['/usr/bin/ldd', str(self.paths[0]), '/usr/bin/ldd'])
        timeouts = [call[1]['timeout'] for call in self.calls]
        self.assertEqual(timeouts, sorted(timeouts, reverse=True))

    def test_other_library_modified_before_invoke_never_reaches_helper(self):
        self.paths[2].write_bytes(b'changed dependency only')
        with self.assertRaisesRegex(ValueError, 'artifact drift'):
            proof.invoke(self.config, ['verify', 'unused-public-fixture'], self.runner)
        self.assertEqual(self.calls, [])

    def test_other_library_modified_by_invocation_prevents_result_delivery(self):
        def run(arguments, **options):
            result = self.runner(arguments, **options)
            if arguments[0] == str(self.paths[0]):
                self.paths[2].write_bytes(b'changed after preflight')
            return result
        with self.assertRaisesRegex(ValueError, 'artifact drift'):
            proof.invoke(self.config, ['verify', 'unused-public-fixture'], run)
        self.assertEqual(len(self.calls), 2)

    def test_schema_single_faults_refuse(self):
        mutations = [lambda c: c.pop('proofSharedLibraries'), lambda c: c.update(proofSharedLibraries=[]),
                     lambda c: c['proofSharedLibraries'].append(copy.deepcopy(c['proofSharedLibraries'][0])),
                     lambda c: c['proofSharedLibraries'][1].update(path=c['proofBinary']),
                     lambda c: c['proofSharedLibraries'][1].update(extra=1),
                     lambda c: c['proofSharedLibraries'][1].update(sha256='AA' * 32),
                     lambda c: c['proofSharedLibraries'][0].update(sha256='11' * 32),
                     lambda c: c['proofSharedLibraries'].pop(0)]
        self.assertEqual(len(proof.capture_pins(self.config)), 3)
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                config = copy.deepcopy(self.config)
                mutation(config)
                with self.assertRaises(ValueError):
                    proof.capture_pins(config)
        for name in ['relative', '//tmp/a', '/tmp//a', '/tmp/../a', '/tmp/./a', '/tmp/a/', '/tmp\\a', '/tmp/\na', '/']:
            with self.subTest(path=name), self.assertRaises(ValueError):
                proof.canonical_path(name)

    def test_resolved_path_alias_refuses_even_with_matching_bytes(self):
        alias = self.root / 'alias.so'
        alias.symlink_to(self.paths[2])
        self.config['proofSharedLibraries'][1]['path'] = str(alias)
        with self.assertRaisesRegex(ValueError, 'canonical artifact'):
            proof.verify_pins(proof.capture_pins(self.config), time.monotonic() + 30)

    def test_unpinned_resolved_dependency_and_missing_declared_dependency_refuse(self):
        extra = self.root / 'unlisted.so'
        extra.write_bytes(b'unlisted')
        listed = [str(path) for path in self.paths[1:]]
        good = '\n'.join(f'{path.name} => {path} (0x1234)' for path in self.paths[1:])
        proof.check_loaded_libraries(good, listed)
        with self.assertRaisesRegex(ValueError, 'unpinned dynamic'):
            proof.check_loaded_libraries(good + f'\nunlisted.so => {extra} (0x1234)', listed)
        with self.assertRaisesRegex(ValueError, 'not loaded'):
            proof.check_loaded_libraries(good.splitlines()[0], listed)
        with self.assertRaisesRegex(ValueError, 'unresolved dynamic'):
            proof.check_loaded_libraries(good + '\nother.so => not found', listed)

    def test_loader_injection_refuses_before_any_process(self):
        for name in ['LD_PRELOAD', 'LD_AUDIT']:
            with self.subTest(name=name), patch.dict(os.environ, {name: '/fixture/injected.so'}):
                with self.assertRaisesRegex(ValueError, 'injected dynamic loader'):
                    proof.invoke(self.config, ['verify', 'unused-public-fixture'], self.runner)
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()
