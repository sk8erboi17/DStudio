#!/usr/bin/env python3
"""Exercise the upstream terminal reader with actual EOF, not source matching."""
import importlib.util
import json
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('q36_password_fixture', Path(sys.argv[1]))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
openpty = fixture.pty.openpty
read = fixture.os.read
master = None
empty_reads = 0
total_reads = 0


def monitored_openpty():
    global master
    master, slave = openpty()
    return master, slave


def monitored_read(fd, size):
    global empty_reads, total_reads
    data = read(fd, size)
    if fd == master:
        total_reads += 1
        if not data:
            empty_reads += 1
            assert empty_reads <= 1, 'Terminal EOF was read again instead of ending the loop'
    return data


fixture.pty.openpty = monitored_openpty
fixture.os.read = monitored_read
try:
    fixture.check(str(Path(sys.argv[2]).resolve()), [], b'stdoutstderr',
                  command='printf stdout; printf stderr >&2')
    assert empty_reads == 1, 'This run did not exercise the EOF path'
    print(json.dumps({'status': 'pass', 'eofReads': empty_reads, 'terminalReads': total_reads}))
finally:
    fixture.pty.openpty = openpty
    fixture.os.read = read
