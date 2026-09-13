#!/usr/bin/env python3
"""Compare executed native rendering with the exact templates inside existing GGUFs.

No weights are loaded, downloaded, changed or inferred with. The bounded metadata
reader obtains the original Jinja oracle; it does not reconstruct that template
from application source. Receipts retain every failing case and both byte strings.
"""
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

from jinja2.sandbox import ImmutableSandboxedEnvironment

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / 'tests/.artifacts/q36-chat-template'
ARTIFACTS.mkdir(parents=True, exist_ok=True)
RUN = Path(tempfile.mkdtemp(prefix='run-', dir=ARTIFACTS))
REPORT = {'started': datetime.now(timezone.utc).isoformat(), 'passed': False, 'cases': [],
          'scope': 'Native Qwen history rendering versus embedded GGUF Jinja, explicit preserve_thinking and thinking off; no inference'}


def sha(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def template_from_gguf(file):
    def identity(info):
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    with file.open('rb') as stream:
        before = os.fstat(stream.fileno())
        data = stream.read(16 * 1024 * 1024)
        assert identity(os.fstat(stream.fileno())) == identity(before), 'GGUF changed during metadata read'
        assert identity(file.stat()) == identity(before), 'GGUF path changed during metadata read'
    position = 0

    def take(n):
        nonlocal position
        assert 0 <= n <= len(data) - position, 'GGUF metadata exceeds 16 MiB bound'
        value = data[position:position+n]
        position += n
        return value

    def u32():
        return struct.unpack('<I', take(4))[0]

    def u64():
        return struct.unpack('<Q', take(8))[0]

    def string():
        return take(u64()).decode('utf-8')

    def skip(kind):
        if kind == 8:
            take(u64())
        elif kind == 9:
            item, count = u32(), u64()
            assert item != 9 and count <= 1000000
            for _ in range(count):
                skip(item)
        else:
            size = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}[kind]
            take(size)

    assert take(4) == b'GGUF' and u32() == 3
    tensors, fields = u64(), u64()
    assert tensors < 1000000 and fields < 10000
    for _ in range(fields):
        key, kind = string(), u32()
        if key == 'tokenizer.chat_template':
            assert kind == 8
            text = string()
            assert len(text.encode()) <= 65536
            return text, {'path': str(file), 'bytes': before.st_size,
                          'templateSHA256': hashlib.sha256(text.encode()).hexdigest()}
        skip(kind)
    raise AssertionError('No embedded chat template')


def run():
    assert len(sys.argv) >= 3, 'Supply exact native source tree and existing GGUF model(s)'
    source = Path(sys.argv[1]).resolve()
    probe = ROOT / 'tests/support/q36_chat_template_probe.c'
    core = ROOT / 'tests/support/q36_catalog_core_probe.c'
    files = [Path(__file__).resolve(), probe, core,
             ROOT / 'patch/q36-metal-runtime/runtime.patch',
             ROOT / 'scripts/apply-q36-metal-runtime.sh'] + [source / f for f in
        ['q36_server.c', 'q36.c', 'q36.h', 'q36_gpu.h', 'q36_image.c', 'q36_image.h',
         'q36_ssd.c', 'q36_ssd.h', 'rax.c', 'rax.h', 'rax_malloc.h']]
    REPORT['inputs'] = {str(f): sha(f) for f in files}
    binary = RUN / 'native-renderer'
    command = ['cc', '-std=c11', '-O1', '-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
               '-ffunction-sections', '-fdata-sections', '-I', str(source), str(probe), str(core)]
    command += [str(source / f) for f in ['q36_image.c', 'q36_ssd.c', 'rax.c']]
    command += ['-lm', '-pthread', '-o', str(binary), '-Wl,-dead_strip' if sys.platform == 'darwin' else '-Wl,--gc-sections']
    build = subprocess.run(command, capture_output=True, text=True, timeout=120)
    REPORT['build'] = {'command': command, 'status': build.returncode, 'stderr': build.stderr}
    assert build.returncode == 0, build.stderr
    REPORT['binarySHA256'] = sha(binary)
    user = {'role': 'user', 'content': 'Inspect the file.'}
    answer = {'role': 'assistant', 'content': 'Here is the result.'}
    call = {'role': 'assistant', 'content': '', 'tool_calls': [
        {'id': 'call_1', 'type': 'function', 'function': {'name': 'read', 'arguments': {'path': 'notes.txt'}}}]}
    result = {'role': 'tool', 'tool_call_id': 'call_1', 'content': 'Recorded text.'}
    histories = [
        ('fresh request', [user]),
        ('empty reasoning retained in current assistant', [user, answer]),
        ('tool continuation without reasoning', [user, call, result]),
        ('tool continuation with visible text', [user, dict(call, content='Reading the file.'), result]),
        ('tool continuation with actual reasoning', [user, dict(call, reasoning_content='Check the source.'), result]),
        ('old empty reasoning before a new query', [user, answer, {'role': 'user', 'content': 'Continue.'}]),
        ('old reasoning before a new query', [user, dict(answer, reasoning_content='Earlier reasoning.'), {'role': 'user', 'content': 'Continue.'}]),
        ('consecutive tool rounds', [user, call, result, answer]),
    ]
    env = ImmutableSandboxedEnvironment(trim_blocks=True, lstrip_blocks=True)
    env.globals['raise_exception'] = lambda message: (_ for _ in ()).throw(ValueError(message))
    REPORT['oracles'] = []
    for filename in sys.argv[2:]:
        model = Path(filename).resolve()
        template, identity = template_from_gguf(model)
        REPORT['oracles'].append(identity)
        (RUN / (model.name + '.jinja')).write_text(template)
        oracle = env.from_string(template)
        for preserve in (False, True):
            for name, messages in histories:
                row = {'name': name, 'model': model.name, 'preserveThinking': preserve,
                       'messages': messages, 'passed': False}
                REPORT['cases'].append(row)
                expected = oracle.render(messages=messages, tools=[], enable_thinking=False,
                                         preserve_thinking=preserve, add_generation_prompt=True)
                actual = subprocess.run([str(binary), str(int(preserve))], input=json.dumps(messages),
                                        capture_output=True, text=True, timeout=5)
                row.update(expected=expected, actual=actual.stdout, stderr=actual.stderr, status=actual.returncode)
                row['passed'] = actual.returncode == 0 and actual.stdout == expected
                print(f"{'PASS' if row['passed'] else 'FAIL'} {model.name}: {name}, preserve={preserve}", flush=True)
    for file, before in REPORT['inputs'].items():
        assert sha(file) == before, 'Input changed: ' + file
    REPORT['passed'] = bool(REPORT['cases']) and all(c['passed'] for c in REPORT['cases'])


print(f'Evidence: {RUN}', flush=True)
try:
    run()
except Exception as error:
    REPORT['error'] = repr(error)
finally:
    REPORT['finished'] = datetime.now(timezone.utc).isoformat()
    (RUN / 'results.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2))
    print(f"{'PASS' if REPORT['passed'] else 'FAIL'} {sum(c['passed'] for c in REPORT['cases'])}/{len(REPORT['cases'])}: {RUN}")
sys.exit(0 if REPORT['passed'] else 1)
