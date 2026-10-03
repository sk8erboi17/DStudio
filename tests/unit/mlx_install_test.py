"""scripts/install-mlx.py: bundled-wheel verification, per-Python requirement
selection, interpreter discovery and receipt rules, with the production
functions, and the lifecycle of patch/mlx-lm-single-model with real `git apply`
on the server.py taken from the bundled wheel. Interpreters are explicitly
simulated (tiny scripts); nothing is installed here. The real offline
installation is `make test-mlx-install`.
  python3 tests/unit/mlx_install_test.py
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('install_mlx', ROOT / 'scripts/install-mlx.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
MANIFEST, MANIFEST_SHA = installer.load_manifest(ROOT)


def sha(data):
    return hashlib.sha256(data).hexdigest()


class Wheels(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='mlx-wheels-'))
        self.assets = self.tmp / 'assets'
        folder = self.assets / 'src/engines/mlx/wheels'
        folder.mkdir(parents=True)
        files = {}
        for name, data in (('a-1.0-py3-none-any.whl', b'alpha'), ('b-2.0-cp314-cp314-macosx_26_0_arm64.whl', b'beta')):
            (folder / name).write_bytes(data)
            files[name] = {'bytes': len(data), 'sha256': sha(data)}
        self.manifest = {'files': files}

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_the_shipped_wheels_match_their_manifest(self):
        installer.verify_wheels(ROOT, MANIFEST)
        self.assertEqual(MANIFEST['pins'], {'mlx': '0.32.3', 'mlx-lm': '0.32.0'})

    def test_changed_missing_extra_or_linked_wheels_install_nothing(self):
        folder = self.assets / 'src/engines/mlx/wheels'
        installer.verify_wheels(self.assets, self.manifest)
        (folder / 'a-1.0-py3-none-any.whl').write_bytes(b'alphX')
        with self.assertRaisesRegex(RuntimeError, 'differs'):
            installer.verify_wheels(self.assets, self.manifest)
        (folder / 'a-1.0-py3-none-any.whl').write_bytes(b'alpha')
        (folder / 'c-1.0-py3-none-any.whl').write_bytes(b'extra')
        with self.assertRaisesRegex(RuntimeError, 'unrecorded'):
            installer.verify_wheels(self.assets, self.manifest)
        (folder / 'c-1.0-py3-none-any.whl').unlink()
        (folder / 'b-2.0-cp314-cp314-macosx_26_0_arm64.whl').unlink()
        os.symlink(folder / 'a-1.0-py3-none-any.whl', folder / 'b-2.0-cp314-cp314-macosx_26_0_arm64.whl')
        with self.assertRaisesRegex(RuntimeError, 'differs'):
            installer.verify_wheels(self.assets, self.manifest)


class Selection(unittest.TestCase):
    def test_requirements_pin_every_package_with_only_compatible_hashes(self):
        for version in ('3.12', '3.13', '3.14'):
            text = installer.requirements(MANIFEST, version)
            lines = dict(line.split(' ', 1) for line in text.strip().splitlines())
            self.assertIn('mlx==0.32.3', lines)
            self.assertIn('mlx-lm==0.32.0', lines)
            tag = installer.python_tag(version)
            mlx_hashes = {m['sha256'] for m in MANIFEST['files'].values() if m['name'] == 'mlx'}
            own = {m['sha256'] for m in MANIFEST['files'].values() if m['name'] == 'mlx' and m['python'] == tag}
            self.assertEqual(len(own), 1)
            self.assertEqual({h for h in mlx_hashes if h in lines['mlx==0.32.3']}, own, 'another Python ABI is never offered')
        names = {m['name'].lower() for m in MANIFEST['files'].values()}
        self.assertEqual(len(installer.requirements(MANIFEST, '3.14').strip().splitlines()), len(names))

    def test_the_newest_supported_cpython_is_chosen(self):
        tmp = Path(tempfile.mkdtemp(prefix='mlx-python-'))
        try:
            fakes = {}
            for version, output in (('3.14', 'cpython 3.14 x86_64'), ('3.13', 'cpython 3.13 arm64'), ('3.12', 'cpython 3.12 arm64')):
                path = tmp / f'python{version}'
                path.write_text(f'#!/bin/sh\necho "{output}"\n')
                path.chmod(0o755)
                fakes[f'python{version}'] = str(path)
            python, version = installer.find_python(MANIFEST, which=lambda name: fakes.get(name), search=())
            self.assertEqual(version, '3.13', 'an Intel interpreter is not an arm64 runtime')
            with self.assertRaisesRegex(RuntimeError, 'needs Python'):
                installer.find_python({'python': ['3.11']}, which=lambda name: None, search=())
        finally:
            shutil.rmtree(tmp)


class Receipt(unittest.TestCase):
    def test_current_only_for_this_manifest_and_interpreter_bytes(self):
        tmp = Path(tempfile.mkdtemp(prefix='mlx-receipt-'))
        try:
            target = tmp / 'mlx'
            (target / 'venv/bin').mkdir(parents=True)
            (target / installer.PYTHON).write_bytes(b'interpreter')
            patches = [{'patch': rel, 'sha256': sha((ROOT / rel).read_bytes())} for rel in installer.PATCHES]
            base = tmp / 'base-python'
            base.write_bytes(b'base interpreter')
            receipt = {'schema': installer.SCHEMA, 'manifestSHA256': MANIFEST_SHA,
                       'pythonBytes': 11, 'pythonSHA256': sha(b'interpreter'), 'patches': patches,
                       'base': installer.base_files([str(base)])}
            self.assertTrue(installer.receipt_current(target, receipt, MANIFEST_SHA))
            base.write_bytes(b'base interpreteR')
            self.assertFalse(installer.receipt_current(target, receipt, MANIFEST_SHA), 'the base Python changed in place')
            base.unlink()
            self.assertFalse(installer.receipt_current(target, receipt, MANIFEST_SHA), 'the base Python was upgraded away')
            self.assertFalse(installer.receipt_current(target, {**receipt, 'base': None}, MANIFEST_SHA),
                             'a receipt without the base (before October 3) is rebuilt')
            base.write_bytes(b'base interpreter')
            self.assertFalse(installer.receipt_current(target, {**receipt, 'patches': []}, MANIFEST_SHA),
                             'an installation without the current patch set is rebuilt')
            self.assertFalse(installer.receipt_current(target, receipt, '0' * 64), 'another bundled wheel set')
            (target / installer.PYTHON).write_bytes(b'interpreteR')
            self.assertFalse(installer.receipt_current(target, receipt, MANIFEST_SHA))
            (target / installer.PYTHON).unlink()
            os.symlink('/usr/bin/true', target / installer.PYTHON)
            self.assertFalse(installer.receipt_current(target, receipt, MANIFEST_SHA), 'a linked interpreter is not admitted')
        finally:
            shutil.rmtree(tmp)


class PatchLifecycle(unittest.TestCase):
    """Every patch in order on the wheel's own server.py: recorded bases,
    apply, repeat-apply refusal, exact reverse and drift refusal."""

    def test_apply_repeat_reverse_and_drift_on_the_bundled_server(self):
        bases = {rel: json.loads((ROOT / rel).parent.joinpath('bases.json').read_text()) for rel in installer.PATCHES}
        tmp = Path(tempfile.mkdtemp(prefix='mlx-patch-'))
        try:
            first = bases[installer.PATCHES[0]]
            self.assertEqual(first['version'], MANIFEST['pins']['mlx-lm'])
            wheel = next(ROOT.glob(f"src/engines/mlx/wheels/mlx_lm-{first['version']}-*.whl"))
            entry = first['patches'][Path(installer.PATCHES[0]).name]
            target = tmp / entry['baseFile']
            target.parent.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(wheel) as archive:
                target.write_bytes(archive.read(entry['baseFile']))
            (tmp / 'UNRELATED.txt').write_text('user change kept\n')
            original = target.read_bytes()

            def git(patch, *args):
                return subprocess.run(['git', 'apply', *args, '-p1', str(ROOT / patch)], cwd=tmp, capture_output=True, text=True)
            for rel in installer.PATCHES:
                meta = bases[rel]
                entry = meta['patches'][Path(rel).name]
                self.assertEqual(meta['order'], [Path(rel).name])
                self.assertEqual(meta['revision'], first['revision'])
                self.assertEqual(entry['sha256'], sha((ROOT / rel).read_bytes()), f'{rel} changed without bases.json')
                self.assertEqual(sha(target.read_bytes()), entry['baseSHA256'], f'{rel} applies to its recorded base')
                self.assertEqual(git(rel, '--check').returncode, 0)
                self.assertEqual(git(rel).returncode, 0)
                patched = target.read_bytes()
                self.assertNotEqual(git(rel, '--check').returncode, 0, 'a second application is refused')
                self.assertEqual(target.read_bytes(), patched)
            text = target.read_text()
            self.assertIn('DSTUDIO_MLX_SINGLE_MODEL', text)
            self.assertIn('DSTUDIO_MLX_REASONING_CONTENT', text)
            for rel in reversed(installer.PATCHES):
                self.assertEqual(git(rel, '-R').returncode, 0)
            self.assertEqual(target.read_bytes(), original, 'reverse restores the wheel bytes exactly')
            self.assertEqual((tmp / 'UNRELATED.txt').read_text(), 'user change kept\n')
            for rel in installer.PATCHES:
                # Drift: a change to the patch's first context line is refused
                # and leaves the file as it was (prerequisites applied first).
                for earlier in installer.PATCHES[:installer.PATCHES.index(rel)]:
                    self.assertEqual(git(earlier).returncode, 0)
                lines = (ROOT / rel).read_text().splitlines()
                hunk = next(i for i, line in enumerate(lines) if line.startswith('@@'))
                context = next(line[1:] for line in lines[hunk + 1:] if line.startswith(' ') and line[1:].strip())
                text = target.read_text()
                self.assertIn(context, text)
                target.write_text(text.replace(context, context + '  # drift', 1))
                drifted = target.read_bytes()
                self.assertNotEqual(git(rel, '--check').returncode, 0, f'drift is rejected for {rel}')
                self.assertEqual(target.read_bytes(), drifted)
                target.write_bytes(original)
        finally:
            shutil.rmtree(tmp)


if __name__ == '__main__':
    result = unittest.main(exit=False, verbosity=1).result
    failed = len(result.failures) + len(result.errors)
    print(f'mlx_install_test: {result.testsRun - failed}/{result.testsRun} passed (production helpers, real git apply on the bundled wheel server.py; simulated interpreters, nothing installed)')
    raise SystemExit(1 if failed else 0)
