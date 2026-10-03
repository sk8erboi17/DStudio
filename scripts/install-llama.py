#!/usr/bin/env python3
"""Install DStudio's bundled llama.cpp server; never fetch sources or models.

Copies the pinned snapshot in src/engines/llama.cpp into a private stage,
builds llama-server (no web UI, no HTTPS) with network access unused, verifies
it and publishes <root>/llama.cpp with an exclusive rename. An existing
installation is reused only when its receipt names this pin, these build
options and the current bytes of every published file.

Two layouts, chosen per platform (the Ollama approach on Linux/Windows):
  static   macOS: one Metal executable. This is the tested configuration.
  dynamic  Linux/Windows: shared libllama/libggml plus one loadable module per
           backend (GGML_BACKEND_DL). Every CPU variant is built; ggml loads
           the best one for the actual processor at startup. CUDA, ROCm/HIP and
           Vulkan modules are built when their toolchain is found (or requested
           with DSTUDIO_LLAMA_BACKENDS=cpu,cuda,hip,vulkan; a requested backend
           without its toolchain fails, it is never silently dropped). The
           server picks the devices it can open. NOT TESTED on Linux/Windows
           hardware: only the macOS dynamic build is exercised by the tests.

Ownership: <root>/.dstudio-llama-install.lock. Installation takes it
exclusively without waiting; every running DStudio llama-server holds it
shared, so an engine in use is never replaced. Files this installer did not
publish are never removed. At most two failed stages are kept for review.
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

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bundled_engine_sources as bundled  # noqa: E402

PIN = '99b95488cac0f00ce3f05af113a8c1e287753f87'
BUILD_NUMBER = '11371'  # upstream tag b11371 at PIN
ENGINE, DIRECTORY = 'llama', 'llama.cpp'
ASSETS = Path(__file__).resolve().parent.parent
RECEIPT = '.dstudio-llama.json'
LOCK = '.dstudio-llama-install.lock'
STAGE_PREFIX = '.dstudio-llama-stage-'
LOG_TAIL = 64 * 1024
PROBE_LIMIT = 16 * 1024
COMMON = (
    '-DLLAMA_BUILD_TESTS=OFF', '-DLLAMA_BUILD_EXAMPLES=OFF', '-DLLAMA_BUILD_TOOLS=ON',
    '-DLLAMA_BUILD_SERVER=ON', '-DLLAMA_BUILD_APP=OFF',
    # The web UI is either built with npm or downloaded: neither is allowed.
    '-DLLAMA_BUILD_UI=OFF', '-DLLAMA_USE_PREBUILT_UI=OFF', '-DLLAMA_OPENSSL=OFF',
)
# The snapshot has no Git metadata; never read the enclosing repository's.
IDENTITY = (f'-DLLAMA_BUILD_NUMBER={BUILD_NUMBER}', f'-DLLAMA_BUILD_COMMIT={PIN[:7]}')
# macOS: every option that changes the produced server, in its original order
# so existing receipts stay valid. Another set is another build.
CMAKE_OPTIONS = ('-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', *COMMON,
                 '-DGGML_METAL=ON', '-DGGML_METAL_EMBED_LIBRARY=ON', '-DGGML_NATIVE=ON', *IDENTITY)
BACKENDS = ('cpu', 'metal', 'cuda', 'hip', 'vulkan')
# Used only when no AMD GPU is visible at build time (amdgpu-arch absent or
# silent); ROCm 6 targets as in Ollama's release builds.
HIP_DEFAULT_TARGETS = ('gfx900;gfx906:xnack-;gfx908:xnack-;gfx90a:xnack+;gfx90a:xnack-;gfx940;gfx941;'
                       'gfx942;gfx1010;gfx1012;gfx1030;gfx1100;gfx1101;gfx1102;gfx1151;gfx1200;gfx1201')
CMAKE_PATHS = ('/opt/homebrew/bin/cmake', '/usr/local/bin/cmake', '/usr/bin/cmake',
               '/Applications/CMake.app/Contents/bin/cmake',
               r'C:\Program Files\CMake\bin\cmake.exe')


def build_id(options, layout):
    # The static form is the original identity of every earlier receipt.
    if layout == 'static':
        return hashlib.sha256(json.dumps([PIN, list(options), 'llama-server']).encode()).hexdigest()
    return hashlib.sha256(json.dumps([PIN, list(options), 'llama-server', layout]).encode()).hexdigest()


BUILD_ID = build_id(CMAKE_OPTIONS, 'static')


class Profile:
    """One complete build recipe: layout, ordered options and build environment."""
    def __init__(self, layout, backends, options, env=None, windows=False):
        self.layout, self.backends, self.options = layout, tuple(backends), tuple(options)
        self.env = dict(env or {})
        self.windows = windows
        self.binary = 'bin/llama-server.exe' if windows else 'bin/llama-server'
        self.build_id = build_id(self.options, layout)

    def manifest(self):
        return {'layout': self.layout, 'backends': list(self.backends), 'cmakeOptions': list(self.options),
                'buildId': self.build_id, 'binary': self.binary}


def static_profile():
    return Profile('static', ('metal',), CMAKE_OPTIONS)


def executable(path):
    return bool(path) and os.path.isfile(path) and os.access(path, os.X_OK)


def first_tool(names, directories, which):
    for name in names:
        found = which(name)
        if executable(found):
            return found
        for directory in directories:
            if directory and executable(os.path.join(directory, name)):
                return os.path.join(directory, name)
    return None


def probe(argv, env, timeout=20):
    """Bounded toolchain query: a missing or broken tool reads as absent."""
    try:
        done = subprocess.run(argv, env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return None
    return done.stdout[:PROBE_LIMIT].decode('utf-8', 'replace').strip() if done.returncode == 0 else None


def detect_toolchains(env, system, which, run=probe):
    """Toolchains present on this machine, without building anything."""
    exe = '.exe' if system == 'windows' else ''
    found = {}
    cuda_roots = [env.get('CUDA_PATH', ''), env.get('CUDA_HOME', '')]
    if system == 'linux':
        cuda_roots += ['/usr/local/cuda', '/opt/cuda']
    nvcc = first_tool(['nvcc' + exe], [os.path.join(r, 'bin') for r in cuda_roots if r], which)
    if nvcc:
        found['cuda'] = {'compiler': nvcc, 'options': ('-DGGML_CUDA=ON', f'-DCMAKE_CUDA_COMPILER={nvcc}'), 'env': {}}
    rocm_roots = [env.get('ROCM_PATH', ''), env.get('HIP_PATH', '')] + (['/opt/rocm'] if system == 'linux' else [])
    hipconfig = first_tool(['hipconfig' + exe, 'hipconfig.bat', 'hipconfig'],
                           [os.path.join(r, 'bin') for r in rocm_roots if r], which)
    if hipconfig:
        # llama.cpp's documented HIP build: HIPCXX=<hipconfig -l>/clang, HIP_PATH=<hipconfig -R>.
        clang_dir, hip_root = run([hipconfig, '-l'], env), run([hipconfig, '-R'], env)
        if clang_dir and hip_root:
            hipcxx = os.path.join(clang_dir, 'clang' + exe)
            arch_tool = first_tool(['amdgpu-arch' + exe], [clang_dir], which)
            listed = run([arch_tool], env) if arch_tool else None
            targets = sorted({line.strip() for line in (listed or '').splitlines() if line.strip().startswith('gfx')})
            gpu_targets = ';'.join(targets) or HIP_DEFAULT_TARGETS
            found['hip'] = {'compiler': hipcxx, 'options': ('-DGGML_HIP=ON', f'-DGPU_TARGETS={gpu_targets}'),
                            'env': {'HIPCXX': hipcxx, 'HIP_PATH': hip_root}}
    sdk = env.get('VULKAN_SDK', '')
    glslc = first_tool(['glslc' + exe], [os.path.join(sdk, 'bin')] if sdk else [], which)
    headers = (sdk and os.path.isfile(os.path.join(sdk, 'include', 'vulkan', 'vulkan.h'))) or \
        (system == 'linux' and os.path.isfile('/usr/include/vulkan/vulkan.h'))
    if glslc and headers:
        found['vulkan'] = {'compiler': glslc, 'options': ('-DGGML_VULKAN=ON',), 'env': {}}
    return found


def dynamic_profile(system=None, machine=None, env=None, which=shutil.which, requested=None, run=probe):
    """The portable layout: shared libraries plus one module per backend."""
    env = os.environ if env is None else env
    system = system or {'darwin': 'darwin', 'win32': 'windows'}.get(sys.platform, sys.platform)
    machine = (machine or platform.machine()).lower()
    if requested is None:
        requested = env.get('DSTUDIO_LLAMA_BACKENDS', '')
    names = [n.strip() for n in requested.split(',') if n.strip()] if requested else []
    unknown = [n for n in names if n not in BACKENDS]
    if unknown:
        raise RuntimeError('Unknown llama.cpp backend(s) in DSTUDIO_LLAMA_BACKENDS: ' + ', '.join(unknown))
    toolchains = detect_toolchains(env, system, which, run) if system != 'darwin' else {}
    if names:
        missing = [n for n in names if n not in ('cpu', 'metal') and n not in toolchains]
        if missing:
            raise RuntimeError('Requested llama.cpp backend(s) without a toolchain on this machine: ' +
                               ', '.join(missing) + ' (install the SDK or remove it from DSTUDIO_LLAMA_BACKENDS)')
        if 'metal' in names and system != 'darwin':
            raise RuntimeError('The Metal backend exists only on macOS')
        chosen = ['cpu'] + [n for n in BACKENDS[1:] if n in names]
    else:
        chosen = ['cpu'] + (['metal'] if system == 'darwin' else [n for n in ('cuda', 'hip', 'vulkan') if n in toolchains])
    options = ['-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=ON', *COMMON,
               '-DGGML_BACKEND_DL=ON', '-DGGML_NATIVE=OFF',
               # Unversioned names: plain files, no symlink chains to publish.
               '-DCMAKE_PLATFORM_NO_VERSIONED_SONAME=ON']
    # ggml has CPU variant sets for x86-64 everywhere and for ARM on Linux/macOS.
    x86 = machine in ('x86_64', 'amd64')
    arm = machine in ('arm64', 'aarch64')
    if x86 or (arm and system in ('linux', 'darwin')):
        options.append('-DGGML_CPU_ALL_VARIANTS=ON')
    if system == 'linux':
        options += ['-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON', '-DCMAKE_INSTALL_RPATH=$ORIGIN']
    elif system == 'darwin':
        options += ['-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON', '-DCMAKE_INSTALL_RPATH=@loader_path']
    options += ['-DGGML_METAL=ON', '-DGGML_METAL_EMBED_LIBRARY=ON'] if 'metal' in chosen else ['-DGGML_METAL=OFF']
    build_env = {}
    for name in chosen[1:]:
        if name == 'metal':
            continue
        options += list(toolchains[name]['options'])
        build_env.update(toolchains[name]['env'])
    options += list(IDENTITY)
    return Profile('dynamic', chosen, options, build_env, windows=system == 'windows')


def default_profile():
    return static_profile() if sys.platform == 'darwin' else dynamic_profile()


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def find_cmake():
    """A Finder-launched app has a minimal PATH: also look where installers put cmake."""
    explicit = os.environ.get('DSTUDIO_CMAKE', '')
    for candidate in ([explicit] if explicit else []) + [shutil.which('cmake') or ''] + list(CMAKE_PATHS):
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    raise RuntimeError('CMake is required to build the llama.cpp engine and was not found. '
                       'Install it (for example `brew install cmake` or your package manager), then retry.')


class Child:
    """One build command in this process group. The launch owner stops the whole
    group on cancellation; SIGTERM to this installer also stops the command."""
    current = None
    stage = None


def stop(_signal, _frame):
    if Child.current and Child.current.poll() is None:
        Child.current.terminate()
        try:
            Child.current.wait(timeout=3)
        except subprocess.TimeoutExpired:
            Child.current.kill()
    # A canceled build has nothing to review: never leave it counting toward
    # the retained-failure limit.
    if Child.stage is not None:
        shutil.rmtree(Child.stage, ignore_errors=True)
    raise SystemExit(130)


def run(argv, cwd, env, log):
    print('llama install: ' + json.dumps(argv), flush=True)
    tail = bytearray()
    child = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
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
                           + tail[-8192:].decode('utf-8', 'replace'))
    return tail.decode('utf-8', 'replace')


def build_environment(root, cmake, profile):
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(('GIT_', 'CMAKE_', 'GGML_', 'LLAMA_', 'DYLD_', 'LD_'))
           and key not in ('CC', 'CXX', 'CFLAGS', 'CXXFLAGS', 'LDFLAGS', 'MAKEFLAGS', 'SDKROOT', 'HIPCXX')}
    if os.name == 'nt':
        # MSVC, MSYS2, CUDA and the Vulkan SDK are all located through PATH.
        env['PATH'] = os.pathsep.join([str(Path(cmake).parent), os.environ.get('PATH', '')])
    else:
        tools = [str(Path(cmake).parent)]
        for value in profile.options:
            if value.startswith('-DCMAKE_CUDA_COMPILER='):
                tools.append(str(Path(value.split('=', 1)[1]).parent))
        tools += [str(Path(profile.env['HIPCXX']).parent)] if 'HIPCXX' in profile.env else []
        env['PATH'] = os.pathsep.join(tools + ['/usr/bin', '/bin', '/usr/sbin', '/sbin'])
    env.update(profile.env)
    env['GIT_CEILING_DIRECTORIES'] = str(root)
    return env


def read_receipt(target):
    path = target / RECEIPT
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > 1 << 20:
            return None
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def published_files(target):
    """Every entry of bin/: ggml loads any backend module it finds there, so
    an unrecorded file is as important as a changed one."""
    names = {}
    for entry in sorted((target / 'bin').iterdir()):
        info = entry.lstat()
        if not stat.S_ISREG(info.st_mode):
            raise RuntimeError(f'{entry} is not a regular file')
        names['bin/' + entry.name] = {'bytes': info.st_size, 'sha256': sha256(entry)}
    return names


def receipt_current(target, receipt, profile=None):
    """True only for this pin, these options and the actual bytes of the published files."""
    profile = profile or default_profile()
    if not receipt or receipt.get('schema') != 'dstudio.llama-install.v1':
        return False
    if receipt.get('commit') != PIN or receipt.get('buildId') != profile.build_id:
        return False
    binary = target / profile.binary
    try:
        info = binary.lstat()
        if not (stat.S_ISREG(info.st_mode) and info.st_mode & 0o111):
            return False
        if profile.layout == 'static':
            return info.st_size == receipt.get('binaryBytes') and sha256(binary) == receipt.get('binarySHA256')
        return published_files(target) == receipt.get('files')
    except (OSError, RuntimeError):
        return False


class Busy(RuntimeError):
    pass


def _lock_windows(fd, exclusive):
    """LockFileEx byte 0: the same range the DStudio host holds shared."""
    import ctypes
    import msvcrt
    from ctypes import wintypes

    class Overlapped(ctypes.Structure):
        _fields_ = [('Internal', ctypes.c_void_p), ('InternalHigh', ctypes.c_void_p),
                    ('Offset', wintypes.DWORD), ('OffsetHigh', wintypes.DWORD), ('hEvent', wintypes.HANDLE)]
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    flags = 0x1 | (0x2 if exclusive else 0)  # LOCKFILE_FAIL_IMMEDIATELY | LOCKFILE_EXCLUSIVE_LOCK
    overlapped = Overlapped()
    if not kernel32.LockFileEx(wintypes.HANDLE(msvcrt.get_osfhandle(fd)), flags, 0, 1, 0, ctypes.byref(overlapped)):
        raise BlockingIOError(ctypes.get_last_error(), 'lease held')


def lock(root, exclusive):
    fd = os.open(root / LOCK, os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0) |
                 getattr(os, 'O_NONBLOCK', 0), 0o600)
    info = os.fstat(fd)
    owned = os.name == 'nt' or info.st_uid == os.geteuid()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not owned or (root / LOCK).is_symlink():
        os.close(fd)
        raise RuntimeError('The llama.cpp installation lease is linked or not owned by this user')
    try:
        if os.name == 'nt':
            _lock_windows(fd, exclusive)
        else:
            import fcntl
            fcntl.flock(fd, (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise Busy('The llama.cpp engine is being installed; retry when the installation finishes'
                   if not exclusive else 'The llama.cpp engine is running; stop the model to update it')
    return fd


def build_candidate(root, cmake, profile):
    stages = [p for p in root.iterdir() if p.name.startswith(STAGE_PREFIX)]
    if len(stages) >= 2:
        raise RuntimeError('Two failed llama.cpp builds are retained in ' + str(root) +
                           '; inspect or remove them before retrying')
    stage = Path(tempfile.mkdtemp(prefix=STAGE_PREFIX, dir=root))
    Child.stage = stage
    try:
        return stage, build_in_stage(root, cmake, stage, profile)
    except BaseException as error:
        if isinstance(error, SystemExit):
            raise
        # Keep only the build log of a failed attempt; sources and objects
        # are reproducible from the bundled snapshot.
        for name in (DIRECTORY, 'build'):
            shutil.rmtree(stage / name, ignore_errors=True)
        Child.stage = None
        raise RuntimeError(f'{error}\nBuild log retained: {stage / "build.log"}') from error


def built_outputs(build, profile):
    """The server and, for the dynamic layout, its shared libraries and modules.
    Multi-config generators (Visual Studio) write into bin/Release."""
    for folder in (build / 'bin', build / 'bin' / 'Release'):
        server = folder / Path(profile.binary).name
        if server.is_file():
            break
    else:
        raise RuntimeError('The build did not produce ' + Path(profile.binary).name)
    if profile.layout == 'static':
        return [server]
    libraries = [p for p in folder.iterdir() if p.is_file() and
                 (p.suffix in ('.so', '.dylib', '.dll') or '.so.' in p.name)]
    if not any(p.name.startswith(('libggml-cpu', 'ggml-cpu')) for p in libraries):
        raise RuntimeError('The dynamic build produced no CPU backend module')
    return [server] + sorted(libraries)


def build_in_stage(root, cmake, stage, profile):
    candidate = stage / DIRECTORY
    proof = bundled.copy_sources(ASSETS, ENGINE, PIN, candidate)
    bundled.verify_sources(ASSETS, ENGINE, PIN, proof)
    env = build_environment(root, cmake, profile)
    jobs = str(max(1, min(16, os.cpu_count() or 1)))
    binary = candidate / profile.binary
    with open(stage / 'build.log', 'wb') as log:
        version = run([cmake, '--version'], stage, env, log).splitlines()[0].strip()
        generator = ['-G', 'Ninja'] if os.name == 'nt' and shutil.which('ninja') else []
        run([cmake, '-S', str(candidate), '-B', str(stage / 'build'), *generator, *profile.options], stage, env, log)
        # In the dynamic layout every backend module is a dependency of ggml,
        # so this target also builds them; nothing else is compiled.
        run([cmake, '--build', str(stage / 'build'), '--config', 'Release', '--target', 'llama-server',
             '-j', jobs], stage, env, log)
        (candidate / 'bin').mkdir()
        for output in built_outputs(stage / 'build', profile):
            shutil.copy2(output, candidate / 'bin' / output.name)
        # The executable must run from its published place, with the build
        # tree gone: proof that no library is resolved from the stage.
        shutil.rmtree(stage / 'build')
        reported = run([str(binary), '--version'], candidate / 'bin', env, log)
        devices = run([str(binary), '--list-devices'], candidate / 'bin', env, log) \
            if profile.layout == 'dynamic' else None
    if f'(build {BUILD_NUMBER}, commit {PIN[:7]})' not in reported:
        raise RuntimeError('The built llama-server does not report the pinned build: ' + reported[-300:])
    receipt = {
        'schema': 'dstudio.llama-install.v1', 'engine': ENGINE, 'repository': proof.get('repository'),
        'commit': PIN, 'buildNumber': BUILD_NUMBER, 'buildId': profile.build_id,
        'cmakeOptions': list(profile.options), 'cmake': version, 'binary': profile.binary,
        'binaryBytes': binary.stat().st_size, 'binarySHA256': sha256(binary),
        'bundledSources': proof, 'modelLoaded': False,
    }
    if profile.layout == 'dynamic':
        # Devices are what this build could open at install time, for
        # diagnostics only; the server re-enumerates them at every start.
        receipt.update({'layout': 'dynamic', 'backends': list(profile.backends),
                        'files': published_files(candidate), 'devicesAtInstall': devices[-4096:]})
    with (candidate / RECEIPT).open('x') as output:
        output.write(json.dumps(receipt, sort_keys=True) + '\n')
        output.flush()
        os.fsync(output.fileno())
    for folder, _, _ in os.walk(candidate, topdown=False):
        bundled.sync_directory(Path(folder))
    return candidate


def install(root, profile=None):
    root = Path(root)
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode):
        raise RuntimeError('The engine root is not a directory')
    root = root.resolve()
    target = root / DIRECTORY
    profile = profile or default_profile()
    # Exclusive: may build or replace. Shared (a DStudio llama-server is
    # running): verification of the current installation only.
    try:
        lease, exclusive = lock(root, exclusive=True), True
    except Busy as busy:
        lease, exclusive = lock(root, exclusive=False), False
        in_use = str(busy)
    try:
        previous = None
        if target.exists() or target.is_symlink():
            if target.is_symlink() or not target.is_dir():
                raise RuntimeError(f'{target} is not a directory DStudio installed; it is preserved')
            receipt = read_receipt(target)
            if receipt_current(target, receipt, profile):
                return {'ok': True, 'engine': ENGINE, 'commit': PIN, 'dir': str(target), 'layout': profile.layout,
                        'backends': list(profile.backends), 'binary': str(target / profile.binary),
                        'built': False, 'reused': True}
            if not receipt or receipt.get('schema') != 'dstudio.llama-install.v1':
                raise RuntimeError(f'{target} contains files DStudio did not install; it is preserved')
            previous = receipt
        if not exclusive:
            raise RuntimeError(in_use)
        cmake = find_cmake()
        stage, candidate = build_candidate(root, cmake, profile)
        parent_fd = None if os.name == 'nt' else os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            if previous is not None:
                # Only an installation with our receipt is replaced, while the
                # exclusive lease proves no DStudio llama-server is using it.
                os.rename(target, stage / 'previous')
            bundled.publish(candidate, target, parent_fd)
            bundled.sync_directory(root)
        finally:
            if parent_fd is not None:
                os.close(parent_fd)
        shutil.rmtree(stage)
        Child.stage = None
        bundled.sync_directory(root)
        return {'ok': True, 'engine': ENGINE, 'commit': PIN, 'dir': str(target), 'layout': profile.layout,
                'backends': list(profile.backends), 'binary': str(target / profile.binary),
                'built': True, 'reused': False, 'replaced': previous is not None}
    finally:
        os.close(lease)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path)
    parser.add_argument('--revision')
    parser.add_argument('--manifest', action='store_true',
                        help='Print the pin and the build recipe this machine would use, then exit')
    args = parser.parse_args()
    if args.manifest:
        try:
            profile = default_profile()
        except RuntimeError as error:
            print(f'llama.cpp build recipe unavailable: {error}', file=sys.stderr)
            return 1
        print(json.dumps({'engine': ENGINE, 'commit': PIN, 'buildNumber': BUILD_NUMBER, **profile.manifest()}))
        return 0
    if not args.root or not args.revision:
        parser.error('--root and --revision are required')
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        if args.revision != PIN:
            raise RuntimeError('The requested llama.cpp revision is not the bundled pin')
        print(json.dumps(install(args.root)), flush=True)
        return 0
    except (OSError, RuntimeError) as error:
        print(f'llama.cpp installation failed: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
