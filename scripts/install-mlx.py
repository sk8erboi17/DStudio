#!/usr/bin/env python3
"""Install DStudio's bundled MLX runtime (mlx + mlx-lm); never touches the network.

The wheels ship with DStudio in src/engines/mlx (PyPI files as published,
pinned by SHA-256 in its manifest). This helper picks an installed Python
3.12-3.14 the bundled wheels support, verifies every wheel, creates a private
virtual environment with real (copied) interpreter files in a stage, installs
with `pip --no-index --require-hashes`, checks that MLX reaches Metal and
publishes <root>/mlx with an exclusive rename. An existing installation is
reused only when its receipt names this manifest, the patch set, the copied
interpreter's bytes and the base Python it still runs on (a venv executable
re-enters its base installation: a Python upgrade that removes or changes it
makes the installation not current, so it is rebuilt instead of failing).

Ownership: <root>/.dstudio-mlx-install.lock, taken exclusively to build or
replace and held shared by every running DStudio MLX server, so a runtime in
use is never replaced. Files this helper did not publish are never removed.
Requirements: macOS 26 or later on Apple Silicon and Python 3.12-3.14.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import stat
import subprocess
import sys
import tempfile

SCRIPTS = Path(__file__).resolve().parent
ASSETS = SCRIPTS.parent
SCHEMA = 'dstudio.mlx-install.v1'
DIRECTORY, RECEIPT, LOCK = 'mlx', '.dstudio-mlx.json', '.dstudio-mlx-install.lock'
STAGE_PREFIX = '.dstudio-mlx-stage-'
PYTHON = 'venv/bin/python3'
# Versioned adaptations applied to the installed mlx-lm, in order.
PATCHES = ['patch/mlx-lm-single-model/single-model.patch',
           'patch/mlx-lm-reasoning-content/reasoning-content.patch']
# The base files the venv executes: the interpreter and, for a framework or
# shared build, the libpython it loads (resolved paths, bytes and SHA-256).
BASE_PROBE = ('import json, os, sys, sysconfig\n'
              'files = [os.path.realpath(sys._base_executable)]\n'
              'library = sysconfig.get_config_var("LDLIBRARY") or ""\n'
              'framework = sysconfig.get_config_var("PYTHONFRAMEWORKPREFIX") or ""\n'
              'libdir = sysconfig.get_config_var("LIBDIR") or ""\n'
              'path = os.path.join(framework, library) if framework and sysconfig.get_config_var("PYTHONFRAMEWORK") '
              'else os.path.join(libdir, library)\n'
              'if library and not library.endswith(".a") and os.path.isfile(path): files.append(os.path.realpath(path))\n'
              'print(json.dumps(files))')
PYTHONS = ('3.14', '3.13', '3.12')
SEARCH = ('/opt/homebrew/bin', '/usr/local/bin', '/Library/Frameworks/Python.framework/Versions/{v}/bin')


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def load_manifest(assets):
    path = assets / 'src/engines/mlx/manifest.json'
    manifest = json.loads(path.read_text())
    if manifest.get('schema') != 'dstudio.mlx-wheels.v1':
        raise RuntimeError('Unsupported bundled MLX manifest')
    return manifest, sha256(path)


def verify_wheels(assets, manifest):
    """Every bundled wheel is a regular file with its recorded bytes; no extras."""
    folder = assets / 'src/engines/mlx/wheels'
    if folder.is_symlink() or not folder.is_dir():
        raise RuntimeError('The bundled MLX wheels are missing or linked; reinstall DStudio')
    present = {p.name for p in folder.iterdir()}
    if present != set(manifest['files']):
        raise RuntimeError('The bundled MLX wheels are missing or contain unrecorded files')
    for name, meta in manifest['files'].items():
        path = folder / name
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size != meta['bytes'] or sha256(path) != meta['sha256']:
            raise RuntimeError(f'Bundled MLX wheel {name} differs from its manifest; nothing installed')
    return folder


def python_tag(version):
    return 'cp' + version.replace('.', '')


def find_python(manifest, which=shutil.which, search=SEARCH):
    """The newest installed CPython the bundled wheels were resolved for."""
    supported = [v for v in PYTHONS if v in manifest['python']]
    for version in supported:
        candidates = [which(f'python{version}') or ''] + [os.path.join(d.format(v=version), f'python{version}') for d in search]
        for candidate in candidates:
            if not candidate or not os.access(candidate, os.X_OK):
                continue
            try:
                out = subprocess.run([candidate, '-c', 'import sys,platform;print(sys.implementation.name, "%d.%d" % sys.version_info[:2], platform.machine())'],
                                     capture_output=True, text=True, timeout=20)
            except (OSError, subprocess.SubprocessError):
                continue
            if out.returncode == 0 and out.stdout.split() == ['cpython', version, 'arm64']:
                return candidate, version
    raise RuntimeError('MLX needs Python ' + ', '.join(supported) + ' (for example `brew install python@3.14`); none was found')


def requirements(manifest, version):
    """One pinned line per package with the hashes of its files usable by this Python."""
    tag = python_tag(version)
    by_name = {}
    for name, meta in manifest['files'].items():
        if meta['python'] in (tag, 'py3', 'py2.py3') or meta['abi'] == 'abi3' or meta['python'].startswith('cp3') and meta['abi'] == 'abi3':
            by_name.setdefault((meta['name'].lower(), meta['version']), []).append(meta['sha256'])
    return ''.join(f'{n}=={v} ' + ' '.join(f'--hash=sha256:{h}' for h in sorted(hs)) + '\n'
                   for (n, v), hs in sorted(by_name.items()))


def check_platform():
    if sys.platform != 'darwin' or platform.machine() != 'arm64':
        raise RuntimeError('The bundled MLX runtime needs Apple Silicon (macOS arm64)')
    major = int(platform.mac_ver()[0].split('.')[0] or 0)
    if major < 26:
        raise RuntimeError('The bundled MLX wheels need macOS 26 or later; use the llama.cpp engine on this Mac')


class Child:
    current = None
    stage = None


def stop(_signal, _frame):
    if Child.current and Child.current.poll() is None:
        Child.current.terminate()
    if Child.stage is not None:
        shutil.rmtree(Child.stage, ignore_errors=True)
    raise SystemExit(130)


def run(argv, cwd, env, log):
    print('mlx install: ' + json.dumps([str(a) for a in argv]), flush=True)
    child = subprocess.Popen([str(a) for a in argv], cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    Child.current = child
    try:
        out = child.stdout.read()
        status = child.wait()
    finally:
        Child.current = None
    log.write(out)
    if status:
        raise RuntimeError(f'Command failed ({status}): {argv[0]} {argv[1] if len(argv) > 1 else ""}\n' + out[-4000:].decode('utf-8', 'replace'))
    return out.decode('utf-8', 'replace')


def environment():
    env = {k: v for k, v in os.environ.items() if not k.startswith(('PIP_', 'PYTHON', 'VIRTUAL_ENV', 'HF_', 'DYLD_'))}
    # No index, no configuration files, no version check: nothing can be fetched.
    env.update({'PIP_NO_INDEX': '1', 'PIP_CONFIG_FILE': os.devnull, 'PIP_DISABLE_PIP_VERSION_CHECK': '1',
                'HF_HUB_OFFLINE': '1', 'PYTHONNOUSERSITE': '1'})
    return env


def read_receipt(target):
    try:
        info = (target / RECEIPT).lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > 1 << 20:
            return None
        return json.loads((target / RECEIPT).read_text())
    except (OSError, ValueError):
        return None


def base_files(paths):
    return [{'path': path, 'bytes': os.stat(path).st_size, 'sha256': sha256(path)} for path in paths]


def base_current(recorded):
    if not isinstance(recorded, list) or not recorded:
        return False
    for entry in recorded:
        try:
            info = os.stat(entry['path'])
            if not stat.S_ISREG(info.st_mode) or info.st_size != entry['bytes'] or sha256(entry['path']) != entry['sha256']:
                return False
        except (OSError, KeyError, TypeError):
            return False
    return True


def receipt_current(target, receipt, manifest_sha):
    if not receipt or receipt.get('schema') != SCHEMA or receipt.get('manifestSHA256') != manifest_sha:
        return False
    if receipt.get('patches', []) != [{'patch': rel, 'sha256': sha256(ASSETS / rel)} for rel in PATCHES]:
        return False
    if not base_current(receipt.get('base')):
        return False
    python = target / PYTHON
    try:
        info = python.lstat()
    except OSError:
        return False
    return stat.S_ISREG(info.st_mode) and info.st_size == receipt.get('pythonBytes') and sha256(python) == receipt.get('pythonSHA256')


class Busy(RuntimeError):
    pass


def lock(root, exclusive):
    import fcntl
    fd = os.open(root / LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid():
        os.close(fd)
        raise RuntimeError('The MLX installation lease is linked or not owned by this user')
    try:
        fcntl.flock(fd, (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise Busy('The MLX runtime is being installed; retry when the installation finishes'
                   if not exclusive else 'The MLX runtime is running; stop the model to update it')
    return fd


def build(root, assets, manifest, manifest_sha, wheels):
    stages = [p for p in root.iterdir() if p.name.startswith(STAGE_PREFIX)]
    if len(stages) >= 2:
        raise RuntimeError(f'Two failed MLX installations are retained in {root}; inspect or remove them first')
    stage = Path(tempfile.mkdtemp(prefix=STAGE_PREFIX, dir=root))
    Child.stage = stage
    candidate = stage / DIRECTORY
    candidate.mkdir()
    env = environment()
    try:
        python, version = find_python(manifest)
        with open(stage / 'install.log', 'wb') as log:
            # --copies: the published interpreter is a regular file whose
            # identity the launch guard can bind, not a link to a system path.
            run([python, '-m', 'venv', '--copies', candidate / 'venv'], stage, env, log)
            req = stage / 'requirements.txt'
            req.write_text(requirements(manifest, version))
            run([candidate / PYTHON, '-m', 'pip', 'install', '--no-index', '--find-links', wheels,
                 '--require-hashes', '--only-binary=:all:', '-r', req], stage, env, log)
            site = run([candidate / PYTHON, '-c', 'import sysconfig; print(sysconfig.get_paths()["purelib"])'],
                       stage, env, log).strip().splitlines()[-1]
            applied = []
            for rel in PATCHES:
                # --check first: a drifted installed file fails before any change.
                # Patches live in the support tree (beside scripts/), the wheels in --assets.
                run(['git', 'apply', '--check', '-p1', ASSETS / rel], site, env, log)
                run(['git', 'apply', '-p1', ASSETS / rel], site, env, log)
                applied.append({'patch': rel, 'sha256': sha256(ASSETS / rel)})
            base = base_files(json.loads(run([candidate / PYTHON, '-c', BASE_PROBE], stage, env, log).strip().splitlines()[-1]))
            probe = run([candidate / PYTHON, '-c', 'import mlx.core as mx, mlx_lm, importlib.metadata as m; '
                         'print(m.version("mlx"), m.version("mlx-lm"), mx.metal.is_available())'], stage, env, log)
        fields = probe.strip().splitlines()[-1].split()
        if fields != [manifest['pins']['mlx'], manifest['pins']['mlx-lm'], 'True']:
            raise RuntimeError('The installed MLX runtime does not report the pinned versions with Metal: ' + probe[-300:])
        receipt = {'schema': SCHEMA, 'engine': 'mlx', 'pins': manifest['pins'], 'manifestSHA256': manifest_sha,
                   'python': version, 'pythonSource': python, 'pythonBytes': (candidate / PYTHON).stat().st_size,
                   'pythonSHA256': sha256(candidate / PYTHON), 'base': base, 'patches': applied,
                   'network': False, 'modelLoaded': False}
        with (candidate / RECEIPT).open('x') as out:
            out.write(json.dumps(receipt, indent=1, sort_keys=True) + '\n')
            out.flush()
            os.fsync(out.fileno())
        return stage, candidate
    except BaseException as error:
        if isinstance(error, SystemExit):
            raise
        shutil.rmtree(candidate, ignore_errors=True)
        Child.stage = None
        raise RuntimeError(f'{error}\nInstall log retained: {stage / "install.log"}') from error


def install(root, assets=ASSETS):
    root = Path(root).resolve()
    if not root.is_dir():
        raise RuntimeError('The engine root is not a directory')
    check_platform()
    manifest, manifest_sha = load_manifest(assets)
    target = root / DIRECTORY
    try:
        lease, exclusive = lock(root, True), True
    except Busy as busy:
        lease, exclusive, in_use = lock(root, False), False, str(busy)
    try:
        previous = None
        if target.exists() or target.is_symlink():
            if target.is_symlink() or not target.is_dir():
                raise RuntimeError(f'{target} is not a directory DStudio installed; it is preserved')
            receipt = read_receipt(target)
            if receipt_current(target, receipt, manifest_sha):
                return {'ok': True, 'engine': 'mlx', 'dir': str(target), 'python': receipt['python'], 'built': False, 'reused': True}
            if not receipt or receipt.get('schema') != SCHEMA:
                raise RuntimeError(f'{target} contains files DStudio did not install; it is preserved')
            previous = receipt
        if not exclusive:
            raise RuntimeError(in_use)
        wheels = verify_wheels(assets, manifest)
        stage, candidate = build(root, assets, manifest, manifest_sha, wheels)
        if previous is not None:
            os.rename(target, stage / 'previous')
        os.rename(candidate, target)
        shutil.rmtree(stage)
        Child.stage = None
        return {'ok': True, 'engine': 'mlx', 'dir': str(target), 'python': read_receipt(target)['python'],
                'built': True, 'reused': False, 'replaced': previous is not None}
    finally:
        os.close(lease)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--root', type=Path)
    parser.add_argument('--assets', type=Path, default=ASSETS)
    parser.add_argument('--manifest', action='store_true', help='print the bundled pins and exit')
    args = parser.parse_args()
    if args.manifest:
        manifest, digest = load_manifest(args.assets)
        print(json.dumps({'engine': 'mlx', 'pins': manifest['pins'], 'python': manifest['python'],
                          'macos': manifest['macos'], 'manifestSHA256': digest}))
        return 0
    if not args.root:
        parser.error('--root is required')
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        print(json.dumps(install(args.root, args.assets.resolve())), flush=True)
        return 0
    except (OSError, RuntimeError) as error:
        print(f'MLX installation failed: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
