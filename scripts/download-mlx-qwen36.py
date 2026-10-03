#!/usr/bin/env python3
"""Pinned Qwen3.6-35B-A3B MLX weights (mlx-community/Qwen3.6-35B-A3B-mxfp8).

Every file of the pinned revision is downloaded into the model folder
(by default <ds4>/mlx/Qwen3.6-35B-A3B-mxfp8), resumable, verified by SHA-256
and published only when complete, with the same per-file machinery as the
Qwen3.8-27B download (scripts/download-qwen27.py). Existing verified files are
reused; nothing is overwritten or deleted. Loads no model.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import sys

REPO = 'mlx-community/Qwen3.6-35B-A3B-mxfp8'
REVISION = '5c216c8705fed28a7a16fc92555befd507628709'
FOLDER = 'Qwen3.6-35B-A3B-mxfp8'
# Large files: the hub's LFS SHA-256. Small files: SHA-256 of the bytes whose
# git blob id matches the pinned revision's tree.
FILES = {
    'README.md': {'bytes': 726, 'sha256': '7e35747cf4b538f50e67a9b7e43b87739c0ba4134f345023310281dbc7e2475c'},
    'chat_template.jinja': {'bytes': 7764, 'sha256': 'e84f32a23fdda27689f868aa4a1a5621f41133e51a48d7f3efcbea2839574259'},
    'config.json': {'bytes': 23589, 'sha256': 'a432ffaf6c9174176987ff20b98455e94c62c62017ecb0ff96664c9476885568'},
    'configuration.json': {'bytes': 58, 'sha256': 'c1b09db419119513247e9b8b912c4b9897106c9b20c6cada7e107d993c5435eb'},
    'generation_config.json': {'bytes': 202, 'sha256': 'e70c136c1b78ddc1fb0905bac8e733a4dc448d4f852a5dd75143fffc70be550e'},
    'model-00001-of-00008.safetensors': {'bytes': 5199508862, 'sha256': '343d150138528b69ef4214f5bdf681ab9d84c62788f929d9ab793f995d0e51f4'},
    'model-00002-of-00008.safetensors': {'bytes': 5207864796, 'sha256': '5abec19da6b84ddee30cd462d4b96ee395683dbe813ba1984c99fc147edf5021'},
    'model-00003-of-00008.safetensors': {'bytes': 5201176324, 'sha256': '9a085eba2606115ac80609a99dce9501cf0cd3bedda15b3583da2ef387f854e6'},
    'model-00004-of-00008.safetensors': {'bytes': 5207865017, 'sha256': '3f3176204472a61355824165d93a52940dd7712a8952e71d8cd38f5c83ee8c33'},
    'model-00005-of-00008.safetensors': {'bytes': 5201176322, 'sha256': 'f387c68b050c61d13eb1efc409798d2b39b47b978fc18f9db96728239b551887'},
    'model-00006-of-00008.safetensors': {'bytes': 5207864945, 'sha256': 'b3a6c76468b10d4a6f83277e1e71de0a138fd372e3e395da27e25a55cbdc3eb6'},
    'model-00007-of-00008.safetensors': {'bytes': 4888984418, 'sha256': '22cfa0a09377163afa0a00fdaf0af2fba31b90eb357b828c9da1226f9ad60199'},
    'model-00008-of-00008.safetensors': {'bytes': 524452081, 'sha256': 'a497d556b62b5120be87288b52d86d2de76ab2e416ff215ce5c76ab33977d1f3'},
    'model.safetensors.index.json': {'bytes': 168938, 'sha256': '7917fa575f1057a586a9826be493c540ee0a0b150d25fd6a1973d78ebbdee7fe'},
    'preprocessor_config.json': {'bytes': 390, 'sha256': '27225450ac9c6529872ee1924fcb0962ff5634834f817040f444118116f4e516'},
    'processor_config.json': {'bytes': 991, 'sha256': '45fc17c8dd2474af6b493b52483c26c0584b0082d368c480f9fa611e73070040'},
    'tokenizer.json': {'bytes': 19989325, 'sha256': '06b9509352d2af50381ab2247e083b80d32d5c0aba91c272ca9ff729b6a0e523'},
    'tokenizer_config.json': {'bytes': 1165, 'sha256': '792fa3f0cb88b111e54ef3134c873531008c4df471d108da17903426e308aa7b'},
    'video_preprocessor_config.json': {'bytes': 385, 'sha256': '7768af27c1fafa9cc9011c1dc20067e03f8915e03b63504550e11d5066986d13'},
    'vocab.json': {'bytes': 6722759, 'sha256': 'ce99b4cb2983d118806ce0a8b777a35b093e2000a503ebde25853284c9dfa003'},
}

_spec = importlib.util.spec_from_file_location('download_qwen27', Path(__file__).resolve().parent / 'download-qwen27.py')
_pinned = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_pinned)


def manifest():
    return {'repository': REPO, 'revision': REVISION, 'folder': FOLDER, 'license': 'Apache-2.0',
            'bytes': sum(f['bytes'] for f in FILES.values()), 'files': FILES}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, help='the model folder to fill')
    parser.add_argument('--manifest', action='store_true', help='print the pins; no disk or network access')
    parser.add_argument('--verify-only', action='store_true', help='verify existing files; never download')
    parser.add_argument('--progress-fd', type=int, help='owned host pipe: D=transfer, V=verification')
    parser.add_argument('--directory-identity', help='admitted folder device:inode; reject a replaced folder')
    args = parser.parse_args()
    if args.manifest:
        print(json.dumps(manifest()))
        return 0
    if not args.directory:
        parser.error('--directory is required')
    expected_store = None
    if args.directory_identity:
        if not re.fullmatch(r'[0-9]{1,20}:[0-9]{1,20}', args.directory_identity):
            parser.error('invalid folder identity')
        expected_store = tuple(int(value) for value in args.directory_identity.split(':'))
    signal.signal(signal.SIGTERM, _pinned.stop_download)
    if args.progress_fd is not None:
        os.set_inheritable(args.progress_fd, False)

    def progress(phase):
        if args.progress_fd is not None:
            try:
                os.write(args.progress_fd, phase.encode('ascii'))
            except OSError:
                pass

    if expected_store is None:
        args.directory.mkdir(parents=True, exist_ok=True)
    for name, item in FILES.items():
        url = f'https://huggingface.co/{REPO}/resolve/{REVISION}/{name}'
        if args.verify_only:
            progress('V')
            _pinned.verify(args.directory / name, item['bytes'], item['sha256'], expected_store)
        else:
            _pinned.download(args.directory, os.environ.get('HF_TOKEN', ''), name=name, size=item['bytes'],
                             expected=item['sha256'], url=url, progress=progress, expected_store=expected_store)
    print(json.dumps({**manifest(), 'files': len(FILES), 'verified': True}), flush=True)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('Download stopped; partial files preserved for resume.', file=sys.stderr)
        sys.exit(130)
    except (OSError, RuntimeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
