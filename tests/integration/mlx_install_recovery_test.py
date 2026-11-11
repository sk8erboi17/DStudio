"""Upgrade, interruption and recovery of the bundled MLX runtime installation.

Runs the production installer (scripts/install-mlx.py) as real child processes
with outbound network denied by macOS sandbox-exec, in task-owned profiles
under tests/.artifacts/mlx-install-recovery/ whose paths contain spaces. Every
run verifies the real bundled wheels against their manifest and applies the
real mlx-lm patches with real `git apply` to the server.py of the bundled
wheel. The host binary supplies the real --install-engine command, the real
launch-preparation worker and the real server guard.

SIMULATED: the interpreter. A stand-in CPython 3.14 provides venv, pip (which
checks the hashes the installer required and unpacks only the mlx-lm wheel)
and the Metal probe; mlx itself is recorded, not installed, and nothing is
loaded. The real offline installation is `make test-mlx-install`; the real
upgrade over an earlier installation is `make test-mlx-upgrade-real`.

  python3 tests/integration/mlx_install_recovery_test.py [tests/.build/dstudio-server-test]
"""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import zipfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tests/support'))
import install_recovery as fx  # noqa: E402

spec = importlib.util.spec_from_file_location('install_mlx', ROOT / 'scripts/install-mlx.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
MANIFEST, MANIFEST_SHA = installer.load_manifest(ROOT)
OWNED = (installer.DIRECTORY, installer.LOCK)
MARKERS = ['DSTUDIO_MLX_SINGLE_MODEL', 'DSTUDIO_MLX_REASONING_CONTENT', 'DSTUDIO_MLX_TOOL_STREAM']
EARLIER_PATCHES = installer.PATCHES[:2]  # the set shipped before the tool-streaming patch (October 3, 2026)
EARLIER_LM = '0.0.1'                     # fixture version label of the earlier wheel set, not an upstream release

# The production installer driven with the earlier patch set: what the previous
# DStudio release left in a profile.
EARLIER_DRIVER = '''
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('install_mlx', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.PATCHES = json.loads(sys.argv[4])
print(json.dumps(m.install(sys.argv[2], Path(sys.argv[3]))))
'''
# The production entry point without this Mac's own interpreter locations.
NO_PYTHON_DRIVER = '''
import importlib.util, sys
spec = importlib.util.spec_from_file_location('install_mlx', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
discover = m.find_python
m.find_python = lambda manifest: discover(manifest, search=())
sys.argv = sys.argv[1:]
sys.exit(m.main())
'''


def clone(source, target):
    """Copy-on-write copy of the bundled wheels (APFS clone); the pinned files
    in src/engines are never opened for writing."""
    target.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(['/bin/cp', '-cR', str(source), str(target)], check=True)


def earlier_wheel_set(assets):
    """An earlier bundle: the same wheels except mlx-lm, replaced by a fixture
    wheel with another version (the real package files, relabelled 0.0.1)."""
    clone(ROOT / 'src/engines/mlx', assets / 'src/engines/mlx')
    folder = assets / 'src/engines/mlx/wheels'
    manifest = json.loads((assets / 'src/engines/mlx/manifest.json').read_text())
    current = next(name for name, meta in manifest['files'].items() if meta['name'].lower().replace('-', '_') == 'mlx_lm')
    version = manifest['files'][current]['version']
    earlier = current.replace(version, EARLIER_LM)
    with zipfile.ZipFile(folder / current) as source, zipfile.ZipFile(folder / earlier, 'w') as output:
        for item in source.infolist():
            output.writestr(item.filename.replace(f'mlx_lm-{version}.dist-info', f'mlx_lm-{EARLIER_LM}.dist-info'), source.read(item))
    (folder / current).unlink()
    data = (folder / earlier).read_bytes()
    manifest['files'][earlier] = {**manifest['files'].pop(current), 'version': EARLIER_LM, 'bytes': len(data),
                                  'sha256': hashlib.sha256(data).hexdigest()}
    manifest['pins'] = {**manifest['pins'], 'mlx-lm': EARLIER_LM}
    (assets / 'src/engines/mlx/manifest.json').write_text(json.dumps(manifest, indent=1, sort_keys=True))
    return assets


def main():
    if sys.platform != 'darwin' or platform.machine() != 'arm64' or int(platform.mac_ver()[0].split('.')[0] or 0) < 26:
        print('mlx_install_recovery_test: NOT RUN (the MLX installer admits only macOS 26 on Apple Silicon)')
        return 2
    host = Path(sys.argv[1] if len(sys.argv) > 1 else 'tests/.build/dstudio-server-test').resolve()
    if not host.is_file():
        print(f'mlx_install_recovery_test: NOT RUN (host binary missing: {host})')
        return 2
    artifacts = ROOT / 'tests/.artifacts/mlx-install-recovery'
    artifacts.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='run-', dir=artifacts))
    cases = fx.Cases('mlx_install_recovery_test', run,
                     'production installer, host CLI, launch worker and guard as real processes, network denied, real '
                     'wheel verification and real git apply; SIMULATED CPython 3.14 (venv, pip, Metal probe), no MLX loaded')
    control = fx.Control(run / 'control')
    tools = fx.standin_python(run / 'toolchain', control)
    os.symlink(sys.executable, tools / 'python3')  # the host starts the installer with `python3`
    script = ROOT / 'scripts/install-mlx.py'
    earlier_bundle = earlier_wheel_set(run / 'earlier bundle')
    base_env = {k: v for k, v in os.environ.items() if k != 'DSTUDIO_INSTALL_FAILPOINT'}
    base_env['PATH'] = f'{tools}:/usr/bin:/bin'
    counter = [0]
    started = []

    template = run / 'earlier installation' / 'install root with spaces'

    def earlier_installation():
        """Installed once by the production installer; every profile receives a
        copy-on-write copy of that directory (its receipt names no path inside it)."""
        if not template.exists():
            template.mkdir(parents=True)
            done = subprocess.run(fx.offline([sys.executable, '-c', EARLIER_DRIVER, str(script), str(template), str(earlier_bundle),
                                              json.dumps(EARLIER_PATCHES)]), capture_output=True, text=True, env=base_env)
            assert done.returncode == 0, done.stderr[-1500:]
            receipt = installer.read_receipt(template / 'mlx')
            assert receipt['pins']['mlx-lm'] == EARLIER_LM and [p['patch'] for p in receipt['patches']] == EARLIER_PATCHES, receipt
        return template / 'mlx'

    def profile(name, earlier=True):
        root = run / name / 'install root with spaces'
        root.mkdir(parents=True)
        user = fx.Profile(root)
        if earlier:
            clone(earlier_installation(), root / 'mlx')
            assert not installer.receipt_current(root / 'mlx', installer.read_receipt(root / 'mlx'), MANIFEST_SHA), \
                'the earlier installation must not be current'
        return root, user

    def start(root, env=None, argv=None, assets=None, which=script):
        counter[0] += 1
        command = argv or fx.offline([sys.executable, str(which), '--root', str(root)] + (['--assets', str(assets)] if assets else []))
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
        return installer.receipt_current(target(root), installer.read_receipt(target(root)), MANIFEST_SHA)

    def server_markers(root):
        site = target(root) / 'venv/lib/python3.14/site-packages'
        text = (site / 'mlx_lm/server.py').read_text()
        return [m for m in MARKERS if m in text], sorted(p.name for p in site.glob('mlx_lm-*.dist-info'))

    def assert_earlier(root, user, snapshot):
        assert fx.tree(target(root)) == snapshot, 'the earlier installation changed'
        assert server_markers(root) == (MARKERS[:2], [f'mlx_lm-{EARLIER_LM}.dist-info']), server_markers(root)
        assert user.unchanged(), 'user bytes changed'

    def assert_new(root, user):
        receipt = installer.read_receipt(target(root))
        assert current(root), receipt
        assert receipt['pins'] == MANIFEST['pins'] and receipt['manifestSHA256'] == MANIFEST_SHA
        assert [p['patch'] for p in receipt['patches']] == installer.PATCHES
        assert server_markers(root) == (MARKERS, [f"mlx_lm-{MANIFEST['pins']['mlx-lm']}.dist-info"]), server_markers(root)
        assert stages(root) == [], stages(root)
        assert user.unchanged(), 'user bytes changed'
        assert user.others(OWNED) == [], user.others(OWNED)

    def guard(root, identity, log):
        python = target(root) / installer.PYTHON
        read, write = os.pipe()
        child = fx.Run(['/bin/sh', '-c', 'exec "$@" 3<&0 </dev/null', 'sh', host, '--resident-guard', target(root), identity,
                        python, '-m', 'mlx_lm', 'server', '--model', 'stand-in'], run / log, stdin=read, env=base_env)
        os.close(read)
        started.append(child)
        return child, write

    def launched():
        return fx.until(lambda: control.path('server.started').exists() and control.path('server.started').read_text(),
                        'the guard did not start the runtime')

    # ------------------------------------------------------------------ upgrade
    def upgrade():
        control.reset()
        root, user = profile('upgrade')
        old_identity = fx.launch_identity(target(root) / installer.PYTHON)
        old_inode = target(root).stat().st_ino
        code, out, err = install(root)
        assert code == 0, err[-1500:]
        assert out['built'] and out['replaced'] and not out['reused'] and out['python'] == '3.14', out
        assert target(root).stat().st_ino != old_inode
        assert_new(root, user)
        receipt = installer.read_receipt(target(root))
        assert receipt['base'] == installer.base_files([str((tools / 'python3.14').resolve())])
        assert receipt['network'] is False and receipt['modelLoaded'] is False
        child, owner = guard(root, old_identity, 'guard-stale')
        os.close(owner)
        assert child.wait(20) == 126 and 'changed' in child.text()[1], child.text()
        assert not control.path('server.started').exists(), 'the replaced interpreter identity must never start'
        child, owner = guard(root, fx.launch_identity(target(root) / installer.PYTHON), 'guard-new')
        state = json.loads(launched())
        assert state['markers'] == MARKERS and state['packages']['mlx_lm'] == MANIFEST['pins']['mlx-lm'], state
        assert state['packages']['mlx'] == MANIFEST['pins']['mlx']
        inode = target(root).stat().st_ino
        code, out, err = install(root)  # in use: verified beside the running server, nothing replaced
        assert code == 0 and out['reused'] and not out['built'], (out, err)
        assert target(root).stat().st_ino == inode
        os.close(owner)
        assert child.wait(20) == 0
        return {'pins': receipt['pins'], 'patches': [p['patch'] for p in receipt['patches']], 'launched': state}

    def reuse():
        control.reset()
        root, user = profile('reuse', earlier=False)
        code, out, err = install(root)
        assert code == 0 and out['built'] and not out['replaced'], (out, err)
        inode = target(root).stat().st_ino
        code, out, err = install(root)
        assert code == 0 and out['reused'] and not out['built'], (out, err)
        assert target(root).stat().st_ino == inode, 'verification must not publish'
        assert_new(root, user)

    # ------------------------------------------------- upgrade fails at each step
    def failing(name, expect, prepare=None, runner=None, retained=0):
        def body():
            control.reset()
            root, user = profile('fails ' + name)
            snapshot = fx.tree(target(root))
            options = (prepare(root) or {}) if prepare else {}
            code, out, err = runner(root) if runner else install(root, **options)
            assert code == 1 and out is None, (code, out, err)
            assert expect in err, err[-1500:]
            assert_earlier(root, user, snapshot)
            left = stages(root)
            assert len(left) == retained, left
            for stage in left:
                assert {p.name for p in (root / stage).iterdir()} <= {'install.log', 'requirements.txt'}, \
                    'only the log of a failed installation is kept'
            assert user.others(OWNED + tuple(left)) == []
            assert not (root / installer.LOCK).exists() or lease_free(root)
            return {'message': err.strip().splitlines()[0][:300]}
        return body

    def without_python(root):
        empty = root.parent / 'empty bin'
        empty.mkdir(exist_ok=True)
        return install(root, env={'PATH': str(empty)},
                       argv=fx.offline([sys.executable, '-c', NO_PYTHON_DRIVER, str(script), '--root', str(root)]))

    def altered_wheels(change):
        def prepare(root):
            assets = root.parent / 'altered bundle'
            clone(ROOT / 'src/engines/mlx', assets / 'src/engines/mlx')
            folder = assets / 'src/engines/mlx/wheels'
            victim = sorted(folder.glob('annotated_doc-*.whl'))[0]
            if change == 'altered':
                data = victim.read_bytes()
                victim.unlink()  # a new file: the clone's source is never written
                victim.write_bytes(data[:-1] + bytes([data[-1] ^ 1]))
            elif change == 'truncated':
                data = victim.read_bytes()
                victim.unlink()
                victim.write_bytes(data[:len(data) // 2])
            elif change == 'missing':
                victim.unlink()
            elif change == 'extra':
                (folder / 'unrecorded-1.0-py3-none-any.whl').write_bytes(b'not in the manifest')
            return {'assets': assets}
        return prepare

    def drifted_patch(root):
        support = root.parent / 'drifted support'
        (support / 'scripts').mkdir(parents=True)
        for name in ('install-mlx.py', 'bundled_engine_sources.py'):
            shutil.copy2(ROOT / 'scripts' / name, support / 'scripts' / name)
        for rel in installer.PATCHES:
            (support / rel).parent.mkdir(parents=True)
            shutil.copy2(ROOT / rel, support / rel)
        patch = support / installer.PATCHES[2]
        lines = patch.read_text().splitlines(keepends=True)
        hunk = next(i for i, line in enumerate(lines) if line.startswith('@@'))
        context = next(i for i in range(hunk + 1, len(lines)) if lines[i].startswith(' ') and lines[i].strip())
        lines[context] = lines[context].rstrip('\n') + '  # drifted context\n'
        patch.write_text(''.join(lines))
        return {'which': support / 'scripts/install-mlx.py', 'assets': ROOT}

    def running_runtime_is_not_replaced():
        control.reset()
        root, user = profile('fails runtime in use')
        snapshot = fx.tree(target(root))
        child, owner = guard(root, fx.launch_identity(target(root) / installer.PYTHON), 'guard-earlier')
        state = json.loads(launched())
        assert state['markers'] == MARKERS[:2] and state['packages']['mlx_lm'] == EARLIER_LM, state
        code, out, err = install(root)
        assert code == 1 and 'The MLX runtime is running; stop the model to update it' in err, (code, err)
        assert fx.alive(state['pid']), 'the running runtime was stopped by an upgrade attempt'
        assert_earlier(root, user, snapshot)
        assert stages(root) == []
        os.close(owner)
        assert child.wait(20) == 0
        code, out, err = install(root)
        assert code == 0 and out['built'] and out['replaced'], (out, err)
        assert_new(root, user)

    def failed_installs_are_bounded():
        control.reset()
        root, user = profile('fails bounded')
        snapshot = fx.tree(target(root))
        control.fail('pip-install')
        for _ in range(2):
            code, out, err = install(root)
            assert code == 1 and 'Install log retained' in err, err[-600:]
        code, out, err = install(root)
        assert code == 1 and 'Two failed MLX installations are retained' in err, err[-600:]
        assert len(stages(root)) == 2
        assert_earlier(root, user, snapshot)
        control.reset()
        shutil.rmtree(root / stages(root)[0])
        code, out, err = install(root)
        assert code == 0 and out['built'], (out, err)
        assert len(stages(root)) == 1 and current(root) and user.unchanged()

    # ----------------------------------------------------------- interruption
    POINTS = [
        ('during wheel verification', ('wheels',), None, 'earlier'),
        ('before the installation (venv)', (), 'venv', 'earlier'),
        ('mid-installation (two packages installed)', (), 'pip-install', 'earlier'),
        ('installed and patched, before publication (Metal probe)', (), 'metal-probe', 'earlier'),
        ('candidate complete, publication not started', ('publish',), None, 'earlier'),
        ('published, stage not yet removed', ('published',), None, 'new'),
    ]

    def interrupted(name, failpoints, barrier, expect, signal_number):
        def body():
            control.reset()
            root, user = profile(f'{signal.Signals(signal_number).name} {name}')
            snapshot = fx.tree(target(root))
            if barrier:
                control.hold(barrier)
            child = start(root, env=control.env(*failpoints))
            control.reached(failpoints[0] if failpoints else barrier, child.process)
            if barrier == 'pip-install':
                half = list(root.glob(installer.STAGE_PREFIX + '*/mlx/venv/lib/python3.14/site-packages/*.dist-info'))
                assert len(half) == 2, f'the barrier must hold a half-installed environment: {half}'
            if signal_number == signal.SIGKILL:
                child.signal_group(signal.SIGKILL)
                assert child.wait(20) == -signal.SIGKILL
            else:
                os.kill(child.pid, signal.SIGTERM)
                code = child.wait(20)
                assert code == 130, (code, child.text())
            fx.until(lambda: not fx.group_members(child.pid), f'processes survive: {fx.group_members(child.pid)}', 10)
            control.reset()
            assert lease_free(root), 'a dead installer still owns the lease'
            if expect == 'earlier':
                assert_earlier(root, user, snapshot)
            else:
                assert current(root) and server_markers(root)[0] == MARKERS and user.unchanged(), 'a publication must be complete'
            if signal_number == signal.SIGTERM:
                assert stages(root) == [], f'a canceled installation leaves no stage: {stages(root)}'
            code, out, err = install(root)
            assert code == 0, err[-1500:]
            assert out['reused'] if expect == 'new' else (out['built'] and out['replaced']), out
            assert_new(root, user)
            return {'afterInterrupt': expect, 'next': 'reused' if out['reused'] else 'built'}
        return body

    def repeated_owner_death_does_not_block():
        root, user = profile('SIGKILL repeated')
        snapshot = fx.tree(target(root))
        for _ in range(3):
            control.reset()
            control.hold('pip-install')
            child = start(root)
            control.reached('pip-install', child.process)
            child.signal_group(signal.SIGKILL)
            child.wait(20)
            assert_earlier(root, user, snapshot)
        control.reset()
        code, out, err = install(root)
        assert code == 0 and out['built'] and out['replaced'], err[-1500:]
        assert_new(root, user)

    def moved_aside_installation_is_put_back():
        control.reset()
        root, user = profile('partial previous aside')
        snapshot = fx.tree(target(root))
        stage = root / (installer.STAGE_PREFIX + 'killed01')
        (stage / 'mlx' / 'venv').mkdir(parents=True)
        (stage / 'mlx' / 'venv' / 'pyvenv.cfg').write_text('half-published candidate\n')
        os.rename(target(root), stage / 'previous')
        code, out, err = without_python(root)
        assert code == 1 and 'MLX needs Python' in err, (code, err[-800:])
        assert_earlier(root, user, snapshot)
        assert stages(root) == [], stages(root)
        code, out, err = install(root)
        assert code == 0 and out['built'] and out['replaced'], err[-1500:]
        assert_new(root, user)

    def cancel_waits_for_a_slow_tool():
        control.reset()
        root, user = profile('SIGTERM slow tool')
        snapshot = fx.tree(target(root))
        control.hold('pip-install')
        control.touch('pip-install.slowterm')  # the tool keeps writing for 0.4 s after SIGTERM
        child = start(root)
        control.reached('pip-install', child.process)
        os.kill(child.pid, signal.SIGTERM)
        assert child.wait(20) == 130
        fx.until(lambda: not fx.group_members(child.pid), 'processes survive', 10)
        assert control.path('pip-install.slowterm.done').exists(), 'the stand-in tool did not run its slow shutdown'
        assert stages(root) == [], f'the stage was removed while its tool still wrote into it: {stages(root)}'
        assert_earlier(root, user, snapshot)

    # ------------------------------------------------------ corrupt/partial state
    def state(name, mutate, expect=None, recovers=False):
        def body():
            control.reset()
            root, user = profile('state ' + name, earlier=False)
            code, out, err = install(root)
            assert code == 0 and out['built'], err[-800:]
            restore = mutate(root)
            restore = restore if callable(restore) else None
            before = fx.tree(target(root)) if target(root).is_dir() and not target(root).is_symlink() else None
            code, out, err = install(root)
            if restore:
                restore()
            if recovers:
                assert code == 0 and out['built'] and out['replaced'], (out, err[-800:])
                if restore:
                    return {'message': 'rebuilt'}
                assert_new(root, user)
            else:
                assert code == 1 and expect in err, (code, err[-800:])
                if before is not None:
                    assert fx.tree(target(root)) == before, 'a refused installation directory must be preserved'
                assert stages(root) == [] and user.unchanged() and lease_free(root)
            return {'message': err.strip().splitlines()[0][:240] if err.strip() else 'rebuilt'}
        return body

    def edit_receipt(**changes):
        def mutate(root):
            path = target(root) / installer.RECEIPT
            receipt = json.loads(path.read_text())
            receipt.update(changes)
            path.write_text(json.dumps(receipt, indent=1, sort_keys=True) + '\n')
        return mutate

    def base_python_changed(root):
        base = tools / 'python3.14'
        original = base.read_bytes()
        base.write_bytes(original + b'# a Python upgrade replaced this file\n')
        return lambda: base.write_bytes(original)

    def replace_with_link(root):
        os.rename(target(root), root / 'elsewhere')
        os.symlink(root / 'elsewhere', target(root))

    def stale_lease_from_a_dead_owner():
        control.reset()
        root, user = profile('state stale lease', earlier=False)
        holder = subprocess.Popen([sys.executable, '-c', f'''import fcntl, os, time
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
        code, out, err = install(root)
        assert code == 0 and out['built'], err[-800:]
        assert_new(root, user)

    # -------------------------------------------------------------- concurrency
    def two_installers_one_publication():
        control.reset()
        root, user = profile('concurrent same root', earlier=False)
        control.hold('pip-install')
        leader = start(root)
        control.reached('pip-install', leader.process)
        code, out, err = install(root)
        assert code == 1 and 'The MLX runtime is being installed; retry when the installation finishes' in err, err[-600:]
        assert len(stages(root)) == 1 and not target(root).exists(), 'the refused installer must not stage or publish'
        control.release('pip-install')
        assert leader.wait() == 0, leader.text()[1][-800:]
        inode = target(root).stat().st_ino
        code, out, err = install(root)
        assert code == 0 and out['reused'] and not out['built'], (out, err)
        assert target(root).stat().st_ino == inode, 'exactly one publication'
        assert_new(root, user)

    def revalidated(name, change, expect):
        def body():
            control.reset()
            root, user = profile('revalidate ' + name)
            control.hold('metal-probe')
            child = start(root)
            control.reached('metal-probe', child.process)
            kept = change(root)
            control.release('metal-probe')
            code = child.wait()
            err = child.text()[1]
            assert code == 1 and expect in err, (code, err[-800:])
            if kept is None:
                assert server_markers(root)[0] == MARKERS[:2], 'the candidate must not have been published'
            else:
                assert fx.tree(target(root)) == kept, 'the directory that appeared during the installation was replaced'
            assert user.unchanged()
            return {'message': err.strip().splitlines()[0][:240]}
        return body

    def replace_lease(root):
        os.unlink(root / installer.LOCK)
        (root / installer.LOCK).write_text('another owner\n')
        os.chmod(root / installer.LOCK, 0o600)

    def replace_target(root):
        os.rename(target(root), root / 'moved by the user')
        target(root).mkdir()
        shutil.copy2(root / 'moved by the user' / installer.RECEIPT, target(root) / installer.RECEIPT)
        (target(root) / 'placed during the installation').write_text('user bytes\n')
        return fx.tree(target(root))

    # ------------------------------------------- the host's own entry points
    support = run / 'support tree'

    def make_support():
        (support / 'scripts').mkdir(parents=True)
        (support / 'extension').mkdir()
        for name in ('install-mlx.py', 'install-llama.py', 'bundled_engine_sources.py'):
            shutil.copy2(ROOT / 'scripts' / name, support / 'scripts' / name)
        for rel in installer.PATCHES:
            (support / rel).parent.mkdir(parents=True)
            shutil.copy2(ROOT / rel, support / rel)
        clone(ROOT / 'src/engines/mlx', support / 'src/engines/mlx')

    def host_env():
        return {**base_env, 'DS4UI_NO_WINDOW': '1'}

    def host_cli():
        control.reset()
        root, user = profile('host cli')
        counter[0] += 1
        child = fx.Run(fx.offline([host, '--install-engine', 'mlx', root]), run / f'host-{counter[0]:03d}', env=host_env(), cwd=support)
        started.append(child)
        code = child.wait()
        out, err = child.text()
        assert code == 0, err[-1200:]
        assert f'install-engine: OK engine=mlx bundled=1 sourcesInstalled=1 path={target(root)}' in out, out[-600:]
        assert_new(root, user)
        again = fx.Run(fx.offline([host, '--install-engine', 'mlx', root]), run / 'host-again', env=host_env(), cwd=support)
        started.append(again)
        assert again.wait() == 0 and 'sourcesInstalled=0' in again.text()[0]
        assert_new(root, user)

    def host_cli_reports_the_reason():
        control.reset()
        root, user = profile('host cli failure')
        snapshot = fx.tree(target(root))
        control.touch('metal-probe.nometal')
        child = fx.Run(fx.offline([host, '--install-engine', 'mlx', root]), run / 'host-failure', env=host_env(), cwd=support)
        started.append(child)
        code = child.wait()
        err = child.text()[1]
        assert code == 1, (code, err)
        line = next(line for line in err.splitlines() if line.startswith('install-engine: FAILED'))
        assert 'does not report the pinned versions with Metal' in line, f'the reason must lead the failure: {line[:300]!r}'
        assert_earlier(root, user, snapshot)
        return {'message': line[:260]}

    def worker(root, log):
        read, write = os.pipe()
        child = fx.Run(fx.offline([host, '--prepare-launch', 'server', root / 'ds4', support, 'mlx/Qwen3.6-35B-A3B-mxfp8',
                                   '', '', 'local', '7', 'none', '0', 'native']), run / log, env=host_env(), stdin=read)
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
            assert result['identity'] == fx.launch_identity(target(root) / installer.PYTHON), result
            assert_new(root, user)
            runner, channel = guard(root, result['identity'], 'guard-worker')
            state = json.loads(launched())
            assert state['markers'] == MARKERS and state['packages']['mlx_lm'] == MANIFEST['pins']['mlx-lm'], state
            os.close(channel)
            assert runner.wait(20) == 0
        finally:
            os.close(owner)
            child.kill_group()
        return {'identity': result['identity']}

    def owner_death():
        control.reset()
        root, user = profile('owner death')
        snapshot = fx.tree(target(root))
        control.hold('pip-install')
        child, owner = worker(root, 'worker-owner-death')
        tool = int(control.reached('pip-install', child.process, 30))
        members = fx.group_members(child.pid)
        assert tool in members and len(members) >= 3, f'worker, installer and tool share one group: {members}'
        begun = time.monotonic()
        os.close(owner)  # cancellation, or the kernel closing a dead host's end
        fx.until(lambda: not fx.alive(tool), 'the installation tool outlived its owner', 4)
        fx.until(lambda: not fx.group_members(child.pid), f'the group outlived its owner: {fx.group_members(child.pid)}', 9)
        elapsed = time.monotonic() - begun
        child.wait(5)
        control.reset()
        assert lease_free(root)
        assert stages(root) == [], f'the canceled installation left its stage: {stages(root)}'
        assert_earlier(root, user, snapshot)
        again, owner = worker(root, 'worker-again')
        try:
            result = worker_result(again)
            assert result['ok'] and result['identity'] == fx.launch_identity(target(root) / installer.PYTHON), result
        finally:
            os.close(owner)
            again.kill_group()
        assert_new(root, user)
        return {'groupGoneAfterSeconds': round(elapsed, 2)}

    try:
        cases.check('upgrade from the earlier wheel and patch set: the new runtime is reported, launched and the only one current', upgrade)
        cases.check('a fresh installation is reused without a second publication', reuse)
        cases.check('upgrade fails, earlier runtime kept: no supported Python is installed',
                    failing('no python', 'MLX needs Python', runner=without_python))
        for change, message in (('altered', 'differs from its manifest; nothing installed'),
                                ('truncated', 'differs from its manifest; nothing installed'),
                                ('missing', 'missing or contain unrecorded files'), ('extra', 'missing or contain unrecorded files')):
            cases.check(f'upgrade fails, earlier runtime kept: bundled wheel {change} (no remote fallback)',
                        failing('wheel ' + change, message, prepare=altered_wheels(change)))
        cases.check('upgrade fails, earlier runtime kept: the virtual environment cannot be created',
                    failing('venv', 'stand-in venv failure', prepare=lambda root: control.fail('venv'), retained=1))
        cases.check('upgrade fails, earlier runtime kept: pip fails with a half-installed environment',
                    failing('pip', 'stand-in pip failure', prepare=lambda root: control.fail('pip-install'), retained=1))
        cases.check('upgrade fails, earlier runtime kept: a patch does not apply to the installed mlx-lm',
                    failing('patch drift', 'git apply', prepare=drifted_patch, retained=1))
        cases.check('upgrade fails, earlier runtime kept: git is not installed',
                    failing('no git', "'git'", prepare=lambda root: {'env': {'PATH': str(tools)}}, retained=1))
        cases.check('upgrade fails, earlier runtime kept: Metal is not available',
                    failing('no metal', 'does not report the pinned versions with Metal',
                            prepare=lambda root: control.touch('metal-probe.nometal'), retained=1))
        cases.check('a running runtime is never replaced; the upgrade proceeds once it stops', running_runtime_is_not_replaced)
        cases.check('failed installations keep only their log, at most two, until one is removed', failed_installs_are_bounded)
        for name, failpoints, barrier, expect in POINTS:
            cases.check(f'owner death (SIGKILL) {name}: nothing half-published, the next run completes',
                        interrupted(name, failpoints, barrier, expect, signal.SIGKILL))
        for name, failpoints, barrier, expect in POINTS:
            cases.check(f'cancellation (SIGTERM) {name}: stage removed, the next run completes',
                        interrupted(name, failpoints, barrier, expect, signal.SIGTERM))
        cases.check('three interrupted installations do not block the fourth', repeated_owner_death_does_not_block)
        cases.check('an installation moved aside by a killed installer is put back before anything can fail',
                    moved_aside_installation_is_put_back)
        cases.check('cancellation waits for a tool that is slow to stop before removing its stage', cancel_waits_for_a_slow_tool)
        cases.check('state: a tampered interpreter is rebuilt',
                    state('tampered', lambda root: (target(root) / installer.PYTHON).write_bytes(b'#!/bin/sh\nexit 1\n'), recovers=True))
        cases.check('state: a receipt with a missing interpreter is rebuilt',
                    state('missing interpreter', lambda root: (target(root) / installer.PYTHON).unlink(), recovers=True))
        cases.check('state: a changed base Python makes the installation not current and it is rebuilt',
                    state('base python', base_python_changed, recovers=True))
        cases.check('state: a receipt naming another wheel set is rebuilt to the bundled pins',
                    state('other manifest', edit_receipt(manifestSHA256='0' * 64), recovers=True))
        cases.check('state: a receipt naming another engine is preserved and refused',
                    state('other engine', edit_receipt(engine='llama'), 'contains files DStudio did not install; it is preserved'))
        cases.check('state: a receipt of another format is preserved and refused',
                    state('other schema', edit_receipt(schema='dstudio.llama-install.v1'),
                          'contains files DStudio did not install; it is preserved'))
        cases.check('state: a truncated receipt is preserved and refused',
                    state('truncated receipt', lambda root: (target(root) / installer.RECEIPT).write_text('{"schema": "dstudio.mlx-'),
                          'contains files DStudio did not install; it is preserved'))
        cases.check('state: a linked installation directory is preserved and refused',
                    state('linked', replace_with_link, 'is not a directory DStudio installed; it is preserved'))
        cases.check('state: the lease of a dead owner does not block the next installation', stale_lease_from_a_dead_owner)
        cases.check('two installers, one root: one leader publishes once, the other is refused at once', two_installers_one_publication)
        cases.check('a lease replaced during the installation cannot publish',
                    revalidated('lease', replace_lease, 'installation lease changed; no candidate published'))
        cases.check('an installation directory replaced during the installation is preserved',
                    revalidated('target', replace_target, 'changed during the installation; it is preserved'))
        make_support()
        cases.check('host --install-engine mlx: installs over the earlier runtime, then reuses', host_cli)
        cases.check('host --install-engine mlx: a failure leads with the installer reason', host_cli_reports_the_reason)
        cases.check('launch worker: the identity it reports is the upgraded interpreter the guard starts',
                    launch_worker_reports_the_upgraded_runtime)
        cases.check('owner gone mid-installation: tools stop, stage removed, earlier runtime kept, relaunch completes', owner_death)
    finally:
        for child in started:
            child.kill_group()
    return cases.finish()


if __name__ == '__main__':
    sys.exit(main())
