#!/usr/bin/env python3
"""Check fragmented input while real terminal redraws and asynchronous output run."""
import errno
import fcntl
import os
from pathlib import Path
import pty
import re
import select
import struct
import subprocess
import sys
import termios
import time


def check(binary, fragments, expected, cols=40):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, cols, 0, 0))
    saved = termios.tcgetattr(slave)
    process = subprocess.Popen([binary, '--terminal-driver'], stdin=slave, stdout=slave,
                               stderr=slave, env={**os.environ, 'TERM': 'xterm-256color'})
    raw = bytearray()
    reply_scan = 0

    def collect(seconds):
        nonlocal reply_scan
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if not select.select([master], [], [], max(0, deadline-time.monotonic()))[0]:
                break
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            raw.extend(data)
            while True:
                pos = raw.find(b'\x1b[6n', reply_scan)
                if pos < 0:
                    break
                os.write(master, b'\x1b[1;1R')
                reply_scan = pos + 4
    try:
        collect(0.3)
        for data in fragments:
            os.write(master, data)
            collect(0.06)
        collect(0.4)
        os.write(master, b'\r')
        deadline = time.monotonic() + 4
        while process.poll() is None and time.monotonic() < deadline:
            collect(0.1)
        collect(0.1)
        assert process.wait(timeout=1) == 0, raw.decode(errors='replace')
        result = re.search(rb'RESULT:([0-9a-f]*)', raw)
        assert result and bytes.fromhex(result[1].decode()) == expected.encode(), raw.decode(errors='replace')
        assert b'model output' in raw, 'asynchronous output was not exercised'
        assert termios.tcgetattr(slave) == saved, 'terminal mode not restored'
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
        os.close(slave)


def main():
    binary = str(Path(sys.argv[1] if len(sys.argv) > 1 else './q36_agent_test').resolve())
    check(binary, [bytes([b]) for b in 'hé中'.encode()] + [b'\x1b', b'[', b'D', b'!'], 'hé!中')
    check(binary, [b'\x1b[20', b'0~', 'pasted 中\nsecond line'.encode(), b'\x1b[201', b'~'],
          'pasted 中\nsecond line')
    check(binary, ['long wrapped text 中 '.encode() * 5, b'\x01', b'START ', b'\x05', b' END'],
          'START ' + 'long wrapped text 中 ' * 5 + ' END', cols=24)
    print('PASS terminal: fragmented UTF-8/arrows, bracketed paste, wrapped editing, redraw, restoration')


if __name__ == '__main__':
    main()
