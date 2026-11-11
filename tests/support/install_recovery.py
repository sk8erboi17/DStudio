"""Shared pieces of the installation upgrade/recovery tests (PLAN.MD P5).

Everything here is harness: task-owned directories, explicitly simulated
toolchains and process control. The installers themselves are the production
scripts, run as real child processes.

Simulated, and labelled so in every result line:
  cmake    a shell script that configures and "builds" in milliseconds and
           emits a stand-in llama-server reporting the build number and commit
           it was configured with. Like the real one, its build step runs in a
           child "build tool" process. No compiler runs.
  python   a stand-in CPython 3.14 (venv, pip, the Metal probe). Its pip
           verifies the SHA-256 the installer required and unpacks the real
           bundled mlx-lm wheel, so the real patches are applied by real
           `git apply`; mlx itself is recorded, not installed.
Both stand-ins park at named barriers (<control>/<name>.hold -> .reached ->
.release) so a test can kill or release a real installer at a known point.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
SANDBOX = '(version 1)(allow default)(deny network-outbound (remote ip "*:*"))'
# The pin DStudio shipped before October 23, 2026 (tag b11371) and the build
# identity its macOS receipts carry (tests/unit/llama_install_profile_test.py).
EARLIER_LLAMA_PIN = '99b95488cac0f00ce3f05af113a8c1e287753f87'
EARLIER_LLAMA_BUILD = '11371'
EARLIER_LLAMA_BUILD_ID = '54bc9e1237ebc60dc4dfedb59b9f2e45221af855593f1383364304c053740871'
BARRIER_ROUNDS = 3000  # x 0.02 s: a parked stand-in gives up after a minute


def offline(argv):
    """The mechanism of the existing offline installation tests: macOS denies
    every outbound IP connection of the command and its children."""
    return ['/usr/bin/sandbox-exec', '-p', SANDBOX, *argv] if sys.platform == 'darwin' else list(argv)


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def tree(path):
    """Every entry below path with its type, mode and bytes: the comparison
    used for "byte-identical afterwards"."""
    path = Path(path)
    rows = {}
    for folder, directories, files in os.walk(path):
        for name in sorted(directories + files):
            entry = Path(folder) / name
            info = entry.lstat()
            key = str(entry.relative_to(path))
            if stat.S_ISLNK(info.st_mode):
                rows[key] = ('link', os.readlink(entry))
            elif stat.S_ISDIR(info.st_mode):
                rows[key] = ('dir', stat.S_IMODE(info.st_mode))
            else:
                rows[key] = ('file', stat.S_IMODE(info.st_mode), info.st_size, sha256(entry))
    return rows


class Profile:
    """A task-owned profile with user bytes an installation must never touch:
    settings, a project, saved sessions, model files and a model-keyed KV cache.
    The model files are tiny stand-ins, never weights."""
    USER = ('ds4web-store.json', 'engine-checkout', 'projects', 'sessions', 'ds4', 'ds4-kv')

    def __init__(self, root):
        self.root = Path(root)
        files = {
            'ds4web-store.json': json.dumps({'rev': 7, 'settings': {'theme': 'dark', 'ctx': 32768},
                                             'conversations': [{'id': 'c1', 'title': 'Saved session', 'turns': 4}]}),
            'engine-checkout': str(self.root / 'ds4') + '\n',
            'projects/site one/index.html': '<h1>User project</h1>\n',
            'projects/site one/notes.md': 'draft kept across upgrades\n',
            'sessions/agent 0001.jsonl': '{"role":"user","content":"saved turn"}\n',
            'ds4/Makefile': 'all:\n\t@false\n',
            'ds4/gguf/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf': 'stand-in bytes, not weights (qwen36)\n',
            'ds4/gguf/Qwen3.8-27B-UD-Q6_K_XL.gguf': 'stand-in bytes, not weights (qwen27)\n',
            'ds4/gguf/Qwen3.8-27B-mmproj-F16.gguf': 'stand-in bytes, not a projector\n',
            'ds4/mlx/Qwen3.6-35B-A3B-mxfp8/config.json': '{"model_type": "stand-in"}\n',
            'ds4/mlx/Qwen3.6-35B-A3B-mxfp8/model-00001-of-00008.safetensors': 'stand-in bytes, not weights (mlx)\n',
            'ds4-kv/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf/0001.kv': 'stand-in KV snapshot keyed by its model\n',
        }
        for name, text in files.items():
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text)
        self.before = self.user_bytes()

    def user_bytes(self):
        return {name: tree(self.root / name) if (self.root / name).is_dir() else ('file', sha256(self.root / name))
                for name in self.USER}

    def unchanged(self):
        return self.user_bytes() == self.before

    def others(self, allowed=()):
        """Entries of the root that are neither user data nor expected installer output."""
        return sorted(p.name for p in self.root.iterdir() if p.name not in self.USER and p.name not in allowed)


class Control:
    """Barriers and failure switches shared with the stand-in tools."""
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)

    def path(self, name):
        return self.directory / name

    def touch(self, name, text=''):
        self.path(name).write_text(text)

    def hold(self, name):
        self.touch(name + '.hold')

    def release(self, name):
        self.touch(name + '.release')

    def fail(self, name):
        self.touch(name + '.fail')

    def reached(self, name, process=None, timeout=20):
        """Wait until a tool or installer parked at the barrier. Not a timing
        assertion: the barrier itself decides where the process stands."""
        deadline = time.monotonic() + timeout
        target = self.path(name + '.reached')
        while not target.exists():
            if process is not None and process.poll() is not None:
                raise AssertionError(f'the process exited ({process.returncode}) before barrier {name}')
            if time.monotonic() > deadline:
                raise AssertionError(f'barrier {name} was not reached')
            time.sleep(0.005)
        return target.read_text().strip()

    def reset(self):
        for entry in self.directory.iterdir():
            if entry.is_file():
                entry.unlink()

    def env(self, *failpoints):
        """Environment for installer failpoints (scripts/bundled_engine_sources.py)."""
        return {'DSTUDIO_INSTALL_FAILPOINT': ','.join(failpoints) + ':' + str(self.directory)} if failpoints else {}


_BARRIER = '''barrier() {
  [ -e "$CONTROL/$1.hold" ] || return 0
  echo $$ > "$CONTROL/$1.reached"
  rounds=0
  while [ ! -e "$CONTROL/$1.release" ]; do
    rounds=$((rounds + 1))
    [ "$rounds" -gt %d ] && exit 97
    sleep 0.02
  done
}
''' % BARRIER_ROUNDS

_SERVER = '''#!/bin/sh
# Stand-in llama-server emitted by the test toolchain. It serves no model.
CONTROL='@CONTROL@'
''' + _BARRIER + '''case "$1" in
--version)
  barrier server-version
  echo "version: @NUMBER@ (@COMMIT@)"
  echo "built with the DStudio test stand-in (build @NUMBER@, commit @COMMIT@)"
  exit 0;;
esac
echo "$$ build @NUMBER@ commit @COMMIT@" > "$CONTROL/server.started"
trap 'echo term > "$CONTROL/server.stopped"; exit 0' TERM
rounds=0
while [ "$rounds" -lt 1200 ]; do rounds=$((rounds + 1)); sleep 0.05; done
'''

_CMAKE = '''#!/bin/sh
# Stand-in for CMake in the installation recovery tests: no compiler runs.
CONTROL='@CONTROL@'
TEMPLATE='@TEMPLATE@'
''' + _BARRIER + '''case "$1" in
--version)
  barrier cmake-version
  echo "cmake version 0.0.0 (DStudio test stand-in)"
  exit 0;;
-S)
  barrier cmake-configure
  if [ -e "$CONTROL/cmake-configure.fail" ]; then echo "CMake Error: stand-in configure failure" >&2; exit 1; fi
  mkdir -p "$4" || exit 1
  : > "$4/identity"
  for option in "$@"; do
    case "$option" in -DLLAMA_BUILD_NUMBER=*|-DLLAMA_BUILD_COMMIT=*) echo "$option" >> "$4/identity";; esac
  done
  [ -f "$2/CMakeLists.txt" ] || { echo "CMake Error: no CMakeLists.txt in $2" >&2; exit 1; }
  echo "configured from $2" > "$4/CMakeCache.txt"
  exit 0;;
--build)
  if [ "$STANDIN_BUILD_TOOL" != 1 ]; then
    # As the real `cmake --build`: the work runs in a child build tool (make)
    # that a signal to this process alone does not stop (observed with the
    # real CMake 4.4 and make: they keep building, reparented to launchd).
    STANDIN_BUILD_TOOL=1 /bin/sh "$0" "$@" &
    wait $!
    exit $?
  fi
  build="$2"
  number=$(sed -n 's/^-DLLAMA_BUILD_NUMBER=//p' "$build/identity")
  commit=$(sed -n 's/^-DLLAMA_BUILD_COMMIT=//p' "$build/identity")
  mkdir -p "$build/bin" "$build/objects"
  echo "partial object" > "$build/objects/server.o"
  # A link in progress: present, executable and not yet a server.
  printf '#!/bin/sh\\necho "truncated link output"\\nexit 70\\n' > "$build/bin/llama-server"
  chmod 755 "$build/bin/llama-server"
  barrier cmake-build
  if [ -e "$CONTROL/cmake-build.bytes" ]; then
    # A large object file, as a real compiler writes one: on a full disk the write fails.
    head -c "$(cat "$CONTROL/cmake-build.bytes")" /dev/zero > "$build/objects/large.o" ||
      { echo "stand-in compiler: error: cannot write $build/objects/large.o" >&2; exit 1; }
  fi
  if [ -e "$CONTROL/cmake-build.fail" ]; then echo "stand-in compiler: error: build failure" >&2; exit 2; fi
  if [ -e "$CONTROL/cmake-build.noserver" ]; then rm -f "$build/bin/llama-server"; exit 0; fi
  if [ -e "$CONTROL/cmake-build.wrongbuild" ]; then number=1; fi
  sed -e "s/@NUMBER@/$number/g" -e "s/@COMMIT@/$commit/g" "$TEMPLATE" > "$build/bin/llama-server.new" || exit 1
  chmod 755 "$build/bin/llama-server.new"
  mv "$build/bin/llama-server.new" "$build/bin/llama-server"
  exit 0;;
esac
echo "stand-in cmake: unexpected arguments: $*" >&2
exit 64
'''


def standin_cmake(directory, control):
    """Write the stand-in cmake and return its path (for DSTUDIO_CMAKE)."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    template = directory / 'llama-server.template'
    template.write_text(_SERVER.replace('@CONTROL@', str(control.directory)))
    cmake = directory / 'cmake'
    cmake.write_text(_CMAKE.replace('@CONTROL@', str(control.directory)).replace('@TEMPLATE@', str(template)))
    cmake.chmod(0o755)
    return cmake


_PYTHON = r'''"""Stand-in CPython 3.14 for the MLX installation recovery tests.
Implements only what scripts/install-mlx.py asks of an interpreter."""
import hashlib, json, os, re, signal, sys, time, zipfile
from pathlib import Path

CONTROL = Path(@CONTROL@)
SELF = Path(sys.argv[1])
ARGS = sys.argv[2:]


def barrier(name):
    if not (CONTROL / (name + '.hold')).exists():
        return
    (CONTROL / (name + '.reached')).write_text(str(os.getpid()))
    for _ in range(@ROUNDS@):
        if (CONTROL / (name + '.release')).exists():
            return
        time.sleep(0.02)
    sys.exit(97)


def venv_root():
    root = SELF.parent.parent
    return root if (root / 'pyvenv.cfg').is_file() else None


def site():
    return venv_root() / 'lib' / 'python3.14' / 'site-packages'


def installed():
    return {p.name[:-len('.dist-info')].rsplit('-', 1)[0]: p.name[:-len('.dist-info')].rsplit('-', 1)[1]
            for p in site().glob('*.dist-info')}


def normal(name):
    return re.sub(r'[-_.]+', '_', name).lower()


def pip(args):
    if os.environ.get('PIP_NO_INDEX') != '1' or '--no-index' not in args or '--require-hashes' not in args:
        sys.exit('stand-in pip: the installer did not forbid the package index')
    wheels = Path(args[args.index('--find-links') + 1])
    wanted = Path(args[args.index('-r') + 1]).read_text().splitlines()
    if (CONTROL / 'pip-install.slowterm').exists():
        packages = site()

        def slow_stop(*_):  # a tool that keeps writing into its tree while it shuts down
            for index in range(40):
                (packages / f'late-{index}').mkdir(parents=True, exist_ok=True)
                (packages / f'late-{index}' / 'written-after-sigterm').write_text('x')
                time.sleep(0.01)
            (CONTROL / 'pip-install.slowterm.done').write_text('done')
            os._exit(143)
        signal.signal(signal.SIGTERM, slow_stop)
    done = 0
    for line in wanted:
        requirement, *hashes = line.split()
        name, version = requirement.split('==')
        allowed = {h.split(':', 1)[1] for h in hashes}
        match = None
        for wheel in sorted(wheels.iterdir()):
            parts = wheel.name.split('-')
            if normal(parts[0]) == normal(name) and parts[1] == version and \
                    hashlib.sha256(wheel.read_bytes()).hexdigest() in allowed:
                match = wheel
                break
        if match is None:
            sys.exit(f'ERROR: No matching distribution found for {requirement} (stand-in pip, hashes required)')
        if normal(name) == 'mlx_lm':
            with zipfile.ZipFile(match) as archive:  # the real package: the patches apply to it
                archive.extractall(site())
        else:
            (site() / f'{normal(name)}-{version}.dist-info').mkdir(parents=True, exist_ok=True)
        done += 1
        if done == 2:
            barrier('pip-install')  # two packages installed, the rest not yet
            if (CONTROL / 'pip-install.fail').exists():
                sys.exit('ERROR: stand-in pip failure after two packages')
    print(f'Successfully installed {done} packages (stand-in pip, nothing fetched)')


def serve():
    text = (site() / 'mlx_lm' / 'server.py').read_text()
    markers = [m for m in ('DSTUDIO_MLX_SINGLE_MODEL', 'DSTUDIO_MLX_REASONING_CONTENT', 'DSTUDIO_MLX_TOOL_STREAM') if m in text]
    (CONTROL / 'server.started').write_text(json.dumps({'pid': os.getpid(), 'markers': markers, 'packages': installed()}))

    def stop(*_):
        (CONTROL / 'server.stopped').write_text('term')
        sys.exit(0)
    signal.signal(signal.SIGTERM, stop)
    for _ in range(1200):
        time.sleep(0.05)


def main():
    if ARGS[:2] == ['-m', 'venv']:
        barrier('venv')
        if (CONTROL / 'venv.fail').exists():
            sys.exit('Error: stand-in venv failure')
        target = Path(ARGS[-1])
        (target / 'bin').mkdir(parents=True)
        (target / 'lib' / 'python3.14' / 'site-packages').mkdir(parents=True)
        (target / 'pyvenv.cfg').write_text(f'home = {SELF.parent}\nbase = {SELF}\nversion = 3.14.0\n')
        data = SELF.read_bytes()  # --copies: a regular file, not a link
        (target / 'bin' / 'python3').write_bytes(data)
        (target / 'bin' / 'python3').chmod(0o755)
        return
    if ARGS[:2] == ['-m', 'pip']:
        return pip(ARGS[2:])
    if ARGS[:3] == ['-m', 'mlx_lm', 'server']:
        return serve()
    if ARGS[:1] == ['-c']:
        code = ARGS[1]
        if 'sys.implementation.name' in code:
            print('cpython 3.14 arm64')
        elif 'get_paths' in code:
            print(site())
        elif '_base_executable' in code:
            base = [line.split('=', 1)[1].strip() for line in (venv_root() / 'pyvenv.cfg').read_text().splitlines()
                    if line.startswith('base =')][0]
            print(json.dumps([os.path.realpath(base)]))
        elif 'metal.is_available' in code:
            barrier('metal-probe')
            packages = installed()
            metal = not (CONTROL / 'metal-probe.nometal').exists()
            print(packages.get('mlx', '?'), packages.get('mlx_lm', '?'), metal)
        else:
            sys.exit('stand-in python: unexpected -c program')
        return
    sys.exit(f'stand-in python: unexpected arguments {ARGS}')


main()
'''


def standin_python(directory, control, name='python3.14'):
    """Write a stand-in interpreter into a private bin directory; returns that
    directory (to be put first on PATH)."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    program = directory / 'standin_python.py'
    program.write_text(_PYTHON.replace('@CONTROL@', repr(str(control.directory))).replace('@ROUNDS@', str(BARRIER_ROUNDS)))
    interpreter = directory / name
    # $0 tells the program which copy runs: the base file or a venv's python3.
    interpreter.write_text(f'#!/bin/sh\nexec {quote(sys.executable)} {quote(str(program))} "$0" "$@"\n')
    interpreter.chmod(0o755)
    return directory


def quote(text):
    assert "'" not in text, text
    return "'" + text + "'"


def source_snapshot(assets, pin, files=None, repository='https://github.com/ggml-org/llama.cpp'):
    """A small llama.cpp-shaped source snapshot with a valid bundled manifest."""
    files = files or {'CMakeLists.txt': 'project(standin)\n', 'LICENSE': 'MIT (fixture)\n',
                      'tools/server/server.cpp': '// fixture source, never compiled\n'}
    tree_root = Path(assets) / 'src/engines/llama.cpp'
    inventory = {}
    for name, text in files.items():
        target = tree_root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        target.chmod(0o644)
        inventory[name] = {'sha256': hashlib.sha256(text.encode()).hexdigest(), 'bytes': len(text.encode()), 'executable': False}
    manifest = {'schema': 'dstudio.engine-sources.v1', 'engines': {'llama': {
        'repository': repository, 'commit': pin, 'directory': 'llama.cpp', 'historical': False, 'files': inventory}}}
    (Path(assets) / 'src/engines/manifest.json').write_text(json.dumps(manifest))
    return tree_root


def support_tree(directory, pin):
    """What the app materializes beside its engines: the production installer
    scripts, copied byte for byte, next to a (small) bundled snapshot."""
    directory = Path(directory)
    (directory / 'scripts').mkdir(parents=True)
    (directory / 'extension').mkdir()
    for name in ('install-llama.py', 'install-mlx.py', 'bundled_engine_sources.py'):
        shutil.copy2(ROOT / 'scripts' / name, directory / 'scripts' / name)
    source_snapshot(directory, pin)
    return directory


class Run:
    """One real child process in its own process group, output kept in files."""
    def __init__(self, argv, log, env=None, cwd=None, stdin=subprocess.DEVNULL, pass_fds=()):
        self.log = Path(log)
        self.out = open(str(self.log) + '.out', 'wb')
        self.err = open(str(self.log) + '.err', 'wb')
        self.process = subprocess.Popen([str(a) for a in argv], stdin=stdin, stdout=self.out, stderr=self.err,
                                        env=env, cwd=cwd, start_new_session=True, pass_fds=pass_fds)
        self.pid = self.process.pid

    def wait(self, timeout=120):
        try:
            code = self.process.wait(timeout=timeout)
        finally:
            self.out.close()
            self.err.close()
        return code

    def text(self):
        return (Path(str(self.log) + '.out').read_text(errors='replace'),
                Path(str(self.log) + '.err').read_text(errors='replace'))

    def signal_group(self, number):
        try:
            os.killpg(self.pid, number)
        except ProcessLookupError:
            pass

    def kill_group(self):
        self.signal_group(signal.SIGKILL)
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass
        for stream in (self.out, self.err):
            if not stream.closed:
                stream.close()


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def group_members(pgid):
    """PIDs still in a process group (ps is the observation, not a signal)."""
    listing = subprocess.run(['ps', '-A', '-o', 'pid=,pgid=,stat='], capture_output=True, text=True).stdout
    members = []
    for line in listing.splitlines():
        parts = line.split()
        if len(parts) >= 3 and parts[1] == str(pgid) and not parts[2].startswith('Z'):
            members.append(int(parts[0]))
    return members


def until(check, message, timeout=20):
    deadline = time.monotonic() + timeout
    while True:
        value = check()
        if value:
            return value
        if time.monotonic() > deadline:
            raise AssertionError(message)
        time.sleep(0.01)


def launch_identity(path):
    """The host's launch_identity(): dev:ino:size:mtime:mtime_ns:ctime:ctime_ns."""
    info = os.stat(path)
    return ':'.join(str(v) for v in (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns // 10**9,
                                     info.st_mtime_ns % 10**9, info.st_ctime_ns // 10**9, info.st_ctime_ns % 10**9))


class Cases:
    """Collects named results, keeps every failure and writes one receipt."""
    def __init__(self, title, run, scope):
        self.title, self.run, self.scope, self.rows = title, Path(run), scope, []

    def check(self, name, function):
        row = {'name': name}
        started = time.time()
        try:
            row.update(function() or {})
            row['status'] = 'PASS'
        except Exception as error:  # noqa: BLE001 - every failure is retained
            row['status'] = 'FAIL'
            row['error'] = f'{type(error).__name__}: {error}'
        row['seconds'] = round(time.time() - started, 2)
        self.rows.append(row)
        print(f"{row['status']} {name}" + (f"\n  {row['error']}" if 'error' in row else ''), flush=True)
        return row['status'] == 'PASS'

    def finish(self):
        passed = sum(row['status'] == 'PASS' for row in self.rows)
        (self.run / 'results.json').write_text(json.dumps({'scope': self.scope, 'cases': self.rows}, indent=1, default=str))
        print(f'{self.title}: {passed}/{len(self.rows)} passed ({self.scope}); receipts: {self.run}')
        return 0 if passed == len(self.rows) and self.rows else 1


LLAMA_EARLIER_DRIVER = '''
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('install_llama', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
number, commit = m.BUILD_NUMBER, m.PIN[:7]
m.PIN, m.BUILD_NUMBER, m.ASSETS = sys.argv[3], sys.argv[4], Path(sys.argv[5])
m.CMAKE_OPTIONS = tuple(o.replace('=' + number, '=' + m.BUILD_NUMBER).replace('=' + commit, '=' + m.PIN[:7])
                        for o in m.CMAKE_OPTIONS)
print(json.dumps(m.install(sys.argv[2])))
'''


def earlier_llama(root, earlier_bundle, env):
    """The b11371 runtime as the previous DStudio left it: the production
    installer driven at the earlier pin against an earlier (fixture) snapshot.
    Its receipt carries the build identity real b11371 receipts have."""
    done = subprocess.run(offline([sys.executable, '-c', LLAMA_EARLIER_DRIVER, str(ROOT / 'scripts/install-llama.py'), str(root),
                                   EARLIER_LLAMA_PIN, EARLIER_LLAMA_BUILD, str(earlier_bundle)]),
                          capture_output=True, text=True, env=env)
    if done.returncode:
        raise AssertionError(done.stderr[-1500:])
    receipt = json.loads((Path(root) / 'llama.cpp/.dstudio-llama.json').read_text())
    assert (receipt['commit'], receipt['buildNumber'], receipt['buildId']) == \
        (EARLIER_LLAMA_PIN, EARLIER_LLAMA_BUILD, EARLIER_LLAMA_BUILD_ID), receipt
    return receipt


def main():
    """Fixtures for the host HTTP test, which is written in JavaScript:
      llama-host <run> <pin>       control, stand-in cmake and a support tree
      llama-earlier <run> <root>   install the earlier runtime into <root>
      tree <directory>             byte digest of a tree, as JSON
      lease-free <lock file>       exit 0 when nobody holds it"""
    command, arguments = sys.argv[1], sys.argv[2:]
    if command == 'llama-host':
        run, pin = Path(arguments[0]), arguments[1]
        control = Control(run / 'control')
        cmake = standin_cmake(run / 'toolchain', control)
        support = support_tree(run / 'support tree', pin)
        # What the host requires of a support directory before it accepts it.
        for name in ('src/harness/design/build-design.sh', 'scripts/apply-ds4-visible-downloads.sh'):
            (support / name).parent.mkdir(parents=True, exist_ok=True)
            (support / name).write_text('#!/bin/sh\nexit 0\n')
        source_snapshot(run / 'earlier bundle', EARLIER_LLAMA_PIN)
        print(json.dumps({'control': str(control.directory), 'cmake': str(cmake), 'support': str(support),
                          'earlierPin': EARLIER_LLAMA_PIN, 'earlierBuildId': EARLIER_LLAMA_BUILD_ID}))
    elif command == 'llama-earlier':
        run, root = Path(arguments[0]), Path(arguments[1])
        env = {**os.environ, 'DSTUDIO_CMAKE': str(run / 'toolchain/cmake')}
        print(json.dumps(earlier_llama(root, run / 'earlier bundle', env)))
    elif command == 'tree':
        print(json.dumps(tree(arguments[0]), sort_keys=True))
    elif command == 'lease-free':
        import fcntl
        fd = os.open(arguments[0], os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 1
        finally:
            os.close(fd)
    else:
        raise SystemExit(main.__doc__)
    return 0


if __name__ == '__main__':
    sys.exit(main())
