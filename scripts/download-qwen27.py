#!/usr/bin/env python3
"""Pinned Qwen3.8-27B candidate weights and native F16 projector; no engine start."""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
from urllib.parse import urlsplit

REPO = 'unsloth/Qwen3.8-27B-GGUF'
REVISION = '4ca720788d1e01f1bff70c033e0d0028fd02e502'
FILES = {
    'model': {'file': 'Qwen3.8-27B-UD-Q6_K_XL.gguf', 'bytes': 25299061664,
              'sha256': '701d8fa9ed214ab21bfc130cd2a7df19ca89bbef7713e2dfb19f3c63696aa917'},
    'vision': {'file': 'Qwen3.8-27B-mmproj-F16.gguf', 'remote': 'mmproj-F16.gguf',
               'bytes': 927607488,
               'sha256': 'cbb841a9ee0636b2ec172f5bb8df2ea8dfeb01e90fe7c6126581d662a0b4e43e'},
}
CHUNK = 1024 * 1024
MAX_SECONDS = 6 * 60 * 60


def identity(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def regular(parent, name, flags=os.O_RDONLY):
    # O_NONBLOCK prevents a replaced FIFO from hanging before fstat can reject it.
    fd = os.open(name, flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=parent)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise RuntimeError(f'Not a regular file; preserved: {name}')
    return fd


def verify_fd(fd, size, expected):
    before = os.fstat(fd)
    if not stat.S_ISREG(before.st_mode) or before.st_size != size:
        raise RuntimeError('Invalid/incomplete file; preserved')
    os.lseek(fd, 0, os.SEEK_SET)
    digest = hashlib.sha256()
    remaining = size
    while remaining:
        chunk = os.read(fd, min(CHUNK, remaining))
        if not chunk:
            raise RuntimeError('File shortened during verification; preserved')
        digest.update(chunk)
        remaining -= len(chunk)
    if identity(before) != identity(os.fstat(fd)):
        raise RuntimeError('File changed during verification; preserved')
    if digest.hexdigest() != expected:
        raise RuntimeError('Checksum mismatch; file preserved, not accepted')
    return identity(before)


def verify(target, size, expected, expected_store=None):
    target = Path(target)
    parent = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        if expected_store and (os.fstat(parent).st_dev, os.fstat(parent).st_ino) != expected_store:
            raise RuntimeError('Model store changed since download admission; not accepted')
        with contextlib.closing(os.fdopen(regular(parent, target.name), 'rb')) as stream:
            checked = verify_fd(stream.fileno(), size, expected)
            if identity(os.stat(target.name, dir_fd=parent, follow_symlinks=False)) != checked:
                raise RuntimeError('File identity changed; preserved')
    finally:
        os.close(parent)


def private_directory(parent, name):
    try:
        os.mkdir(name, 0o700, dir_fd=parent)
    except FileExistsError:
        pass
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    info = os.fstat(fd)
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        os.close(fd)
        raise RuntimeError(f'Download preparation directory is not private: {name}')
    return fd


def transfer(fd, size, url, token):
    start = os.fstat(fd).st_size
    parsed = urlsplit(url)
    # Public CLI URLs are fixed HTTPS pins. HTTP is only allowed for loopback
    # behavioral fixtures; redirects may never downgrade HTTPS or reach file://.
    loopback = parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', '::1')
    if parsed.username or parsed.password or (parsed.scheme != 'https' and not loopback):
        raise ValueError('Download requires HTTPS')
    protocols = '=http' if loopback else '=https'
    config = 'header = ' + json.dumps('Authorization: Bearer ' + token) + '\n' if token else ''
    command = [
        'curl', '--disable', '--fail', '--location', '--silent', '--show-error',
        '--proto', protocols, '--proto-redir', protocols, '--connect-timeout', '30',
        '--max-time', str(MAX_SECONDS), '--speed-limit', '1024', '--speed-time', '120',
        '--max-filesize', str(size - start), '--continue-at', str(start),
        '--output', '-', '--config', '-', url,
    ]
    os.lseek(fd, start, os.SEEK_SET)
    child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    try:
        child.stdin.write(config.encode('ascii'))
        child.stdin.close()
        written = start
        while True:
            chunk = child.stdout.read(CHUNK)
            if not chunk:
                break
            if len(chunk) > size - written:
                raise RuntimeError('Download exceeds pinned size; partial preserved')
            view = memoryview(chunk)
            while view:
                count = os.write(fd, view)
                if count <= 0:
                    raise RuntimeError('Partial write failed; partial preserved')
                view = view[count:]
                written += count
        code = child.wait(timeout=5)
        if code:
            raise RuntimeError(f'Download failed ({code}); partial preserved for resume')
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=2)
        child.stdout.close()
        child.stdin.close()


def download(directory, token='', *, name, size, expected, url, progress=None, expected_store=None):
    """One non-waiting leader per filename; no global lock or inference lease.

    Only the two pinned components are exposed by the CLI. Each preparation has
    one persistent empty lock file and one resumable partial bounded by the exact
    component size. The OS lock, not file presence/PID text, denotes ownership.
    Failures retain the partial; verified publication uses an atomic hard link
    on the same volume. No existing target is overwritten or deleted.
    """
    import fcntl  # q36's managed targets are POSIX Metal/Vulkan, not Windows.
    if (not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,180}', name) or
            not isinstance(size, int) or not 0 < size <= 1024**4 or
            not re.fullmatch(r'[a-f0-9]{64}', expected)):
        raise ValueError('Invalid pinned component identity')
    if len(token) > 4096 or any(ord(c) < 32 or ord(c) > 126 for c in token):
        raise ValueError('Invalid Hugging Face token')
    destination = Path(directory).resolve()
    if not expected_store:
        destination.mkdir(parents=True, exist_ok=True)
    with contextlib.ExitStack() as handles:
        root = os.open(destination, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        handles.callback(os.close, root)
        if expected_store and (os.fstat(root).st_dev, os.fstat(root).st_ino) != expected_store:
            raise RuntimeError('Model store changed since download admission; not published')
        prepared = private_directory(root, '.dstudio-qwen27-downloads')
        handles.callback(os.close, prepared)
        stage = private_directory(prepared, name)
        handles.callback(os.close, stage)
        lock = regular(stage, 'lock', os.O_RDWR | os.O_CREAT)
        handles.callback(os.close, lock)
        if os.fstat(lock).st_nlink != 1:
            raise RuntimeError('Linked preparation lock; preserved')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError(f'Download already active for {name}') from error

        def revalidate_store():
            current = os.stat(destination, follow_symlinks=False)
            owned = os.fstat(root)
            if (current.st_dev, current.st_ino) != (owned.st_dev, owned.st_ino):
                raise RuntimeError('Model store changed during preparation; not published')

        try:
            existing = regular(root, name)
        except FileNotFoundError:
            existing = None
        if existing is not None:
            handles.callback(os.close, existing)
            if progress:
                progress('V')
            checked = verify_fd(existing, size, expected)
            revalidate_store()
            if identity(os.stat(name, dir_fd=root, follow_symlinks=False)) != checked:
                raise RuntimeError('Model identity changed; not accepted')
            return destination / name

        partial = regular(stage, 'data.part', os.O_RDWR | os.O_CREAT)
        handles.callback(os.close, partial)
        info = os.fstat(partial)
        if info.st_nlink != 1 or info.st_size > size:
            raise RuntimeError('Invalid/linked partial; preserved')
        if info.st_size < size:
            if progress:
                progress('D')
            print(f'Downloading {name}: {size / 1e9:.2f} GB; resumable', flush=True)
            transfer(partial, size, url, token)
        os.fsync(partial)
        if progress:
            progress('V')
        print(f'Verifying SHA-256: {name}', flush=True)
        checked = verify_fd(partial, size, expected)
        revalidate_store()
        if identity(os.stat('data.part', dir_fd=stage, follow_symlinks=False)) != checked:
            raise RuntimeError('Partial identity changed; not published')
        # Preparation is private and locked; the bounded publication never
        # replaces a concurrent user file. Verification is outside publication.
        os.link('data.part', name, src_dir_fd=stage, dst_dir_fd=root, follow_symlinks=False)
        os.fsync(root)
        os.unlink('data.part', dir_fd=stage)
        os.fsync(stage)
        return destination / name


def manifest():
    return {'repository': REPO, 'revision': REVISION, 'license': 'Apache-2.0',
            'status': 'candidate; engine and model quality require separate qualification',
            'files': FILES}


def stop_download(_signal, _frame):
    raise KeyboardInterrupt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path)
    parser.add_argument('--component', choices=('model', 'vision', 'all'), default='all')
    parser.add_argument('--manifest', action='store_true', help='Print pins without disk or network access')
    parser.add_argument('--verify-only', action='store_true', help='Verify existing files; never download')
    parser.add_argument('--progress-fd', type=int, help='Owned host pipe: D=transfer, V=SHA-256 verification')
    parser.add_argument('--directory-identity', help='Admitted model store device:inode; reject a replaced directory')
    args = parser.parse_args()
    if args.manifest:
        print(json.dumps(manifest()))
        return
    if not args.directory:
        parser.error('--directory is required for download/verification')
    if os.name != 'posix':
        parser.error('The q36 download path currently requires a POSIX host')
    expected_store = None
    if args.directory_identity:
        if not re.fullmatch(r'[0-9]{1,20}:[0-9]{1,20}', args.directory_identity):
            parser.error('Invalid model store identity')
        expected_store = tuple(int(value) for value in args.directory_identity.split(':'))

    signal.signal(signal.SIGTERM, stop_download)
    # At most four one-byte notifications for the two pinned components. Curl
    # must not inherit the channel. Losing the UI does not invalidate a verified
    # transfer; readiness still comes from our exit status, never these hints.
    if args.progress_fd is not None:
        os.set_inheritable(args.progress_fd, False)

    def progress(phase):
        if args.progress_fd is not None:
            try:
                os.write(args.progress_fd, phase.encode('ascii'))
            except OSError:
                pass

    completed = []
    for component in FILES if args.component == 'all' else (args.component,):
        item = FILES[component]
        url = f"https://huggingface.co/{REPO}/resolve/{REVISION}/{item.get('remote', item['file'])}"
        if args.verify_only:
            progress('V')
            verify(args.directory / item['file'], item['bytes'], item['sha256'], expected_store)
        else:
            download(args.directory, os.environ.get('HF_TOKEN', ''), name=item['file'],
                     size=item['bytes'], expected=item['sha256'], url=url, progress=progress,
                     expected_store=expected_store)
        completed.append(item)
    print(json.dumps({**manifest(), 'verifiedFiles': completed}), flush=True)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('Download stopped; partial files preserved for resume.', file=sys.stderr)
        sys.exit(130)
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
