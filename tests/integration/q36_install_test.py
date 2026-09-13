"""Installer behavior on real archives/files/processes; no network or model weights."""
import importlib.util
import fcntl
import io
import json
import os
from pathlib import Path
import select
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location('q36_install', 'scripts/install-q36.py')
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='dstudio-q36-install-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.archive = self.root / 'fixture.tar.gz'
        self.target = self.root / 'candidate'

    def archive_with(self, entries):
        with tarfile.open(self.archive, 'w:gz') as package:
            for name, value, kind in entries:
                member = tarfile.TarInfo('q36-' + installer.PIN + '/' + name)
                if kind == 'file':
                    member.size = len(value)
                    package.addfile(member, io.BytesIO(value))
                else:
                    member.type = tarfile.SYMTYPE
                    member.linkname = value
                    package.addfile(member)

    def installed_fixture(self):
        """Real files and executable --help peers, explicitly not an engine build."""
        tree = self.root / 'q36'
        tree.mkdir()
        (tree / 'q36.c').write_bytes(b'fixture compiler input')
        for name in ('q36', 'q36-server'):
            (tree / name).write_text('#!/bin/sh\n[ "$1" = "--help" ]\n')
            (tree / name).chmod(0o755)
        inputs = ['patch/q36-metal-runtime/next-review.patch', 'scripts/apply-q36-metal-runtime.sh',
                  'scripts/apply-q36-agent-tty.sh', 'patch/q36-agent-tty/monitor.patch',
                  'patch/q36-agent-tty/monitor-owner.patch', 'patch/q36-metal-runtime/cache-usage.patch']
        receipt = {'engine': 'q36', 'commit': installer.PIN,
                   'backend': 'metal' if sys.platform == 'darwin' else 'vulkan',
                   'patches': {name: installer.sha256(installer.ASSETS / name) for name in inputs},
                   'sources': installer.source_identity(tree),
                   'binaries': {name: installer.sha256(tree / name) for name in ('q36', 'q36-server')}}
        (tree / '.dstudio-source.json').write_text(json.dumps(receipt))
        return tree

    def test_extracts_actual_bytes_and_nested_sources(self):
        self.archive_with([('q36.c', b'compiler input', 'file'), ('metal/a.metal', b'shader', 'file')])
        installer.extract_sources(self.archive, self.target)
        self.assertEqual((self.target / 'q36.c').read_bytes(), b'compiler input')
        self.assertEqual((self.target / 'metal/a.metal').read_bytes(), b'shader')

    def test_archive_links_and_traversal_rejected_before_any_extraction(self):
        for name, value, kind in [('../user.txt', b'bad', 'file'), ('outside', '/tmp', 'symlink')]:
            with self.subTest(name=name):
                self.archive_with([('good.c', b'good', 'file'), (name, value, kind)])
                with self.assertRaisesRegex(RuntimeError, 'archive entry'):
                    installer.extract_sources(self.archive, self.target)
                self.assertFalse(self.target.exists())
                self.assertFalse((self.root / 'user.txt').exists())

    def test_archive_file_and_byte_budgets(self):
        self.archive_with([('a.c', b'abcdef', 'file'), ('b.c', b'xyz', 'file')])
        for limit, value in [('FILE_LIMIT', 1), ('SOURCE_LIMIT', 8)]:
            with self.subTest(limit=limit), mock.patch.object(installer, limit, value):
                with self.assertRaises(RuntimeError):
                    installer.extract_sources(self.archive, self.target)
                self.assertFalse(self.target.exists())

    def test_duplicate_archive_files_never_overwrite(self):
        self.archive_with([('a.c', b'first', 'file'), ('a.c', b'second', 'file')])
        with self.assertRaises(FileExistsError):
            installer.extract_sources(self.archive, self.target)
        self.assertEqual((self.target / 'a.c').read_bytes(), b'first')

    def test_atomic_publish_preserves_empty_and_populated_destinations(self):
        source, destination = self.root / 'source', self.root / 'destination'
        source.mkdir()
        (source / 'binary').write_bytes(b'verified candidate')
        fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, fd)
        destination.mkdir()
        before = destination.stat().st_ino
        with self.assertRaises(FileExistsError):
            installer.no_replace(fd, 'source', fd, 'destination')
        self.assertEqual(destination.stat().st_ino, before)
        (destination / 'user.txt').write_bytes(b'keep')
        with self.assertRaises(FileExistsError):
            installer.no_replace(fd, 'source', fd, 'destination')
        self.assertEqual((destination / 'user.txt').read_bytes(), b'keep')
        installer.no_replace(fd, 'source', fd, 'new-engine')
        self.assertEqual((self.root / 'new-engine/binary').read_bytes(), b'verified candidate')
        self.assertFalse(source.exists())

    def test_source_identity_detects_changes_but_does_not_write(self):
        self.target.mkdir()
        source = self.target / 'q36.c'
        source.write_bytes(b'one')
        initial = installer.source_identity(self.target)
        self.assertEqual(installer.source_identity(self.target), initial)
        source.write_bytes(b'two')
        self.assertNotEqual(installer.source_identity(self.target), initial)
        self.assertEqual(source.read_bytes(), b'two')
        source.unlink()
        source.symlink_to(self.root / 'outside.c')
        with self.assertRaisesRegex(RuntimeError, 'Nonregular'):
            installer.source_identity(self.target)

    def test_durable_preparation_preserves_bytes_and_rejects_links(self):
        self.target.mkdir()
        source = self.target / 'runtime'
        source.write_bytes(b'newly built runtime')
        installer.sync_candidate(self.target)
        self.assertEqual(source.read_bytes(), b'newly built runtime')
        link = self.target / 'outside'
        link.symlink_to(self.root / 'user.bin')
        with self.assertRaises(OSError):
            installer.sync_candidate(self.target)
        self.assertTrue(link.is_symlink())

    def test_shared_model_alias_is_data_but_linked_source_is_rejected(self):
        self.target.mkdir()
        (self.target / 'q36.c').write_bytes(b'compiler input')
        expected = installer.source_identity(self.target)
        shared = self.root / 'model-store'
        shared.mkdir()
        (shared / 'unrelated.c').write_bytes(b'not an engine compiler input')
        alias = self.target / 'gguf'
        alias.symlink_to(shared, target_is_directory=True)
        self.assertEqual(installer.source_identity(self.target), expected)
        self.assertEqual((shared / 'unrelated.c').read_bytes(), b'not an engine compiler input')
        (self.target / 'metal').symlink_to(shared, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, 'Linked directory'):
            installer.source_identity(self.target)

    def test_wrong_pin_has_no_disk_or_process_side_effects(self):
        before = list(self.root.iterdir())
        with mock.patch.object(installer, 'command', side_effect=AssertionError('must not spawn')):
            with self.assertRaisesRegex(RuntimeError, 'pins disagree'):
                installer.install(self.root, '0' * 40)
        self.assertEqual(list(self.root.iterdir()), before)

    def test_existing_checkout_and_symlink_are_preserved(self):
        target = self.root / 'q36'
        target.mkdir()
        (target / 'user.c').write_bytes(b'unrelated source')
        with mock.patch.object(installer, 'command', side_effect=AssertionError('must not spawn')):
            with self.assertRaisesRegex(RuntimeError, 'preserved'):
                installer.install(self.root, installer.PIN)
        self.assertEqual((target / 'user.c').read_bytes(), b'unrelated source')
        target.rename(self.root / 'saved')
        target.symlink_to(self.root / 'saved', target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, 'preserved'):
            installer.install(self.root, installer.PIN)
        self.assertTrue(target.is_symlink())

    def test_busy_leader_does_not_start_another_preparation(self):
        with (self.root / '.dstudio-q36-install.lock').open('w') as lease:
            os.fchmod(lease.fileno(), 0o600)
            fcntl.flock(lease.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            with mock.patch.object(installer, 'command', side_effect=AssertionError('must not spawn')):
                with self.assertRaisesRegex(RuntimeError, 'already active'):
                    installer.install(self.root, installer.PIN)
            self.assertEqual(sorted(p.name for p in self.root.iterdir()), ['.dstudio-q36-install.lock'])

    def test_read_only_verification_coexists_with_a_runtime_lease(self):
        tree = self.installed_fixture()
        before = {p.name: (p.stat().st_ino, p.read_bytes()) for p in tree.iterdir()}
        with (self.root / '.dstudio-q36-install.lock').open('w') as lease:
            os.fchmod(lease.fileno(), 0o600)
            fcntl.flock(lease.fileno(), fcntl.LOCK_SH | fcntl.LOCK_NB)
            installer.install(self.root, installer.PIN)
            self.assertEqual({p.name: (p.stat().st_ino, p.read_bytes()) for p in tree.iterdir()}, before)
            # The installer closes only its own handle, not the active reader.
            with (self.root / '.dstudio-q36-install.lock').open('r') as probe:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(probe.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_shared_runtime_cannot_authorize_a_new_installation(self):
        with (self.root / '.dstudio-q36-install.lock').open('w') as lease:
            os.fchmod(lease.fileno(), 0o600)
            fcntl.flock(lease.fileno(), fcntl.LOCK_SH | fcntl.LOCK_NB)
            with mock.patch.object(installer, 'command', side_effect=AssertionError('must not prepare')):
                with self.assertRaisesRegex(RuntimeError, 'already active'):
                    installer.install(self.root, installer.PIN)
            self.assertFalse((self.root / 'q36').exists())
            self.assertEqual(list(self.root.glob('.dstudio-q36-stage-*')), [])

    def test_install_lease_rejects_aliases_and_shared_writable_files(self):
        original = self.root / 'unrelated-user-data'
        original.write_bytes(b'preserve exactly')
        for kind in ('symlink', 'hardlink', 'writable'):
            with self.subTest(kind=kind):
                case = self.root / kind
                case.mkdir()
                lease = case / '.dstudio-q36-install.lock'
                if kind == 'symlink':
                    lease.symlink_to(original)
                elif kind == 'hardlink':
                    os.link(original, lease)
                else:
                    lease.write_bytes(b'not a private lease')
                    lease.chmod(0o666)
                with mock.patch.object(installer, 'command', side_effect=AssertionError('must not prepare')):
                    with self.assertRaises((OSError, RuntimeError)):
                        installer.install(case, installer.PIN)
                self.assertEqual(original.read_bytes(), b'preserve exactly')
                self.assertEqual(list(case.iterdir()), [lease])

    def test_install_conversion_revalidates_a_racing_publication(self):
        real_flock = fcntl.flock
        tree = self.root / 'q36'

        def race(fd, mode):
            result = real_flock(fd, mode)
            if mode == fcntl.LOCK_EX | fcntl.LOCK_NB:
                tree.mkdir()
                (tree / 'winner.txt').write_bytes(b'published by the competing installer')
            return result

        with mock.patch.object(installer.fcntl, 'flock', side_effect=race), \
                mock.patch.object(installer, 'command', side_effect=AssertionError('must not prepare')):
            with self.assertRaisesRegex(RuntimeError, 'changed during admission'):
                installer.install(self.root, installer.PIN)
        self.assertEqual((tree / 'winner.txt').read_bytes(), b'published by the competing installer')
        self.assertEqual(list(self.root.glob('.dstudio-q36-stage-*')), [])

    def test_managed_inventory_does_not_adopt_later_user_files(self):
        tree = self.installed_fixture()
        readme = tree / 'README.md'
        readme.write_bytes(b'owned documentation')
        inventory = installer.managed_files(tree)
        receipt_file = tree / '.dstudio-source.json'
        receipt = json.loads(receipt_file.read_text())
        receipt['managedFiles'] = inventory
        receipt_file.write_text(json.dumps(receipt))
        original_receipt = receipt_file.read_bytes()
        (tree / 'personal-notes.md').write_bytes(b'user notes: preserve')
        (tree / 'cache').mkdir()
        (tree / 'cache/state.json').write_bytes(b'{"previous":"compatible cache bytes"}')
        shared = self.root / 'shared-weights'
        shared.mkdir()
        (shared / 'model.gguf').write_bytes(b'model-store fixture, not weights')
        (tree / 'gguf').symlink_to(shared, target_is_directory=True)
        before = {p: (p.stat().st_ino, p.read_bytes()) for p in
                  [tree / 'personal-notes.md', tree / 'cache/state.json', shared / 'model.gguf']}
        installer.install(self.root, installer.PIN)
        self.assertEqual(receipt_file.read_bytes(), original_receipt)
        self.assertEqual(installer.managed_files(tree, inventory), inventory)
        for file, snapshot in before.items():
            self.assertEqual((file.stat().st_ino, file.read_bytes()), snapshot)

    def test_managed_non_source_edits_reject_without_running_a_binary(self):
        tree = self.installed_fixture()
        (tree / 'README.md').write_bytes(b'original owned documentation')
        receipt_file = tree / '.dstudio-source.json'
        receipt = json.loads(receipt_file.read_text())
        receipt['managedFiles'] = installer.managed_files(tree)
        receipt_file.write_text(json.dumps(receipt))
        (tree / 'README.md').write_bytes(b'a local documentation change')
        with mock.patch.object(installer, 'command', side_effect=AssertionError('must not execute')):
            with self.assertRaisesRegex(RuntimeError, 'local edits preserved'):
                installer.install(self.root, installer.PIN)
        self.assertEqual((tree / 'README.md').read_bytes(), b'a local documentation change')

    def test_installed_user_code_projects_are_not_engine_inputs(self):
        tree = self.installed_fixture()
        receipt_file = tree / '.dstudio-source.json'
        receipt = json.loads(receipt_file.read_text())
        receipt['managedFiles'] = installer.managed_files(tree)
        receipt_file.write_text(json.dumps(receipt))
        (tree / 'projects/client').mkdir(parents=True)
        (tree / 'projects/client/main.c').write_bytes(b'int main(void) { return 0; }\n')
        (tree / 'projects/client/Makefile').write_bytes(b'all:\n\t@false\n')
        (tree / 'linked-project').symlink_to('projects/client', target_is_directory=True)
        before = installer.installation_snapshot(tree)
        actual_hash = installer.sha256

        def owned_hash(file):
            self.assertNotIn('projects', Path(file).parts, 'User code is not an engine input')
            return actual_hash(file)

        with mock.patch.object(installer, 'sha256', side_effect=owned_hash):
            installer.install(self.root, installer.PIN)
        self.assertEqual(installer.installation_snapshot(tree), before)
        self.assertEqual(json.loads(receipt_file.read_text()), receipt)

    def test_owned_source_area_stays_strict_with_an_unrelated_project(self):
        tree = self.installed_fixture()
        (tree / 'metal').mkdir()
        shader = tree / 'metal/a.metal'
        shader.write_bytes(b'original shader')
        receipt = json.loads((tree / '.dstudio-source.json').read_text())
        receipt['sources'] = installer.source_identity(tree)
        (tree / 'project').mkdir()
        (tree / 'project/example.c').write_bytes(b'unrelated example')
        for change in ('changed shader', 'omitted shader', 'extra shader', 'extra root source', 'linked shader'):
            with self.subTest(change=change):
                candidate = json.loads(json.dumps(receipt))
                if change == 'changed shader':
                    shader.write_bytes(b'local shader changes')
                elif change == 'omitted shader':
                    del candidate['sources']['metal/a.metal']
                elif change == 'extra shader':
                    (tree / 'metal/extra.metal').write_bytes(b'extra compiler input')
                elif change == 'extra root source':
                    (tree / 'extra.c').write_bytes(b'extra compiler input')
                else:
                    shader.unlink()
                    shader.symlink_to('../project/example.c')
                with self.assertRaises(RuntimeError):
                    installer.verify_existing(tree, candidate)
                if shader.is_symlink():
                    shader.unlink()
                shader.write_bytes(b'original shader')
                for extra in (tree / 'metal/extra.metal', tree / 'extra.c'):
                    extra.unlink(missing_ok=True)
        installer.verify_existing(tree, receipt)

    def test_nonregular_binary_does_not_block_installer_or_mutate_the_fifo(self):
        tree = self.installed_fixture()
        binary = tree / 'q36'
        binary.unlink()
        os.mkfifo(binary)
        result = subprocess.run([sys.executable, str(Path(installer.__file__).resolve()),
                                 '--root', str(self.root), '--revision', installer.PIN],
                                capture_output=True, text=True, timeout=3)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Nonregular', result.stderr)
        self.assertTrue(stat.S_ISFIFO(binary.lstat().st_mode))

    def test_managed_inventory_rejects_aliases_paths_and_byte_or_entry_overflow(self):
        self.target.mkdir()
        (self.target / 'a').write_bytes(b'12345678')
        (self.target / 'b').write_bytes(b'12345678')
        inventory = installer.managed_files(self.target)
        self.assertEqual(set(inventory), {'a', 'b'})
        for key in ('../outside', '/outside', 'a//b', './a', 'gguf/model.gguf'):
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, 'Invalid managed-file path'):
                installer.managed_files(self.target, {key: '0' * 64})
        with mock.patch.object(installer, 'SOURCE_LIMIT', 7):
            with self.assertRaisesRegex(RuntimeError, 'byte budget'):
                installer.managed_files(self.target)
        with mock.patch.object(installer, 'FILE_LIMIT', 1):
            with self.assertRaisesRegex(RuntimeError, 'count'):
                installer.managed_files(self.target)
        (self.target / 'b').unlink()
        (self.target / 'empty-dir').mkdir()
        with mock.patch.object(installer, 'FILE_LIMIT', 1):
            with self.assertRaisesRegex(RuntimeError, 'count'):
                installer.managed_files(self.target)
        (self.target / 'empty-dir').rmdir()
        (self.target / 'linked').symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, 'Nonregular'):
            installer.managed_files(self.target)

    def test_publication_revalidates_installer_and_patch_inputs(self):
        # Network, patch application and compilation are simulated here. The
        # production extraction, input hashing, revalidation and publication
        # execute against real files; a separate live gate builds upstream.
        self.archive_with([('q36.c', b'fixture source', 'file')])
        for changed in (None, 'installer', 'patch'):
            with self.subTest(changed=changed):
                case = self.root / (changed or 'unchanged')
                assets, destination = case / 'assets', case / 'install'
                destination.mkdir(parents=True)
                inputs = [
                    'patch/q36-metal-runtime/next-review.patch',
                    'scripts/apply-q36-metal-runtime.sh',
                    'scripts/apply-q36-agent-tty.sh',
                    'patch/q36-agent-tty/monitor.patch',
                    'patch/q36-agent-tty/monitor-owner.patch',
                    'patch/q36-metal-runtime/cache-usage.patch',
                ]
                for name in inputs:
                    file = assets / name
                    file.parent.mkdir(parents=True, exist_ok=True)
                    file.write_bytes(b'fixture preparation input: ' + name.encode())
                installer_file = assets / 'scripts/install-q36.py'
                shutil.copyfile(installer.__file__, installer_file)
                initial_installer = installer.sha256(installer_file)
                initial_patches = {name: installer.sha256(assets / name) for name in inputs}
                applied = []

                def prepare(argv, cwd, env, seconds):
                    if argv[0] == 'curl':
                        shutil.copyfile(self.archive, argv[argv.index('--output') + 1])
                    elif argv[0] == '/bin/sh':
                        applied.append((Path(argv[1]).name, argv[2:]))
                    elif argv[0] == 'make':
                        for name in ('q36', 'q36-server'):
                            (cwd / name).write_bytes(b'simulated binary: ' + name.encode())
                        if changed:
                            file = installer_file if changed == 'installer' else assets / inputs[-1]
                            file.write_bytes(file.read_bytes() + b'\nchanged during preparation\n')
                    else:
                        self.assertEqual(argv[1:], ['--help'])
                        self.assertIn(Path(argv[0]).name, ('q36', 'q36-server'))
                    return 'simulated command output'

                with mock.patch.object(installer, 'ASSETS', assets), \
                        mock.patch.object(installer, '__file__', str(installer_file)), \
                        mock.patch.object(installer, 'command', side_effect=prepare):
                    if changed:
                        error = 'Installer changed' if changed == 'installer' else 'patch inputs changed'
                        with self.assertRaisesRegex(RuntimeError, error):
                            installer.install(destination, installer.PIN)
                        self.assertFalse((destination / 'q36').exists())
                        stages = list(destination.glob('.dstudio-q36-stage-*'))
                        self.assertEqual(len(stages), 1, 'failed preparation remains inspectable')
                        self.assertFalse((stages[0] / 'q36/.dstudio-source.json').exists())
                        self.assertEqual((stages[0] / 'q36/q36.c').read_bytes(), b'fixture source')
                    else:
                        installer.install(destination, installer.PIN)
                        receipt = json.loads((destination / 'q36/.dstudio-source.json').read_text())
                        self.assertEqual(receipt['installerSHA256'], initial_installer)
                        self.assertEqual(receipt['patches'], initial_patches)
                        self.assertEqual(receipt['patchOrder'], [inputs[0], inputs[3], inputs[4], inputs[5]])
                        self.assertEqual(receipt['managedFiles'], installer.managed_files(destination / 'q36'))
                        self.assertEqual(set(receipt['managedFiles']), {'q36.c', 'q36', 'q36-server', '.dstudio-build.log'})
                        self.assertFalse(receipt['modelLoaded'])
                        self.assertFalse(receipt['qualityValidated'])
                        self.assertEqual(list(destination.glob('.dstudio-q36-stage-*')), [])
                self.assertEqual(applied, [
                    ('apply-q36-metal-runtime.sh', ['apply', 'next-review']),
                    ('apply-q36-agent-tty.sh', ['apply', 'monitor']),
                    ('apply-q36-agent-tty.sh', ['apply', 'monitor-owner']),
                    ('apply-q36-metal-runtime.sh', ['apply', 'cache-usage']),
                ])

    def test_command_errors_and_output_limits_are_not_success(self):
        with self.assertRaisesRegex(RuntimeError, r'failed \(7\)'):
            installer.command([sys.executable, '-c', 'raise SystemExit(7)'], self.root, os.environ, 5)
        with mock.patch.object(installer, 'LOG_LIMIT', 64):
            with self.assertRaisesRegex(RuntimeError, 'output exceeded'):
                installer.command([sys.executable, '-c', 'print("x"*1024)'], self.root, os.environ, 5)

    def test_command_supervision_preserves_decoded_bytes_and_the_raw_output_limit(self):
        with mock.patch.object(installer, 'LOG_LIMIT', 64):
            result = installer.command([sys.executable, '-c', 'import os; os.write(1, bytes([255])*64)'],
                                       self.root, os.environ, 5)
            self.assertEqual(result, '\ufffd' * 64)
            with self.assertRaisesRegex(RuntimeError, 'output exceeded the 64-byte limit'):
                installer.command([sys.executable, '-c', 'import os; os.write(1, b"x"*65)'],
                                  self.root, os.environ, 5)

    def upgrade_fixture(self):
        tree = self.installed_fixture()
        receipt_file = tree / '.dstudio-source.json'
        receipt = json.loads(receipt_file.read_text())
        receipt['commit'] = installer.LEGACY_PIN
        receipt['managedFiles'] = installer.managed_files(tree)
        receipt_file.write_text(json.dumps(receipt))
        self.archive_with([('q36.c', b'new independently prepared source', 'file')])
        return tree, receipt_file.read_bytes()

    def prepare_upgrade(self, argv, cwd, env, seconds):
        # Only download/patch/build are simulated. The installed --help program,
        # locks, hardlinks, receipts, namespace exchange and fsync are real.
        if argv[0] == 'curl':
            shutil.copyfile(self.archive, argv[argv.index('--output') + 1])
        elif argv[0] == 'make':
            for name in ('q36', 'q36-server'):
                (cwd / name).write_text('#!/bin/sh\n[ "$1" = "--help" ] && printf "new runtime\\n"\n')
                (cwd / name).chmod(0o755)
        elif argv[0] != '/bin/sh':
            result = subprocess.run(argv, cwd=cwd, env=env, capture_output=True, timeout=seconds)
            self.assertEqual(result.returncode, 0)
        return 'simulated build output, not a real engine build'

    def test_upgrade_keeps_user_files_and_previous_engine_at_atomic_publication(self):
        tree, old_receipt = self.upgrade_fixture()
        old_inode = tree.stat().st_ino
        (tree / 'projects').mkdir()
        (tree / 'projects/draft.md').write_bytes(b'original project')
        (tree / 'settings.json').write_bytes(b'{"context":131072}')
        (tree / 'cache').mkdir()
        (tree / 'cache/session.bin').write_bytes(b'previous compatible cache')
        (tree / 'empty-user-directory').mkdir()
        (tree / 'empty-user-directory').chmod(0o700)
        shared = self.root / 'shared-models'
        shared.mkdir()
        model = shared / 'model.gguf'
        model.write_bytes(b'fixture weights; not an LLM')
        (tree / 'gguf').symlink_to('../shared-models', target_is_directory=True)
        os.link(tree / 'projects/draft.md', tree / 'second-alias.md')
        retained = [tree / 'projects/draft.md', tree / 'settings.json', tree / 'cache/session.bin', model]
        before = {p: (p.stat().st_ino, p.read_bytes()) for p in retained}
        actual_exchange = installer.exchange_installation

        def exchange(source_fd, target_fd):
            # The old source/receipt remain visible until the one transition.
            self.assertEqual(tree.stat().st_ino, old_inode)
            self.assertEqual((tree / '.dstudio-source.json').read_bytes(), old_receipt)
            self.assertEqual((tree / 'q36.c').read_bytes(), b'fixture compiler input')
            return actual_exchange(source_fd, target_fd)

        with mock.patch.object(installer, 'command', side_effect=self.prepare_upgrade), \
                mock.patch.object(installer, 'exchange_installation', side_effect=exchange) as publication:
            installer.install(self.root, installer.PIN)
            self.assertEqual(publication.call_count, 1)
            receipt = json.loads((tree / '.dstudio-source.json').read_text())
            backup = self.root / receipt['upgradeFrom']['backup']
            self.assertEqual(backup.stat().st_ino, old_inode)
            self.assertEqual((backup / '.dstudio-source.json').read_bytes(), old_receipt)
            self.assertEqual((backup / 'q36.c').read_bytes(), b'fixture compiler input')
            self.assertEqual((tree / 'q36.c').read_bytes(), b'new independently prepared source')
            self.assertEqual(receipt['commit'], installer.PIN)
            installer.managed_files(tree, receipt['managedFiles'])
            self.assertNotIn('settings.json', receipt['managedFiles'])
            self.assertEqual(os.readlink(tree / 'gguf'), '../shared-models')
            self.assertEqual(stat.S_IMODE((tree / 'empty-user-directory').stat().st_mode), 0o700)
            for file, state in before.items():
                self.assertEqual((file.stat().st_ino, file.read_bytes()), state)
            self.assertEqual((tree / 'second-alias.md').stat().st_ino,
                             (tree / 'projects/draft.md').stat().st_ino)
            self.assertTrue((backup.parent / 'upgrade.json').is_file())
            # Reopening is verification, never another exchange or new backup.
            installer.install(self.root, installer.PIN)
            self.assertEqual(publication.call_count, 1)
            self.assertEqual(len(list(self.root.glob('.dstudio-q36-stage-*'))), 1)

    def test_upgrade_preserves_code_projects_without_compiling_or_adopting_them(self):
        tree, old_receipt = self.upgrade_fixture()
        project = tree / 'user-project'
        project.mkdir()
        (project / 'main.c').write_bytes(b'int main(void) { return 23; }\n')
        (project / 'Makefile').write_bytes(b'all:\n\t@false\n')
        (tree / 'linked-project').symlink_to('user-project', target_is_directory=True)
        before = {name: (file.stat().st_ino, file.read_bytes()) for name, file in
                  [('main.c', project / 'main.c'), ('Makefile', project / 'Makefile')]}

        def prepare(argv, cwd, env, seconds):
            if argv[0] == 'make':
                self.assertFalse((cwd / 'user-project').exists(), 'Never compile a user project as an engine')
                self.assertFalse((cwd / 'linked-project').exists())
            return self.prepare_upgrade(argv, cwd, env, seconds)

        with mock.patch.object(installer, 'command', side_effect=prepare):
            installer.install(self.root, installer.PIN)
            installer.install(self.root, installer.PIN)
        receipt = json.loads((tree / '.dstudio-source.json').read_text())
        backup = self.root / receipt['upgradeFrom']['backup']
        self.assertEqual((backup / '.dstudio-source.json').read_bytes(), old_receipt)
        self.assertEqual(os.readlink(tree / 'linked-project'), 'user-project')
        for name, expected in before.items():
            file = project / name
            self.assertEqual((file.stat().st_ino, file.read_bytes()), expected)
            self.assertNotIn('user-project/' + name, receipt['sources'])
            self.assertNotIn('user-project/' + name, receipt['managedFiles'])
            self.assertEqual((backup / 'user-project' / name).stat().st_ino, expected[0])

    def test_upgrade_does_not_replace_an_active_runtime(self):
        tree, old_receipt = self.upgrade_fixture()
        with (self.root / '.dstudio-q36-install.lock').open('w') as lease:
            os.fchmod(lease.fileno(), 0o600)
            fcntl.flock(lease.fileno(), fcntl.LOCK_SH | fcntl.LOCK_NB)
            with mock.patch.object(installer, 'command', side_effect=AssertionError('must not build')):
                with self.assertRaisesRegex(RuntimeError, 'already active'):
                    installer.install(self.root, installer.PIN)
        self.assertEqual((tree / '.dstudio-source.json').read_bytes(), old_receipt)
        self.assertEqual(list(self.root.glob('.dstudio-q36-stage-*')), [])

    def test_upgrade_build_failure_and_data_races_preserve_old_installation(self):
        tree, old_receipt = self.upgrade_fixture()
        original_inode = tree.stat().st_ino
        note = tree / 'user.txt'
        note.write_bytes(b'before')
        for action in ('build failure', 'user edit'):
            with self.subTest(action=action):
                def prepare(argv, cwd, env, seconds):
                    result = self.prepare_upgrade(argv, cwd, env, seconds)
                    if argv[0] == 'make':
                        if action == 'build failure':
                            raise RuntimeError('intentional build failure')
                        note.write_bytes(b'user edited while compiling')
                    return result

                with mock.patch.object(installer, 'command', side_effect=prepare), \
                        mock.patch.object(installer, 'exchange_installation', side_effect=AssertionError('no publication')):
                    with self.assertRaisesRegex(RuntimeError, 'build failure|changed during preparation'):
                        installer.install(self.root, installer.PIN)
                self.assertEqual(tree.stat().st_ino, original_inode)
                self.assertEqual((tree / '.dstudio-source.json').read_bytes(), old_receipt)
                self.assertEqual((tree / 'q36.c').read_bytes(), b'fixture compiler input')
        self.assertEqual(note.read_bytes(), b'user edited while compiling')
        self.assertEqual(len(list(self.root.glob('.dstudio-q36-stage-*'))), 2)

    def test_upgrade_conflict_never_overwrites_an_unowned_user_file(self):
        tree, old_receipt = self.upgrade_fixture()
        (tree / 'README.md').write_bytes(b'personal file with an upstream name')
        self.archive_with([('q36.c', b'new compiler input', 'file'), ('README.md', b'new upstream file', 'file')])
        with mock.patch.object(installer, 'command', side_effect=self.prepare_upgrade):
            with self.assertRaisesRegex(RuntimeError, 'User file conflicts'):
                installer.install(self.root, installer.PIN)
        self.assertEqual((tree / 'README.md').read_bytes(), b'personal file with an upstream name')
        self.assertEqual((tree / '.dstudio-source.json').read_bytes(), old_receipt)

    def test_upgrade_rejects_unrecorded_patch_requirements_and_legacy_ownership(self):
        tree, original_receipt = self.upgrade_fixture()
        for problem in ('additional patch', 'legacy receipt'):
            with self.subTest(problem=problem):
                receipt = json.loads(original_receipt)
                if problem == 'additional patch':
                    receipt['patches']['my-required.patch'] = '0' * 64
                else:
                    del receipt['managedFiles']
                encoded = json.dumps(receipt).encode()
                (tree / '.dstudio-source.json').write_bytes(encoded)
                with mock.patch.object(installer, 'command', side_effect=AssertionError('must not build')):
                    with self.assertRaisesRegex(RuntimeError, 'additional patch requirements|ownership migration'):
                        installer.install(self.root, installer.PIN)
                self.assertEqual((tree / '.dstudio-source.json').read_bytes(), encoded)

    def test_upgrade_cancel_before_exchange_preserves_old_engine(self):
        tree, old_receipt = self.upgrade_fixture()
        original_inode = tree.stat().st_ino
        (tree / 'user.txt').write_bytes(b'preserve me')
        with mock.patch.object(installer, 'command', side_effect=self.prepare_upgrade), \
                mock.patch.object(installer, 'exchange_installation', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                installer.install(self.root, installer.PIN)
        self.assertEqual(tree.stat().st_ino, original_inode)
        self.assertEqual((tree / '.dstudio-source.json').read_bytes(), old_receipt)
        self.assertEqual((tree / 'user.txt').read_bytes(), b'preserve me')
        self.assertEqual(len(list(self.root.glob('.dstudio-q36-stage-*/upgrade.json'))), 1)

    @unittest.skipUnless(sys.platform == 'darwin', 'Legacy ownership migration is Metal-only')
    def test_legacy_upgrade_reconstructs_archive_ownership_without_adopting_old_build_files(self):
        tree, _ = self.upgrade_fixture()
        (tree / 'README.md').write_bytes(b'original distributed README')
        (tree / 'q36_gpu_core_metal.o').write_bytes(b'unrecorded object: could be a user file')
        (tree / '.dstudio-build.log').write_bytes(b'original unrecorded build log')
        (tree / 'notes.txt').write_bytes(b'personal notes')
        with mock.patch.object(installer, 'PIN', installer.LEGACY_PIN):
            self.archive_with([('q36.c', b'fixture compiler input', 'file'),
                               ('README.md', b'original distributed README', 'file')])
        legacy_archive = self.root / 'legacy-fixture.tar.gz'
        self.archive.rename(legacy_archive)
        self.archive_with([('q36.c', b'new independently prepared source', 'file'),
                           ('README.md', b'new distributed README', 'file')])
        receipt_file = tree / '.dstudio-source.json'
        receipt = json.loads(receipt_file.read_text())
        del receipt['managedFiles']
        receipt['archiveSHA256'] = installer.sha256(legacy_archive)
        old_receipt = json.dumps(receipt).encode()
        receipt_file.write_bytes(old_receipt)
        retained = [tree / 'q36_gpu_core_metal.o', tree / '.dstudio-build.log', tree / 'notes.txt']
        before = {p: (p.stat().st_ino, p.read_bytes()) for p in retained}

        def prepare(argv, cwd, env, seconds):
            if argv[0] == 'curl' and argv[-1].endswith(installer.LEGACY_PIN):
                shutil.copyfile(legacy_archive, argv[argv.index('--output') + 1])
                return 'simulated network, exact legacy fixture archive'
            result = self.prepare_upgrade(argv, cwd, env, seconds)
            if argv[0] == 'make':
                (cwd / 'q36_gpu_core_metal.o').write_bytes(b'new generated object')
            return result

        with mock.patch.object(installer, 'command', side_effect=prepare):
            installer.install(self.root, installer.PIN)
            current = json.loads(receipt_file.read_text())
            self.assertTrue(current['upgradeFrom']['ownershipReconstructed'])
            self.assertEqual(set(current['upgradeFrom']['legacyBuildFilesPreserved']),
                             {'.dstudio-build.log', 'q36_gpu_core_metal.o'})
            self.assertEqual((tree / 'README.md').read_bytes(), b'new distributed README')
            self.assertEqual((tree / 'q36.c').read_bytes(), b'new independently prepared source')
            backup = self.root / current['upgradeFrom']['backup']
            self.assertEqual((backup / '.dstudio-source.json').read_bytes(), old_receipt)
            products = self.root / current['upgradeFrom']['newBuildProducts']
            self.assertEqual((products / 'q36_gpu_core_metal.o').read_bytes(), b'new generated object')
            for file, data in before.items():
                self.assertEqual((file.stat().st_ino, file.read_bytes()), data)
                self.assertNotIn(file.name, current['managedFiles'])
            installer.install(self.root, installer.PIN)

    @unittest.skipUnless(sys.platform == 'darwin', 'Legacy ownership migration is Metal-only')
    def test_legacy_archive_mismatch_cannot_authorize_any_old_file_replacement(self):
        tree, _ = self.upgrade_fixture()
        receipt_file = tree / '.dstudio-source.json'
        receipt = json.loads(receipt_file.read_text())
        del receipt['managedFiles']
        receipt['archiveSHA256'] = '0' * 64
        original = json.dumps(receipt).encode()
        receipt_file.write_bytes(original)
        with mock.patch.object(installer, 'command', side_effect=self.prepare_upgrade), \
                mock.patch.object(installer, 'exchange_installation', side_effect=AssertionError('must not publish')):
            with self.assertRaisesRegex(RuntimeError, 'Legacy source archive identity differs'):
                installer.install(self.root, installer.PIN)
        self.assertEqual(receipt_file.read_bytes(), original)
        self.assertEqual((tree / 'q36.c').read_bytes(), b'fixture compiler input')

    def test_upgrade_cannot_implicitly_downgrade_an_unreviewed_revision(self):
        tree, _ = self.upgrade_fixture()
        receipt_file = tree / '.dstudio-source.json'
        receipt = json.loads(receipt_file.read_text())
        receipt['commit'] = 'f' * 40
        original = json.dumps(receipt).encode()
        receipt_file.write_bytes(original)
        with mock.patch.object(installer, 'command', side_effect=AssertionError('must not build')):
            with self.assertRaisesRegex(RuntimeError, 'not a reviewed upgrade base'):
                installer.install(self.root, installer.PIN)
        self.assertEqual(receipt_file.read_bytes(), original)

    @unittest.skipUnless(sys.platform == 'darwin', 'Legacy vnode check uses macOS lsof')
    def test_legacy_idle_check_rejects_a_real_running_executable_without_stopping_it(self):
        tree, _ = self.upgrade_fixture()
        # Do not copy an Apple platform binary: AMFI can kill that relocated
        # executable after exec. Compile an owned peer and wait for its actual
        # readiness signal before exercising the unchanged admission oracle.
        build = subprocess.run(['cc', '-x', 'c', '-', '-o', str(tree / 'q36-server')],
                               input='#include <stdio.h>\n#include <unistd.h>\nint main(void) { puts("READY"); fflush(stdout); for (;;) pause(); }\n',
                               text=True, capture_output=True, timeout=30)
        self.assertEqual(build.returncode, 0, build.stderr)
        child = subprocess.Popen([str(tree / 'q36-server')], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.assertTrue(select.select([child.stdout], [], [], 3)[0], 'Native peer never became ready')
            self.assertEqual(child.stdout.readline(), b'READY\n')
            self.assertIsNone(child.poll(), 'The native busy-process fixture exited before admission')
            with self.assertRaisesRegex(RuntimeError, 'still in use'):
                installer.require_legacy_idle(tree)
            self.assertIsNone(child.poll(), 'The read-only admission check stopped an existing process')
        finally:
            if child.poll() is None:
                child.terminate()
            child.wait(timeout=3)
            child.stdout.close()
            child.stderr.close()
        installer.require_legacy_idle(tree)

    def test_upgrade_failed_post_exchange_fsync_is_retried_without_second_publication(self):
        tree, old_receipt = self.upgrade_fixture()
        actual_exchange, actual_fsync = installer.exchange_installation, os.fsync
        exchanged, failed = False, False

        def exchange(source_fd, target_fd):
            nonlocal exchanged
            actual_exchange(source_fd, target_fd)
            exchanged = True

        def fail_after_exchange(fd):
            nonlocal failed
            if exchanged and not failed:
                failed = True
                raise OSError('injected namespace fsync failure')
            return actual_fsync(fd)

        with mock.patch.object(installer, 'command', side_effect=self.prepare_upgrade), \
                mock.patch.object(installer, 'exchange_installation', side_effect=exchange), \
                mock.patch.object(installer.os, 'fsync', side_effect=fail_after_exchange):
            with self.assertRaisesRegex(RuntimeError, 'was published.*durability'):
                installer.install(self.root, installer.PIN)
        receipt = json.loads((tree / '.dstudio-source.json').read_text())
        backup = self.root / receipt['upgradeFrom']['backup']
        self.assertEqual((backup / '.dstudio-source.json').read_bytes(), old_receipt)
        synced = []

        def track_sync(fd):
            synced.append(os.fstat(fd).st_ino)
            return actual_fsync(fd)

        with mock.patch.object(installer, 'command', side_effect=self.prepare_upgrade), \
                mock.patch.object(installer.os, 'fsync', side_effect=track_sync), \
                mock.patch.object(installer, 'exchange_installation', side_effect=AssertionError('no second publication')):
            installer.install(self.root, installer.PIN)
        self.assertIn(self.root.stat().st_ino, synced)
        self.assertIn(backup.parent.stat().st_ino, synced)

    def test_upgrade_interruption_after_exchange_is_reported_and_reopening_is_idempotent(self):
        tree, old_receipt = self.upgrade_fixture()
        (tree / 'user.txt').write_bytes(b'preserved original data')
        actual_exchange = installer.exchange_installation

        def interrupt_after_exchange(source_fd, target_fd):
            actual_exchange(source_fd, target_fd)
            raise KeyboardInterrupt('simulated interruption immediately after the kernel transition')

        with mock.patch.object(installer, 'command', side_effect=self.prepare_upgrade), \
                mock.patch.object(installer, 'exchange_installation', side_effect=interrupt_after_exchange):
            with self.assertRaisesRegex(RuntimeError, 'was published.*interrupted'):
                installer.install(self.root, installer.PIN)
        receipt = json.loads((tree / '.dstudio-source.json').read_text())
        self.assertEqual(receipt['commit'], installer.PIN)
        backup = self.root / receipt['upgradeFrom']['backup']
        self.assertEqual((backup / '.dstudio-source.json').read_bytes(), old_receipt)
        self.assertEqual((tree / 'user.txt').read_bytes(), b'preserved original data')
        journal = json.loads((backup.parent / 'upgrade.json').read_text())
        self.assertEqual(journal['newDirectory'], [tree.stat().st_dev, tree.stat().st_ino])
        self.assertEqual(journal['oldDirectory'], [backup.stat().st_dev, backup.stat().st_ino])
        with mock.patch.object(installer, 'command', side_effect=self.prepare_upgrade), \
                mock.patch.object(installer, 'exchange_installation', side_effect=AssertionError('no second commit')):
            installer.install(self.root, installer.PIN)
        self.assertEqual(len(list(self.root.glob('.dstudio-q36-stage-*'))), 1)

    def test_command_never_signals_a_reaped_process_group_identity(self):
        actual_killpg = os.killpg
        signals = []

        def observe(group, sig):
            if sig:
                # ChildProcessError here would prove its PID reservation was
                # already released. Observe without reaping the real process.
                os.waitid(os.P_PID, group, os.WEXITED | os.WNOWAIT | os.WNOHANG)
                signals.append(sig)
            return actual_killpg(group, sig)

        with mock.patch.object(installer.os, 'killpg', side_effect=observe):
            # Exercise the group-owning implementation in this process so the
            # waitid probe observes every real signal. Caller-death coverage
            # below also executes the public command and its actual supervisor.
            self.assertEqual(installer._command(['/bin/sh', '-c', 'printf exact-output'],
                                                self.root, os.environ, 3), 'exact-output')
        self.assertIn(signal.SIGKILL, signals)

    def test_deadline_releases_descendants_even_after_parent_exits(self):
        # The owned child binds a port and retains stdout after its parent exits.
        # A closed listener proves real cleanup, not merely a timeout exception.
        marker = self.root / 'listener-port'
        script = '''
import os, pathlib, signal, socket, sys
child = os.fork()
if child: raise SystemExit(0)
signal.signal(signal.SIGTERM, signal.SIG_IGN)
server = socket.socket()
server.bind(('127.0.0.1', 0))
server.listen()
pathlib.Path(sys.argv[1]).write_text(str(server.getsockname()[1]))
signal.pause()
'''
        with self.assertRaisesRegex(RuntimeError, 'deadline'):
            installer.command([sys.executable, '-c', script, str(marker)], self.root, os.environ, 1)
        self.assertTrue(marker.exists(), 'fixture never reached its blocked state')
        with socket.socket() as probe:
            probe.settimeout(1)
            self.assertNotEqual(probe.connect_ex(('127.0.0.1', int(marker.read_text()))), 0)

    def test_installer_death_cannot_leave_its_command_running(self):
        self.assert_owner_death_cleanup()

    def test_installer_death_is_observed_after_command_closes_its_output(self):
        self.assert_owner_death_cleanup(close_output=True)

    def test_installer_death_escalates_only_the_command_ignoring_termination(self):
        self.assert_owner_death_cleanup(ignore_term=True)

    def assert_owner_death_cleanup(self, *, close_output=False, ignore_term=False):
        # A real owned command acknowledges admission over an authenticated
        # private socket, then blocks. Kill only the installer we created:
        # EOF must prove descendant cleanup, not a status-file assumption.
        token = os.urandom(16).hex()
        worker = '''
import json, os, signal, socket, sys
if sys.argv[3] == '1':
    os.close(1)
    os.close(2)
if sys.argv[4] == '1':
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
with socket.create_connection(('127.0.0.1', int(sys.argv[1])), timeout=5) as peer:
    peer.settimeout(None)
    peer.sendall((json.dumps({'token': sys.argv[2], 'pid': os.getpid()}) + '\\n').encode())
    peer.recv(1)  # Test-owned release if the cleanup assertion fails.
'''
        runner = '''
import importlib.util, json, os, pathlib, sys
spec = importlib.util.spec_from_file_location('owned_installer', sys.argv[1])
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
installer.command(json.loads(sys.argv[2]), pathlib.Path(sys.argv[3]), os.environ, 30)
'''
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            listener.listen(1)
            listener.settimeout(5)
            argv = [sys.executable, '-c', worker, str(listener.getsockname()[1]), token,
                    str(int(close_output)), str(int(ignore_term))]
            owner = subprocess.Popen([sys.executable, '-B', '-c', runner,
                                      str(Path(SPEC.origin).resolve()), json.dumps(argv), str(self.root)],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            connection = None
            try:
                connection, _ = listener.accept()
                connection.settimeout(5)
                hello = bytearray()
                while not hello.endswith(b'\n'):
                    data = connection.recv(1)
                    self.assertTrue(data, 'Owned command closed before admission')
                    hello.extend(data)
                    self.assertLessEqual(len(hello), 256)
                identity = json.loads(hello)
                self.assertEqual(identity['token'], token)
                self.assertGreater(identity['pid'], 1)
                self.assertIsNone(owner.poll(), 'Installer must still own the admitted command')
                owner.kill()
                self.assertEqual(owner.wait(timeout=3), -signal.SIGKILL)
                self.assertEqual(connection.recv(1), b'',
                                 'Installer death must terminate its blocked command')
            finally:
                if connection is not None:
                    # Never signal a PID advertised by the fixture. Releasing
                    # this exact connection lets an orphan exit on the red run.
                    try:
                        connection.sendall(b'x')
                    except OSError:
                        pass
                    connection.close()
                if owner.poll() is None:
                    owner.terminate()
                try:
                    owner.wait(timeout=5)
                finally:
                    owner.stderr.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
