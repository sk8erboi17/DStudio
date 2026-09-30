#!/usr/bin/env python3
"""Verify and copy DStudio's pinned engine sources without network access.

This module owns no cache or runtime state. Copies are private candidates,
bounded to 8192 files / 256 MiB, and retain upstream bytes and executable modes.
The caller owns build, cancellation and final runtime publication. The CLI
publishes source-only installations exclusively; it never replaces local data.
"""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import tempfile
from contextlib import contextmanager

FILE_LIMIT = 8192
BYTE_LIMIT = 256 * 1024 * 1024
MANIFEST_LIMIT = 4 * 1024 * 1024


def read_regular(path, limit, sink=None, root=None):
    # On POSIX, each parent is opened relative to an already confined directory
    # descriptor. A link substituted after pathname validation cannot escape.
    parent = None
    try:
        if root is not None and os.name != 'nt':
            parts = path.relative_to(root).parts
            parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            for name in parts[:-1]:
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                os.close(parent)
                parent = child
            snapshot = lambda: os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
            before = snapshot()
            opener = lambda: os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        else:
            snapshot = path.lstat
            before = snapshot()
            opener = lambda: os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) |
                                     getattr(os, 'O_NONBLOCK', 0))
        if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
            raise RuntimeError('Bundled source is linked, nonregular or oversized')
        digest, chunks, size = hashlib.sha256(), [], 0
        with os.fdopen(opener(), 'rb') as stream:
            opened = os.fstat(stream.fileno())
            if (not stat.S_ISREG(opened.st_mode) or
                    (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino)):
                raise RuntimeError('Bundled source identity changed while opening')
            for data in iter(lambda: stream.read(1024 * 1024), b''):
                size += len(data)
                if size > limit:
                    raise RuntimeError('Bundled source exceeds its byte limit')
                digest.update(data)
                if sink is not None:
                    sink.write(data)
                elif limit == MANIFEST_LIMIT:
                    chunks.append(data)
            after = os.fstat(stream.fileno())
        stamp = lambda value: (value.st_dev, value.st_ino, value.st_size,
                               value.st_mtime_ns, value.st_ctime_ns)
        if stamp(before) != stamp(after) or stamp(after) != stamp(snapshot()):
            raise RuntimeError('Bundled source changed while reading')
        return digest.hexdigest(), size, b''.join(chunks)
    finally:
        if parent is not None:
            os.close(parent)


def load_catalog(assets):
    root = assets / 'src/engines'
    if (assets / 'src').is_symlink() or root.is_symlink():
        raise RuntimeError('Bundled engine source directory is linked')
    digest, _, data = read_regular(root / 'manifest.json', MANIFEST_LIMIT, root=assets)
    catalog = json.loads(data)
    if catalog.get('schema') != 'dstudio.engine-sources.v1':
        raise RuntimeError('Unsupported bundled engine source manifest')
    return catalog, digest, root


def checked_files(entry):
    files = entry.get('files')
    if not isinstance(files, dict) or not files or len(files) > FILE_LIMIT:
        raise RuntimeError('Bundled source inventory exceeds its file limit')
    total = 0
    for name, metadata in files.items():
        parts = PurePosixPath(name).parts
        if (not parts or len(parts) > 20 or len(name) > 1024 or '\\' in name or
                '..' in parts or PurePosixPath(name).is_absolute() or
                PurePosixPath(name).as_posix() != name or parts[0] in ('.git', 'gguf') or
                not isinstance(metadata, dict) or type(metadata.get('bytes')) is not int or
                not 0 <= metadata['bytes'] <= BYTE_LIMIT or type(metadata.get('executable')) is not bool or
                not isinstance(metadata.get('sha256'), str) or len(metadata['sha256']) != 64 or
                any(c not in '0123456789abcdef' for c in metadata['sha256'])):
            raise RuntimeError('Invalid bundled source inventory entry')
        total += metadata['bytes']
        if total > BYTE_LIMIT:
            raise RuntimeError('Bundled source inventory exceeds its byte limit')
    return files


def source_entry(assets, engine, revision):
    catalog, digest, root = load_catalog(assets)
    entry = catalog.get('engines', {}).get(engine)
    if not isinstance(entry, dict) or entry.get('commit') != revision:
        raise RuntimeError('Bundled source and native engine pins disagree')
    directory = entry.get('directory')
    if not isinstance(directory, str) or not directory or Path(directory).name != directory or directory in ('.', '..') or '\\' in directory:
        raise RuntimeError('Invalid bundled engine directory')
    files = checked_files(entry)
    tree = root / directory
    if tree.is_symlink() or not tree.is_dir():
        raise RuntimeError('Bundled engine sources are missing or linked; reinstall DStudio')
    names, pending, visited = set(), [tree], 0
    while pending:
        folder = pending.pop()
        with os.scandir(folder) as entries:
            for item in entries:
                visited += 1
                if visited > 2 * FILE_LIMIT:
                    raise RuntimeError('Bundled source directory exceeds its entry limit')
                name = str(Path(item.path).relative_to(tree))
                if item.is_dir(follow_symlinks=False):
                    pending.append(Path(item.path))
                elif item.is_file(follow_symlinks=False):
                    names.add(name)
                else:
                    raise RuntimeError('Bundled engine sources contain a linked or special file')
    if names != set(files):
        raise RuntimeError('Bundled engine sources are missing or contain unrecorded files')
    return entry, digest, tree


def transfer(assets, engine, revision, target=None):
    entry, manifest_hash, tree = source_entry(assets, engine, revision)
    if target is not None:
        target.mkdir(mode=0o700, exist_ok=False)
    for name, metadata in entry['files'].items():
        source = tree / name
        for parent in source.parents:
            if parent == tree.parent:
                break
            if parent.is_symlink():
                raise RuntimeError('Linked parent of a bundled source file')
        if target is not None:
            output = target / name
            output.parent.mkdir(parents=True, exist_ok=True)
            with output.open('xb') as sink:
                digest, size, _ = read_regular(source, metadata['bytes'], sink, root=assets)
                sink.flush()
                os.fsync(sink.fileno())
            output.chmod(0o755 if metadata['executable'] else 0o644)
        else:
            digest, size, _ = read_regular(source, metadata['bytes'], root=assets)
        if (digest, size) != (metadata['sha256'], metadata['bytes']):
            raise RuntimeError('Bundled engine source digest differs; no candidate published')
    if load_catalog(assets)[1] != manifest_hash:
        raise RuntimeError('Bundled engine source manifest changed during preparation')
    return {'manifestSHA256': manifest_hash, 'engine': engine, 'commit': revision,
            'repository': entry['repository'], 'source': 'bundled',
            'files': len(entry['files']), 'bytes': sum(m['bytes'] for m in entry['files'].values())}


def copy_sources(assets, engine, revision, target):
    return transfer(assets, engine, revision, target)


def verify_sources(assets, engine, revision, expected):
    if transfer(assets, engine, revision) != expected:
        raise RuntimeError('Bundled engine source identity changed; no candidate published')


def legacy_inventory(assets, revision, archive_hash):
    catalog, digest, _ = load_catalog(assets)
    entry = catalog.get('legacyQ36', {}).get(revision)
    if entry is None:
        current = catalog.get('engines', {}).get('q36', {})
        if current.get('commit') == revision:
            entry = {**current, 'files': {**current['files'], **current.get('omitted', {})}}
    if not isinstance(entry, dict) or entry.get('archiveSHA256') != archive_hash:
        raise RuntimeError('Legacy source archive identity differs; existing installation preserved')
    return {name: metadata['sha256'] for name, metadata in checked_files(entry).items()}, digest


def publish(source, target, parent_fd):
    # Linux/macOS rename with exclusive destination semantics also protects an
    # empty directory created by a racing owner. Windows rename is exclusive.
    if os.name == 'nt':
        os.rename(source, target)
        return
    library = ctypes.CDLL(None, use_errno=True)
    rename, flag = (library.renameatx_np, 4) if sys.platform == 'darwin' else (library.renameat2, 1)
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    stage_fd = os.open(source.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        result = rename(stage_fd, os.fsencode(source.name), parent_fd, os.fsencode(target.name), flag)
    finally:
        os.close(stage_fd)
    if result:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


@contextmanager
def source_lease(target):
    # One nonblocking preparation per target. A process exit releases the lease;
    # at most two failed private candidates are retained per engine for review.
    path = target.parent / ('.dstudio-' + target.name + '-sources.lock')
    fd = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0) |
                 getattr(os, 'O_NONBLOCK', 0), 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or path.is_symlink():
            raise RuntimeError('Source installation lease is linked or nonregular')
        if os.name == 'nt':
            import msvcrt
            if not info.st_size:
                os.write(fd, b'\0')
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield fd
    finally:
        os.close(fd)


def sync_directory(path):
    if os.name != 'nt':
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def install(assets, engine, revision, target):
    entry, _, _ = source_entry(assets, engine, revision)
    if entry.get('historical'):
        raise RuntimeError('Historical engine source is not an active installer target')
    with source_lease(target) as lease:
        return install_owned(assets, engine, revision, target, lease)


def install_owned(assets, engine, revision, target, lease):
    prefix = '.dstudio-' + target.name + '-source-'
    if sum(p.name.startswith(prefix) for p in target.parent.iterdir()) >= 2:
        raise RuntimeError('Two prior source preparations retained; inspect them before retrying')
    parent_identity = target.parent.stat()
    initial = target.lstat() if target.exists() or target.is_symlink() else None
    if initial is not None and (not stat.S_ISDIR(initial.st_mode) or any(target.iterdir())):
        raise RuntimeError('Target contains local data; refusing to replace it')
    stage = Path(tempfile.mkdtemp(prefix=prefix, dir=target.parent))
    candidate = stage / 'source'
    proof = copy_sources(assets, engine, revision, candidate)
    verify_sources(assets, engine, revision, proof)
    receipt = {**proof, 'bundledSources': proof, 'modelLoaded': False}
    with (candidate / '.dstudio-source.json').open('x') as output:
        output.write(json.dumps(receipt, sort_keys=True) + '\n')
        output.flush()
        os.fsync(output.fileno())
    for folder, _, _ in os.walk(candidate, topdown=False):
        sync_directory(Path(folder))
    sync_directory(stage)
    parent_now = target.parent.stat()
    if (parent_now.st_dev, parent_now.st_ino) != (parent_identity.st_dev, parent_identity.st_ino):
        raise RuntimeError('Installation parent changed during preparation')
    held = os.fstat(lease)
    named = (target.parent / ('.dstudio-' + target.name + '-sources.lock')).lstat()
    if held.st_nlink != 1 or (held.st_dev, held.st_ino) != (named.st_dev, named.st_ino):
        raise RuntimeError('Source installation lease changed; no candidate published')
    if initial is not None:
        current = target.lstat()
        stamp = lambda s: (s.st_dev, s.st_ino, s.st_mtime_ns, s.st_ctime_ns)
        if stamp(current) != stamp(initial) or any(target.iterdir()):
            raise RuntimeError('Target changed during source preparation; local data preserved')
        target.rmdir()  # An added file also makes this operation fail safely.
    parent_fd = None if os.name == 'nt' else os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        publish(candidate, target, parent_fd)
        try:
            sync_directory(target.parent)
            stage.rmdir()
            sync_directory(target.parent)
        except OSError as error:
            raise RuntimeError('Engine sources were published, but final durability acknowledgement '
                               'was interrupted; reopen to verify the retained installation') from error
    finally:
        if parent_fd is not None:
            os.close(parent_fd)
    print(json.dumps({'ok': True, 'engine': engine, 'bundled': True, 'downloaded': False,
                      'sourcesInstalled': True, 'modelLoaded': False}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--target', type=Path, required=True)
    args = parser.parse_args()
    try:
        install(Path(__file__).resolve().parent.parent, args.engine, args.revision, args.target)
    except (OSError, ValueError, RuntimeError) as error:
        print(f'Bundled engine installation failed: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
