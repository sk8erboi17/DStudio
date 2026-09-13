#!/usr/bin/env python3
"""Prepare the pinned q36 engine privately, then publish one verified installation.

Called by DStudio's native --install-engine q36 command, not an HTTP owner loop.
No models, upstream Agent execution, existing checkout edits or app restart.
"""
import argparse
import ctypes
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import selectors
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time

PIN = '8362010a301b3360296e435703f58ffc230a024a'
LEGACY_PIN = 'd67687ed15ad9f52b755a9b5fdfc0214ea937555'
URL = f'https://codeload.github.com/Ninnix/q36/tar.gz/{PIN}'
SOURCE_LIMIT = 256 * 1024 * 1024
FILE_LIMIT = 8192
LOG_LIMIT = 2 * 1024 * 1024
ASSETS = Path(__file__).resolve().parent.parent


def sha256(file):
    digest = hashlib.sha256()
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size > 2 * SOURCE_LIMIT:
            raise RuntimeError('Nonregular or oversized installation input; preserved')
        read = 0
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            read += len(chunk)
            if read > 2 * SOURCE_LIMIT:
                raise RuntimeError('Installation input grew beyond its byte limit; preserved')
            digest.update(chunk)
        after = os.fstat(stream.fileno())
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise RuntimeError('Installation input changed while being verified; preserved')
    return digest.hexdigest()


def managed_files(tree, expected=None):
    """Hash owned installation files, never claim later user data as managed.

    Fresh preparation has no model/user data. Its complete byte inventory is
    recorded before publication; subsequent verification visits only that
    inventory. Compiler-source discovery remains a separate stricter check.
    Bounds: 8192 entries, 20 path components, 1024 chars/path, 512 MiB total.
    Legacy receipts without this inventory retain their old validation scope;
    they are not sufficient evidence to overwrite unrecorded files in an upgrade.
    """
    names = []
    if expected is None:
        pending, count = [tree], 0
        while pending:
            root = pending.pop()
            with os.scandir(root) as entries:
                for entry in entries:
                    count += 1
                    relative = str(Path(entry.path).relative_to(tree))
                    if count > FILE_LIMIT or len(relative) > 1024 or len(PurePosixPath(relative).parts) > 20:
                        raise RuntimeError('Managed file count or path limit exceeded')
                    if entry.is_dir(follow_symlinks=False):
                        pending.append(Path(entry.path))
                    elif not entry.is_file(follow_symlinks=False):
                        raise RuntimeError('Nonregular entry in managed preparation')
                    elif relative != '.dstudio-source.json':
                        names.append(relative)
    else:
        if (not isinstance(expected, dict) or not expected or len(expected) > FILE_LIMIT or
                any(not isinstance(name, str) for name in expected)):
            raise RuntimeError('Invalid managed-file inventory; preserved')
        names = list(expected)
    result, size = {}, 0
    for name in sorted(names):
        parts = PurePosixPath(name).parts
        if (not parts or len(parts) > 20 or len(name) > 1024 or '\\' in name or
                PurePosixPath(name).is_absolute() or '..' in parts or
                PurePosixPath(name).as_posix() != name or
                parts[0] == 'gguf' or name == '.dstudio-source.json'):
            raise RuntimeError('Invalid managed-file path; preserved')
        for depth in range(1, len(parts)):
            if tree.joinpath(*parts[:depth]).is_symlink():
                raise RuntimeError('Linked parent of a managed file; preserved')
        file = tree / name
        info = file.lstat()
        size += info.st_size
        if not stat.S_ISREG(info.st_mode) or size > 2 * SOURCE_LIMIT:
            raise RuntimeError('Managed file type or byte budget changed; preserved')
        result[name] = sha256(file)
        if expected is not None and result[name] != expected[name]:
            raise RuntimeError('Managed installation file changed; local edits preserved')
    return result


def mac_command_group_alive(group):
    """macOS killpg reports EPERM for an all-zombie group: ask the kernel.

    SDK libproc.h / proc_info.h: PROC_PGRP_ONLY=2, SHORTBSDINFO=13,
    SZOMB=5. No process names/arguments are captured. The bounded snapshot is
    only a liveness observation; it never supplies authority to signal a PID.
    """
    class ShortBSDInfo(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint32) for name in ('pid', 'ppid', 'pgid', 'status')] + [
            ('comm', ctypes.c_char * 16)] + [(name, ctypes.c_uint32) for name in
                                           ('flags', 'uid', 'gid', 'ruid', 'rgid', 'svuid', 'svgid', 'reserved')]

    lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    lib.proc_listpids.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int]
    lib.proc_listpids.restype = ctypes.c_int
    lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    lib.proc_pidinfo.restype = ctypes.c_int
    pids = (ctypes.c_int * 4096)()
    count = lib.proc_listpids(2, group, pids, ctypes.sizeof(pids))
    if count < 0 or count >= ctypes.sizeof(pids) or count % ctypes.sizeof(ctypes.c_int):
        raise RuntimeError('Cannot bound the owned command group; cleanup is unverified')
    for pid in pids[:count // ctypes.sizeof(ctypes.c_int)]:
        if not pid:
            continue
        info = ShortBSDInfo()
        size = lib.proc_pidinfo(pid, 13, 0, ctypes.byref(info), ctypes.sizeof(info))
        if size == 0 and ctypes.get_errno() == errno.ESRCH:
            continue
        if size != ctypes.sizeof(info):
            raise RuntimeError('Cannot inspect the owned command group; cleanup is unverified')
        if info.pgid == group and info.status != 5:
            return True
    return False


def signal_command_group(group, sig):
    try:
        os.killpg(group, sig)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        if sys.platform == 'darwin' and not mac_command_group_alive(group):
            return False
        raise


def _command(argv, cwd, env, seconds=180, *, lifetime_fd=None,
             pass_fds=(), cleanup_grace=2, output_limit=None):
    """Supervise one reserved process group, optionally tied to an owner pipe.

    The installer itself cannot run cleanup after SIGKILL. Its separate
    supervisor is the actual command's parent, retaining waitid/WNOWAIT identity
    until the last signal. Only that supervisor receives the pipe's read end;
    compiler descendants must never inherit an end that could hide owner death.
    """
    if not all(hasattr(os, name) for name in ('waitid', 'WNOWAIT', 'WEXITED', 'P_PID')):
        raise RuntimeError('This installer requires Python waitid/WNOWAIT process supervision')
    if output_limit is None:
        output_limit = LOG_LIMIT
    if lifetime_fd is not None:
        os.set_blocking(lifetime_fd, False)

    def require_owner():
        if lifetime_fd is not None:
            try:
                os.read(lifetime_fd, 1)
            except BlockingIOError:
                return
            # The owner never writes data: EOF (or any unexpected byte) revokes
            # admission. Check even when the command has closed stdout early.
            raise RuntimeError('Installer owner disconnected; owned command stopped')

    require_owner()
    child = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             start_new_session=True, pass_fds=pass_fds)
    output = bytearray()
    deadline = time.monotonic() + seconds
    try:
        with selectors.DefaultSelector() as reader:
            reader.register(child.stdout, selectors.EVENT_READ)
            while reader.get_map():
                require_owner()
                if time.monotonic() >= deadline:
                    raise RuntimeError(f'Command deadline ({seconds}s) exceeded')
                for key, _ in reader.select(min(0.2, max(0, deadline - time.monotonic()))):
                    data = os.read(key.fd, 8192)
                    if not data:
                        reader.unregister(key.fileobj)
                        continue
                    if len(output) + len(data) > output_limit:
                        raise RuntimeError(f'Command output exceeded the {output_limit}-byte limit')
                    output.extend(data)
            # Observe completion without reaping: its PID still reserves the
            # command's process-group identity until the final group signal.
            # Reaping first would let a later killpg hit a recycled PID/PGID.
            while True:
                require_owner()
                status = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOWAIT | os.WNOHANG)
                if status is not None:
                    result = status.si_status if status.si_code == os.CLD_EXITED else -status.si_status
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError(f'Command deadline ({seconds}s) exceeded')
                time.sleep(0.01)
        if result:
            raise RuntimeError(f'Command failed ({result}):\n' + output[-8192:].decode('utf-8', 'replace'))
        return output.decode('utf-8', 'replace')
    finally:
        # Only this command's process group; a compiler child must not outlive
        # a cancelled installer or release its preparation lease prematurely.
        signal_command_group(child.pid, signal.SIGTERM)
        grace = time.monotonic() + cleanup_grace
        while os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOWAIT | os.WNOHANG) is None:
            if time.monotonic() >= grace:
                break
            time.sleep(0.01)
        # A parent may have exited while descendants still own sockets/files.
        # Signal them before reaping the leader, then verify actual group drain.
        signal_command_group(child.pid, signal.SIGKILL)
        try:
            child.wait(timeout=2)
            drained_by = time.monotonic() + 2
            while True:
                if not signal_command_group(child.pid, 0):  # Observation only after reaping.
                    break
                if time.monotonic() >= drained_by:
                    raise RuntimeError('Command group did not drain; inspect retained preparation before retrying')
                time.sleep(0.01)
        finally:
            child.stdout.close()


def command(argv, cwd, env, seconds=180):
    """A bounded, installer-only supervisor survives loss of the caller.

    One extra Python process per sequential command; no worker pool or model
    process. The inner command keeps its original work deadline/output limit.
    Eight additional seconds cover its existing termination/reap/drain path,
    not more compilation time. The parent owns the sole keepalive writer.
    """
    print('q36 install: ' + json.dumps(argv), flush=True)
    read_fd, write_fd = os.pipe()
    try:
        supervised = [sys.executable, '-B', str(Path(__file__).resolve()),
                      '--owned-command', str(read_fd), str(seconds), str(LOG_LIMIT), json.dumps(argv)]
        return _command(supervised, cwd, env, seconds + 8,
                        pass_fds=(read_fd,), cleanup_grace=8,
                        # UTF-8 replacement may expand each invalid input byte
                        # to three bytes; preserve the existing decoded result.
                        output_limit=3 * LOG_LIMIT + 8192)
    finally:
        os.close(write_fd)
        os.close(read_fd)


def extract_sources(archive, target, revision=None):
    """Bound compressed/unpacked bytes and reject all nonregular archive entries."""
    members = []
    total = 0
    prefix = 'q36-' + (revision or PIN)
    with tarfile.open(archive, 'r:gz') as package:
        for item in package:
            parts = PurePosixPath(item.name).parts
            if (not parts or parts[0] != prefix or '..' in parts or
                    '\\' in item.name or not (item.isfile() or item.isdir())):
                raise RuntimeError('Unexpected or linked archive entry; no source published')
            if len(parts) > 20 or item.size < 0 or item.size > SOURCE_LIMIT:
                raise RuntimeError('Archive entry exceeds preparation limits')
            total += item.size
            members.append((item, parts[1:]))
            if total > SOURCE_LIMIT or len(members) > FILE_LIMIT:
                raise RuntimeError('Archive exceeds preparation byte/file limits')
        # Validate the whole index before writing. The unique 0700 preparation
        # contains no user files or links; exclusive creates also reject aliases.
        for item, parts in members:
            output = target.joinpath(*parts)
            if item.isdir():
                output.mkdir(parents=True, exist_ok=True)
                continue
            output.parent.mkdir(parents=True, exist_ok=True)
            with package.extractfile(item) as source, output.open('xb') as sink:
                remaining = item.size
                while remaining:
                    data = source.read(min(1024 * 1024, remaining))
                    if not data:
                        raise RuntimeError('Archive member was truncated')
                    sink.write(data)
                    remaining -= len(data)
            output.chmod(0o755 if item.mode & 0o111 else 0o644)


def source_identity(tree, *, installed=False):
    result = {}
    size = 0
    for root, directories, files in os.walk(tree, followlinks=False):
        # The managed gguf alias is runtime data, never a compiler input of the
        # pinned Makefile (which remains hashed). Do not traverse shared weights
        # or make their presence invalidate an otherwise identical installation.
        if Path(root) == tree:
            directories[:] = [name for name in directories if name != 'gguf']
            if installed:
                # Both reviewed pins use explicit root sources, metal/*.metal,
                # Vulkan shaders and these distributed support directories.
                # New user project directories are not compiler/runtime inputs.
                # Keep discovery strict inside engine areas: removing a shader
                # from a receipt or adding a compiler input must still reject.
                directories[:] = [name for name in directories if name in
                                  ('metal', 'vulkan', 'tests', 'gguf-tools', 'third_party')]
        if installed and Path(root) == tree / 'third_party':
            directories[:] = [name for name in directories if name == 'iris']
        for directory in directories:
            if (Path(root) / directory).is_symlink():
                raise RuntimeError('Linked directory in engine preparation')
        for name in files:
            file = Path(root) / name
            if name != 'Makefile' and file.suffix not in ('.c', '.h', '.m', '.metal', '.comp', '.inc'):
                continue
            info = file.lstat()
            if not stat.S_ISREG(info.st_mode):
                raise RuntimeError('Nonregular source in engine preparation')
            size += info.st_size
            if size > SOURCE_LIMIT or len(result) >= FILE_LIMIT:
                raise RuntimeError('Source identity exceeds preparation limits')
            result[str(file.relative_to(tree))] = sha256(file)
    return result


def no_replace(source_parent, source_name, target_parent, target_name):
    """Platform no-clobber directory publication; never emulate with overwrite."""
    library = ctypes.CDLL(None, use_errno=True)
    if sys.platform == 'darwin':
        rename = library.renameatx_np
        flag = 4  # RENAME_EXCL in the macOS SDK's stdio.h.
    elif sys.platform.startswith('linux'):
        rename = library.renameat2
        flag = 1  # RENAME_NOREPLACE.
    else:
        raise RuntimeError('Atomic installation publication is unavailable on this platform')
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(source_parent, os.fsencode(source_name), target_parent, os.fsencode(target_name), flag):
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def exchange_installation(source_parent, target_parent):
    """One atomic directory exchange; the old installation remains in staging."""
    library = ctypes.CDLL(None, use_errno=True)
    if sys.platform == 'darwin':
        rename, flag = library.renameatx_np, 2  # RENAME_SWAP.
    elif sys.platform.startswith('linux'):
        rename, flag = library.renameat2, 2  # RENAME_EXCHANGE.
    else:
        raise RuntimeError('Atomic installation upgrade is unavailable on this platform')
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(source_parent, b'q36', target_parent, b'q36', flag):
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def sync_upgrade_namespace(root_fd, receipt):
    # Reopening after an interrupted final fsync verifies code first, then
    # retries namespace durability. Never repeat the exchange or infer rollback
    # authority from this metadata: shared user files may have changed since.
    previous = receipt.get('upgradeFrom')
    if previous is None:
        return
    backup = previous.get('backup') if isinstance(previous, dict) else None
    if (not isinstance(backup, str) or len(backup) > 255 or
            len(backup.split('/')) != 2 or backup.split('/')[1] != 'q36' or
            not backup.split('/')[0].startswith('.dstudio-q36-stage-')):
        raise RuntimeError('Invalid q36 upgrade recovery location; files preserved')
    fd = os.open(backup.split('/')[0], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
    try:
        os.fsync(fd)
        os.fsync(root_fd)
    finally:
        os.close(fd)


def installation_receipt(tree):
    """Read a bounded regular receipt without following an alias or a FIFO."""
    fd = os.open(tree / '.dstudio-source.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as source:
        before = os.fstat(source.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size > 1024 * 1024:
            raise RuntimeError('Existing q36 has no valid installation receipt; preserved')
        data = source.read(1024 * 1024 + 1)
        after = os.fstat(source.fileno())
        if len(data) > 1024 * 1024 or file_stamp(before) != file_stamp(after):
            raise RuntimeError('Installation receipt changed or exceeded its limit; preserved')
    receipt = json.loads(data)
    if not isinstance(receipt, dict):
        raise RuntimeError('Invalid installation receipt; preserved')
    return receipt, hashlib.sha256(data).hexdigest()


def verify_existing(tree, receipt, require_inventory=False):
    sources, binaries = receipt.get('sources'), receipt.get('binaries')
    if not isinstance(sources, dict) or not isinstance(binaries, dict):
        raise RuntimeError('Invalid installation identities; preserved')
    if source_identity(tree, installed=True) != sources:
        raise RuntimeError('Existing q36 source changed; local edits preserved')
    if 'managedFiles' in receipt:
        owned = receipt['managedFiles']
        if (not isinstance(owned, dict) or any(owned.get(name) != digest for name, digest in
                {**sources, **binaries}.items())):
            raise RuntimeError('Managed inventory omits a recorded compiler input or runtime; preserved')
        managed_files(tree, owned)
    elif require_inventory:
        raise RuntimeError('Legacy q36 receipt needs ownership migration before upgrade; preserved')
    for name in ('q36', 'q36-server'):
        if (tree / name).is_symlink() or sha256(tree / name) != binaries.get(name):
            raise RuntimeError('Existing q36 binary changed; preserved')


def file_stamp(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_nlink)


def installation_snapshot(tree):
    """Bounded metadata only: never read, copy or follow user/model payloads.

    This is an upgrade-private change detector, not a second source of truth.
    At most 8192 entries / 20 components / 1024 chars per path; existing payload
    bytes are not buffered. Symlinks are retained verbatim, including broken
    ones. Unsupported special files or a concurrent change reject publication.
    """
    snapshot, pending = {'': file_stamp(tree.lstat())}, [tree]
    while pending:
        directory = pending.pop()
        with os.scandir(directory) as entries:
            for entry in entries:
                name = str(Path(entry.path).relative_to(tree))
                if len(snapshot) >= FILE_LIMIT or len(name) > 1024 or len(PurePosixPath(name).parts) > 20:
                    raise RuntimeError('Upgrade data inventory exceeds its entry/path limit; preserved')
                info = entry.stat(follow_symlinks=False)
                if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)):
                    raise RuntimeError('Special file in existing installation; preserved')
                value = file_stamp(info)
                if stat.S_ISLNK(info.st_mode):
                    link = os.readlink(entry.path)
                    if len(os.fsencode(link)) > 4096:
                        raise RuntimeError('Upgrade symlink exceeds its byte limit; preserved')
                    value += (link,)
                snapshot[name] = value
                if stat.S_ISDIR(info.st_mode):
                    pending.append(Path(entry.path))
    return snapshot


def legacy_ownership(tree, receipt, stage, env):
    """Reconstruct only provable ownership; never adopt an old build directory.

    The two reviewed Metal archive layouts load shader source, not unrecorded
    binary shader files. Sources and desktop executables are already hashed in
    legacy receipts. Other distributed files belong to the installer only if
    they still match the exact archived bytes. Unknown files stay user-owned.
    """
    revision, digest = receipt.get('commit'), receipt.get('archiveSHA256')
    if (receipt.get('backend') != 'metal' or revision not in (LEGACY_PIN, PIN) or
            not isinstance(digest, str) or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest)):
        raise RuntimeError('Legacy q36 ownership migration lacks a reviewed archive identity; preserved')
    archive, original = stage / 'legacy-source.tar.gz', stage / 'legacy-source'
    url = f'https://codeload.github.com/Ninnix/q36/tar.gz/{revision}'
    command(['curl', '--disable', '--fail', '--location', '--silent', '--show-error',
             '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '20',
             '--max-time', '120', '--max-filesize', str(64 * 1024 * 1024),
             '--output', str(archive), url], stage, env, 130)
    if sha256(archive) != digest:
        raise RuntimeError('Legacy source archive identity differs; existing installation preserved')
    extract_sources(archive, original, revision)
    distributed = managed_files(original)
    owned = {**receipt['sources'], **receipt['binaries']}
    for name, expected in distributed.items():
        file = tree / name
        if (name not in owned and file.is_file() and not file.is_symlink() and
                file.stat().st_size <= 2 * SOURCE_LIMIT and sha256(file) == expected):
            owned[name] = expected
    managed_files(tree, owned)
    return owned


def require_legacy_idle(tree):
    # Older desktop hosts did not hold the installation-use lease. On the
    # reviewed macOS migration path also inspect open vnodes of the two native
    # desktop executables. This never signals, stops or restarts that process.
    # Manual/uncooperative launches must remain stopped throughout the update;
    # the new host's lease is what excludes a launch racing final publication.
    probe = subprocess.run(['/usr/sbin/lsof', '-nP', '-t', '--', str(tree / 'q36'), str(tree / 'q36-server')],
                           stdin=subprocess.DEVNULL, capture_output=True, timeout=5)
    if len(probe.stdout) > 32768 or len(probe.stderr) > 32768 or probe.returncode not in (0, 1) or probe.stderr:
        raise RuntimeError('Cannot verify legacy q36 process ownership; existing installation preserved')
    if probe.stdout.strip():
        raise RuntimeError('Legacy q36 executable is still in use; stop that engine before upgrading')


def retain_legacy_build_paths(candidate, stage, previous, source_files, snapshot):
    # A legacy receipt did not own objects, extra upstream command-line tools
    # or build logs. Keep their original bytes at their original paths. Move
    # only our own *new* non-runtime build products out of conflicting names.
    # Desktop q36/q36-server and all distributed source/runtime assets must
    # always be the newly verified version; they can never use this exception.
    retained = []
    for name in managed_files(candidate):
        if (name not in snapshot or name in previous['managedFiles'] or name in source_files or
                name in ('q36', 'q36-server')):
            continue
        destination = stage / 'new-build-products' / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        (candidate / name).rename(destination)
        retained.append(name)
    return retained


def preserve_user_files(tree, candidate, owned, snapshot):
    """Retain unowned paths in place, sharing regular-file inodes, not bytes.

    The complete previous engine is retained after exchange. Its shared user
    files are NOT an immutable backup or undo of later user edits. Only owned
    engine files are independently retained for a future validated rollback.
    Conflicts reject the update; an unknown file is never silently adopted.
    """
    if installation_snapshot(tree) != snapshot:
        raise RuntimeError('Installation data changed during preparation; preserved')
    expected = dict(snapshot)
    # Account for our own link-count/ctime changes even when user files have
    # several aliases. No content change is authorized by a successful link.
    aliases = {}
    for name, stamp in snapshot.items():
        if stat.S_ISREG(stamp[2]):
            aliases.setdefault(stamp[:2], []).append(name)
    directories, preserved = [], []
    for name, initial in sorted(snapshot.items()):
        if not name or name == '.dstudio-source.json' or name in owned:
            continue
        source, target = tree / name, candidate / name
        if stat.S_ISDIR(initial[2]):
            if target.is_symlink() or (target.exists() and not target.is_dir()):
                raise RuntimeError('User directory conflicts with the new engine; preserved')
            if not target.exists():
                target.mkdir()
                directories.append((target, initial[2]))
            continue
        if target.exists() or target.is_symlink():
            raise RuntimeError('User file conflicts with the new engine; preserved: ' + name)
        if file_stamp(source.lstat()) != expected[name][:9]:
            raise RuntimeError('User file changed while being prepared; preserved')
        if stat.S_ISLNK(initial[2]):
            target.symlink_to(initial[9])
        else:
            os.link(source, target, follow_symlinks=False)
            linked = file_stamp(target.lstat())
            previous = expected[name]
            if linked[:7] != previous[:7] or linked[8] != previous[8] + 1:
                raise RuntimeError('User file changed during link preparation; preserved')
            for alias in aliases[initial[:2]]:
                expected[alias] = linked
        preserved.append(name)
    if installation_snapshot(tree) != expected:
        raise RuntimeError('Installation data changed before publication; preserved')
    # Sync the new namespace, not multi-GiB model contents. Existing file bytes
    # have not been modified. Do not follow model-store or user-directory links.
    for directory, mode in reversed(directories):
        directory.chmod(stat.S_IMODE(mode))
    for directory in sorted((candidate / name for name, stamp in snapshot.items()
                             if stat.S_ISDIR(stamp[2])), key=lambda p: len(p.parts), reverse=True):
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    return expected, preserved


def sync_candidate(tree):
    # Durable preparation precedes publication. A receipt alone must not become
    # durable while the binaries and patched inputs it identifies are not.
    count, size = 0, 0
    for root, directories, files in os.walk(tree, topdown=False, followlinks=False):
        for name in directories:
            if (Path(root) / name).is_symlink():
                raise RuntimeError('Linked directory before durable publication')
        for name in files:
            fd = os.open(Path(root) / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                info = os.fstat(fd)
                count += 1
                size += info.st_size
                if not stat.S_ISREG(info.st_mode) or count > FILE_LIMIT or size > 2 * SOURCE_LIMIT:
                    raise RuntimeError('Build outputs exceed preparation limits')
                os.fsync(fd)
            finally:
                os.close(fd)
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def install(root, revision):
    if revision != PIN:
        raise RuntimeError('Native installer and q36 patch pins disagree; no installation')
    if sys.platform == 'darwin' and platform.machine() == 'arm64':
        backend, targets = 'metal', ['metal']
    elif sys.platform.startswith('linux'):
        backend, targets = 'vulkan', ['q36', 'q36-server', 'GLSLC=glslc']
    else:
        raise RuntimeError('q36 requires Apple Silicon Metal or Linux Vulkan; platform not qualified')
    root = root.resolve(strict=True)
    if not root.is_dir():
        raise RuntimeError('Installation root must be an existing directory')
    tree = root / 'q36'
    env = dict(os.environ)
    for key in list(env):
        if key.startswith(('GIT_', 'Q36_', 'DYLD_')) or key in (
                'MAKEFLAGS', 'MAKELEVEL', 'MFLAGS', 'MAKEOVERRIDES', 'GNUMAKEFLAGS',
                'CFLAGS', 'CPPFLAGS', 'LDFLAGS', 'CC', 'CXX', 'Q36_DIR'):
            del env[key]
    patch_file = ASSETS / 'patch/q36-metal-runtime/next-review.patch'
    patch_script = ASSETS / 'scripts/apply-q36-metal-runtime.sh'
    terminal_script = ASSETS / 'scripts/apply-q36-agent-tty.sh'
    terminal_patch = ASSETS / 'patch/q36-agent-tty/monitor.patch'
    owner_patch = ASSETS / 'patch/q36-agent-tty/monitor-owner.patch'
    usage_patch = ASSETS / 'patch/q36-metal-runtime/cache-usage.patch'
    patch_order = [str(file.relative_to(ASSETS)) for file in (patch_file, terminal_patch, owner_patch, usage_patch)]
    patch_identity = {str(file.relative_to(ASSETS)): sha256(file) for file in
                      (patch_file, patch_script, terminal_script, terminal_patch, owner_patch, usage_patch)}
    installer_identity = sha256(Path(__file__).resolve())
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    lock = -1
    try:
        lock = os.open('.dstudio-q36-install.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                       0o600, dir_fd=root_fd)
        info = os.fstat(lock)
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or
                info.st_uid != os.geteuid() or info.st_mode & (stat.S_IWGRP | stat.S_IWOTH)):
            raise RuntimeError('Invalid installer preparation lock')
        try:
            # Read-only verification must coexist with the resident model:
            # Chat -> Agent preparation verifies this same installation.
            # This is a non-waiting process-lifetime lease, not an app-state
            # mutex. Never unlink it, including on failure or cancellation.
            fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError('q36 installation already active; retry after its result') from error
        previous = previous_hash = snapshot = None
        if tree.exists() or tree.is_symlink():
            if tree.is_symlink() or not tree.is_dir():
                raise RuntimeError('Existing q36 path is not a managed directory; preserved')
            if not (tree / '.dstudio-source.json').exists():
                raise RuntimeError('Existing q36 has no valid installation receipt; preserved')
            receipt, receipt_hash = installation_receipt(tree)
            if (receipt.get('engine'), receipt.get('backend')) != ('q36', backend):
                raise RuntimeError('Existing q36 engine/backend identity differs; preserved')
            current = (receipt.get('commit'), receipt.get('patches')) == (PIN, patch_identity)
            verify_existing(tree, receipt)
            if current:
                for name in ('q36', 'q36-server'):
                    command([str(tree / name), '--help'], tree, env, 15)
                sync_upgrade_namespace(root_fd, receipt)
                print(json.dumps({'ok': True, 'engine': 'q36', 'downloaded': False, 'backend': backend,
                                  'path': str(tree), 'modelLoaded': False,
                                  'upgradeFrom': receipt.get('upgradeFrom')}))
                return
            # Unknown patch requirements must not be silently dropped by an
            # upgrade. Recorded source edits are checked above, before any build.
            known = set(patch_identity) | {'patch/q36-metal-runtime/runtime.patch'}
            if not isinstance(receipt.get('patches'), dict) or set(receipt['patches']) - known:
                raise RuntimeError('Existing q36 has additional patch requirements; preserved')
            if receipt.get('commit') not in (LEGACY_PIN, PIN):
                raise RuntimeError('Existing q36 revision is not a reviewed upgrade base; preserved')
            if 'managedFiles' not in receipt and (receipt.get('backend') != 'metal' or
                                                  not receipt.get('archiveSHA256')):
                raise RuntimeError('Legacy q36 receipt needs ownership migration before upgrade; preserved')
            previous, previous_hash, snapshot = receipt, receipt_hash, installation_snapshot(tree)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError('q36 installation or runtime already active; retry after its result') from error
        # flock SH -> EX conversion is not guaranteed atomic. Recheck after
        # exclusive admission; a competing installer may have published while
        # our shared lease was being converted. Never overwrite that result.
        if previous:
            if installation_receipt(tree)[1] != previous_hash or installation_snapshot(tree) != snapshot:
                raise RuntimeError('q36 installation changed during admission; retry verification')
        elif tree.exists() or tree.is_symlink():
            raise RuntimeError('q36 installation changed during admission; retry verification')
        legacy = previous is not None and 'managedFiles' not in previous
        if legacy:
            require_legacy_idle(tree)
        # A failed candidate is retained, never silently erased. Bound retained
        # preparations to two; logs are bounded separately by command().
        if sum(1 for name in os.listdir(root_fd) if name.startswith('.dstudio-q36-stage-')) >= 2:
            raise RuntimeError('Two prior q36 preparations are retained; inspect them before retrying')
        stage = Path(tempfile.mkdtemp(prefix='.dstudio-q36-stage-', dir=root))
        print(f'q36 install: private preparation {stage}', flush=True)
        stage_info = stage.stat()
        candidate = stage / 'q36'
        archive = stage / 'source.tar.gz'
        if legacy:
            previous['managedFiles'] = legacy_ownership(tree, previous, stage, env)
        command(['curl', '--disable', '--fail', '--location', '--silent', '--show-error',
                 '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '20',
                 '--max-time', '120', '--max-filesize', str(64 * 1024 * 1024),
                 '--output', str(archive), URL], stage, env, 130)
        archive_hash = sha256(archive)
        extract_sources(archive, candidate)
        env['Q36_DIR'] = str(candidate)
        # The terminal and owner changes are separate, reviewed upstream
        # adaptations. Preserve their application order in the durable receipt.
        command(['/bin/sh', str(patch_script), 'apply', 'next-review'], candidate, env, 20)
        command(['/bin/sh', str(terminal_script), 'apply', 'monitor'], candidate, env, 20)
        command(['/bin/sh', str(terminal_script), 'apply', 'monitor-owner'], candidate, env, 20)
        command(['/bin/sh', str(patch_script), 'apply', 'cache-usage'], candidate, env, 20)
        frozen = source_identity(candidate)
        distributed_inputs = managed_files(candidate) if legacy else None
        build_command = ['make', '-B', '-j2', *targets]
        build_log = command(build_command, candidate, env, 300)
        with (candidate / '.dstudio-build.log').open('x') as output:
            output.write(build_log)
        binaries = {}
        for name in ('q36', 'q36-server'):
            command([str(candidate / name), '--help'], candidate, env, 15)
            binaries[name] = sha256(candidate / name)
        if source_identity(candidate) != frozen:
            raise RuntimeError('Engine source changed during build; candidate not published')
        if any(sha256(ASSETS / name) != digest for name, digest in patch_identity.items()):
            raise RuntimeError('DStudio patch inputs changed during build; candidate not published')
        if sha256(Path(__file__).resolve()) != installer_identity:
            raise RuntimeError('Installer changed during build; candidate not published')
        legacy_build_paths = retain_legacy_build_paths(candidate, stage, previous, distributed_inputs, snapshot) \
            if legacy else []
        if legacy:
            sync_candidate(stage / 'legacy-source')
            if legacy_build_paths:
                sync_candidate(stage / 'new-build-products')
        receipt = {'engine': 'q36', 'commit': PIN, 'url': URL, 'archiveSHA256': archive_hash,
                   'backend': backend, 'patches': patch_identity, 'patchOrder': patch_order,
                   'sources': frozen, 'binaries': binaries,
                   'managedFiles': managed_files(candidate),
                   'buildCommand': build_command, 'installerSHA256': installer_identity,
                   'modelLoaded': False, 'qualityValidated': False}
        if previous:
            receipt['upgradeFrom'] = {'commit': previous['commit'], 'receiptSHA256': previous_hash,
                                      'backup': stage.name + '/q36', 'userFilesShared': True}
            if legacy:
                receipt['upgradeFrom']['ownershipReconstructed'] = True
                receipt['upgradeFrom']['legacyBuildFilesPreserved'] = legacy_build_paths
                receipt['upgradeFrom']['newBuildProducts'] = stage.name + '/new-build-products'
                receipt['upgradeFrom']['newBuildFilesSHA256'] = {
                    name: sha256(stage / 'new-build-products' / name) for name in legacy_build_paths}
        encoded = json.dumps(receipt, sort_keys=True)
        if len(encoded.encode('utf-8')) > 1024 * 1024:
            raise RuntimeError('Installation receipt exceeds its 1 MiB limit; no publication')
        with (candidate / '.dstudio-source.json').open('x') as output:
            output.write(encoded)
            output.flush()
            os.fsync(output.fileno())
        sync_candidate(candidate)
        managed_files(candidate, receipt['managedFiles'])
        if previous:
            if legacy:
                require_legacy_idle(tree)
            snapshot, preserved = preserve_user_files(tree, candidate, previous['managedFiles'], snapshot)
            # Revalidate both code identities after variable-cost preparation.
            verify_existing(tree, previous, require_inventory=True)
            if (installation_receipt(tree)[1] != previous_hash or
                    installation_snapshot(tree) != snapshot):
                raise RuntimeError('Existing installation changed before commit; preserved')
            managed_files(candidate, receipt['managedFiles'])
            journal = {'version': 1, 'oldReceiptSHA256': previous_hash,
                       'newReceiptSHA256': sha256(candidate / '.dstudio-source.json'),
                       'oldDirectory': list(snapshot[''][:2]),
                       'newDirectory': list(file_stamp(candidate.lstat())[:2]),
                       'preservedPaths': preserved, 'userFilesShared': True}
            with (stage / 'upgrade.json').open('x') as output:
                json.dump(journal, output, sort_keys=True)
                output.flush()
                os.fsync(output.fileno())
        current, owned, current_stage = root.lstat(), os.fstat(root_fd), stage.lstat()
        if (not stat.S_ISDIR(current.st_mode) or not stat.S_ISDIR(current_stage.st_mode) or
                (current.st_dev, current.st_ino) != (owned.st_dev, owned.st_ino) or
                (current_stage.st_dev, current_stage.st_ino) != (stage_info.st_dev, stage_info.st_ino)):
            raise RuntimeError('Installation destination changed; no candidate published')
        named_lease = os.stat('.dstudio-q36-install.lock', dir_fd=root_fd, follow_symlinks=False)
        held_lease = os.fstat(lock)
        if ((named_lease.st_dev, named_lease.st_ino) != (held_lease.st_dev, held_lease.st_ino) or
                held_lease.st_nlink != 1):
            raise RuntimeError('Installation lease identity changed; no candidate published')
        stage_fd = os.open(stage, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        next_identity = file_stamp(candidate.lstat())[:2]
        try:
            os.fsync(stage_fd)
            if previous:
                # Metadata checks are repeated immediately before the single
                # namespace transition. The private build never replaces a live
                # model; the exclusive lifetime lease remains held throughout.
                if (installation_snapshot(tree) != snapshot or
                        installation_receipt(tree)[1] != previous_hash):
                    raise RuntimeError('Existing installation changed at publication; preserved')
                if legacy:
                    require_legacy_idle(tree)
                exchange_installation(stage_fd, root_fd)
            else:
                no_replace(stage_fd, 'q36', root_fd, 'q36')
            os.fsync(root_fd)
            os.fsync(stage_fd)
        except BaseException as error:
            installed_identity = file_stamp(os.stat('q36', dir_fd=root_fd, follow_symlinks=False))[:2] \
                if os.path.lexists(tree) else None
            if installed_identity == next_identity:
                raise RuntimeError('q36 installation was published, but final acknowledgement/durability '
                                   'was interrupted; reopen to verify. Previous engine and recovery '
                                   'record remain in ' + stage.name) from error
            raise
        finally:
            os.close(stage_fd)
        # Only the exact archive made here, not recursive cleanup of a caller's
        # directory. Unexpected entries keep this preparation visible for review.
        if not previous:
            archive.unlink()
            stage.rmdir()
        print(json.dumps({'ok': True, 'engine': 'q36', 'downloaded': True, 'backend': backend,
                          'path': str(tree), 'modelLoaded': False,
                          'upgradeFrom': receipt.get('upgradeFrom')}), flush=True)
    finally:
        if lock >= 0:
            os.close(lock)
        os.close(root_fd)


def main():
    def stop(_signal, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    if sys.argv[1:2] == ['--owned-command']:
        if len(sys.argv) != 6:
            raise RuntimeError('Invalid installer command supervision arguments')
        fd, seconds, limit = int(sys.argv[2]), float(sys.argv[3]), int(sys.argv[4])
        if (fd < 3 or not stat.S_ISFIFO(os.fstat(fd).st_mode) or
                not 0 < seconds <= 1800 or not 0 < limit <= LOG_LIMIT or
                len(sys.argv[5]) > 128 * 1024):
            raise RuntimeError('Invalid installer command lifetime or budget')
        argv = json.loads(sys.argv[5])
        if (not isinstance(argv, list) or not 0 < len(argv) <= 1024 or
                any(not isinstance(arg, str) or '\0' in arg for arg in argv)):
            raise RuntimeError('Invalid installer command vector')
        try:
            output = _command(argv, Path.cwd(), os.environ, seconds,
                              lifetime_fd=fd, output_limit=limit)
            sys.stdout.buffer.write(output.encode('utf-8'))
            sys.stdout.buffer.flush()
        finally:
            os.close(fd)
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--revision', required=True)
    args = parser.parse_args()

    install(args.root, args.revision)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('q36 installation stopped; candidate preserved, no running model.', file=sys.stderr)
        sys.exit(130)
    except (OSError, RuntimeError, ValueError, AttributeError, subprocess.SubprocessError, tarfile.TarError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
