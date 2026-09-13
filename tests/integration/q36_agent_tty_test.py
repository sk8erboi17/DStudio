#!/usr/bin/env python3
"""Real model-free q36 Agent/PTY tests; never use actual sudo or credentials."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import shutil
import subprocess
import sys
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[2]
assert sys.argv[1:] in ([], ['--next-review'], ['--monitor-owner']), 'Select the pinned, next-review or monitor-owner candidate'
MONITOR_OWNER = '--monitor-owner' in sys.argv
NEXT_REVIEW = '--next-review' in sys.argv or MONITOR_OWNER
PIN = '8362010a301b3360296e435703f58ffc230a024a' if NEXT_REVIEW else 'd02b6a20a7662300003c859e186ceb5bec7aa849'
VARIANT = 'monitor' if NEXT_REVIEW else 'pinned'
SOURCE = Path(os.environ['Q36_SOURCE']).resolve()
ARTIFACTS = ROOT / 'tests/.artifacts/q36-agent-tty'
ARTIFACTS.mkdir(parents=True, exist_ok=True)
RUN = Path(tempfile.mkdtemp(prefix='run-', dir=ARTIFACTS))
TREE = RUN / 'source'
PATCH = ROOT / 'patch/q36-agent-tty' / ('monitor.patch' if NEXT_REVIEW else 'runtime.patch')
SCRIPT = ROOT / 'scripts/apply-q36-agent-tty.sh'
REPORT = {'scope': 'Native Agent and terminal tests with fictional password fixtures; no model or actual sudo',
          'pin': PIN, 'patchVariant': VARIANT, 'stages': [], 'source': str(SOURCE)}


def digest(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def save():
    (RUN / 'report.json').write_text(json.dumps(REPORT, indent=2) + '\n')


def command(name, args, *, expected=0, timeout=60, env=None, stdin=None):
    start = time.monotonic()
    actual_env = dict(os.environ if env is None else env)
    if args[0] == 'git':
        actual_env = {k: v for k, v in actual_env.items() if not k.startswith('GIT_')}
        actual_env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null',
                          GIT_CEILING_DIRECTORIES=str(TREE.parent))
    row = {'name': name, 'argv': [str(x) for x in args], 'expected': expected, 'status': 'running'}
    REPORT['stages'].append(row); save()
    try:
        result = subprocess.run(args, cwd=TREE if TREE.exists() else ROOT,
                                env=actual_env, stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=timeout)
    except subprocess.TimeoutExpired as error:
        (RUN / (name + '.stdout')).write_bytes(error.stdout or b'')
        (RUN / (name + '.stderr')).write_bytes(error.stderr or b'')
        row.update(status='fail', reason='timeout', deadlineSeconds=timeout,
                   seconds=time.monotonic() - start)
        save()
        raise
    (RUN / (name + '.stdout')).write_bytes(result.stdout)
    (RUN / (name + '.stderr')).write_bytes(result.stderr)
    row.update(returncode=result.returncode, seconds=time.monotonic() - start,
               status='pass' if result.returncode == expected else 'fail')
    save()
    assert result.returncode == expected, (name, result.returncode, result.stderr[-3000:])
    return result


def git_apply(*args):
    return ['git', '-c', 'core.autocrlf=false', 'apply', *args, str(PATCH)]


def run_patch(name, action, expected=0, variant=VARIANT):
    return command(name, ['/bin/sh', str(SCRIPT), action, variant], expected=expected,
                   env={**os.environ, 'Q36_DIR': str(TREE)})


def build_lifetime(name):
    command(name, ['cc', '-O2', '-DQ36_METAL', *(['-DQ36_TTY_MONITOR_TEST'] if NEXT_REVIEW else []), '-Wno-unused-function', '-I.',
            str(ROOT / 'tests/support/q36_agent_tty_probe.c'), 'q36_help.o', 'q36_kvstore.o', 'q36_ssd.o',
            'q36_web.o', 'linenoise.o', 'q36_gpu_core_metal.o', 'q36_metal.o', 'q36_image.o',
            '-lm', '-pthread', '-framework', 'Foundation', '-framework', 'Metal', '-o', 'tty-lifetime'])


def copy_sources():
    files = {}
    for folder, dirs, names in os.walk(SOURCE, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in ('.git', 'gguf', 'build', '__pycache__', '.cache')
                         and not Path(folder, d).is_symlink())
        for name in sorted(names):
            file = Path(folder, name)
            if file.is_symlink() or not file.is_file(): continue
            if file.suffix not in ('.c', '.h', '.m', '.metal', '.inc', '.py') and name != 'Makefile': continue
            assert file.stat().st_size <= 8 * 1024 * 1024, 'unexpected large source file'
            relative = file.relative_to(SOURCE)
            target = TREE / relative; target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(file, target); files[str(relative)] = digest(file)
            assert len(files) <= 2048
    return files


try:
    if (SOURCE / '.git').exists():
        top = subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', '--show-toplevel'], text=True).strip()
        assert Path(top).resolve() == SOURCE
        revision = subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip()
    else:
        revision = json.loads((SOURCE / '.dstudio-source.json').read_text())['commit']
    assert revision == PIN, 'Use the reviewed q36 base, not a surrounding repository identity'
    REPORT['inputs'] = copy_sources()
    REPORT['patchSha256'] = digest(PATCH); REPORT['scriptSha256'] = digest(SCRIPT)
    REPORT['harnessSha256'] = digest(__file__); save()
    if MONITOR_OWNER:
        REPORT['ownerPatchSha256'] = digest(ROOT / 'patch/q36-agent-tty/monitor-owner.patch')
        run_patch('restore-copied-owner', 'restore', variant='monitor-owner')
    run_patch('restore-copied-candidate', 'restore')
    original = {name: (TREE / name).read_bytes() for name in ('q36_agent.c', 'tests/test_agent_password.py')}
    # Only the test's terminal-state observation is corrected in the baseline:
    # same semantic oracle in BOTH versions, while the production bug remains.
    command('baseline-test-oracle', git_apply('--include=tests/test_agent_password.py'))
    baseline_oracle = digest(TREE / 'tests/test_agent_password.py')
    command('baseline-build', ['make', '-j2', 'q36_agent_test_metal'], timeout=180)
    command('baseline-agent', ['./q36_agent_test_metal'])
    build_lifetime('baseline-layout-build')
    REPORT['baselineLayout'] = json.loads(command('baseline-layout', ['./tty-lifetime', '--layout']).stdout)
    save()
    red = command('baseline-password-red', ['python3', 'tests/test_agent_password.py', './q36_agent_test_metal'], expected=1)
    assert b'NO_TERMINAL' in red.stderr, 'baseline failed for a different reason'
    command('restore-baseline-oracle', git_apply('--reverse', '--include=tests/test_agent_password.py'))
    assert all((TREE / name).read_bytes() == data for name, data in original.items())

    # Unrelated contributor code survives the whole apply/repeat/restore cycle.
    unrelated = b'\n/* unrelated contributor note retained by the patch test */\n'
    with (TREE / 'q36_agent.c').open('ab') as stream: stream.write(unrelated)
    run_patch('apply', 'apply')
    applied = {name: digest(TREE / name) for name in original}
    run_patch('repeat-apply', 'apply'); assert applied == {name: digest(TREE / name) for name in original}
    assert digest(TREE / 'tests/test_agent_password.py') == baseline_oracle, 'Grader differs between variants'
    if MONITOR_OWNER:
        run_patch('apply-monitor-owner', 'apply', variant='monitor-owner')
    command('candidate-build', ['make', '-j2', 'q36_agent_test_metal'], timeout=180)
    command('candidate-agent', ['./q36_agent_test_metal'])
    command('candidate-password', ['python3', 'tests/test_agent_password.py', './q36_agent_test_metal'])
    (RUN / 'upstream-reader.py').write_bytes(original['tests/test_agent_password.py'])
    eof_red = command('terminal-eof-red', ['python3', str(ROOT / 'tests/support/q36_terminal_eof_probe.py'),
                         str(RUN / 'upstream-reader.py'), str(TREE / 'q36_agent_test_metal')], expected=1)
    assert b'Terminal EOF was read again' in eof_red.stderr, 'Reader baseline failed for a different reason'
    command('terminal-eof', ['python3', str(ROOT / 'tests/support/q36_terminal_eof_probe.py'),
                            str(TREE / 'tests/test_agent_password.py'), str(TREE / 'q36_agent_test_metal')])

    # Independent master/slave oracle: master catches an actual mode change
    # after session exit; a normal macOS exit may invalidate the slave handle.
    terminal = []
    for altered in (False, True):
        master, slave = pty.openpty()
        before = termios.tcgetattr(master)
        code = ('import termios; t=termios.tcgetattr(0); t[3]^=termios.ECHO; '
                'termios.tcsetattr(0,termios.TCSANOW,t)') if altered else 'pass'
        child = subprocess.Popen([sys.executable, '-c', code], stdin=slave, stdout=slave, stderr=slave,
                                 start_new_session=True, preexec_fn=lambda: fcntl.ioctl(0, termios.TIOCSCTTY, 0))
        try:
            assert child.wait(timeout=5) == 0
            changed = termios.tcgetattr(master) != before
            assert changed == altered
            terminal.append({'modeDeliberatelyChanged': altered, 'masterDetectedChange': changed})
        finally:
            if child.poll() is None: child.kill(); child.wait()
            os.close(master); os.close(slave)
    REPORT['terminalOracle'] = terminal; save()

    build_lifetime('lifetime-build')
    master, slave = pty.openpty()
    try:
        result = command('descriptor-lifetime', ['./tty-lifetime'], stdin=slave)
        REPORT['lifetime'] = json.loads(result.stdout); save()
        assert REPORT['lifetime']['jobs'] == 32 and REPORT['lifetime']['leakedDescriptors'] == 0
    finally: os.close(master); os.close(slave)

    if MONITOR_OWNER:
        run_patch('restore-monitor-owner', 'restore', variant='monitor-owner')
        run_patch('repeat-restore-monitor-owner', 'restore', variant='monitor-owner')
        assert applied == {name: digest(TREE / name) for name in original}
    run_patch('restore', 'restore'); run_patch('repeat-restore', 'restore')
    assert (TREE / 'q36_agent.c').read_bytes() == original['q36_agent.c'] + unrelated
    assert (TREE / 'tests/test_agent_password.py').read_bytes() == original['tests/test_agent_password.py']
    command('construct-partial', git_apply('--include=q36_agent.c'))
    partial = {name: digest(TREE / name) for name in original}
    run_patch('partial-rejected', 'apply', expected=1)
    assert partial == {name: digest(TREE / name) for name in original}
    command('restore-partial', git_apply('--reverse', '--include=q36_agent.c'))
    # A truncated base cannot be guessed. Preserve the exact broken input.
    full_source = (TREE / 'q36_agent.c').read_bytes()
    (TREE / 'q36_agent.c').write_bytes(full_source[:1024])
    drift = digest(TREE / 'q36_agent.c')
    run_patch('drift-rejected', 'apply', expected=1)
    assert digest(TREE / 'q36_agent.c') == drift
    (TREE / 'q36_agent.c').write_bytes(full_source)
    # A source symlink must not allow patching its target, even within the test.
    source_file = TREE / 'q36_agent.c'
    saved_source = TREE / 'saved-agent.c'
    source_file.rename(saved_source)
    source_file.symlink_to(saved_source.name)
    run_patch('linked-source-rejected', 'apply', expected=2)
    assert source_file.is_symlink() and saved_source.read_bytes() == full_source
    source_file.unlink(); saved_source.rename(source_file)
    assert REPORT['inputs'] == {name: digest(SOURCE / name) for name in REPORT['inputs']}, 'Original checkout was altered'
    REPORT['status'] = 'pass'; save()
finally:
    REPORT.setdefault('status', 'fail'); save()
    print('Native tty evidence:', RUN)
