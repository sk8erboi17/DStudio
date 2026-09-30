#!/usr/bin/env python3
"""Import an exact local Git archive or upstream archive; never fetch sources.

Engine code stays byte-identical to upstream. DStudio adaptations belong in
patch/. Only datasets, benchmark outputs and compiled files are omitted.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import tarfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def omitted(name, data):
    parts = PurePosixPath(name).parts
    if (data.startswith((b'\x7fELF', b'\xcf\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'MZ')) or
            name.endswith(('.o', '.f32', '.gguf', '.metallib', '.air', '.pyc'))):
        return 'compiled output or model data'
    if (PurePosixPath(name).suffix in ('.c', '.h', '.cpp', '.cuh', '.cu', '.m', '.metal',
                                      '.py', '.sh', '.js', '.comp') or data.startswith(b'#!') or
            PurePosixPath(name).name.upper().startswith(('LICENSE', 'COPYING', 'NOTICE', 'README'))):
        return None
    if name.startswith(('gguf-tools/imatrix/dataset/', 'gguf-tools/quality-testing/data/',
                        'dir-steering/out/')):
        return 'upstream dataset or generated benchmark output'
    if (name.startswith('gguf-tools/quality-testing/') and len(parts) > 3 and
            parts[2] != 'tests'):
        return 'upstream generated quality receipts'
    if name.startswith('speed-bench/') and name.endswith('.txt'):
        return 'upstream benchmark text dataset'
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', required=True)
    parser.add_argument('--directory', required=True)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--output-root', type=Path,
                        default=Path(__file__).resolve().parent.parent / 'src/engines')
    parser.add_argument('--strip-prefix', action='store_true')
    parser.add_argument('--historical', action='store_true')
    parser.add_argument('--legacy-inventory', action='store_true')
    args = parser.parse_args()
    root = args.output_root
    manifest_file = root / 'manifest.json'
    manifest = json.loads(manifest_file.read_text()) if manifest_file.exists() else {
        'schema': 'dstudio.engine-sources.v1', 'engines': {}, 'legacyQ36': {}}
    entry = {'repository': args.repository, 'commit': args.revision,
             'directory': args.directory, 'historical': args.historical,
             'files': {}, 'omitted': {}}
    if args.strip_prefix:
        entry['archiveSHA256'] = digest(args.archive.read_bytes())
    if (len(args.revision) != 40 or any(c not in '0123456789abcdef' for c in args.revision) or
            Path(args.directory).name != args.directory or args.directory in ('.', '..')):
        raise RuntimeError('Invalid source revision or snapshot directory')
    target = root / args.directory
    if not args.legacy_inventory:
        target.mkdir(parents=True, exist_ok=False)
    total, names = 0, set()
    with tarfile.open(args.archive) as package:
        if package.pax_headers.get('comment') != args.revision:
            raise RuntimeError('Archive Git identity does not match the pinned upstream revision')
        for item in package:
            parts = PurePosixPath(item.name).parts
            if args.strip_prefix:
                expected = args.repository.rstrip('/').split('/')[-1] + '-' + args.revision
                if not parts or parts[0] != expected:
                    raise RuntimeError('Archive prefix does not match the pinned upstream revision')
                parts = parts[1:]
            if not parts or item.isdir():
                continue
            name = '/'.join(parts)
            if not item.isfile() or '..' in parts or PurePosixPath(name).is_absolute():
                raise RuntimeError('Unexpected linked or unsafe upstream archive entry')
            if name in names:
                raise RuntimeError('Duplicate upstream archive file')
            names.add(name)
            total += item.size
            if total > 256 * 1024 * 1024 or len(entry['files']) + len(entry['omitted']) >= 8192:
                raise RuntimeError('Upstream snapshot exceeds its byte/file bounds')
            data = package.extractfile(item).read()
            metadata = {'sha256': digest(data), 'bytes': len(data),
                        'executable': bool(item.mode & 0o111)}
            reason = None if args.legacy_inventory else omitted(name, data)
            if reason:
                entry['omitted'][name] = {**metadata, 'reason': reason}
            else:
                entry['files'][name] = metadata
                if not args.legacy_inventory:
                    file = target / name
                    file.parent.mkdir(parents=True, exist_ok=True)
                    file.write_bytes(data)
                    file.chmod(0o755 if metadata['executable'] else 0o644)
    key = 'legacyQ36' if args.legacy_inventory else 'engines'
    manifest[key][args.revision if args.legacy_inventory else args.engine] = entry
    root.mkdir(parents=True, exist_ok=True)
    manifest_file.write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
    print(json.dumps({'engine': args.engine, 'commit': args.revision,
                      'files': len(entry['files']), 'omitted': len(entry['omitted']),
                      'bytes': sum(x['bytes'] for x in entry['files'].values())}))


if __name__ == '__main__':
    main()
