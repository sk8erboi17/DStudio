"""Upgrade, interruption and recovery of the bundled llama.cpp installation.

Runs the production installer (scripts/install-llama.py) as real child
processes, with outbound network denied by macOS sandbox-exec, in task-owned
profiles under tests/.artifacts/llama-install-recovery/ whose paths contain
spaces. The host binary supplies the real --install-engine command, the real
launch-preparation worker and the real server guard.

SIMULATED: the toolchain. `cmake` is a shell stand-in that emits a stand-in
llama-server reporting the build it was configured with; no compiler runs and
no model exists. The real offline CMake build over an earlier installation is
`make test-llama-upgrade-real` (explicit, minutes of CPU).

  python3 tests/integration/llama_install_recovery_test.py [tests/.build/dstudio-server-test]
"""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tests/support'))
import install_recovery as fx  # noqa: E402

spec = importlib.util.spec_from_file_location('install_llama', ROOT / 'scripts/install-llama.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
PIN, NUMBER = installer.PIN, installer.BUILD_NUMBER
BANNER = f'(build {NUMBER}, commit {PIN[:7]})'
EARLIER_BANNER = f'(build {fx.EARLIER_LLAMA_BUILD}, commit {fx.EARLIER_LLAMA_PIN[:7]})'
OWNED = (installer.DIRECTORY, installer.LOCK)

# The production entry point with this Mac's own cmake locations removed, so
# "CMake is not installed" does not depend on what the test machine has.
NO_CMAKE_DRIVER = '''
import importlib.util, sys
spec = importlib.util.spec_from_file_location('install_llama', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.CMAKE_PATHS = ()
sys.argv = sys.argv[1:]
sys.exit(m.main())
'''


def main():
    if sys.platform != 'darwin':
        print('llama_install_recovery_test: NOT RUN (the static macOS recipe and sandbox-exec are exercised here)')
        return 2
    host = Path(sys.argv[1] if len(sys.argv) > 1 else 'tests/.build/dstudio-server-test').resolve()
    if not host.is_file():
        print(f'llama_install_recovery_test: NOT RUN (host binary missing: {host})')
        return 2
    artifacts = ROOT / 'tests/.artifacts/llama-install-recovery'
    artifacts.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='run-', dir=artifacts))
    cases = fx.Cases('llama_install_recovery_test', run,
                     'production installer, host CLI, launch worker and guard as real processes, network denied; '
                     'SIMULATED cmake and stand-in llama-server, no compiler, no model')
    control = fx.Control(run / 'control')
    cmake = fx.standin_cmake(run / 'toolchain', control)
    support = fx.support_tree(run / 'support tree', PIN)
    earlier_bundle = run / 'earlier bundle'
    fx.source_snapshot(earlier_bundle, fx.EARLIER_LLAMA_PIN)
    script = support / 'scripts/install-llama.py'
    base_env = {k: v for k, v in os.environ.items() if k not in ('DSTUDIO_INSTALL_FAILPOINT', 'DSTUDIO_CMAKE')}
    base_env['DSTUDIO_CMAKE'] = str(cmake)
    counter = [0]
    started = []

    def profile(name, earlier=True):
        root = run / name / 'install root with spaces'
        root.mkdir(parents=True)
        user = fx.Profile(root)
        if earlier:
            # The production installer driven at the earlier pin: how a profile
            # installed by the previous DStudio looks (b11371 build identity).
            receipt = fx.earlier_llama(root, earlier_bundle, base_env)
            assert not installer.receipt_current(root / 'llama.cpp', receipt), 'an earlier pin must not be current'
        return root, user

    def start(root, env=None, which=script, argv=None, revision=PIN):
        counter[0] += 1
        command = argv or fx.offline([sys.executable, str(which), '--root', str(root), '--revision', revision])
        child = fx.Run(command, run / f'installer-{counter[0]:03d}', env={**base_env, **(env or {})})
        started.append(child)
        return child

    def install(root, **options):
        child = start(root, **options)
        code = child.wait()
        out, err = child.text()
        rows = [json.loads(line) for line in out.splitlines() if line.startswith('{')]
        return code, (rows[-1] if rows else None), err

    def target(root):
        return root / installer.DIRECTORY

    def stages(root):
        return sorted(p.name for p in root.iterdir() if p.name.startswith(installer.STAGE_PREFIX))

    def version(root):
        done = subprocess.run([str(target(root) / 'bin/llama-server'), '--version'], capture_output=True, text=True, timeout=20)
        return done.returncode, done.stdout + done.stderr

    def lease_free(root):
        fd = os.open(root / installer.LOCK, os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except BlockingIOError:
            return False
        finally:
            os.close(fd)

    def current(root):
        return installer.receipt_current(target(root), installer.read_receipt(target(root)))

    def assert_earlier(root, user, snapshot):
        assert fx.tree(target(root)) == snapshot, 'the earlier installation changed'
        code, text = version(root)
        assert code == 0 and EARLIER_BANNER in text, text
        assert user.unchanged(), 'user bytes changed'

    def assert_new(root, user):
        receipt = installer.read_receipt(target(root))
        assert current(root), receipt
        assert (receipt['commit'], receipt['buildId']) == (PIN, installer.BUILD_ID)
        code, text = version(root)
        assert code == 0 and BANNER in text, text
        assert stages(root) == [], stages(root)
        assert user.unchanged(), 'user bytes changed'
        assert user.others(OWNED) == [], user.others(OWNED)

    def guard(root, identity, log):
        server = target(root) / 'bin/llama-server'
        read, write = os.pipe()
        child = fx.Run(['/bin/sh', '-c', 'exec "$@" 3<&0 </dev/null', 'sh', host, '--resident-guard', target(root), identity,
                        server, '--model', 'stand-in.gguf'], run / log, stdin=read)
        os.close(read)
        started.append(child)
        return child, write

    # ------------------------------------------------------------------ upgrade
    def upgrade():
        control.reset()
        root, user = profile('upgrade')
        old_identity = fx.launch_identity(target(root) / 'bin/llama-server')
        old_inode = target(root).stat().st_ino
        # The repository's own installer and the real bundled snapshot.
        code, out, err = install(root, which=ROOT / 'scripts/install-llama.py')
        assert code == 0, err[-1500:]
        assert out['built'] and out['replaced'] and not out['reused'], out
        assert out['commit'] == PIN and out['dir'] == str(target(root).resolve())
        receipt = installer.read_receipt(target(root))
        manifest = json.loads((ROOT / 'src/engines/manifest.json').read_text())['engines']['llama']
        assert receipt['bundledSources']['files'] == len(manifest['files']) and receipt['bundledSources']['source'] == 'bundled'
        assert receipt['binarySHA256'] == fx.sha256(target(root) / 'bin/llama-server')
        assert target(root).stat().st_ino != old_inode
        assert_new(root, user)
        # Reported and launched: the real guard starts exactly the published binary.
        child, owner = guard(root, old_identity, 'guard-stale')
        os.close(owner)
        assert child.wait(20) == 126 and 'changed' in child.text()[1], child.text()
        assert not control.path('server.started').exists(), 'the replaced executable identity must never start'
        child, owner = guard(root, fx.launch_identity(target(root) / 'bin/llama-server'), 'guard-new')
        launched = fx.until(lambda: control.path('server.started').exists() and control.path('server.started').read_text(),
                            'the guard did not start the new runtime')
        assert f'build {NUMBER} commit {PIN[:7]}' in launched, launched
        # In use: the installer verifies beside the running server and replaces nothing.
        inode = target(root).stat().st_ino
        code, out, err = install(root)
        assert code == 0 and out['reused'] and not out['built'], (out, err)
        assert target(root).stat().st_ino == inode
        os.close(owner)
        assert child.wait(20) == 0
        return {'receipt': {k: receipt[k] for k in ('commit', 'buildNumber', 'buildId', 'binarySHA256')}, 'launched': launched.strip()}

    def reuse_after_upgrade():
        root, user = profile('reuse', earlier=False)
        code, out, err = install(root)
        assert code == 0 and out['built'] and not out['replaced'], (out, err)
        inode = target(root).stat().st_ino
        code, out, err = install(root)
        assert code == 0 and out['reused'] and not out['built'], (out, err)
        assert target(root).stat().st_ino == inode, 'verification must not publish'
        assert_new(root, user)

    # ------------------------------------------------- upgrade fails at each step
    def failing(name, expect, prepare=None, runner=None, retained=0, revision=PIN):
        def body():
            control.reset()
            root, user = profile('fails ' + name)
            snapshot = fx.tree(target(root))
            options = {}
            if prepare:
                options = prepare(root) or {}
            code, out, err = runner(root) if runner else install(root, which=options.get('which', script), revision=revision)
            assert code == 1 and out is None, (code, out, err)
            assert expect in err, err[-1500:]
            assert_earlier(root, user, snapshot)
            left = stages(root)
            assert len(left) == retained, left
            for stage in left:
                assert sorted(p.name for p in (root / stage).iterdir()) == ['build.log'], 'only the log of a failed build is kept'
            assert user.others(OWNED + tuple(left)) == []
            assert lease_free(root)
            return {'message': err.strip().splitlines()[0][:300]}
        return body

    def altered_bundle(change):
        def prepare(root):
            private = fx.support_tree(root.parent / 'altered support', PIN)
            source = private / 'src/engines/llama.cpp'
            if change == 'truncated':
                (source / 'tools/server/server.cpp').write_text('// fixture')
            elif change == 'altered':
                (source / 'CMakeLists.txt').write_text('project(tampered)\n')
            elif change == 'missing':
                (source / 'LICENSE').unlink()
            elif change == 'extra':
                (source / 'extra.cpp').write_text('// not in the manifest\n')
            return {'which': private / 'scripts/install-llama.py'}
        return prepare

    def without_cmake(root):
        """The installer on a machine with no CMake: nothing configured, an
        empty PATH and no well-known location."""
        empty = root.parent / 'empty bin'
        empty.mkdir(exist_ok=True)
        return install(root, env={'DSTUDIO_CMAKE': '', 'PATH': str(empty)},
                       argv=fx.offline([sys.executable, '-c', NO_CMAKE_DRIVER, str(script), '--root', str(root), '--revision', PIN]))

    def running_engine_is_not_replaced():
        control.reset()
        root, user = profile('fails engine in use')
        snapshot = fx.tree(target(root))
        child, owner = guard(root, fx.launch_identity(target(root) / 'bin/llama-server'), 'guard-earlier')
        launched = fx.until(lambda: control.path('server.started').exists() and control.path('server.started').read_text(),
                            'the guard did not start the earlier runtime')
        server_pid = int(launched.split()[0])
        code, out, err = install(root)
        assert code == 1 and 'The llama.cpp engine is running; stop the model to update it' in err, (code, err)
        assert fx.alive(server_pid), 'the running engine was stopped by an upgrade attempt'
        assert_earlier(root, user, snapshot)
        assert stages(root) == []
        os.close(owner)
        assert child.wait(20) == 0
        code, out, err = install(root)  # the model stopped: the upgrade proceeds
        assert code == 0 and out['built'] and out['replaced'], (out, err)
        assert_new(root, user)

    def failed_builds_are_bounded():
        control.reset()
        root, user = profile('fails bounded')
        snapshot = fx.tree(target(root))
        control.fail('cmake-build')
        for _ in range(2):
            code, out, err = install(root)
            assert code == 1 and 'Build log retained' in err, err[-600:]
        code, out, err = install(root)
        assert code == 1 and 'Two failed llama.cpp builds are retained' in err, err[-600:]
        assert len(stages(root)) == 2
        assert_earlier(root, user, snapshot)
        control.reset()
        code, out, err = install(root)  # a working toolchain alone does not clear retained failures
        assert code == 1 and 'Two failed llama.cpp builds are retained' in err, err[-600:]
        shutil.rmtree(root / stages(root)[0])  # the user inspected and removed one
        code, out, err = install(root)
        assert code == 0 and out['built'], (out, err)
        assert len(stages(root)) == 1 and current(root) and user.unchanged()

    # ----------------------------------------------------------- interruption
    POINTS = [
        # (name, failpoints, stand-in barrier, what the profile holds right after the kill)
        ('copying sources', ('source-copy',), None, 'earlier'),
        ('before the build (cmake --version)', (), 'cmake-version', 'earlier'),
        ('mid-build (truncated link output present)', (), 'cmake-build', 'earlier'),
        ('after the build, before publication (server --version)', (), 'server-version', 'earlier'),
        ('candidate complete, publication not started', ('publish',), None, 'earlier'),
        ('published, stage not yet removed', ('published',), None, 'new'),
    ]

    def interrupted(name, failpoints, barrier, expect, signal_number, alone=False):
        # Every owner signals the installer's whole process group: Stop, the
        # launch worker and a host-death cancellation. `alone` sends SIGTERM to
        # the installer only, which stops its direct command (a real
        # `cmake --build` would leave its make running, so no owner does that).
        def body():
            control.reset()
            root, user = profile(f'{signal.Signals(signal_number).name}{" installer alone" if alone else ""} {name}')
            snapshot = fx.tree(target(root))
            if barrier:
                control.hold(barrier)
            child = start(root, env=control.env(*failpoints))
            control.reached(failpoints[0] if failpoints else barrier, child.process)
            if barrier == 'cmake-build':
                partial = list(root.glob(installer.STAGE_PREFIX + '*/build/bin/llama-server'))
                assert partial and 'truncated' in partial[0].read_text(), 'the barrier must hold a half-built server'
            if signal_number == signal.SIGKILL:
                child.signal_group(signal.SIGKILL)  # the owner's group dies: installer and tools
                code = child.wait(20)
                assert code == -signal.SIGKILL, code
            else:
                if alone:
                    os.kill(child.pid, signal.SIGTERM)
                else:
                    child.signal_group(signal.SIGTERM)  # cancellation, as Stop and the launch worker send it
                code = child.wait(20)
                assert code == 130, (code, child.text())
            fx.until(lambda: not fx.group_members(child.pid), f'processes survive: {fx.group_members(child.pid)}', 10)
            control.reset()
            assert lease_free(root), 'a dead installer still owns the lease'
            assert user.unchanged()
            if expect == 'earlier':
                assert_earlier(root, user, snapshot)
            else:
                assert current(root) and BANNER in version(root)[1], 'a publication must be complete'
            if signal_number == signal.SIGTERM:
                assert stages(root) == [], f'a canceled installation leaves no stage: {stages(root)}'
            code, out, err = install(root)
            assert code == 0, err[-1500:]
            assert out['reused'] if expect == 'new' else (out['built'] and out['replaced']), out
            assert_new(root, user)
            return {'afterInterrupt': expect, 'next': 'reused' if out['reused'] else 'built'}
        return body

    def repeated_owner_death_does_not_block():
        control.reset()
        root, user = profile('SIGKILL repeated')
        snapshot = fx.tree(target(root))
        for _ in range(3):
            control.reset()
            control.hold('cmake-build')
            child = start(root)
            control.reached('cmake-build', child.process)
            child.signal_group(signal.SIGKILL)
            child.wait(20)
            assert_earlier(root, user, snapshot)
        control.reset()
        code, out, err = install(root)
        assert code == 0 and out['built'] and out['replaced'], err[-1500:]
        assert_new(root, user)

    def interrupted_exchange_restores_the_earlier_runtime():
        # The state an installer killed between moving the old installation
        # aside and publishing the new one leaves behind (releases up to this
        # one renamed in two steps). The next run must put the working
        # installation back before anything can fail.
        control.reset()
        root, user = profile('partial previous aside')
        snapshot = fx.tree(target(root))
        stage = root / (installer.STAGE_PREFIX + 'killed01')
        (stage / 'llama.cpp' / 'bin').mkdir(parents=True)
        (stage / 'llama.cpp' / 'bin' / 'llama-server').write_text('half-published candidate\n')
        os.rename(target(root), stage / 'previous')
        code, out, err = without_cmake(root)
        assert code == 1 and 'CMake is required' in err, (code, err[-800:])
        assert_earlier(root, user, snapshot)
        assert stages(root) == [], stages(root)
        code, out, err = install(root)
        assert code == 0 and out['built'] and out['replaced'], err[-1500:]
        assert_new(root, user)

    def parent_only_kill_cannot_publish():
        control.reset()
        root, user = profile('SIGKILL installer only')
        snapshot = fx.tree(target(root))
        control.hold('cmake-build')
        child = start(root)
        tool = int(control.reached('cmake-build', child.process))
        os.kill(child.pid, signal.SIGKILL)  # only the installer; its compiler keeps running
        child.wait(20)
        assert fx.alive(tool), 'the stand-in compiler should still be parked'
        assert_earlier(root, user, snapshot)
        control.release('cmake-build')  # the orphan finishes its build in the abandoned stage
        fx.until(lambda: not fx.alive(tool), 'the orphaned compiler did not finish')
        assert_earlier(root, user, snapshot)  # nobody is left to publish it
        control.reset()
        code, out, err = install(root)
        assert code == 0 and out['built'] and out['replaced'], err[-1500:]
        assert_new(root, user)

    # ------------------------------------------------------ corrupt/partial state
    def state(name, mutate, expect=None, recovers=False, keeps=True):
        def body():
            control.reset()
            root, user = profile('state ' + name, earlier=False)
            code, out, err = install(root)
            assert code == 0 and out['built'], err[-800:]
            mutate(root)
            before = fx.tree(target(root)) if target(root).is_dir() and not target(root).is_symlink() else None
            link = os.readlink(target(root)) if target(root).is_symlink() else None
            code, out, err = install(root)
            if recovers:
                assert code == 0 and out['built'] and out['replaced'], (out, err[-800:])
                assert_new(root, user)
            else:
                assert code == 1 and expect in err, (code, err[-800:])
                if keeps and before is not None:
                    assert fx.tree(target(root)) == before, 'a refused installation directory must be preserved'
                if link is not None:
                    assert os.readlink(target(root)) == link
                assert stages(root) == [] and user.unchanged() and lease_free(root)
            return {'message': err.strip().splitlines()[0][:240] if err.strip() else 'rebuilt'}
        return body

    def edit_receipt(**changes):
        def mutate(root):
            path = target(root) / installer.RECEIPT
            receipt = json.loads(path.read_text())
            receipt.update(changes)
            path.write_text(json.dumps(receipt, sort_keys=True) + '\n')
        return mutate

    def replace_with_link(root):
        os.rename(target(root), root / 'elsewhere')
        os.symlink(root / 'elsewhere', target(root))

    def stale_lease_from_a_dead_owner():
        control.reset()
        root, user = profile('state stale lease', earlier=False)
        holder = subprocess.Popen([sys.executable, '-c', f'''import fcntl, os, sys, time
fd = os.open({str(root / installer.LOCK)!r}, os.O_RDWR | os.O_CREAT, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX); os.write(fd, b"owner %d\\n" % os.getpid()); print("held", flush=True); time.sleep(60)'''],
                                  stdout=subprocess.PIPE, text=True)
        try:
            assert holder.stdout.readline().strip() == 'held'
            code, out, err = install(root)
            assert code == 1 and 'being installed; retry when the installation finishes' in err, err[-600:]
            assert not target(root).exists() and stages(root) == []
        finally:
            holder.kill()
            holder.wait()
            holder.stdout.close()
        assert (root / installer.LOCK).read_text().startswith('owner '), 'the dead owner left its lease file behind'
        code, out, err = install(root)
        assert code == 0 and out['built'], err[-800:]
        assert_new(root, user)

    # -------------------------------------------------------------- concurrency
    def two_installers_one_publication():
        control.reset()
        root, user = profile('concurrent same root', earlier=False)
        control.hold('cmake-build')
        leader = start(root)
        control.reached('cmake-build', leader.process)
        code, out, err = install(root)  # the second installer is refused at once, it does not wait
        assert code == 1 and 'The llama.cpp engine is being installed; retry when the installation finishes' in err, err[-600:]
        assert len(stages(root)) == 1 and not target(root).exists(), 'the refused installer must not stage or publish'
        control.release('cmake-build')
        assert leader.wait() == 0, leader.text()[1][-800:]
        first = json.loads([line for line in leader.text()[0].splitlines() if line.startswith('{')][-1])
        assert first['built'] and not first['replaced']
        inode = target(root).stat().st_ino
        code, out, err = install(root)
        assert code == 0 and out['reused'] and not out['built'], (out, err)
        assert target(root).stat().st_ino == inode, 'exactly one publication'
        assert_new(root, user)

    def independent_roots_overlap():
        control.reset()
        first, user_first = profile('concurrent root one', earlier=False)
        second, user_second = profile('concurrent root two', earlier=False)
        control.hold('cmake-build')
        blocked = start(first)
        control.reached('cmake-build', blocked.process)
        other_control = fx.Control(run / 'control two')
        other_cmake = fx.standin_cmake(run / 'toolchain two', other_control)
        code, out, err = install(second, env={'DSTUDIO_CMAKE': str(other_cmake)})
        assert code == 0 and out['built'], err[-800:]  # completed while the first is still parked
        assert blocked.process.poll() is None and not target(first).exists()
        control.release('cmake-build')
        assert blocked.wait() == 0
        assert current(first) and current(second) and user_first.unchanged() and user_second.unchanged()

    def revalidated(name, change, expect):
        def body():
            control.reset()
            root, user = profile('revalidate ' + name)
            control.hold('cmake-build')
            child = start(root)
            control.reached('cmake-build', child.process)
            kept = change(root)
            control.release('cmake-build')
            code = child.wait()
            err = child.text()[1]
            assert code == 1 and expect in err, (code, err[-800:])
            code, text = version(root) if kept is None else (0, EARLIER_BANNER)
            assert code == 0 and EARLIER_BANNER in text, 'the candidate must not have been published'
            if kept is not None:
                assert fx.tree(target(root)) == kept, 'the directory that appeared during the build was replaced'
            assert user.unchanged()
            return {'message': err.strip().splitlines()[0][:240]}
        return body

    def replace_lease(root):
        os.unlink(root / installer.LOCK)
        (root / installer.LOCK).write_text('another owner\n')
        os.chmod(root / installer.LOCK, 0o600)

    def replace_target(root):
        os.rename(target(root), root / 'moved by the user')
        (target(root) / 'bin').mkdir(parents=True)
        (target(root) / 'bin' / 'llama-server').write_text('placed during the build\n')
        shutil.copy2(root / 'moved by the user' / installer.RECEIPT, target(root) / installer.RECEIPT)
        return fx.tree(target(root))

    # ------------------------------------------- the host's own entry points
    def host_env(extra=None):
        return {**base_env, 'DS4UI_NO_WINDOW': '1', **(extra or {})}

    def host_install(root, extra=None, path=None):
        env = host_env(extra)
        if path is not None:
            env['PATH'] = path
        counter[0] += 1
        child = fx.Run(fx.offline([host, '--install-engine', 'llama', root]), run / f'host-{counter[0]:03d}', env=env, cwd=support)
        started.append(child)
        return child

    def host_cli_installs_reuses_and_upgrades():
        control.reset()
        root, user = profile('host cli')
        child = host_install(root)
        code = child.wait()
        out, err = child.text()
        assert code == 0, err[-1200:]
        assert f'install-engine: OK engine=llama bundled=1 sourcesInstalled=1 path={target(root)}' in out, out[-600:]
        assert_new(root, user)
        child = host_install(root)
        assert child.wait() == 0
        assert 'sourcesInstalled=0' in child.text()[0], 'a verified installation is reused, not reinstalled'
        assert_new(root, user)

    def host_cli_reports_a_missing_python():
        control.reset()
        root, user = profile('host cli no python')
        snapshot = fx.tree(target(root))
        empty = root.parent / 'empty bin'
        empty.mkdir()
        child = fx.Run([host, '--install-engine', 'llama', root], run / 'host-no-python',
                       env={**host_env(), 'PATH': str(empty)}, cwd=support)
        started.append(child)
        code = child.wait()
        out, err = child.text()
        assert code == 1, (code, out, err)
        assert 'install-engine: FAILED' in err and 'Python 3' in err, f'the failure must name the missing dependency: {err!r}'
        assert_earlier(root, user, snapshot)
        return {'message': err.strip()[:300]}

    def worker(root, log):
        read, write = os.pipe()
        child = fx.Run(fx.offline([host, '--prepare-launch', 'server', root / 'ds4', support,
                                   'gguf/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf', '', '', 'local', '7', 'none', '0', 'native']),
                       run / log, env=host_env(), stdin=read)
        os.close(read)
        started.append(child)
        return child, write

    def worker_result(child):
        def read():
            lines = [line for line in child.text()[0].splitlines() if line.startswith('{"v":1')]
            return json.loads(lines[-1]) if lines else None
        return fx.until(read, 'the launch worker reported nothing', 30)

    def launch_worker_reports_the_upgraded_runtime():
        control.reset()
        root, user = profile('launch worker')
        child, owner = worker(root, 'worker-upgrade')
        try:
            result = worker_result(child)
            assert result['ok'], result
            assert result['identity'] == fx.launch_identity(target(root) / 'bin/llama-server'), result
            assert_new(root, user)
            runner, channel = guard(root, result['identity'], 'guard-worker')
            launched = fx.until(lambda: control.path('server.started').exists() and control.path('server.started').read_text(),
                                'the guard did not start the reported runtime')
            assert f'build {NUMBER} commit {PIN[:7]}' in launched
            os.close(channel)
            assert runner.wait(20) == 0
        finally:
            os.close(owner)
            child.kill_group()
        return {'identity': result['identity']}

    def launch_worker_reports_the_reason():
        control.reset()
        root, user = profile('launch worker failure')
        snapshot = fx.tree(target(root))
        control.fail('cmake-build')
        child, owner = worker(root, 'worker-failure')
        try:
            result = worker_result(child)
        finally:
            os.close(owner)
            child.kill_group()
        assert not result['ok'] and not result['identity'], result
        # The launch error holds 255 bytes: it must carry the installer's reason,
        # not the echo of the first command it ran.
        assert result['error'].startswith('llama.cpp installation failed (1): Command failed (2): '), result['error']
        assert '--build' in result['error'] and 'llama install: [' not in result['error'], result['error']
        control.reset()
        assert_earlier(root, user, snapshot)
        return {'reported': result['error']}

    def owner_death(name, close_owner):
        def body():
            control.reset()
            root, user = profile('owner ' + name)
            snapshot = fx.tree(target(root))
            control.hold('cmake-build')
            child, owner = worker(root, 'worker-' + name.replace(' ', '-'))
            tool = int(control.reached('cmake-build', child.process, 30))
            members = fx.group_members(child.pid)
            assert tool in members and len(members) >= 3, f'worker, installer and tool share one group: {members}'
            begun = time.monotonic()
            close_owner(child, owner)
            # Documented bound: SIGTERM to the group at once, SIGKILL five seconds later.
            fx.until(lambda: not fx.alive(tool), 'the build tool outlived its owner', 4)
            fx.until(lambda: not fx.group_members(child.pid), f'the group outlived its owner: {fx.group_members(child.pid)}', 9)
            elapsed = time.monotonic() - begun
            child.wait(5)
            control.reset()
            assert lease_free(root)
            assert stages(root) == [], f'the canceled installation left its stage: {stages(root)}'
            assert_earlier(root, user, snapshot)
            again, owner = worker(root, 'worker-again-' + name.replace(' ', '-'))
            try:
                result = worker_result(again)
                assert result['ok'] and result['identity'] == fx.launch_identity(target(root) / 'bin/llama-server'), result
            finally:
                os.close(owner)
                again.kill_group()
            assert_new(root, user)
            return {'groupGoneAfterSeconds': round(elapsed, 2)}
        return body

    def host_dies(child, owner):
        # The host process is gone without closing anything itself: the kernel
        # closes its end of the channel, which is also what a cancellation
        # does on purpose. A stand-in owner process holds the channel here.
        holder = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], pass_fds=(owner,))
        os.close(owner)
        holder.kill()
        holder.wait()

    try:
        cases.check('upgrade from the b11371 installation: the new runtime is reported, launched and the only one current', upgrade)
        cases.check('a fresh installation is reused without a second publication', reuse_after_upgrade)
        cases.check('upgrade fails, earlier runtime kept: CMake is not installed',
                    failing('no cmake', 'CMake is required to build the llama.cpp engine and was not found', runner=without_cmake))
        for change, message in (('truncated', 'Bundled engine source digest differs; no candidate published'),
                                ('altered', 'Bundled source is linked, nonregular or oversized'),
                                ('missing', 'Bundled engine sources are missing or contain unrecorded files'),
                                ('extra', 'Bundled engine sources are missing or contain unrecorded files')):
            cases.check(f'upgrade fails, earlier runtime kept: bundled source {change} (no remote fallback)',
                        failing('bundle ' + change, message, prepare=altered_bundle(change)))
        cases.check('upgrade fails, earlier runtime kept: configure fails',
                    failing('configure', 'stand-in configure failure',
                            prepare=lambda root: control.fail('cmake-configure'), retained=1))
        cases.check('upgrade fails, earlier runtime kept: the build fails with a truncated server in its tree',
                    failing('build', 'stand-in compiler: error: build failure',
                            prepare=lambda root: control.fail('cmake-build'), retained=1))
        cases.check('upgrade fails, earlier runtime kept: the build produces no server',
                    failing('no server', 'The build did not produce llama-server',
                            prepare=lambda root: control.touch('cmake-build.noserver'), retained=1))
        cases.check('upgrade fails, earlier runtime kept: the built server reports another build',
                    failing('wrong build', 'The built llama-server does not report the pinned build',
                            prepare=lambda root: control.touch('cmake-build.wrongbuild'), retained=1))
        cases.check('upgrade fails, earlier runtime kept: another revision than the bundled pin is requested',
                    failing('other revision', 'The requested llama.cpp revision is not the bundled pin',
                            revision=fx.EARLIER_LLAMA_PIN))
        cases.check('a running engine is never replaced; the upgrade proceeds once it stops', running_engine_is_not_replaced)
        cases.check('failed builds keep only their log, at most two, until one is removed', failed_builds_are_bounded)
        for name, failpoints, barrier, expect in POINTS:
            cases.check(f'owner death (SIGKILL) {name}: nothing half-published, the next run completes',
                        interrupted(name, failpoints, barrier, expect, signal.SIGKILL))
        for name, failpoints, barrier, expect in POINTS:
            cases.check(f'cancellation (SIGTERM to the installer group) {name}: stage removed, the next run completes',
                        interrupted(name, failpoints, barrier, expect, signal.SIGTERM))
        cases.check('SIGTERM to the installer alone while cmake runs: the command stops, stage removed, the next run completes',
                    interrupted('before the build (cmake --version)', (), 'cmake-version', 'earlier', signal.SIGTERM, alone=True))
        cases.check('three interrupted builds do not block the fourth', repeated_owner_death_does_not_block)
        cases.check('an installation moved aside by a killed installer is put back before anything can fail',
                    interrupted_exchange_restores_the_earlier_runtime)
        cases.check('a compiler orphaned by a killed installer cannot publish', parent_only_kill_cannot_publish)
        cases.check('state: a tampered server is rebuilt',
                    state('tampered', lambda root: (target(root) / 'bin/llama-server').write_text('#!/bin/sh\nexit 1\n'), recovers=True))
        cases.check('state: a receipt with a missing binary is rebuilt',
                    state('missing binary', lambda root: (target(root) / 'bin/llama-server').unlink(), recovers=True))
        cases.check('state: a receipt naming another pin is rebuilt to the bundled pin',
                    state('other pin', edit_receipt(commit='0' * 40), recovers=True))
        cases.check('state: a receipt naming another engine is preserved and refused',
                    state('other engine', edit_receipt(engine='mlx'), 'contains files DStudio did not install; it is preserved'))
        cases.check('state: a receipt of another format is preserved and refused',
                    state('other schema', edit_receipt(schema='dstudio.mlx-install.v1'),
                          'contains files DStudio did not install; it is preserved'))
        cases.check('state: a truncated receipt is preserved and refused',
                    state('truncated receipt', lambda root: (target(root) / installer.RECEIPT).write_text('{"schema": "dstudio.llama-'),
                          'contains files DStudio did not install; it is preserved'))
        cases.check('state: a linked installation directory is preserved and refused',
                    state('linked', replace_with_link, 'is not a directory DStudio installed; it is preserved'))
        cases.check('state: the lease of a dead owner does not block the next installation', stale_lease_from_a_dead_owner)
        cases.check('two installers, one root: one leader publishes once, the other is refused at once', two_installers_one_publication)
        cases.check('installations in different roots overlap', independent_roots_overlap)
        cases.check('a lease replaced during the build cannot publish',
                    revalidated('lease', replace_lease, 'installation lease changed; no candidate published'))
        cases.check('an installation directory replaced during the build is preserved',
                    revalidated('target', replace_target, 'changed during the installation; it is preserved'))
        cases.check('host --install-engine llama: installs over the earlier runtime, then reuses', host_cli_installs_reuses_and_upgrades)
        cases.check('host --install-engine llama: a missing python3 is named', host_cli_reports_a_missing_python)
        cases.check('launch worker: the identity it reports is the upgraded binary the guard starts',
                    launch_worker_reports_the_upgraded_runtime)
        cases.check('launch worker: a failed build is reported with its reason', launch_worker_reports_the_reason)
        cases.check('host killed mid-build: tools stop within the bound, stage removed, earlier runtime kept, relaunch completes',
                    owner_death('host death', host_dies))
    finally:
        for child in started:
            child.kill_group()
    return cases.finish()


if __name__ == '__main__':
    sys.exit(main())
