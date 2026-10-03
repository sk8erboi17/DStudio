"""scripts/install-llama.py build recipes and installation verification.

Executes the production profile, receipt and lease functions. Toolchains are
explicitly simulated: tiny executables named nvcc/hipconfig/amdgpu-arch/glslc
in a private directory. Nothing is configured or compiled here; the real
dynamic build is tests/integration/llama_dynamic_build_test.py.
  python3 tests/unit/llama_install_profile_test.py
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('install_llama', ROOT / 'scripts/install-llama.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)

# The build identity of every macOS receipt written before the dynamic layout
# existed (scripts/install-llama.py at the llama.cpp import).
MACOS_BUILD_ID = '54bc9e1237ebc60dc4dfedb59b9f2e45221af855593f1383364304c053740871'


def tool(directory, name, body='exit 0'):
    path = Path(directory) / name
    path.write_text('#!/bin/sh\n' + body + '\n')
    path.chmod(0o755)
    return str(path)


class Toolchains:
    """A private PATH holding only the simulated tools a case asks for."""
    def __init__(self, root):
        self.bin = Path(root) / 'bin'
        self.bin.mkdir()
        self.env = {'PATH': str(self.bin)}

    def which(self, name):
        return shutil.which(name, path=str(self.bin))


class Profiles(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='llama-profile-')
        self.tools = Toolchains(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def profile(self, system='linux', machine='x86_64', requested=''):
        return installer.dynamic_profile(system=system, machine=machine, env=self.tools.env,
                                         which=self.tools.which, requested=requested)

    def test_macos_keeps_the_tested_static_build_and_its_receipts(self):
        static = installer.static_profile()
        self.assertEqual(static.layout, 'static')
        self.assertEqual(static.build_id, MACOS_BUILD_ID)
        self.assertEqual(installer.BUILD_ID, MACOS_BUILD_ID)
        self.assertIn('-DBUILD_SHARED_LIBS=OFF', static.options)
        self.assertIn('-DGGML_METAL=ON', static.options)
        self.assertEqual(static.binary, 'bin/llama-server')

    def test_cpu_only_linux_builds_every_cpu_variant_as_a_module(self):
        linux = self.profile()
        self.assertEqual(linux.backends, ('cpu',))
        for option in ('-DBUILD_SHARED_LIBS=ON', '-DGGML_BACKEND_DL=ON', '-DGGML_NATIVE=OFF',
                       '-DGGML_CPU_ALL_VARIANTS=ON', '-DGGML_METAL=OFF', '-DCMAKE_INSTALL_RPATH=$ORIGIN',
                       '-DCMAKE_PLATFORM_NO_VERSIONED_SONAME=ON',
                       '-DLLAMA_BUILD_NUMBER=11371', '-DLLAMA_BUILD_COMMIT=99b9548'):
            self.assertIn(option, linux.options)
        self.assertFalse(any(o.startswith(('-DGGML_CUDA', '-DGGML_HIP', '-DGGML_VULKAN')) for o in linux.options))
        self.assertNotEqual(linux.build_id, MACOS_BUILD_ID)

    def test_detected_toolchains_add_their_backend_modules(self):
        nvcc = tool(self.tools.bin, 'nvcc')
        clang_dir = Path(self.tmp) / 'rocm' / 'llvm' / 'bin'
        clang_dir.mkdir(parents=True)
        tool(clang_dir, 'amdgpu-arch', 'echo gfx1100; echo gfx1100; echo gfx90a')
        tool(self.tools.bin, 'hipconfig',
             f'case "$1" in -l) echo {clang_dir};; -R) echo {Path(self.tmp) / "rocm"};; esac')
        sdk = Path(self.tmp) / 'vulkan'
        (sdk / 'include' / 'vulkan').mkdir(parents=True)
        (sdk / 'include' / 'vulkan' / 'vulkan.h').write_text('')
        (sdk / 'bin').mkdir()
        tool(sdk / 'bin', 'glslc')
        self.tools.env['VULKAN_SDK'] = str(sdk)
        linux = self.profile()
        self.assertEqual(linux.backends, ('cpu', 'cuda', 'hip', 'vulkan'))
        self.assertIn('-DGGML_CUDA=ON', linux.options)
        self.assertIn(f'-DCMAKE_CUDA_COMPILER={nvcc}', linux.options)
        self.assertIn('-DGGML_HIP=ON', linux.options)
        self.assertIn('-DGPU_TARGETS=gfx1100;gfx90a', linux.options, 'visible GPUs, deduplicated')
        self.assertIn('-DGGML_VULKAN=ON', linux.options)
        self.assertEqual(linux.env['HIPCXX'], str(clang_dir / 'clang'))
        self.assertEqual(linux.env['HIP_PATH'], str(Path(self.tmp) / 'rocm'))
        # Another toolchain set is another build: no receipt can be shared.
        self.assertNotEqual(linux.build_id, self.profile(requested='cpu').build_id)

    def test_hip_without_a_visible_gpu_uses_the_release_target_list(self):
        clang_dir = Path(self.tmp) / 'clang'
        clang_dir.mkdir()
        tool(self.tools.bin, 'hipconfig', f'case "$1" in -l) echo {clang_dir};; -R) echo /opt/rocm;; esac')
        self.assertIn('-DGPU_TARGETS=' + installer.HIP_DEFAULT_TARGETS, self.profile().options)

    def test_a_broken_hip_toolchain_is_absent_not_half_configured(self):
        tool(self.tools.bin, 'hipconfig', 'exit 3')
        self.assertEqual(self.profile().backends, ('cpu',))

    def test_vulkan_needs_both_the_shader_compiler_and_headers(self):
        tool(self.tools.bin, 'glslc')
        self.assertEqual(self.profile(system='windows').backends, ('cpu',), 'glslc alone is not a Vulkan SDK')

    def test_requested_backends_are_explicit(self):
        with self.assertRaisesRegex(RuntimeError, 'without a toolchain on this machine: cuda'):
            self.profile(requested='cpu,cuda')
        with self.assertRaisesRegex(RuntimeError, 'Unknown llama.cpp backend'):
            self.profile(requested='cpu,opencl')
        with self.assertRaisesRegex(RuntimeError, 'only on macOS'):
            self.profile(requested='metal')
        tool(self.tools.bin, 'nvcc')
        self.assertEqual(self.profile(requested='cuda').backends, ('cpu', 'cuda'))
        # Requesting less than what is installed is honoured: CPU only.
        self.assertEqual(self.profile(requested='cpu').backends, ('cpu',))

    def test_windows_layout(self):
        windows = self.profile(system='windows', machine='AMD64')
        self.assertEqual(windows.binary, 'bin/llama-server.exe')
        self.assertIn('-DGGML_CPU_ALL_VARIANTS=ON', windows.options)
        self.assertFalse(any('RPATH' in o for o in windows.options), 'DLLs resolve next to the executable')
        arm = self.profile(system='windows', machine='ARM64')
        self.assertNotIn('-DGGML_CPU_ALL_VARIANTS=ON', arm.options, 'ggml has no Windows ARM variant set')

    def test_manifest_cli_reports_this_machines_recipe(self):
        out = subprocess.run([sys.executable, str(ROOT / 'scripts/install-llama.py'), '--manifest'],
                             capture_output=True, text=True, check=True)
        recipe = json.loads(out.stdout)
        self.assertEqual(recipe['commit'], installer.PIN)
        if sys.platform == 'darwin':
            self.assertEqual((recipe['layout'], recipe['buildId']), ('static', MACOS_BUILD_ID))
        env = {**os.environ, 'DSTUDIO_LLAMA_BACKENDS': 'nope'}
        bad = subprocess.run([sys.executable, str(ROOT / 'scripts/install-llama.py'), '--manifest'],
                             capture_output=True, text=True, env=env)
        if sys.platform != 'darwin':
            self.assertEqual(bad.returncode, 1)


class Receipts(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='llama-receipt-'))
        self.target = self.tmp / 'llama.cpp'
        (self.target / 'bin').mkdir(parents=True)
        tools = Toolchains(self.tmp)
        self.profile = installer.dynamic_profile(system='linux', machine='x86_64', env=tools.env,
                                                 which=tools.which, requested='')
        server = self.target / 'bin' / 'llama-server'
        server.write_bytes(b'server')
        server.chmod(0o755)
        for name in ('libllama.so', 'libggml-base.so', 'libggml-cpu-haswell.so'):
            (self.target / 'bin' / name).write_bytes(name.encode())
        self.receipt = {'schema': 'dstudio.llama-install.v1', 'commit': installer.PIN,
                        'buildId': self.profile.build_id, 'files': installer.published_files(self.target)}

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def current(self):
        return installer.receipt_current(self.target, self.receipt, self.profile)

    def test_an_unchanged_installation_is_current(self):
        self.assertTrue(self.current())
        self.assertEqual(sorted(self.receipt['files']), ['bin/libggml-base.so', 'bin/libggml-cpu-haswell.so',
                                                         'bin/libllama.so', 'bin/llama-server'])

    def test_an_extra_backend_module_is_rejected(self):
        # ggml would load any libggml-*.so it finds next to the server.
        (self.target / 'bin' / 'libggml-cuda.so').write_bytes(b'unrecorded')
        self.assertFalse(self.current())

    def test_changed_or_missing_bytes_are_rejected(self):
        (self.target / 'bin' / 'libggml-cpu-haswell.so').write_bytes(b'changed!')
        self.assertFalse(self.current())
        (self.target / 'bin' / 'libggml-cpu-haswell.so').unlink()
        self.assertFalse(self.current())

    def test_a_linked_file_is_rejected(self):
        (self.target / 'bin' / 'libggml-cpu-haswell.so').unlink()
        os.symlink(self.target / 'bin' / 'libllama.so', self.target / 'bin' / 'libggml-cpu-haswell.so')
        self.assertFalse(self.current())

    def test_another_recipe_is_another_build(self):
        self.receipt['buildId'] = installer.static_profile().build_id
        self.assertFalse(self.current())


@unittest.skipIf(os.name == 'nt', 'POSIX flock lease')
class Lease(unittest.TestCase):
    def test_exclusive_install_and_shared_server_leases(self):
        root = Path(tempfile.mkdtemp(prefix='llama-lease-'))
        try:
            holder = subprocess.Popen([sys.executable, '-c', f'''import fcntl,os,sys,time
fd=os.open({str(root / installer.LOCK)!r}, os.O_RDWR | os.O_CREAT, 0o600)
fcntl.flock(fd, fcntl.LOCK_SH); print("held", flush=True); time.sleep(30)'''], stdout=subprocess.PIPE, text=True)
            self.assertEqual(holder.stdout.readline().strip(), 'held')
            try:
                with self.assertRaisesRegex(installer.Busy, 'running; stop the model'):
                    installer.lock(root, exclusive=True)
                os.close(installer.lock(root, exclusive=False))  # verification beside a running server
            finally:
                holder.kill()
                holder.wait()
                holder.stdout.close()
            fd = installer.lock(root, exclusive=True)
            with self.assertRaisesRegex(installer.Busy, 'being installed'):
                installer.lock(root, exclusive=False)
            os.close(fd)
            os.unlink(root / installer.LOCK)
            os.symlink(root / 'elsewhere', root / installer.LOCK)
            (root / 'elsewhere').write_text('')
            with self.assertRaises((RuntimeError, OSError)):
                installer.lock(root, exclusive=True)
        finally:
            shutil.rmtree(root)


if __name__ == '__main__':
    result = unittest.main(exit=False, verbosity=1).result
    total = result.testsRun
    failed = len(result.failures) + len(result.errors)
    print(f'llama_install_profile_test: {total - failed}/{total} passed '
          '(production recipes/receipts/leases; simulated toolchains, nothing compiled)')
    sys.exit(1 if failed else 0)
