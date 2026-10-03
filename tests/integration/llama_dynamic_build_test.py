"""Real build of the dynamic (Ollama-like) llama.cpp layout that Linux and
Windows use, executed on macOS: shared libraries plus one loadable module per
backend, every Apple CPU variant and the Metal module.

This is the only place the dynamic installer path runs on real hardware. It
does not test CUDA, ROCm, Vulkan, Linux or Windows; it proves the recipe,
collection, relocation, receipt and reuse logic they share.

  python3 tests/integration/llama_dynamic_build_test.py [--infer gguf/MODEL.gguf]

The build runs offline (macOS sandbox-exec denies outbound IP) in a new
task-owned directory under tests/.artifacts/llama-dynamic-build/. --infer
additionally loads that existing model from ds4/ with the published server on
a free loopback port and checks one exact answer; it is never run implicitly.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('install_llama', ROOT / 'scripts/install-llama.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
SANDBOX = '(version 1)(allow default)(deny network-outbound (remote ip "*:*"))'
results = []


def check(name, fn):
    row = {'name': name}
    started = time.time()
    try:
        row.update(fn() or {})
        row['status'] = 'PASS'
    except Exception as error:  # noqa: BLE001 - every failure is retained
        row['status'] = 'FAIL'
        row['error'] = f'{type(error).__name__}: {error}'
    row['seconds'] = round(time.time() - started, 2)
    results.append(row)
    print(f"{row['status']} {name}" + (f"\n  {row['error']}" if 'error' in row else ''), flush=True)
    return row['status'] == 'PASS'


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--infer', help='existing model path relative to ds4/, loaded once')
    args = parser.parse_args()
    if sys.platform != 'darwin':
        print('llama_dynamic_build_test: NOT RUN (this harness builds the Metal variant on macOS)')
        return 2
    artifacts = ROOT / 'tests/.artifacts/llama-dynamic-build'
    artifacts.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='run-', dir=artifacts))
    root = run / 'engines'
    root.mkdir()
    target = root / installer.DIRECTORY
    profile = installer.dynamic_profile(system='darwin', requested='')
    report = {'run': str(run), 'scope': 'real macOS dynamic build; CUDA/ROCm/Vulkan/Linux/Windows not run',
              'recipe': profile.manifest(), 'checks': results}
    outcome = {}

    def build():
        code = ('import importlib.util,json,sys; s=importlib.util.spec_from_file_location("i",sys.argv[1]);'
                'm=importlib.util.module_from_spec(s); s.loader.exec_module(m);'
                'print(json.dumps(m.install(sys.argv[2], m.dynamic_profile(system="darwin", requested=""))))')
        started = time.time()
        done = subprocess.run(['sandbox-exec', '-p', SANDBOX, sys.executable, '-c', code,
                               str(ROOT / 'scripts/install-llama.py'), str(root)],
                              capture_output=True, text=True)
        (run / 'install.log').write_text(done.stdout + done.stderr)
        assert done.returncode == 0, done.stderr[-2000:]
        outcome.update(json.loads(done.stdout.strip().splitlines()[-1]))
        assert outcome['built'] and outcome['layout'] == 'dynamic'
        return {'buildSeconds': round(time.time() - started, 1)}

    if not check('the dynamic layout builds offline from the bundled sources', build):
        return finish(report, run)

    receipt = json.loads((target / installer.RECEIPT).read_text())

    def layout():
        files = sorted(receipt['files'])
        names = [Path(f).name for f in files]
        cpu = [n for n in names if n.startswith('libggml-cpu')]
        assert receipt['layout'] == 'dynamic' and receipt['backends'] == ['cpu', 'metal'], receipt['backends']
        assert 'llama-server' in names and any(n.startswith('libllama') for n in names), names
        assert any(n.startswith('libggml-metal') for n in names), names
        assert len(cpu) >= 2, f'expected every Apple CPU variant as a module: {cpu}'
        stages = list(root.glob(installer.STAGE_PREFIX + '*'))
        assert not stages, f'stage left behind: {stages}'
        return {'files': names, 'cpuVariants': cpu}

    def relocated():
        # No library may be resolved from the private stage: it no longer
        # exists. Load commands decide that; source paths compiled in for
        # assert messages (__FILE__) do not, and the tested static build has
        # them too. The first run of this check matched raw bytes and failed on
        # those strings (receipt run-n4hyywj1 is retained).
        stage_marker = str(root) + '/' + installer.STAGE_PREFIX
        loads = {}
        for name in receipt['files']:
            listing = subprocess.run(['otool', '-l', str(target / name)], capture_output=True, text=True, check=True)
            paths = [line.split()[1] for line in listing.stdout.splitlines()
                     if line.strip().startswith(('name ', 'path '))]
            assert not [p for p in paths if stage_marker in p], f'{name} loads from the build stage: {paths}'
            private = [p for p in paths if not p.startswith(('/usr/lib/', '/System/', '@rpath/', '@loader_path'))]
            assert not private, f'{name} loads a library outside the installation: {private}'
            loads[Path(name).name] = paths
        moved = run / 'moved'
        shutil.copytree(target, moved)
        version = subprocess.run([str(moved / 'bin/llama-server'), '--version'], capture_output=True, text=True,
                                 cwd=moved / 'bin', timeout=60)
        assert '(build 11371, commit 99b9548)' in version.stdout + version.stderr
        devices = subprocess.run([str(moved / 'bin/llama-server'), '--list-devices'], capture_output=True,
                                 text=True, cwd=moved / 'bin', timeout=60)
        listing = devices.stdout + devices.stderr
        assert 'MTL0' in listing or 'Metal' in listing, listing[-1500:]
        shutil.rmtree(moved)
        return {'devices': listing.strip()[-600:], 'loadCommands': loads}

    def reused():
        started = time.time()
        again = installer.install(root, profile)
        assert again['reused'] and not again['built'], again
        return {'verifySeconds': round(time.time() - started, 2)}

    def tamper():
        assert installer.receipt_current(target, receipt, profile)
        extra = target / 'bin' / 'libggml-extra.so'
        extra.write_bytes(b'not built here')
        try:
            assert not installer.receipt_current(target, receipt, profile), 'an unrecorded module was accepted'
        finally:
            extra.unlink()
        assert not installer.receipt_current(target, receipt, installer.static_profile()), \
            'the static macOS recipe must not adopt a dynamic build'
        assert installer.receipt_current(target, receipt, profile)

    check('the published tree holds the server, shared libraries and every backend module', layout)
    check('the server runs from a new location with the build tree gone and loads Metal', relocated)
    check('a second installation verifies and reuses the build', reused)
    check('an unrecorded backend module or another recipe is not current', tamper)
    if args.infer:
        check('the dynamic build answers a held-out arithmetic question with real weights',
              lambda: infer(target, ROOT / 'ds4' / args.infer, run))
    return finish(report, run)


def infer(target, model, run):
    assert model.is_file(), f'{model} is not an existing model file'
    port = free_port()
    log = open(run / 'server.log', 'wb')
    server = subprocess.Popen([str(target / 'bin/llama-server'), '--model', str(model), '--ctx-size', '4096',
                               '--parallel', '1', '--fit', 'on', '--flash-attn', 'auto', '--jinja',
                               '--host', '127.0.0.1', '--port', str(port), '--no-webui'],
                              cwd=target / 'bin', stdout=log, stderr=subprocess.STDOUT)
    try:
        started = time.time()
        while True:
            assert server.poll() is None, 'llama-server exited while loading'
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=2) as reply:
                    if reply.status == 200:
                        break
            except OSError:
                pass
            time.sleep(0.5)
        loaded = time.time() - started
        # Thinking off: a simple sum (an earlier thinking-off product failed; see tests/README.md).
        body = {'messages': [{'role': 'user', 'content': 'What is 1234 plus 4321? Reply with the number only.'}],
                'temperature': 0, 'max_tokens': 64, 'chat_template_kwargs': {'enable_thinking': False}}
        request = urllib.request.Request(f'http://127.0.0.1:{port}/v1/chat/completions', json.dumps(body).encode(),
                                         {'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=600) as reply:
            answer = json.load(reply)['choices'][0]['message']['content'].strip()
        (run / 'answer.json').write_text(json.dumps({'request': body, 'answer': answer}, indent=1))
        assert answer.replace(',', '') == '5555', answer
        return {'model': model.name, 'loadSeconds': round(loaded, 1), 'answer': answer}
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait()
        log.close()


def finish(report, run):
    report['finished'] = time.strftime('%Y-%m-%dT%H:%M:%S')
    (run / 'report.json').write_text(json.dumps(report, indent=1))
    passed = sum(r['status'] == 'PASS' for r in results)
    print(f'llama_dynamic_build_test: {passed}/{len(results)} passed (real macOS dynamic build; '
          f'CUDA/ROCm/Vulkan/Linux/Windows not run); receipts: {run}')
    return 0 if passed == len(results) else 1


if __name__ == '__main__':
    sys.exit(main())
