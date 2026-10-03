"""Lifecycle of the versioned harness patches (patch/harness-*) and the
installer's receipt rule, with the production functions of
scripts/install-harness.py and real `git apply` on private copies of the
bundled snapshots. Nothing is built or downloaded.
  python3 tests/integration/harness_patches_test.py
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('install_harness', ROOT / 'scripts/install-harness.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def touched(patch):
    return [line[6:].strip() for line in Path(patch).read_text().splitlines() if line.startswith('+++ b/')]


class PatchLifecycle(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='harness-patches-'))

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def tree(self, name):
        """A private copy of only the files the patches touch, plus a sibling."""
        tree = self.tmp / name
        for rel in installer.PATCHES[name]:
            for file in touched(ROOT / rel):
                (tree / file).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT / 'src/harness' / name / file, tree / file)
        (tree / 'UNRELATED.txt').write_text('user change kept\n')
        return tree

    def git(self, tree, *args):
        return subprocess.run(['git', 'apply', *args], cwd=tree, capture_output=True, text=True)

    def test_every_patch_is_recorded_with_its_base(self):
        for name, patches in installer.PATCHES.items():
            bases = json.loads((ROOT / f'patch/harness-{name}/bases.json').read_text())
            self.assertEqual(bases['revision'], json.loads((ROOT / 'src/harness/manifest.json').read_text())['engines'][name]['commit'])
            for rel in patches:
                entry = bases['patches'][Path(rel).name]
                self.assertEqual(entry['sha256'], sha(ROOT / rel), f'{rel} changed without its bases.json')
                self.assertEqual(entry['baseSHA256'], sha(ROOT / 'src/harness' / name / entry['baseFile']))
                self.assertEqual(bases['order'], [Path(p).name for p in patches])

    def test_apply_repeat_reverse_and_drift(self):
        for name, patches in installer.PATCHES.items():
            with self.subTest(harness=name):
                tree = self.tree(name)
                original = {f: sha(tree / f) for rel in patches for f in touched(ROOT / rel)}
                with open(self.tmp / f'{name}.log', 'wb') as log:
                    applied = installer.apply_patches(name, tree, log)
                self.assertEqual([p['patch'] for p in applied], patches)
                for file, digest in original.items():
                    self.assertNotEqual(sha(tree / file), digest, f'{file} was patched')
                # A second application is refused before any byte changes.
                patched = {f: sha(tree / f) for f in original}
                for rel in patches:
                    self.assertNotEqual(self.git(tree, '--check', '-p1', str(ROOT / rel)).returncode, 0)
                self.assertEqual({f: sha(tree / f) for f in original}, patched)
                # Reverse restores the bundled bytes exactly; other files untouched.
                for rel in reversed(patches):
                    self.assertEqual(self.git(tree, '-R', '-p1', str(ROOT / rel)).returncode, 0)
                self.assertEqual({f: sha(tree / f) for f in original}, original)
                self.assertEqual((tree / 'UNRELATED.txt').read_text(), 'user change kept\n')
                # Drift: an upstream change to a line the patch relies on (its
                # first context line) fails the check and leaves the file as it was.
                patch_lines = (ROOT / patches[0]).read_text().splitlines()
                hunk = next(i for i, l in enumerate(patch_lines) if l.startswith('@@'))
                context = next(l[1:] for l in patch_lines[hunk + 1:] if l.startswith(' ') and l[1:].strip())
                file = touched(ROOT / patches[0])[0]
                text = (tree / file).read_text()
                self.assertIn(context, text)
                (tree / file).write_text(text.replace(context, context + ' // drift', 1))
                drifted = sha(tree / file)
                with open(self.tmp / f'{name}-drift.log', 'wb') as log:
                    with self.assertRaises(RuntimeError):
                        installer.apply_patches(name, tree, log)
                self.assertEqual(sha(tree / file), drifted, 'a rejected patch leaves the file untouched')


class Snapshots(unittest.TestCase):
    def test_the_bundled_harness_sources_verify_byte_for_byte(self):
        sys_path = str(ROOT / 'scripts')
        import sys
        if sys_path not in sys.path:
            sys.path.insert(0, sys_path)
        import bundled_engine_sources as bundled
        for name in ('pi', 'opencode', 'pi-ds4'):
            proof = bundled.transfer(ROOT, name, installer.pin(ROOT, name), catalog=bundled.HARNESSES)
            self.assertGreater(proof['files'], 0)
        with self.assertRaises(RuntimeError):
            bundled.transfer(ROOT, 'pi', 'f' * 40, catalog=bundled.HARNESSES)


class Receipts(unittest.TestCase):
    def test_a_different_patch_set_is_not_current(self):
        tmp = Path(tempfile.mkdtemp(prefix='harness-receipt-'))
        try:
            target = tmp / 'opencode'
            (target / 'bin').mkdir(parents=True)
            (target / 'bin/opencode').write_bytes(b'built')
            commit = installer.pin(ROOT, 'opencode')
            expected = [{'patch': rel, 'sha256': sha(ROOT / rel)} for rel in installer.PATCHES['opencode']]
            receipt = {'schema': installer.SCHEMA, 'harness': 'opencode', 'commit': commit,
                       'entrySHA256': sha(target / 'bin/opencode'), 'patches': expected}
            (target / '.dstudio-harness.json').write_text(json.dumps(receipt))
            self.assertTrue(installer.current(target, 'opencode', commit))
            # An installation built before the patch existed (the first opencode
            # install of 2026-10-03 recorded no patches) must be rebuilt.
            receipt['patches'] = []
            (target / '.dstudio-harness.json').write_text(json.dumps(receipt))
            self.assertFalse(installer.current(target, 'opencode', commit))
            receipt['patches'] = expected
            (target / '.dstudio-harness.json').write_text(json.dumps(receipt))
            (target / 'bin/opencode').write_bytes(b'changed')
            self.assertFalse(installer.current(target, 'opencode', commit), 'changed entry-point bytes')
            self.assertFalse(installer.current(target, 'opencode', 'f' * 40), 'another pin')
        finally:
            shutil.rmtree(tmp)


class BridgeRefresh(unittest.TestCase):
    def test_an_updated_bridge_is_copied_without_touching_built_harnesses(self):
        tmp = Path(tempfile.mkdtemp(prefix='harness-bridge-'))
        try:
            bridge = tmp / 'harness' / 'bridge'
            bridge.mkdir(parents=True)
            (bridge / 'dstudio-harness.mjs').write_text('// older bridge\n')
            built = tmp / 'harness' / 'pi' / 'built.txt'
            built.parent.mkdir(parents=True)
            built.write_text('built pi')
            done = subprocess.run(['python3', str(ROOT / 'scripts/install-harness.py'), '--refresh-bridge', '--root', str(tmp)],
                                  capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertFalse(json.loads(done.stdout.strip().splitlines()[-1])['bridge']['reused'])
            for name in installer.BRIDGE:
                self.assertEqual(sha(bridge / name), sha(ROOT / 'src/harness/bridge' / name))
            self.assertEqual(built.read_text(), 'built pi', 'a built harness is untouched')
            again = subprocess.run(['python3', str(ROOT / 'scripts/install-harness.py'), '--refresh-bridge', '--root', str(tmp)],
                                   capture_output=True, text=True)
            self.assertTrue(json.loads(again.stdout.strip().splitlines()[-1])['bridge']['reused'])
        finally:
            shutil.rmtree(tmp)


if __name__ == '__main__':
    result = unittest.main(exit=False, verbosity=1).result
    failed = len(result.failures) + len(result.errors)
    print(f'harness_patches_test: {result.testsRun - failed}/{result.testsRun} passed (real git apply on private copies; nothing built)')
    raise SystemExit(1 if failed else 0)
