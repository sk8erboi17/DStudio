#!/usr/bin/env python3
"""Download the pinned Qwen3.6 Q6_K_XL; publish only after size and SHA-256 checks."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

REPO = 'unsloth/Qwen3.6-35B-A3B-GGUF'
REVISION = 'a483e9e6cbd595906af30beda3187c2663a1118c'
FILE = 'Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf'
SIZE = 31843777504
SHA256 = 'f6b6c6d5cfa6f00d964eeb7add28eb14ce7481734d506b90681007678cd2c484'
URL = f'https://huggingface.co/{REPO}/resolve/{REVISION}/{FILE}'


def verify(target, size, expected):
    if target.is_symlink() or not target.is_file() or target.stat().st_size != size:
        raise RuntimeError(f'Invalid/incomplete model file; preserved: {target}')
    digest = hashlib.sha256()
    with target.open('rb') as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            digest.update(chunk)
    if digest.hexdigest() != expected:
        raise RuntimeError(f'Checksum mismatch; file preserved, not accepted: {target}')


def download(directory, token='', *, name=FILE, size=SIZE, expected=SHA256, url=URL):
    destination = Path(directory).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    target = destination / name
    partial = destination / (name + '.part')
    if target.exists() or target.is_symlink():
        verify(target, size, expected)
        return target
    if partial.is_symlink() or (partial.exists() and
                               (not partial.is_file() or partial.stat().st_size > size)):
        raise RuntimeError(f'Invalid partial file; preserved: {partial}')
    if not partial.exists() or partial.stat().st_size < size:
        # Credentials travel through stdin, never subprocess argv or error logs.
        if any(ord(c) < 32 or ord(c) > 126 for c in token):
            raise ValueError('Invalid Hugging Face token')
        config = 'header = ' + json.dumps('Authorization: Bearer ' + token) + '\n' if token else ''
        print(f'Downloading {name}: {size / 1e9:.1f} GB (resumable)', flush=True)
        result = subprocess.run([
            'curl', '--fail', '--location', '--retry', '3', '--connect-timeout', '30',
            '--speed-limit', '1024', '--speed-time', '120', '--continue-at', '-',
            '--output', str(partial), '--config', '-', url,
        ], input=config, text=True)
        if result.returncode:
            raise RuntimeError(f'Download failed ({result.returncode}); partial preserved for resume')
    print(f'Verifying SHA-256: {name}', flush=True)
    verify(partial, size, expected)
    # Atomic no-clobber publication: a concurrent user file is never replaced.
    os.link(partial, target)
    partial.unlink()
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--token', help='Optional Hugging Face token; prefer HF_TOKEN')
    args = parser.parse_args()
    download(args.directory, args.token or os.environ.get('HF_TOKEN', ''))
    print(json.dumps({'repository': REPO, 'revision': REVISION,
                      'verifiedFiles': [{'file': FILE, 'bytes': SIZE, 'sha256': SHA256}]}), flush=True)
    print('Qwen3.6 verified. No PLE, MTP or vision encoder is required for text Chat.')


if __name__ == '__main__':
    main()
