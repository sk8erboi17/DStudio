"""Real offline installation of the bundled MLX runtime (scripts/install-mlx.py)
into a new task-owned root, with outbound network denied by macOS
sandbox-exec: pinned versions, Metal reachable, reuse, and a changed
interpreter making the installation not current. No model is loaded.
Requires macOS 26 on Apple Silicon and Python 3.12-3.14; otherwise NOT RUN.
  python3 tests/integration/mlx_install_offline_test.py
"""
import json
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SANDBOX = '(version 1)(allow default)(deny network-outbound (remote ip "*:*"))'
if sys.platform != 'darwin' or platform.machine() != 'arm64' or int(platform.mac_ver()[0].split('.')[0] or 0) < 26:
    print('mlx_install_offline_test: NOT RUN (needs macOS 26 on Apple Silicon)')
    raise SystemExit(2)
artifacts = ROOT / 'tests/.artifacts/mlx-install'
artifacts.mkdir(parents=True, exist_ok=True)
root = Path(tempfile.mkdtemp(prefix='run-', dir=artifacts))
results = []


def install():
    done = subprocess.run(['sandbox-exec', '-p', SANDBOX, sys.executable, str(ROOT / 'scripts/install-mlx.py'), '--root', str(root)],
                          capture_output=True, text=True)
    (root / f'install-{len(results)}.log').write_text(done.stdout + done.stderr)
    return done


def check(name, fn):
    try:
        fn(); results.append((name, True)); print(f'PASS {name}')
    except Exception as error:  # noqa: BLE001 - every failure is reported
        results.append((name, False)); print(f'FAIL {name}\n  {error}')


def first():
    done = install()
    assert done.returncode == 0, done.stderr[-2000:]
    out = json.loads(done.stdout.strip().splitlines()[-1])
    assert out['built'] and not out['reused'], out
    receipt = json.loads((root / 'mlx/.dstudio-mlx.json').read_text())
    assert receipt['pins'] == {'mlx': '0.32.3', 'mlx-lm': '0.32.0'} and receipt['network'] is False
    assert not list(root.glob('.dstudio-mlx-stage-*')), 'no stage is left behind'


def server_cli():
    done = subprocess.run([str(root / 'mlx/venv/bin/python3'), '-m', 'mlx_lm', 'server', '--help'],
                          capture_output=True, text=True, timeout=120, env={'HF_HUB_OFFLINE': '1', 'PATH': '/usr/bin:/bin'})
    assert done.returncode == 0 and '--prompt-concurrency' in done.stdout, done.stderr[-500:]


def reuse():
    done = install()
    out = json.loads(done.stdout.strip().splitlines()[-1])
    assert out['reused'] and not out['built'], out


def tamper():
    python = root / 'mlx/venv/bin/python3'
    data = python.read_bytes()
    python.write_bytes(data + b'\0')
    try:
        sys.path.insert(0, str(ROOT / 'scripts'))
        import importlib.util
        spec = importlib.util.spec_from_file_location('install_mlx', ROOT / 'scripts/install-mlx.py')
        mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
        _, digest = mod.load_manifest(ROOT)
        assert not mod.receipt_current(root / 'mlx', mod.read_receipt(root / 'mlx'), digest)
    finally:
        python.write_bytes(data)


check('installs offline: pinned mlx/mlx-lm reach Metal', first)
check('the published interpreter runs the MLX server CLI', server_cli)
check('a second installation verifies and reuses it', reuse)
check('a changed interpreter is not current', tamper)
shutil.rmtree(root / 'mlx', ignore_errors=True)
passed = sum(ok for _, ok in results)
print(f'mlx_install_offline_test: {passed}/{len(results)} passed (real offline install; no model); logs: {root}')
raise SystemExit(0 if passed == len(results) else 1)
