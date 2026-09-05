#!/usr/bin/env python3
"""Download the pinned native Qwen base + required PLE, not a second MTP base."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

REPO = 'ivanfioravanti/Qwen3.8-Flash-Next-DS4-Q4'
REVISION = '3e95a639e7f8ee791e43272b39d322a185b193c7'
FILES = (
    ('Qwen3.8-Flash-Next-Q4KImatrixExperts-MXFP4Down-BF16Emb-BF16Control-Q8GDN-Q8QSA-Q8Shared-Q8Out.gguf',
     73371680704, 'a5834d7ba6f1165d0356cd73bd2fb9ee7f0b2d48df435d18ffbeb9b6f35b8aef'),
    ('Qwen3.8-Flash-Next-PLE-Q4_1.gguf', 32000157440,
     '66db3ab390f4dd5063ecc89cc180f4713898577682347001bf64ab8e328527a1'),
)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--token', help='Optional Hugging Face token; prefer HF_TOKEN')
    args = parser.parse_args()
    hf = shutil.which('hf')
    if not hf:
        parser.error('Hugging Face CLI (hf) is required; install huggingface_hub and hf_xet')
    destination = args.directory.resolve()
    destination.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    if args.token:
        env['HF_TOKEN'] = args.token
    verified = []
    for name, size, expected in FILES:
        target = destination / name
        if not target.exists():
            print(f'Downloading {name}: {size / 1e9:.1f} GB, revision {REVISION}', flush=True)
            subprocess.run([hf, 'download', REPO, name, '--revision', REVISION,
                            '--repo-type', 'model', '--local-dir', str(destination)], env=env, check=True)
        if target.is_symlink() or not target.is_file() or target.stat().st_size != size:
            raise RuntimeError(f'Invalid/incomplete model file; preserved for inspection: {target}')
        print(f'Verifying SHA-256: {name}', flush=True)
        digest = hashlib.sha256()
        with target.open('rb') as stream:
            for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b''):
                digest.update(chunk)
        if digest.hexdigest() != expected:
            raise RuntimeError(f'Checksum mismatch; file preserved, not accepted: {target}')
        verified.append({'file': name, 'bytes': size, 'sha256': expected})
    receipt = {'repository': REPO, 'revision': REVISION, 'verifiedFiles': verified}
    print(json.dumps(receipt, indent=2), flush=True)
    print('Qwen base and PLE downloaded and verified. MTP is not required for plain inference.')

if __name__ == '__main__':
    main()
