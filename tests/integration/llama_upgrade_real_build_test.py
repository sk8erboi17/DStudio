"""Real offline upgrade of the bundled llama.cpp over an earlier installation.

Explicit and CPU-heavy (a few minutes): the production installer copies the
real bundled snapshot and builds llama-server with the real CMake and compiler,
with outbound network denied by macOS sandbox-exec, in a task-owned profile
whose path contains spaces. The profile first holds the b11371 installation as
the previous DStudio left it (its receipt identity; that earlier runtime itself
is the stand-in the model-free tests use, since b11371 sources no longer ship).

The first upgrade attempt is killed while the compiler is running (the owner's
whole process group, as a dying host does); the second attempt must complete.
No model is loaded and the server is asked only for --version.

  python3 tests/integration/llama_upgrade_real_build_test.py
"""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
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
OBJECTS_BEFORE_KILL = 25  # compiled objects that prove the real build is under way


def main():
    if sys.platform != 'darwin':
        print('llama_upgrade_real_build_test: NOT RUN (builds the macOS Metal recipe)')
        return 2
    try:
        cmake = installer.find_cmake()
    except RuntimeError as error:
        print(f'llama_upgrade_real_build_test: NOT RUN ({str(error).splitlines()[0]})')
        return 2
    artifacts = ROOT / 'tests/.artifacts/llama-upgrade-real'
    artifacts.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='run-', dir=artifacts))
    cases = fx.Cases('llama_upgrade_real_build_test', run,
                     'REAL offline CMake build of the bundled llama.cpp over an earlier installation, network denied; '
                     'the earlier b11371 runtime is a stand-in with the real receipt identity; no model, --version only')
    root = run / 'install root with spaces'
    root.mkdir()
    user = fx.Profile(root)
    target = root / installer.DIRECTORY
    control = fx.Control(run / 'control')
    standin = fx.standin_cmake(run / 'toolchain', control)
    fx.source_snapshot(run / 'earlier bundle', fx.EARLIER_LLAMA_PIN)
    env = {k: v for k, v in os.environ.items() if k not in ('DSTUDIO_INSTALL_FAILPOINT', 'DSTUDIO_CMAKE')}
    fx.earlier_llama(root, run / 'earlier bundle', {**env, 'DSTUDIO_CMAKE': str(standin)})
    earlier = fx.tree(target)
    command = fx.offline([sys.executable, str(ROOT / 'scripts/install-llama.py'), '--root', str(root), '--revision', PIN])
    started = []
    facts = {'cmake': cmake}

    def stages():
        return sorted(p for p in root.iterdir() if p.name.startswith(installer.STAGE_PREFIX))

    def lease_free():
        fd = os.open(root / installer.LOCK, os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except BlockingIOError:
            return False
        finally:
            os.close(fd)

    def version():
        done = subprocess.run([str(target / 'bin/llama-server'), '--version'], capture_output=True, text=True, timeout=60,
                              cwd=target / 'bin')
        return done.returncode, done.stdout + done.stderr

    def killed_mid_build():
        child = fx.Run(command, run / 'installer-killed', env=env)
        started.append(child)

        def objects():
            if child.process.poll() is not None:
                raise AssertionError(f'the installer exited ({child.process.returncode}) before compiling: {child.text()[1][-800:]}')
            found = stages()
            return found and sum(1 for _ in (found[0] / 'build').rglob('*.o')) >= OBJECTS_BEFORE_KILL
        fx.until(objects, 'the real build did not start compiling', timeout=600)
        compiled = sum(1 for _ in (stages()[0] / 'build').rglob('*.o'))
        child.signal_group(signal.SIGKILL)
        assert child.wait(30) == -signal.SIGKILL
        fx.until(lambda: not fx.group_members(child.pid), f'compilers survive: {fx.group_members(child.pid)}', 30)
        assert lease_free()
        assert fx.tree(target) == earlier, 'the earlier installation changed'
        assert f'(build {fx.EARLIER_LLAMA_BUILD}, commit {fx.EARLIER_LLAMA_PIN[:7]})' in version()[1]
        assert user.unchanged()
        assert len(stages()) == 1, 'the killed build left its stage for the next installer to remove'
        facts['objectsWhenKilled'] = compiled
        return {'objectsWhenKilled': compiled}

    def completes():
        begun = time.time()
        child = fx.Run(command, run / 'installer-complete', env=env)
        started.append(child)
        code = child.wait(3600)
        out, err = child.text()
        assert code == 0, err[-3000:]
        result = json.loads([line for line in out.splitlines() if line.startswith('{')][-1])
        assert result['built'] and result['replaced'] and not result['reused'], result
        receipt = installer.read_receipt(target)
        assert installer.receipt_current(target, receipt), receipt
        assert (receipt['commit'], receipt['buildNumber'], receipt['buildId']) == (PIN, NUMBER, installer.BUILD_ID)
        assert receipt['bundledSources']['source'] == 'bundled' and receipt['modelLoaded'] is False
        assert receipt['binarySHA256'] == fx.sha256(target / 'bin/llama-server')
        code, text = version()
        assert code == 0 and f'(build {NUMBER}, commit {PIN[:7]})' in text, text[-400:]
        assert stages() == [], f'stages left: {stages()}'
        assert user.unchanged(), 'user bytes changed'
        assert user.others((installer.DIRECTORY, installer.LOCK)) == []
        facts.update(buildSeconds=round(time.time() - begun, 1), binaryBytes=receipt['binaryBytes'],
                     binarySHA256=receipt['binarySHA256'], cmakeVersion=receipt['cmake'])
        return dict(facts)

    def reused():
        inode = target.stat().st_ino
        done = subprocess.run(command, capture_output=True, text=True, env=env)
        assert done.returncode == 0, done.stderr[-800:]
        result = json.loads(done.stdout.strip().splitlines()[-1])
        assert result['reused'] and not result['built'] and target.stat().st_ino == inode, result

    try:
        if cases.check('the real build is killed while compiling: the earlier runtime stays, nothing is published', killed_mid_build) \
                and cases.check('the next run removes the abandoned stage, builds offline and publishes the pinned server', completes):
            cases.check('a further run verifies and reuses the build', reused)
    finally:
        for child in started:
            child.kill_group()
    return cases.finish()


if __name__ == '__main__':
    sys.exit(main())
