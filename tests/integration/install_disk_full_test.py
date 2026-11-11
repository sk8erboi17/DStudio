"""Engine installation when the disk fills up: the failure is reported, nothing
half-installed is published or left holding the space, and a later retry
completes.

Real: the production source installer (scripts/bundled_engine_sources.py) on
the real bundled main snapshot, the host's --install-engine llama with the
production scripts/install-llama.py, and real "No space left on device" errors
from small task-owned HFS+ volumes (hdiutil) that this test creates and
removes. Outbound network is denied by macOS sandbox-exec.
SIMULATED: the llama.cpp snapshot is a small verified fixture with one 40 MiB
file; cmake is the stand-in of tests/support/install_recovery.py (nothing is
compiled) and its large object file stands in for a compiler filling the
disk. No model.

  python3 tests/integration/install_disk_full_test.py [tests/.build/dstudio-server-test]
"""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tests/support'))
import install_recovery as fx  # noqa: E402

MiB = 1 << 20
MANIFEST = json.loads((ROOT / 'src/engines/manifest.json').read_text())['engines']


class Volume:
    """A small HFS+ disk image mounted inside the run directory."""
    def __init__(self, run, megabytes, name):
        self.image, self.mount = run / f'{name}.dmg', run / name
        self.mount.mkdir()
        subprocess.run(['hdiutil', 'create', '-quiet', '-size', f'{megabytes}m', '-fs', 'HFS+', '-volname', name,
                        '-layout', 'NONE', str(self.image)], check=True, capture_output=True)
        subprocess.run(['hdiutil', 'attach', '-nobrowse', '-noautoopen', '-mountpoint', str(self.mount), str(self.image)],
                       check=True, capture_output=True)
        self.attached = True

    def free(self):
        info = os.statvfs(self.mount)
        return info.f_bavail * info.f_frsize

    def fill(self, leave):
        """Write one filler file so that about `leave` bytes stay free."""
        filler = self.mount / 'filler.bin'
        size, block = max(0, self.free() - leave), b'\x5a' * MiB
        with open(filler, 'wb') as output:
            while size > 0:
                size -= output.write(block[:min(size, len(block))])
            output.flush()
            os.fsync(output.fileno())
        return filler

    def detach(self):
        if not self.attached:
            return
        done = subprocess.run(['hdiutil', 'detach', '-quiet', str(self.mount)], capture_output=True)
        if done.returncode:
            done = subprocess.run(['hdiutil', 'detach', '-quiet', '-force', str(self.mount)], capture_output=True)
        self.attached = done.returncode != 0
        if not self.attached:
            self.image.unlink(missing_ok=True)


def lease_free(path):
    fd = os.open(path, os.O_RDWR)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except BlockingIOError:
        return False
    finally:
        os.close(fd)


def main():
    if sys.platform != 'darwin':
        print('install_disk_full_test: NOT RUN (uses macOS hdiutil and sandbox-exec)')
        return 2
    host = Path(sys.argv[1] if len(sys.argv) > 1 else 'tests/.build/dstudio-server-test').resolve()
    artifacts = ROOT / 'tests/.artifacts/install-disk-full'
    artifacts.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='run-', dir=artifacts))
    cases = fx.Cases('install_disk_full_test', run,
                     'production source installer on the real main snapshot, host --install-engine llama and install-llama.py, '
                     'real ENOSPC on task-owned HFS+ volumes, network denied; SIMULATED llama.cpp fixture snapshot and cmake, '
                     'nothing compiled, no model')
    control = fx.Control(run / 'control')
    cmake = fx.standin_cmake(run / 'toolchain', control)
    # The support tree the app materializes: the production installer scripts
    # beside a llama.cpp-shaped snapshot with a verified manifest. One 40 MiB
    # source file makes the copy large enough to fill the volume (copying the
    # real 3859-file snapshot onto disk images took minutes per attempt).
    support = fx.support_tree(run / 'support tree', MANIFEST['llama']['commit'])
    fx.source_snapshot(support, MANIFEST['llama']['commit'], files={
        'CMakeLists.txt': 'project(standin)\n', 'LICENSE': 'MIT (fixture)\n',
        'tools/server/server.cpp': '// fixture source, never compiled\n',
        'ggml/src/large-fixture.c': '// fixture source, never compiled\n' * (40 * MiB // 34)})
    spec = importlib.util.spec_from_file_location('install_llama', support / 'scripts/install-llama.py')
    installer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(installer)
    base_env = {k: v for k, v in os.environ.items() if k not in ('DSTUDIO_INSTALL_FAILPOINT', 'DSTUDIO_CMAKE')}
    volumes, started, counter = [], [], [0]

    def volume(megabytes, name):
        made = Volume(run, megabytes, name)
        volumes.append(made)
        return made

    def main_installer(target):
        counter[0] += 1
        child = fx.Run(fx.offline([sys.executable, ROOT / 'scripts/bundled_engine_sources.py', '--engine', 'main',
                                   '--revision', MANIFEST['main']['commit'], '--target', target]),
                       run / f'main-installer-{counter[0]:03d}', env=base_env)
        started.append(child)
        return (child.wait(), *child.text())

    def host_llama(root):
        counter[0] += 1
        child = fx.Run(fx.offline([host, '--install-engine', 'llama', root]), run / f'host-llama-{counter[0]:03d}',
                       env={**base_env, 'DSTUDIO_CMAKE': str(cmake), 'DS4UI_NO_WINDOW': '1'}, cwd=support)
        started.append(child)
        return (child.wait(), *child.text())

    def llama_stages(root):
        return sorted(p for p in root.iterdir() if p.name.startswith(installer.STAGE_PREFIX))

    def llama_installed(root, user):
        target = root / installer.DIRECTORY
        receipt = installer.read_receipt(target)
        assert installer.receipt_current(target, receipt), receipt
        version = subprocess.run([str(target / 'bin/llama-server'), '--version'], capture_output=True, text=True, timeout=20)
        assert f"build {installer.BUILD_NUMBER}, commit {installer.PIN[:7]}" in version.stdout, version.stdout
        assert user.unchanged(), 'user bytes changed'

    def main_sources_disk_full():
        disk = volume(40, 'DStudioMainSources')
        root = disk.mount / 'install root with spaces'
        root.mkdir()
        (root / 'user notes.txt').write_text('kept\n')
        target = root / 'ds4'
        filler = disk.fill(8 * MiB)
        code, out, err = main_installer(target)
        assert code == 1, (code, err[-600:])
        assert 'Bundled engine installation failed: [Errno 28] No space left on device' in err, err[-600:]
        assert not target.exists(), 'a partial source copy was published'
        assert lease_free(root / '.dstudio-ds4-sources.lock'), 'the failed installer still owns the lease'
        failed = sorted(p.name for p in root.iterdir() if p.name.startswith('.dstudio-ds4-source-'))
        assert len(failed) == 1, failed  # interrupted candidates are retained for review, as documented
        filler.unlink()
        code, out, err = main_installer(target)
        assert code == 0, err[-800:]
        receipt = json.loads((target / '.dstudio-source.json').read_text())
        assert (receipt['engine'], receipt['commit'], receipt['source']) == ('main', MANIFEST['main']['commit'], 'bundled')
        present = fx.tree(target)
        files = {name for name, row in present.items() if row[0] == 'file'} - {'.dstudio-source.json'}
        assert files == set(MANIFEST['main']['files']), 'the published tree is exactly the manifest'
        assert all(present[name][3] == meta['sha256'] for name, meta in MANIFEST['main']['files'].items())
        assert (root / 'user notes.txt').read_text() == 'kept\n'
        return {'message': err.strip().splitlines()[-1][:200] if err.strip() else '', 'retainedFailedCandidates': failed}

    def llama_copy_disk_full():
        disk = volume(96, 'DStudioLlamaCopy')
        root = disk.mount / 'install root with spaces'
        root.mkdir()
        user = fx.Profile(root)
        filler = disk.fill(24 * MiB)  # the snapshot is 40 MiB
        code, out, err = host_llama(root)
        assert code == 1, (code, out[-400:], err[-600:])
        assert 'install-engine: FAILED: llama.cpp installation failed (1): [Errno 28] No space left on device' in err, err[-600:]
        assert not (root / installer.DIRECTORY).exists(), 'nothing is published'
        assert llama_stages(root) == [], 'the partial source copy is removed, not left filling the disk'
        assert lease_free(root / installer.LOCK)
        assert user.unchanged()
        message = err.strip().splitlines()[-1]
        filler.unlink()
        code, out, err = host_llama(root)
        assert code == 0, err[-1200:]
        assert 'install-engine: OK engine=llama bundled=1 sourcesInstalled=1' in out, out[-600:]
        llama_installed(root, user)
        assert llama_stages(root) == []
        return {'message': message[:300]}

    def llama_build_disk_full():
        control.reset()
        disk = volume(96, 'DStudioLlamaBuild')
        root = disk.mount / 'install root with spaces'
        root.mkdir()
        user = fx.Profile(root)
        disk.fill(56 * MiB)  # room for the sources, not for the (stand-in) build output
        free_before = disk.free()
        control.touch('cmake-build.bytes', str(512 * MiB))
        code, out, err = host_llama(root)
        assert code == 1, (code, out[-400:], err[-600:])
        # The full disk also stops the installer's own log writes: the reason
        # comes from that error, and the log is kept for review.
        assert 'install-engine: FAILED: llama.cpp installation failed (1): [Errno 28] No space left on device' in err, err[-800:]
        assert 'Build log retained' in err, err[-800:]
        message = err.strip().splitlines()[0]
        assert not (root / installer.DIRECTORY).exists(), 'nothing is published'
        stages = llama_stages(root)
        assert len(stages) == 1 and sorted(p.name for p in stages[0].iterdir()) == ['build.log'], \
            'a failed build keeps only its log: no sources or objects left filling the disk'
        log = (stages[0] / 'build.log').read_text(errors='replace')
        freed = disk.free()
        assert free_before - freed < 2 * MiB, f'{free_before - freed} bytes are still taken after the failure'
        assert lease_free(root / installer.LOCK)
        assert user.unchanged()
        control.path('cmake-build.bytes').unlink()  # the space the build needs is available again
        code, out, err = host_llama(root)
        assert code == 0, err[-1200:]
        llama_installed(root, user)
        assert len(llama_stages(root)) == 1, 'the one failed build log stays for review'
        return {'message': message[:300], 'buildLogTail': (log.strip().splitlines() or [''])[-1][:200],
                'heldAfterFailure': free_before - freed}

    try:
        cases.check('main sources: the disk fills while copying; reported, nothing published, a retry after freeing space installs',
                    main_sources_disk_full)
        cases.check('llama.cpp via the host: the disk fills while copying the bundled sources; reported, stage removed, a retry installs',
                    llama_copy_disk_full)
        cases.check('llama.cpp via the host: the disk fills during the build; reported with its log, space released, a retry installs',
                    llama_build_disk_full)
    finally:
        for child in started:
            child.kill_group()
        for disk in volumes:
            disk.detach()
    return cases.finish()


if __name__ == '__main__':
    sys.exit(main())
