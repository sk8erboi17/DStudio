#!/usr/bin/env python3
"""Install a third-party coding-agent harness for DStudio: pi or opencode.

The pinned sources ship with DStudio (src/harness, verified against its
manifest byte for byte). Building them needs their JavaScript dependencies,
which are NOT bundled: this explicit installation is the only DStudio step that
downloads them, pinned by each project's lockfile (npm ci, bun install
--frozen-lockfile). Launching an installed harness is offline.

Layout under <root>/harness (beside ds4/ and llama.cpp/):
  bridge/            the DStudio bridge (copied from the support tree)
  pi/                the built pi workspace (sources + node_modules + dist)
  pi-ds4/            pi-ds4 with patch/harness-pi-ds4 applied
  opencode/bin/      the compiled opencode executable
  <name>/.dstudio-harness.json  receipt: pin, patches, entry-point SHA-256
Each harness is built in a private stage and published with a rename; an
existing installation is replaced only when its receipt is DStudio's. Lease:
<root>/.dstudio-harness-install.lock, exclusive and nonblocking.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bundled_engine_sources as bundled  # noqa: E402

SCRIPTS = Path(__file__).resolve().parent
SUPPORT = SCRIPTS.parent
SCHEMA = 'dstudio.harness-install.v1'
LOCK = '.dstudio-harness-install.lock'
STAGE_PREFIX = '.dstudio-harness-stage-'
BUN_VERSION = '1.3.14'  # opencode's packageManager
LOG_TAIL = 64 * 1024
PATCHES = {'pi-ds4': ['patch/harness-pi-ds4/external-server.patch'],
           'opencode': ['patch/harness-opencode/directory-confinement.patch']}
ENTRY = {'pi': 'packages/coding-agent/dist/bundle/cli.js', 'opencode': 'bin/opencode', 'pi-ds4': 'index.ts'}
BRIDGE = ('dstudio-harness.mjs', 'pi-workspace-guard.ts')


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def pin(assets, name):
    catalog, _, _ = bundled.load_catalog(assets, bundled.HARNESSES)
    entry = catalog['engines'].get(name)
    if not entry:
        raise RuntimeError(f'{name} is not a bundled harness')
    return entry['commit']


class Child:
    current = None
    stage = None


def stop(_signal, _frame):
    if Child.current and Child.current.poll() is None:
        Child.current.terminate()
        try:
            Child.current.wait(timeout=5)
        except subprocess.TimeoutExpired:
            Child.current.kill()
    if Child.stage is not None:
        shutil.rmtree(Child.stage, ignore_errors=True)
    raise SystemExit(130)


def run(argv, cwd, env, log):
    print('harness install: ' + json.dumps([str(a) for a in argv]), flush=True)
    tail = bytearray()
    child = subprocess.Popen([str(a) for a in argv], cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    Child.current = child
    try:
        for chunk in iter(lambda: child.stdout.read1(8192), b''):
            log.write(chunk)
            tail.extend(chunk)
            del tail[:-LOG_TAIL]
        status = child.wait()
    finally:
        Child.current = None
        child.stdout.close()
    if status:
        raise RuntimeError(f'Command failed ({status}): {argv[0]} {argv[1] if len(argv) > 1 else ""}\n'
                           + tail[-6000:].decode('utf-8', 'replace'))
    return tail.decode('utf-8', 'replace')


def environment(root, extra_path=()):
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(('GIT_', 'NPM_CONFIG_', 'npm_config_', 'BUN_', 'PI_', 'OPENCODE_'))}
    env['PATH'] = os.pathsep.join([*map(str, extra_path), os.environ.get('PATH', '')])
    env.update({'GIT_CEILING_DIRECTORIES': str(root), 'HUSKY': '0', 'CI': '1',
                'npm_config_audit': 'false', 'npm_config_fund': 'false', 'npm_config_update_notifier': 'false'})
    return env


def find_tool(name):
    found = shutil.which(name) or next((p for p in (f'/opt/homebrew/bin/{name}', f'/usr/local/bin/{name}')
                                        if os.access(p, os.X_OK)), None)
    if not found:
        raise RuntimeError(f'{name} is required to build this harness and was not found')
    return found


def apply_patches(name, tree, log):
    applied = []
    for rel in PATCHES.get(name, []):
        patch = SUPPORT / rel
        env = environment(tree)
        # --check first: a drifted base fails before any byte changes.
        run(['git', 'apply', '--check', '-p1', str(patch)], tree, env, log)
        run(['git', 'apply', '-p1', str(patch)], tree, env, log)
        applied.append({'patch': rel, 'sha256': sha256(patch)})
    return applied


def build_pi(tree, root, log):
    node, npm = find_tool('node'), find_tool('npm')
    env = environment(root, [Path(node).parent])
    run([npm, 'ci', '--no-audit', '--no-fund'], tree, env, log)
    run([npm, 'run', 'build'], tree, env, log)
    shutil.copy2(tree / 'packages/coding-agent/package.json', tree / 'packages/coding-agent/dist/package.json')
    version = run([node, tree / ENTRY['pi'], '--version'], tree, env, log).strip().splitlines()[-1]
    return {'version': version, 'node': run([node, '--version'], tree, env, log).strip()}


def build_opencode(tree, root, stage, log):
    node, npm = find_tool('node'), find_tool('npm')
    tools = stage / 'tools'
    tools.mkdir()
    env = environment(root, [Path(node).parent])
    # Bun from npm, pinned, private to this build; nothing is installed system-wide.
    run([npm, 'install', '--prefix', tools, '--no-audit', '--no-fund', f'bun@{BUN_VERSION}'], stage, env, log)
    bun = tools / 'node_modules/.bin/bun'
    env = environment(root, [bun.parent, Path(node).parent])
    run([bun, 'install', '--frozen-lockfile'], tree, env, log)
    models = stage / 'models-empty.json'
    models.write_text('{}')
    env.update({'MODELS_DEV_API_JSON': str(models), 'OPENCODE_CHANNEL': 'dstudio'})
    run([bun, 'run', 'script/build.ts', '--single', '--skip-embed-web-ui', '--skip-install'],
        tree / 'packages/opencode', env, log)
    built = sorted((tree / 'packages/opencode/dist').glob('opencode-*/bin/opencode'))
    if len(built) != 1:
        raise RuntimeError(f'Expected one opencode executable, found {len(built)}')
    out = stage / 'opencode'
    (out / 'bin').mkdir(parents=True)
    shutil.copy2(built[0], out / 'bin/opencode')
    for name in ('LICENSE',):
        shutil.copy2(tree / name, out / name)
    version = run([out / 'bin/opencode', '--version'], stage, env, log).strip().splitlines()[-1]
    return out, {'version': version, 'bun': BUN_VERSION}


def receipt_path(target):
    return target / '.dstudio-harness.json'


def read_receipt(target):
    try:
        info = receipt_path(target).lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > 1 << 20:
            return None
        return json.loads(receipt_path(target).read_text())
    except (OSError, ValueError):
        return None


def current(target, name, commit):
    receipt = read_receipt(target)
    if not receipt or receipt.get('schema') != SCHEMA or receipt.get('harness') != name or receipt.get('commit') != commit:
        return False
    # The exact patch set DStudio applies now, in order: a new, removed or
    # changed patch makes the installation not current.
    expected = [{'patch': rel, 'sha256': sha256(SUPPORT / rel)} for rel in PATCHES.get(name, [])]
    if receipt.get('patches', []) != expected:
        return False
    entry = target / ENTRY[name]
    return entry.is_file() and not entry.is_symlink() and sha256(entry) == receipt.get('entrySHA256')


def install_bridge(root, log):
    """The bridge is DStudio's own code: copied, never built."""
    target = root / 'harness' / 'bridge'
    sources = SUPPORT / 'src/harness/bridge'
    files = {name: sha256(sources / name) for name in BRIDGE}
    if target.is_dir() and all((target / n).is_file() and sha256(target / n) == h for n, h in files.items()):
        return {'reused': True, 'files': files}
    stage = Path(tempfile.mkdtemp(prefix=STAGE_PREFIX, dir=root / 'harness'))
    try:
        for name in BRIDGE:
            shutil.copy2(sources / name, stage / name)
        (stage / 'dstudio-harness.mjs').chmod(0o755)
        if target.exists():
            shutil.rmtree(target)
        os.rename(stage, target)
    finally:
        shutil.rmtree(stage, ignore_errors=True)
    log.write(b'bridge installed\n')
    return {'reused': False, 'files': files}


def install_one(root, assets, name, log_dir):
    commit = pin(assets, name)
    target = root / 'harness' / name
    if target.exists() and current(target, name, commit):
        return {'harness': name, 'commit': commit, 'reused': True, 'dir': str(target)}
    if target.exists() and (target.is_symlink() or (read_receipt(target) or {}).get('schema') != SCHEMA):
        raise RuntimeError(f'{target} contains files DStudio did not install; it is preserved')
    stages = list((root / 'harness').glob(STAGE_PREFIX + '*'))
    if len(stages) >= 2:
        raise RuntimeError(f'Two failed harness builds are retained in {root / "harness"}; inspect or remove them first')
    stage = Path(tempfile.mkdtemp(prefix=STAGE_PREFIX, dir=root / 'harness'))
    Child.stage = stage
    log_path = log_dir / f'{name}-build.log'
    try:
        with open(log_path, 'wb') as log:
            tree = stage / 'src'
            proof = bundled.copy_sources(assets, name, commit, tree, bundled.HARNESSES)
            bundled.verify_sources(assets, name, commit, proof, bundled.HARNESSES)
            patches = apply_patches(name, tree, log)
            details = {}
            if name == 'pi':
                details = build_pi(tree, root, log)
                published = tree
            elif name == 'opencode':
                published, details = build_opencode(tree, root, stage, log)
            else:
                published = tree
            receipt = {'schema': SCHEMA, 'harness': name, 'commit': commit, 'repository': proof.get('repository'),
                       'bundledSources': proof, 'patches': patches, 'entry': ENTRY[name],
                       'entrySHA256': sha256(published / ENTRY[name]), 'dependenciesDownloaded': name in ('pi', 'opencode'),
                       **details}
            receipt_path(published).write_text(json.dumps(receipt, indent=1, sort_keys=True) + '\n')
        previous = None
        if target.exists():
            previous = stage / 'previous'
            os.rename(target, previous)
        os.rename(published, target)
        shutil.rmtree(stage)
        Child.stage = None
        return {'harness': name, 'commit': commit, 'reused': False, 'dir': str(target), 'replaced': previous is not None,
                'log': str(log_path), **{k: v for k, v in details.items() if k in ('version',)}}
    except BaseException as error:
        if isinstance(error, SystemExit):
            raise
        for child in stage.iterdir():
            if child.is_dir():
                shutil.rmtree(child, ignore_errors=True)
        Child.stage = None
        raise RuntimeError(f'{error}\nBuild log: {log_path}') from error


def lock(root):
    import fcntl
    fd = os.open(root / LOCK, os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise RuntimeError('A harness installation is already running')
    return fd


def status(root, assets):
    rows = {}
    for name in ('pi', 'opencode', 'pi-ds4'):
        target = root / 'harness' / name
        commit = pin(assets, name)
        receipt = read_receipt(target) or {}
        rows[name] = {'installed': target.exists() and current(target, name, commit), 'commit': commit,
                      'version': receipt.get('version', ''), 'dir': str(target)}
    bridge = root / 'harness' / 'bridge'
    rows['bridge'] = {'installed': all((bridge / n).is_file() and sha256(bridge / n) == sha256(SUPPORT / 'src/harness/bridge' / n)
                                       for n in BRIDGE)}
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--root', type=Path, required=True, help='managed installation root (holds ds4/)')
    parser.add_argument('--assets', type=Path, default=SUPPORT, help='directory holding src/harness sources')
    parser.add_argument('--harness', choices=('pi', 'opencode', 'all'))
    parser.add_argument('--status', action='store_true')
    args = parser.parse_args()
    root = args.root.resolve()
    if not root.is_dir():
        print('harness installation failed: the root is not a directory', file=sys.stderr)
        return 1
    try:
        if args.status:
            print(json.dumps(status(root, args.assets.resolve())))
            return 0
        if not args.harness:
            parser.error('--harness is required')
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        (root / 'harness').mkdir(exist_ok=True)
        (root / 'harness' / 'logs').mkdir(exist_ok=True)
        fd = lock(root)
        try:
            names = ['pi', 'opencode'] if args.harness == 'all' else [args.harness]
            if 'pi' in names:
                names.append('pi-ds4')
            results = []
            with open(root / 'harness' / 'logs' / 'bridge.log', 'wb') as log:
                results.append({'harness': 'bridge', **install_bridge(root, log)})
            for name in names:
                results.append(install_one(root, args.assets.resolve(), name, root / 'harness' / 'logs'))
            print(json.dumps({'ok': True, 'results': results}), flush=True)
        finally:
            os.close(fd)
        return 0
    except (OSError, RuntimeError) as error:
        print(f'harness installation failed: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
