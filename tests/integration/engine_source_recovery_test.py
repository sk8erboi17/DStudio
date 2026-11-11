"""Interruption, concurrency and upgrade of the main and Laguna source
installations, with real processes.

Runs the production source installer (scripts/bundled_engine_sources.py) on
the real bundled snapshots as child processes with outbound network denied by
macOS sandbox-exec, in task-owned roots whose paths contain spaces, and the
host's real --install-engine main command over an installation of the earlier
main pin (0aaea5a) taken from this repository's own history.

Nothing is compiled: `make` is a stand-in that records its call and fails, so
the upgrade case proves the refusal happens before any build. The real builds
are `make test-setup-live` and `make test-first-launch-e2e`.

  python3 tests/integration/engine_source_recovery_test.py [tests/.build/dstudio-server-test]
"""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tests/support'))
import install_recovery as fx  # noqa: E402

spec = importlib.util.spec_from_file_location('sources', ROOT / 'scripts/bundled_engine_sources.py')
sources = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sources)
MANIFEST = json.loads((ROOT / 'src/engines/manifest.json').read_text())['engines']
ENGINES = {'main': 'ds4', 'laguna': 'ds4-laguna-s21'}
# Main moved from 0aaea5a to 890898c on November 3, 2026 (docs/BUNDLED_ENGINES.md).
EARLIER_MAIN_PIN = '0aaea5a238fb41a35106a551e73c8409dfb751ac'
EARLIER_MAIN_TREE = 'fa056a59~1'  # the repository commit before that refresh
MANAGED = ('apply-ds4-visible-downloads.sh', 'apply-ds4-media-memory.sh', 'apply-ds4-server-metrics.sh',
           'apply-ds4-glm53-runtime.sh')


class NotRun(Exception):
    pass


def main():
    if sys.platform != 'darwin':
        print('engine_source_recovery_test: NOT RUN (uses macOS sandbox-exec)')
        return 2
    host = Path(sys.argv[1] if len(sys.argv) > 1 else 'tests/.build/dstudio-server-test').resolve()
    artifacts = ROOT / 'tests/.artifacts/engine-source-recovery'
    artifacts.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='run-', dir=artifacts))
    cases = fx.Cases('engine_source_recovery_test', run,
                     'production source installer and host CLI as real processes on the real bundled main/Laguna '
                     'snapshots, network denied; SIMULATED make, nothing compiled, no model')
    control = fx.Control(run / 'control')
    base_env = {k: v for k, v in os.environ.items() if k != 'DSTUDIO_INSTALL_FAILPOINT'}
    started = []
    counter = [0]

    def start(engine, target, env=None):
        counter[0] += 1
        child = fx.Run(fx.offline([sys.executable, ROOT / 'scripts/bundled_engine_sources.py', '--engine', engine,
                                   '--revision', MANIFEST[engine]['commit'], '--target', target]),
                       run / f'installer-{counter[0]:03d}', env={**base_env, **(env or {})})
        started.append(child)
        return child

    def install(engine, target):
        child = start(engine, target)
        code = child.wait()
        return code, *child.text()

    def candidates(target):
        return sorted(p.name for p in target.parent.iterdir() if p.name.startswith(f'.dstudio-{target.name}-source-'))

    def lease_free(target):
        fd = os.open(target.parent / f'.dstudio-{target.name}-sources.lock', os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except BlockingIOError:
            return False
        finally:
            os.close(fd)

    def assert_installed(engine, target):
        receipt = json.loads((target / '.dstudio-source.json').read_text())
        entry = MANIFEST[engine]
        assert receipt['commit'] == entry['commit'] and receipt['engine'] == engine and receipt['source'] == 'bundled', receipt
        present = fx.tree(target)
        files = {name for name, row in present.items() if row[0] == 'file'} - {'.dstudio-source.json'}
        assert files == set(entry['files']), 'the published tree is exactly the manifest'
        assert all(present[name][3] == meta['sha256'] for name, meta in entry['files'].items()), 'published bytes differ'

    def interrupted(engine, point, signal_number):
        def body():
            control.reset()
            root = run / f'{engine} {signal.Signals(signal_number).name} {point}' / 'install root with spaces'
            root.mkdir(parents=True)
            (root / 'user notes.txt').write_text('kept\n')
            target = root / ENGINES[engine]
            child = start(engine, target, env=control.env(point))
            control.reached(point, child.process)
            if point == 'source-copy':
                partial = list(root.glob(f'.dstudio-{target.name}-source-*/source'))
                copied = sum(1 for _ in partial[0].rglob('*') if _.is_file())
                assert 0 < copied < len(MANIFEST[engine]['files']), f'the barrier must hold a partial copy: {copied}'
            child.signal_group(signal_number)
            assert child.wait(20) == -signal_number
            assert not target.exists(), 'an interrupted source installation published something'
            assert lease_free(target), 'a dead installer still owns the lease'
            assert len(candidates(target)) == 1, 'the interrupted candidate is retained for review, as documented'
            assert (root / 'user notes.txt').read_text() == 'kept\n'
            code, out, err = install(engine, target)
            assert code == 0, err[-800:]
            assert_installed(engine, target)
            assert len(candidates(target)) == 1, 'the next installation removes only its own stage'
            return {'retainedCandidates': 1}
        return body

    def retained_candidates_are_bounded(engine):
        def body():
            control.reset()
            root = run / f'{engine} bounded' / 'install root with spaces'
            root.mkdir(parents=True)
            target = root / ENGINES[engine]
            for _ in range(2):
                control.reset()
                child = start(engine, target, env=control.env('source-publish'))
                control.reached('source-publish', child.process)
                child.signal_group(signal.SIGKILL)
                child.wait(20)
            code, out, err = install(engine, target)
            assert code == 1 and 'Two prior source preparations retained; inspect them before retrying' in err, err[-600:]
            assert not target.exists() and len(candidates(target)) == 2
            for name in candidates(target):  # the user inspected and removed them
                subprocess.run(['/bin/rm', '-rf', str(root / name)], check=True)
            code, out, err = install(engine, target)
            assert code == 0, err[-800:]
            assert_installed(engine, target)
        return body

    def two_installers(engine):
        def body():
            control.reset()
            root = run / f'{engine} concurrent' / 'install root with spaces'
            root.mkdir(parents=True)
            target = root / ENGINES[engine]
            leader = start(engine, target, env=control.env('source-publish'))
            control.reached('source-publish', leader.process)
            code, out, err = install(engine, target)
            assert code == 1 and 'Bundled engine installation failed' in err, (code, err[-400:])
            assert not target.exists() and len(candidates(target)) == 1, 'the refused installer staged or published'
            control.release('source-publish')
            assert leader.wait() == 0, leader.text()[1][-600:]
            assert_installed(engine, target)
            inode = target.stat().st_ino
            code, out, err = install(engine, target)  # an installed checkout is local data: never replaced
            assert code == 1 and 'Target contains local data; refusing to replace it' in err, err[-400:]
            assert target.stat().st_ino == inode and candidates(target) == []
            return {'refused': err.strip().splitlines()[0][:200]}
        return body

    archive = run / 'earlier-main.tar'

    def earlier_main_history():
        done = subprocess.run(['git', '-C', str(ROOT), 'archive', '-o', str(archive), EARLIER_MAIN_TREE,
                               'src/engines/ds4', 'src/engines/manifest.json'], capture_output=True, text=True)
        if done.returncode:
            raise NotRun(f'the earlier main snapshot is not in this checkout\'s history ({done.stderr.strip()[:120]})')

    def earlier_main_is_refused_before_any_build():
        bundle = run / 'earlier main bundle'
        bundle.mkdir()
        with tarfile.open(archive) as tar:
            tar.extractall(bundle, filter='data')
        root = run / 'main upgrade' / 'install root with spaces'
        root.mkdir(parents=True)
        target = root / 'ds4'
        # The production installer on the earlier bundle: digests verified against
        # the manifest of that release, receipt written as that release wrote it.
        sources.install(bundle, 'main', EARLIER_MAIN_PIN, target)
        assert json.loads((target / '.dstudio-source.json').read_text())['commit'] == EARLIER_MAIN_PIN
        (target / 'gguf').mkdir()
        (target / 'gguf' / 'DeepSeek stand-in.gguf').write_text('stand-in bytes, not weights\n')
        (target / 'mlx').mkdir()
        (target / 'mlx' / 'config.json').write_text('{}\n')
        (target / 'ds4-server').write_text('#!/bin/sh\necho "earlier server stand-in"\n')
        (target / 'ds4-server').chmod(0o755)
        (root / 'ds4web-store.json').write_text('{"conversations": 3}\n')
        before = fx.tree(root)
        tools = run / 'tools'
        tools.mkdir()
        (tools / 'make').write_text(f'#!/bin/sh\necho "$@" >> {fx.quote(str(run / "make.calls"))}\n'
                                    'echo "stand-in make: nothing is compiled in this test" >&2\nexit 1\n')
        (tools / 'make').chmod(0o755)
        child = fx.Run(fx.offline([host, '--install-engine', 'main', root]), run / 'host-main-upgrade',
                       env={**base_env, 'PATH': f'{tools}:{base_env["PATH"]}', 'DS4UI_NO_WINDOW': '1'}, cwd=ROOT)
        started.append(child)
        code = child.wait()
        out, err = child.text()
        assert code == 1 and 'install-engine: FAILED: main runtime patches failed' in err, (code, err[-600:])
        assert 'source drift or partial patch; no files changed' in out + err, (out + err)[-800:]
        assert not (run / 'make.calls').exists(), 'the refusal must come before any build'
        after = fx.tree(root)
        changed = sorted(name for name in before if before[name] != after.get(name))
        assert sorted(set(after) - set(before)) == [] and sorted(set(before) - set(after)) == [], 'files appeared or vanished'
        user = [name for name in changed if not name.startswith('ds4/') or name.startswith(('ds4/gguf', 'ds4/mlx'))
                or name in ('ds4/ds4-server', 'ds4/.dstudio-source.json')]
        assert user == [], f'user data, models, the receipt or the built server changed: {user}'
        # Retained observation (November 11, 2026), not a requirement: four
        # managed adaptations were applied before the fifth refused the earlier
        # sources, so the refused checkout is left partially adapted (an open
        # defect, PLAN.MD P5). They are DStudio's reversible patches; restoring
        # them must return the earlier checkout byte for byte.
        for script in reversed(MANAGED):
            restored = subprocess.run(['/bin/sh', str(ROOT / 'scripts' / script), 'restore'], capture_output=True, text=True,
                                      env={**base_env, 'DS4_DIR': str(target)})
            assert restored.returncode == 0, restored.stdout + restored.stderr
        assert fx.tree(root) == before, 'restoring the managed adaptations did not return the earlier checkout exactly'
        return {'sourcesLeftPatchedUntilRestored': changed}

    earlier_main_is_refused_before_any_build.requires = earlier_main_history
    not_run = []

    def check(name, body):
        # A case that cannot run here is reported as NOT RUN and is not a pass.
        try:
            probe = getattr(body, 'requires', None)
            if probe:
                probe()
        except NotRun as reason:
            not_run.append(f'{name}: {reason}')
            return False
        return cases.check(name, body)

    try:
        for engine in ENGINES:
            check(f'{engine}: killed while copying sources: nothing published, the next run completes',
                  interrupted(engine, 'source-copy', signal.SIGKILL))
            check(f'{engine}: terminated with the candidate complete: nothing published, the next run completes',
                  interrupted(engine, 'source-publish', signal.SIGTERM))
            check(f'{engine}: two interrupted candidates are retained and a third attempt waits for the user',
                  retained_candidates_are_bounded(engine))
            check(f'{engine}: two installers, one target: one leader publishes once, the other is refused',
                  two_installers(engine))
        if host.is_file():
            check('main: an installation of the earlier pin is refused as drift before any build; user bytes kept',
                  earlier_main_is_refused_before_any_build)
        else:
            not_run.append(f'main upgrade: host binary missing ({host})')
    finally:
        for child in started:
            child.kill_group()
    for line in not_run:
        print('NOT RUN ' + line)
    if not_run:
        cases.scope += f'; {len(not_run)} case(s) NOT RUN'
    return cases.finish()


if __name__ == '__main__':
    sys.exit(main())
