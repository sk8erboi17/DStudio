"""Real source-copy/publication behavior; fixture engines are not inference."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location('sources', 'scripts/bundled_engine_sources.py')
sources = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sources)
PIN = '1' * 40


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='dstudio-bundled-sources-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.assets = self.root / 'assets'
        self.tree = self.assets / 'src/engines/ds4'
        self.tree.mkdir(parents=True)
        self.target = self.root / 'install/ds4'
        self.target.parent.mkdir()
        self.files = {'ds4.c': b'fixture compiler input\x00', 'metal/a.metal': b'fixture shader',
                      'tool.sh': b'#!/bin/sh\nexit 0\n', 'empty.h': b''}
        metadata = {}
        for name, value in self.files.items():
            file = self.tree / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(value)
            file.chmod(0o755 if name.endswith('.sh') else 0o644)
            metadata[name] = {'sha256': hashlib.sha256(value).hexdigest(), 'bytes': len(value),
                              'executable': name.endswith('.sh')}
        self.catalog = {'schema': 'dstudio.engine-sources.v1', 'engines': {'main': {
            'repository': 'https://example.invalid/ds4', 'commit': PIN,
            'directory': 'ds4', 'historical': False, 'files': metadata}}}
        self.manifest = self.assets / 'src/engines/manifest.json'
        self.save()

    def save(self):
        self.manifest.write_text(json.dumps(self.catalog))

    def install(self):
        return sources.install(self.assets, 'main', PIN, self.target)

    def test_copies_exact_bytes_modes_and_pinned_receipt_without_git_identity(self):
        self.install()
        for name, value in self.files.items():
            self.assertEqual((self.target / name).read_bytes(), value)
            self.assertEqual(bool((self.target / name).stat().st_mode & 0o111), name.endswith('.sh'))
        receipt = json.loads((self.target / '.dstudio-source.json').read_text())
        self.assertEqual(receipt['commit'], PIN)
        self.assertEqual(receipt['source'], 'bundled')
        self.assertFalse(receipt['modelLoaded'])
        self.assertEqual(receipt['manifestSHA256'], hashlib.sha256(self.manifest.read_bytes()).hexdigest())
        self.assertFalse(list(self.target.parent.glob('.dstudio-ds4-source-*')))

    def test_accepts_a_verified_empty_target(self):
        self.target.mkdir()
        self.install()
        self.assertEqual((self.target / 'ds4.c').read_bytes(), self.files['ds4.c'])

    def test_keeps_existing_user_data_and_aliases(self):
        self.target.mkdir()
        note = self.target / 'notes'
        note.write_bytes(b'private user data')
        inode = self.target.stat().st_ino
        with self.assertRaisesRegex(RuntimeError, 'local data'):
            self.install()
        self.assertEqual(note.read_bytes(), b'private user data')
        self.assertEqual(self.target.stat().st_ino, inode)
        self.target.rename(self.target.with_name('user'))
        self.target.symlink_to(self.target.with_name('user'), target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, 'local data'):
            self.install()
        self.assertTrue(self.target.is_symlink())

    def test_rejects_missing_extra_and_tampered_sources_without_publication(self):
        for mode in ('missing', 'extra', 'tampered'):
            with self.subTest(mode=mode):
                file = self.tree / 'ds4.c'
                file.write_bytes(self.files['ds4.c'])
                extra = self.tree / 'unknown.c'
                if extra.exists():
                    extra.unlink()
                if mode == 'missing':
                    file.unlink()
                elif mode == 'extra':
                    extra.write_bytes(b'extra source')
                else:
                    file.write_bytes(b'tampered input')
                with self.assertRaises(RuntimeError):
                    self.install()
                self.assertFalse(self.target.exists())

    def test_rejects_linked_files_directories_manifest_and_fifo(self):
        outside = self.root / 'outside'
        outside.write_bytes(self.files['ds4.c'])
        file = self.tree / 'ds4.c'
        file.unlink()
        file.symlink_to(outside)
        with self.assertRaisesRegex(RuntimeError, 'linked'):
            self.install()
        file.unlink()
        os.mkfifo(file)
        with self.assertRaisesRegex(RuntimeError, 'special'):
            self.install()
        file.unlink()
        file.write_bytes(self.files['ds4.c'])
        metal = self.tree / 'metal'
        metal.rename(self.root / 'metal')
        metal.symlink_to(self.root / 'metal', target_is_directory=True)
        with self.assertRaises(RuntimeError):
            self.install()
        metal.unlink()
        (self.root / 'metal').rename(metal)
        self.manifest.rename(self.root / 'manifest.json')
        self.manifest.symlink_to(self.root / 'manifest.json')
        with self.assertRaisesRegex(RuntimeError, 'linked'):
            self.install()
        self.assertFalse(self.target.exists())

    def test_inventory_bounds_and_unsafe_paths_fail_before_candidate(self):
        entry = self.catalog['engines']['main']
        for name in ('../outside', '/absolute', 'metal/../escape', 'gguf/model', '.git/config'):
            with self.subTest(name=name):
                metadata = entry['files'].pop('ds4.c')
                entry['files'][name] = metadata
                self.save()
                with self.assertRaisesRegex(RuntimeError, 'inventory'):
                    self.install()
                entry['files'].pop(name)
                entry['files']['ds4.c'] = metadata
        self.save()
        for constant, limit in [('FILE_LIMIT', 1), ('BYTE_LIMIT', 1), ('MANIFEST_LIMIT', 16)]:
            with mock.patch.object(sources, constant, limit), self.assertRaises(RuntimeError):
                self.install()
        self.assertFalse(self.target.exists())

    def test_parent_replaced_with_link_cannot_be_read_during_copy(self):
        # A deterministic switch after the parent's path check must fail even
        # if the outside bytes happen to match. No timing-based race assertion.
        metal = self.tree / 'metal'
        outside = self.root / 'outside directory'
        outside.mkdir()
        (outside / 'a.metal').write_bytes(self.files['metal/a.metal'])
        check = Path.is_symlink
        switched = False
        def replace(path):
            nonlocal switched
            result = check(path)
            if path == metal and not switched:
                switched = True
                metal.rename(self.root / 'original metal')
                metal.symlink_to(outside, target_is_directory=True)
            return result
        with mock.patch.object(Path, 'is_symlink', replace), self.assertRaises((OSError, RuntimeError)):
            sources.copy_sources(self.assets, 'main', PIN, self.root / 'candidate')
        self.assertTrue(switched)

    def test_wrong_pin_and_historical_engine_have_no_installation_effect(self):
        with self.assertRaisesRegex(RuntimeError, 'pins disagree'):
            sources.install(self.assets, 'main', '2' * 40, self.target)
        self.catalog['engines']['main']['historical'] = True
        self.save()
        with self.assertRaisesRegex(RuntimeError, 'Historical'):
            self.install()
        self.assertEqual(list(self.target.parent.iterdir()), [])

    def test_racing_empty_or_populated_target_cannot_be_overwritten(self):
        copy = sources.copy_sources
        for populated in (False, True):
            with self.subTest(populated=populated):
                def prepare(*args):
                    proof = copy(*args)
                    self.target.mkdir()
                    if populated:
                        (self.target / 'note').write_bytes(b'keep racing data')
                    return proof
                with mock.patch.object(sources, 'copy_sources', side_effect=prepare), self.assertRaises(FileExistsError):
                    self.install()
                self.assertEqual(list(self.target.iterdir()), [self.target / 'note'] if populated else [])
                if populated:
                    self.assertEqual((self.target / 'note').read_bytes(), b'keep racing data')
                    (self.target / 'note').unlink()
                self.target.rmdir()

    def test_changed_empty_target_is_revalidated_after_copy(self):
        self.target.mkdir()
        copy = sources.copy_sources
        def prepare(*args):
            proof = copy(*args)
            (self.target / 'note').write_bytes(b'new user note')
            return proof
        with mock.patch.object(sources, 'copy_sources', side_effect=prepare), self.assertRaisesRegex(RuntimeError, 'Target changed'):
            self.install()
        self.assertEqual((self.target / 'note').read_bytes(), b'new user note')

    def test_manifest_or_source_change_before_publication_is_rejected(self):
        copy = sources.copy_sources
        for kind in ('manifest', 'source'):
            with self.subTest(kind=kind):
                self.save()
                (self.tree / 'ds4.c').write_bytes(self.files['ds4.c'])
                def prepare(*args):
                    proof = copy(*args)
                    if kind == 'manifest':
                        self.catalog['engines']['main']['repository'] += '/changed'
                        self.save()
                    else:
                        (self.tree / 'ds4.c').write_bytes(b'changed after source copy')
                    return proof
                with mock.patch.object(sources, 'copy_sources', side_effect=prepare), self.assertRaises(RuntimeError):
                    self.install()
                self.assertFalse(self.target.exists())

    def test_busy_owner_does_not_start_a_second_preparation(self):
        with sources.source_lease(self.target), self.assertRaises(OSError):
            self.install()
        self.assertFalse(list(self.target.parent.glob('.dstudio-ds4-source-*')))

    def test_independent_source_preparations_overlap(self):
        second = self.root / 'second install/ds4'
        second.parent.mkdir()
        barrier = threading.Barrier(2)
        copy = sources.copy_sources
        def prepare(*args):
            proof = copy(*args)
            barrier.wait(timeout=5)
            return proof
        with mock.patch.object(sources, 'copy_sources', side_effect=prepare), ThreadPoolExecutor(max_workers=2) as pool:
            pending = [pool.submit(sources.install, self.assets, 'main', PIN, target)
                       for target in (self.target, second)]
            for future in pending:
                future.result(timeout=10)
        for target in (self.target, second):
            self.assertEqual((target / 'ds4.c').read_bytes(), self.files['ds4.c'])
        for name, value in self.files.items():
            self.assertEqual((self.tree / name).read_bytes(), value)

    def test_replaced_owner_lease_cannot_publish(self):
        copy = sources.copy_sources
        def prepare(*args):
            proof = copy(*args)
            lease = self.target.parent / '.dstudio-ds4-sources.lock'
            lease.unlink()
            lease.write_bytes(b'replacement lease')
            return proof
        with mock.patch.object(sources, 'copy_sources', side_effect=prepare), self.assertRaisesRegex(RuntimeError, 'lease changed'):
            self.install()
        self.assertFalse(self.target.exists())

    def test_interrupted_acknowledgement_keeps_the_published_bytes(self):
        sync = sources.sync_directory
        def fail_parent(path):
            if path == self.target.parent:
                raise OSError('simulated parent fsync failure after publication')
            sync(path)
        with mock.patch.object(sources, 'sync_directory', side_effect=fail_parent), self.assertRaisesRegex(RuntimeError, 'were published'):
            self.install()
        for name, value in self.files.items():
            self.assertEqual((self.target / name).read_bytes(), value)
        self.assertTrue((self.target / '.dstudio-source.json').is_file())
        inode = self.target.stat().st_ino
        with self.assertRaisesRegex(RuntimeError, 'local data'):
            self.install()
        self.assertEqual(self.target.stat().st_ino, inode)

    def test_failed_preparation_count_is_bounded(self):
        (self.tree / 'ds4.c').write_bytes(b'corrupt source')
        for _ in range(2):
            with self.assertRaisesRegex(RuntimeError, 'digest'):
                self.install()
        with self.assertRaisesRegex(RuntimeError, 'Two prior'):
            self.install()
        self.assertEqual(len(list(self.target.parent.glob('.dstudio-ds4-source-*'))), 2)

    def test_all_shipped_snapshots_copy_and_verify_actual_bytes(self):
        assets = Path('.').resolve()
        catalog, _, _ = sources.load_catalog(assets)
        copied = set()
        for engine, entry in catalog['engines'].items():
            with self.subTest(engine=engine):
                target = self.root / entry['directory']
                proof = sources.copy_sources(assets, engine, entry['commit'], target)
                sources.verify_sources(assets, engine, entry['commit'], proof)
                copied.add(proof['engine'])
                self.assertEqual(proof['files'], len(entry['files']))
                self.assertTrue((target / 'LICENSE').is_file())
                self.assertFalse((target / '.git').exists())
                self.assertFalse((target / 'gguf').exists())
                # Sources only: no prebuilt engine or server binary is shipped.
                self.assertFalse(any(p.name in ('ds4', 'ds4-server', 'llama-server') and p.is_file()
                                     for p in target.iterdir()))
                self.assertFalse((target / 'bin').exists())
        self.assertEqual(copied, {'main', 'laguna', 'llama'})

    def test_git_tracks_every_shipped_snapshot_file(self):
        """A clone must carry complete snapshots. Upstream trees contain names
        matched by ignore rules (a `core/` directory, nested .gitignore files);
        those files are added with `git add -f`. Missing, extra or wrongly
        executable tracked files would make an offline installation fail on
        every fresh checkout although this working tree verifies."""
        import subprocess
        inside = subprocess.run(['git', 'rev-parse', '--is-inside-work-tree'], capture_output=True, text=True)
        if inside.returncode or inside.stdout.strip() != 'true':
            self.skipTest('NOT RUN: not a Git checkout (for example an installed app)')
        for catalog in (sources.ENGINES, sources.HARNESSES):
            manifest = json.loads(Path(catalog, 'manifest.json').read_text())
            for name, entry in manifest['engines'].items():
                with self.subTest(catalog=catalog, engine=name):
                    folder = f"{catalog}/{entry.get('directory', name)}"
                    listed = subprocess.run(['git', 'ls-files', '-s', '-z', '--', folder + '/'],
                                            capture_output=True, check=True).stdout.split(b'\0')
                    tracked = {}
                    for record in filter(None, listed):
                        meta, path = record.split(b'\t', 1)
                        tracked[path.decode()[len(folder) + 1:]] = meta.split()[0].decode()
                    self.assertEqual(sorted(set(entry['files']) - set(tracked)), [], 'untracked snapshot files')
                    self.assertEqual(sorted(set(tracked) - set(entry['files'])), [], 'tracked files outside the manifest')
                    wrong = [f for f, m in entry['files'].items() if (tracked[f] == '100755') != bool(m.get('executable'))]
                    self.assertEqual(wrong, [], 'tracked mode differs from the manifest')
        wheels = json.loads(Path('src/engines/mlx/manifest.json').read_text())['files']
        listed = subprocess.run(['git', 'ls-files', '--', 'src/engines/mlx/wheels/'], capture_output=True, text=True, check=True)
        self.assertEqual(sorted(Path(p).name for p in listed.stdout.split()), sorted(wheels))

    def test_retired_qwen_next_sources_are_unavailable_without_publication(self):
        assets = Path('.').resolve()
        revision = 'ff4f0ff4fdff70d6b7c3941ef437b91dde960e14'
        for operation in (sources.copy_sources, sources.install):
            with self.subTest(operation=operation.__name__):
                with self.assertRaisesRegex(RuntimeError, 'pins disagree'):
                    operation(assets, 'historical-qwen38', revision, self.target)
                self.assertFalse(self.target.exists())
                self.assertFalse(list(self.target.parent.iterdir()))


if __name__ == '__main__':
    unittest.main(verbosity=2)
