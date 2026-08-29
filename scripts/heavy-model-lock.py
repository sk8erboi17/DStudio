#!/usr/bin/env python3
"""Serialize DStudio's heavyweight local accelerator pipelines.

The lock is intentionally process-wide and survives exec().  DS4 residency is
released by the caller before this wrapper is entered; this guard prevents the
Qwen3.8 vision, Ideogram 4, HunyuanImage and MiniMax H3 workers from ever loading together.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import sys
import time


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = list(args.command)
    if command and command[0] == "--":
        command.pop(0)
    if not command:
        parser.error("a command is required after --")

    root = Path(os.environ.get("DSTUDIO_HEAVY_MODEL_DIR", Path.home() / ".dstudio"))
    root.mkdir(parents=True, exist_ok=True)
    lock_path = root / "heavy-model.lock"
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        os.ftruncate(fd, 0)
        payload = {
            "pid": os.getpid(),
            "kind": args.kind,
            "started": int(time.time()),
            "command": Path(command[0]).name,
        }
        os.write(fd, (json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8"))
        os.fsync(fd)
        # Python descriptors are close-on-exec by default.  Keep this one open
        # so the kernel owns the lock for the complete model worker lifetime.
        os.set_inheritable(fd, True)
        os.execvpe(command[0], command, os.environ.copy())
    except OSError as exc:
        print(f"DStudio heavyweight-model lock failed: {exc}", file=sys.stderr)
        return 126
    finally:
        try:
            os.close(fd)
        except OSError:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
