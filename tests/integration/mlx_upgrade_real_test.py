"""Real offline upgrade of the bundled MLX runtime over an earlier installation.

Explicit (about a minute; macOS 26 on Apple Silicon with Python 3.12-3.14,
otherwise NOT RUN): the production installer creates a real virtual environment
and installs the real bundled wheels with pip, with outbound network denied by
macOS sandbox-exec, in a task-owned profile whose path contains spaces.

The profile first receives a real installation with the patch set DStudio
shipped before the tool-streaming patch (October 3, 2026). The upgrade to the
current patch set is killed while pip is installing (the owner's whole process
group); the next attempt must complete. No model is loaded: the installer's own
Metal availability probe and the server's --help are the only MLX code run.

  python3 tests/integration/mlx_upgrade_real_test.py
"""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import platform
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tests/support'))
import install_recovery as fx  # noqa: E402

spec = importlib.util.spec_from_file_location('install_mlx', ROOT / 'scripts/install-mlx.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
MANIFEST, MANIFEST_SHA = installer.load_manifest(ROOT)
MARKERS = ['DSTUDIO_MLX_SINGLE_MODEL', 'DSTUDIO_MLX_REASONING_CONTENT', 'DSTUDIO_MLX_TOOL_STREAM']
EARLIER_PATCHES = installer.PATCHES[:2]
EARLIER_DRIVER = '''
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('install_mlx', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.PATCHES = json.loads(sys.argv[3])
print(json.dumps(m.install(sys.argv[2])))
'''
PACKAGES_BEFORE_KILL = 3  # installed distributions that prove pip is mid-installation


def main():
    if sys.platform != 'darwin' or platform.machine() != 'arm64' or int(platform.mac_ver()[0].split('.')[0] or 0) < 26:
        print('mlx_upgrade_real_test: NOT RUN (needs macOS 26 on Apple Silicon)')
        return 2
    try:
        python, python_version = installer.find_python(MANIFEST)
    except RuntimeError as error:
        print(f'mlx_upgrade_real_test: NOT RUN ({error})')
        return 2
    artifacts = ROOT / 'tests/.artifacts/mlx-upgrade-real'
    artifacts.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='run-', dir=artifacts))
    cases = fx.Cases('mlx_upgrade_real_test', run,
                     f'REAL offline MLX installation with {python} over a real earlier-patch-set installation, '
                     'network denied; no model loaded')
    root = run / 'install root with spaces'
    root.mkdir()
    user = fx.Profile(root)
    target = root / installer.DIRECTORY
    env = {k: v for k, v in os.environ.items() if k != 'DSTUDIO_INSTALL_FAILPOINT'}
    script = ROOT / 'scripts/install-mlx.py'
    command = fx.offline([sys.executable, str(script), '--root', str(root)])
    started = []
    state = {}

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

    def server_text():
        return next((target / 'venv/lib').glob('python*/site-packages/mlx_lm/server.py')).read_text()

    def earlier_installation():
        done = subprocess.run(fx.offline([sys.executable, '-c', EARLIER_DRIVER, str(script), str(root), json.dumps(EARLIER_PATCHES)]),
                              capture_output=True, text=True, env=env)
        (run / 'earlier-install.log').write_text(done.stdout + done.stderr)
        assert done.returncode == 0, done.stderr[-2000:]
        receipt = installer.read_receipt(target)
        assert [p['patch'] for p in receipt['patches']] == EARLIER_PATCHES and receipt['pins'] == MANIFEST['pins'], receipt
        assert not installer.receipt_current(target, receipt, MANIFEST_SHA), 'the earlier patch set must not be current'
        text = server_text()
        assert [m in text for m in MARKERS] == [True, True, False]
        state['earlier'] = fx.tree(target)
        state['identity'] = fx.launch_identity(target / installer.PYTHON)

    def killed_mid_installation():
        child = fx.Run(command, run / 'installer-killed', env=env)
        started.append(child)

        def installing():
            if child.process.poll() is not None:
                raise AssertionError(f'the installer exited ({child.process.returncode}) before pip ran: {child.text()[1][-800:]}')
            found = stages()
            return found and len(list(found[0].glob('mlx/venv/lib/python*/site-packages/*.dist-info'))) >= PACKAGES_BEFORE_KILL
        fx.until(installing, 'pip did not start installing', timeout=300)
        packages = len(list(stages()[0].glob('mlx/venv/lib/python*/site-packages/*.dist-info')))
        child.signal_group(signal.SIGKILL)
        assert child.wait(30) == -signal.SIGKILL
        fx.until(lambda: not fx.group_members(child.pid), f'tools survive: {fx.group_members(child.pid)}', 30)
        assert lease_free()
        assert fx.tree(target) == state['earlier'], 'the earlier installation changed'
        assert fx.launch_identity(target / installer.PYTHON) == state['identity']
        assert user.unchanged()
        assert len(stages()) == 1
        return {'distributionsWhenKilled': packages}

    def completes():
        begun = time.time()
        child = fx.Run(command, run / 'installer-complete', env=env)
        started.append(child)
        code = child.wait(1800)
        out, err = child.text()
        assert code == 0, err[-3000:]
        result = json.loads([line for line in out.splitlines() if line.startswith('{')][-1])
        assert result['built'] and result['replaced'] and not result['reused'], result
        receipt = installer.read_receipt(target)
        assert installer.receipt_current(target, receipt, MANIFEST_SHA), receipt
        assert receipt['pins'] == MANIFEST['pins'] and [p['patch'] for p in receipt['patches']] == installer.PATCHES
        assert receipt['network'] is False and receipt['modelLoaded'] is False
        text = server_text()
        assert all(marker in text for marker in MARKERS), 'the upgraded server carries every current patch'
        assert fx.launch_identity(target / installer.PYTHON) != state['identity'], 'a new interpreter file was published'
        help_text = subprocess.run([str(target / installer.PYTHON), '-m', 'mlx_lm', 'server', '--help'], capture_output=True,
                                   text=True, timeout=180, env={'HF_HUB_OFFLINE': '1', 'PATH': '/usr/bin:/bin'})
        assert help_text.returncode == 0 and '--prompt-concurrency' in help_text.stdout, help_text.stderr[-500:]
        assert stages() == [], f'stages left: {stages()}'
        assert user.unchanged(), 'user bytes changed'
        assert user.others((installer.DIRECTORY, installer.LOCK)) == []
        return {'seconds': round(time.time() - begun, 1), 'python': receipt['python'], 'pins': receipt['pins']}

    def reused():
        inode = target.stat().st_ino
        done = subprocess.run(command, capture_output=True, text=True, env=env)
        assert done.returncode == 0, done.stderr[-800:]
        result = json.loads(done.stdout.strip().splitlines()[-1])
        assert result['reused'] and not result['built'] and target.stat().st_ino == inode, result

    try:
        if cases.check('a real installation with the earlier patch set', earlier_installation) \
                and cases.check('the upgrade is killed while pip installs: the earlier runtime stays, nothing is published',
                                killed_mid_installation) \
                and cases.check('the next run removes the abandoned stage, installs offline and publishes the current patch set', completes):
            cases.check('a further run verifies and reuses the installation', reused)
    finally:
        for child in started:
            child.kill_group()
    return cases.finish()


if __name__ == '__main__':
    sys.exit(main())
