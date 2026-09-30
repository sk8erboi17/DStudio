#!/usr/bin/env python3
"""Exercise the real password UI and bash runner with a model-free sudo fixture."""

import fcntl
import os
from pathlib import Path
import pty
import select
import shlex
import struct
import subprocess
import sys
import termios
import time


def check(binary, answers, expected, timeout=5, command=None, noninteractive=False):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    saved = termios.tcgetattr(slave)
    command = command or f"exec {shlex.quote(binary)} --password-child"
    process = subprocess.Popen(
        [binary, "--noninteractive-driver" if noninteractive else "--password-driver",
         command, str(timeout)],
        stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
        preexec_fn=lambda: fcntl.ioctl(0, termios.TIOCSCTTY, 0),
        env={**os.environ, "TERM": "xterm-256color"},
    )
    transcript = bytearray()
    answered = 0
    deadline = time.monotonic() + timeout + 5
    marker = b"[sudo] password for test: "
    try:
        while time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], 0.1)
            if ready:
                transcript.extend(os.read(master, 65536))
                if transcript.count(marker) > answered and answered < len(answers):
                    os.write(master, answers[answered])
                    answered += 1
            elif process.poll() is not None:
                break
        assert process.wait(timeout=1) == 0, transcript.decode(errors="replace")
        assert expected in transcript, transcript.decode(errors="replace")
        assert b"DRAFT_OK=1" in transcript, transcript.decode(errors="replace")
        assert termios.tcgetattr(slave) == saved, "terminal mode was not restored"
        for secret in (b"q36-test-secret", b"wrong-secret", b"secret-suffix"):
            assert secret not in transcript, "password leaked into terminal/tool output"
        return transcript
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
        os.close(slave)


def main():
    binary = str(Path(sys.argv[1] if len(sys.argv) > 1 else "./q36_agent_test").resolve())
    check(binary, [b"q36-test-secret\rsecret-suffix"], b"PASSWORD_OK")
    check(binary, [b"wrong-secret\r", b"q36-test-secret\r"], b"PASSWORD_OK")
    check(binary, [b"typo\x15q36-test-secreX\x7ft\r"], b"PASSWORD_OK")
    check(binary, [b"wrong-secret\x03"], b"Password entry cancelled")
    result = check(binary, [], b"Password entry timed out", timeout=1)
    assert b"timed_out=1" in result
    check(binary, [], b"stdoutstderr", command="printf stdout; printf stderr >&2")
    check(binary, [], b"NO_TERMINAL", noninteractive=True)
    print("q36-agent password tests: entry, retry, editing, cancellation, timeout, "
          "output isolation, noninteractive mode, and terminal restoration passed")


if __name__ == "__main__":
    main()
