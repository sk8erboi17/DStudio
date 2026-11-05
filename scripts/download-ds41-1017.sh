#!/bin/sh
# DStudio-owned downloader for the DeepSeek V4.1 Flash 1017 checkpoint:
#   ds41f-q2           antirez's official 1017 Q2, the file the vendored
#                      download_model.sh (890898c) names for ds41f-q2, with the
#                      same published 1017 SHA-256; here it is also pinned to a
#                      repository revision.
#   ds41f-1017-vision  the community 1017 vision sidecar (antirez publishes none);
#                      source revision 1bae0e10, the same as the 1017 Q2.
#   ds41f-q2-original  the original V4.1 Q2 (source revision df42c109), still
#                      published in the same repository; it pairs with the
#                      original sidecar (ds41f-vision) and resumes a download
#                      started before ds41f-q2 became the 1017 file.
# Each repository is pinned to a revision and every file is checked for exact
# size + SHA-256. Run from the ds4 checkout (cwd) or set DS4_GGUF_DIR.
# Usage: download-ds41-1017.sh ds41f-q2|ds41f-q2-original|ds41f-1017-vision [--token TOKEN]
#        download-ds41-1017.sh TARGET --print-pin   (repo revision file bytes sha256; no download)
set -eu

usage() {
    echo "Usage: $0 ds41f-q2|ds41f-q2-original|ds41f-1017-vision [--token TOKEN | --print-pin]" >&2
}

[ $# -ge 1 ] || { usage; exit 1; }
TARGET=$1
shift
case "$TARGET" in
    ds41f-q2)
        REPO="antirez/deepseek-v4.1-flash-gguf"
        REVISION="9dcee51692e6540f697141fc98b097e3c96492a3"
        FILE="DeepSeek-V4.1-Flash-1017-IQ2_XXS-Q2_K-imatrix.gguf"
        EXPECTED_BYTES=365713686528
        EXPECTED_SHA="5296e85ff64b42ecb62c8d0c0c54e1caa07e3df8e93112f2365ebbaed62ce93a" ;;
    ds41f-q2-original)
        REPO="antirez/deepseek-v4.1-flash-gguf"
        REVISION="9dcee51692e6540f697141fc98b097e3c96492a3"
        FILE="DeepSeek-V4.1-Flash-Q2.gguf"
        EXPECTED_BYTES=365713686528
        EXPECTED_SHA="1ce6a8f8806205c13330d7ca287bd198331dc5ca35ccc5d8a9a92a188a6f6f42" ;;
    ds41f-1017-vision)
        REPO="nazeshinjite/DeepSeek-V4.1-Flash-1017-ds4-GGUF"
        REVISION="796f58533a0e4b7a89cb006b22aeb44e783f0323"
        FILE="DeepSeek-V4.1-Flash-1017-Vision.gguf"
        EXPECTED_BYTES=970555552
        EXPECTED_SHA="861f1097e8686111fa23dc4a6bf139fd0c4cc114db2f1b4090a267f7683c0dbf" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown target: $TARGET" >&2; usage; exit 1 ;;
esac

if [ "${1:-}" = --print-pin ]; then
    printf '%s %s %s %s %s\n' "$REPO" "$REVISION" "$FILE" "$EXPECTED_BYTES" "$EXPECTED_SHA"
    exit 0
fi

# Test-only oracle override. Production values above are never read from the
# environment unless the explicit test switch is set.
if [ "${DSTUDIO_DS41_1017_TEST_MODE:-0}" = 1 ]; then
    EXPECTED_BYTES=${DSTUDIO_DS41_1017_TEST_BYTES:?}
    EXPECTED_SHA=${DSTUDIO_DS41_1017_TEST_SHA:?}
fi

TOKEN=${HF_TOKEN:-}
while [ $# -gt 0 ]; do
    case "$1" in
        --token)
            shift
            [ $# -gt 0 ] || { echo "Missing value after --token" >&2; exit 1; }
            TOKEN=$1 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
    shift
done
if [ -z "$TOKEN" ] && [ -s "$HOME/.cache/huggingface/token" ]; then
    TOKEN=$(cat "$HOME/.cache/huggingface/token")
fi

ROOT=$(pwd)
OUT_DIR=${DS4_GGUF_DIR:-"$ROOT/gguf"}
case "$OUT_DIR" in
    /*) ;;
    *) OUT_DIR="$ROOT/$OUT_DIR" ;;
esac
OUT="$OUT_DIR/$FILE"

# Keep the transport here so installed bundles and the root CLI use the same
# implementation. HF Hub 1.19 uses a fresh random temporary on every attempt;
# disabling Xet alone therefore does not restore resume. Reuse the exact pinned
# cache partial in place, under HF's per-file lock, and use curl's range resume.
# Tokens reach curl through stdin, never argv. Existing weights are not moved.
HF_TOKEN=$TOKEN
export HF_TOKEN
exec python3 - "$OUT" "$EXPECTED_BYTES" "$EXPECTED_SHA" "$REPO" "$REVISION" <<'PY'
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import time
from urllib.parse import quote, urlsplit

out = Path(sys.argv[1])
size, sha, repo, revision = int(sys.argv[2]), *sys.argv[3:]
CHUNK = 1024 * 1024

def identity(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns

def regular(parent, name, flags=os.O_RDONLY, allow_links=False):
    fd = os.open(name, flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=parent)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or (not allow_links and info.st_nlink != 1):
        os.close(fd)
        raise RuntimeError(f'Not a regular file with one link; preserved: {name}')
    return fd

def verify(fd):
    before = os.fstat(fd)
    if before.st_size != size:
        raise RuntimeError(f'Incorrect file size: {out}; file preserved.')
    print(f'Verifying SHA-256: {out.name}', flush=True)
    os.lseek(fd, 0, os.SEEK_SET)
    digest = hashlib.sha256()
    remaining = size
    while remaining:
        chunk = os.read(fd, min(CHUNK, remaining))
        if not chunk:
            raise RuntimeError('File shortened during verification; preserved.')
        digest.update(chunk)
        remaining -= len(chunk)
    if identity(before) != identity(os.fstat(fd)):
        raise RuntimeError('File changed during verification; preserved.')
    if digest.hexdigest() != sha:
        raise RuntimeError('Checksum mismatch; file preserved, not accepted.')
    return identity(before)

def transfer(fd, url, token):
    start = os.fstat(fd).st_size
    config = 'header = ' + json.dumps('Authorization: Bearer ' + token) + '\n' if token else ''
    protocol = '=http' if url.startswith('http://127.0.0.1:') else '=https'
    command = ['curl', '--disable', '--fail', '--location', '--silent', '--show-error',
               '--proto', protocol, '--proto-redir', protocol, '--connect-timeout', '30',
               '--speed-limit', '1024', '--speed-time', '60', '--continue-at', str(start),
               '--max-filesize', str(size - start), '--output', '-', '--config', '-', url]
    os.lseek(fd, start, os.SEEK_SET)
    child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    try:
        child.stdin.write(config.encode('ascii'))
        child.stdin.close()
        written = start
        while chunk := child.stdout.read1(CHUNK):
            if len(chunk) > size - written:
                raise RuntimeError('Download exceeds pinned size; partial preserved.')
            data = memoryview(chunk)
            while data:
                count = os.write(fd, data)
                if count <= 0:
                    raise RuntimeError('Partial write failed; preserved.')
                data = data[count:]
                written += count
        return child.wait(timeout=5)
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

def stop(_signal, _frame):
    raise KeyboardInterrupt

def main():
    token = os.environ.get('HF_TOKEN', '')
    if len(token) > 4096 or any(ord(c) < 32 or ord(c) > 126 for c in token):
        raise ValueError('Invalid Hugging Face token')
    hub = 'https://huggingface.co'
    if os.environ.get('DSTUDIO_DS41_1017_TEST_MODE') == '1':
        hub = os.environ.get('DSTUDIO_DS41_1017_TEST_URL', hub)
        parsed = urlsplit(hub)
        if hub != 'https://huggingface.co' and not (
                parsed.scheme == 'http' and parsed.hostname == '127.0.0.1' and
                not parsed.username and not parsed.password and parsed.path == ''):
            raise ValueError('Test URL must be a loopback HTTP fixture')
    url = f'{hub}/{repo}/resolve/{revision}/{quote(out.name)}'
    out.parent.mkdir(parents=True, exist_ok=True)
    destination = out.parent.resolve()
    with contextlib.ExitStack() as handles:
        root = os.open(destination, os.O_RDONLY | os.O_DIRECTORY)
        handles.callback(os.close, root)
        cache = root
        for name in ('.cache', 'huggingface', 'download'):
            try:
                os.mkdir(name, 0o700, dir_fd=cache)
            except FileExistsError:
                pass
            cache = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=cache)
            handles.callback(os.close, cache)
        lock = regular(cache, out.name + '.lock', os.O_RDWR | os.O_CREAT)
        handles.callback(os.close, lock)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Download already active for this file')
        try:
            existing = regular(root, out.name, allow_links=True)
        except FileNotFoundError:
            existing = None
        if existing is not None:
            handles.callback(os.close, existing)
            checked = verify(existing)
            if identity(os.stat(out.name, dir_fd=root, follow_symlinks=False)) != checked:
                raise RuntimeError('Existing file changed; not accepted.')
            print(f'Already downloaded and verified: {out}', flush=True)
            return
        # Same digest matching and bounded enumeration as host progress. A retry
        # continues the largest existing copy, never creates a hidden second one.
        partial_name, largest = f'dstudio.{sha}.http.incomplete', -1
        with os.scandir(cache) as entries:
            for i, entry in enumerate(entries):
                if i >= 512:
                    raise RuntimeError('Too many download cache entries; preserved.')
                if f'.{sha}.' not in entry.name or not entry.name.endswith('.incomplete'):
                    continue
                info = entry.stat(follow_symlinks=False)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise RuntimeError('Linked download partial; preserved.')
                if info.st_size > size:
                    raise RuntimeError('Oversized download partial; preserved.')
                if info.st_size > largest:
                    partial_name, largest = entry.name, info.st_size
        partial = regular(cache, partial_name, os.O_RDWR | os.O_CREAT)
        handles.callback(os.close, partial)
        print(f'Downloading {out.name}: resuming at {os.fstat(partial).st_size} / {size} bytes over HTTP', flush=True)
        # Bound retries of failed/stalled connections, not the total duration of
        # a healthy multi-hour transfer. Each attempt obtains fresh redirect URLs.
        for attempt in range(5):
            if os.fstat(partial).st_size == size:
                break
            code = transfer(partial, url, token)
            os.fsync(partial)
            if code == 0 and os.fstat(partial).st_size == size:
                break
            if code in (18, 28, 52, 55, 56, 92) and attempt < 4:
                print(f'Connection interrupted ({code}); retrying from {os.fstat(partial).st_size} bytes', flush=True)
                time.sleep(min(2 ** attempt, 8))
                continue
            raise RuntimeError(f'Download failed ({code}); partial preserved for resume.')
        checked = verify(partial)
        if identity(os.stat(partial_name, dir_fd=cache, follow_symlinks=False)) != checked:
            raise RuntimeError('Partial changed; not published.')
        current, owned = os.stat(destination), os.fstat(root)
        if (current.st_dev, current.st_ino) != (owned.st_dev, owned.st_ino):
            raise RuntimeError('Model store changed; not published.')
        # Publication never overwrites existing weights. No large copy or rename
        # of the user's partial is needed, and only verified bytes become a model.
        os.link(partial_name, out.name, src_dir_fd=cache, dst_dir_fd=root, follow_symlinks=False)
        os.fsync(root)
        os.unlink(partial_name, dir_fd=cache)
        os.fsync(cache)
        print(f'Verified: {out}', flush=True)

signal.signal(signal.SIGTERM, stop)
try:
    main()
except KeyboardInterrupt:
    print('Download stopped; partial preserved for resume.', file=sys.stderr)
    sys.exit(130)
except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
PY
