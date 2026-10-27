#!/usr/bin/env python3
"""Download one pinned Qwen3.6-35B-A3B / Qwen3.8-27B variant from scripts/qwen-variants.json.

Every file of the variant (and its required components, such as the
Qwen3.8-27B F16 projector) is fetched from its pinned repository revision,
resumable, verified by size and SHA-256 and published only when complete:
one non-waiting leader per file, a private flock-owned stage, verification
outside publication and an atomic no-clobber hard link. Existing verified files
are reused; nothing is overwritten or deleted. Loads no model and starts no
engine.

  --variant ID --directory DIR   GGUF variants: DIR is the shared gguf/ store.
                                 MLX variants: DIR is the model folder.
  --variant ID --root DS4DIR     the same store, resolved from the catalog.
  --list                         the pinned variants; no disk or network access.
  --variant ID --manifest|--field NAME
                                 the pins of one variant; no disk or network access.

The catalog is shipped with DStudio and never fetched.
"""
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
from urllib.parse import quote, urlsplit

SCHEMA = 'dstudio.qwen-variants'
VERSION = 1
HERE = Path(__file__).resolve().parent
CATALOG = HERE / 'qwen-variants.json'
CATALOG_MAX_BYTES = 512 * 1024
MAX_VARIANTS = 96
MAX_COMPONENTS = 8
MAX_FILE_BYTES = 1024 ** 4
HUB = 'https://huggingface.co'
FAMILIES = {'qwen36': 'Qwen3.6-35B-A3B', 'qwen27': 'Qwen3.8-27B'}
ENGINES = ('llama', 'mlx')
# The original pins are frozen: existing installs, settings and partial
# downloads depend on their ids, paths and files. Each digest is pin_digest()
# of the variant as first published.
ORIGINALS = {
    'qwen36-q6': ('gguf/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf',
                  '2b826bb0a1b84bcc3cf2a51dcde9b9d487499aee0f6f99b9d3854c442b9bcf16'),
    'qwen27-q6': ('gguf/Qwen3.8-27B-UD-Q6_K_XL.gguf',
                  'ec6e2fe4ef8d694fd929204a35a48b2dfa64d6b2e4d447b58a09ff1775472a66'),
    'qwen36-mlx': ('mlx/Qwen3.6-35B-A3B-mxfp8',
                   '9d3780cfc940ce7628bd06732f4e18fde59ff1bcfd674b65be1fdeae8cf664a7'),
}
# The private per-file stage inside each store.
STAGE = '.dstudio-qwen-downloads'
CHUNK = 1024 * 1024
MAX_SECONDS = 6 * 60 * 60
MODIFIED = re.compile(r'abliterat|uncensor|jailbreak|heretic', re.I)
ID = re.compile(r'qwen(36|27)-[a-z0-9][a-z0-9_.-]{0,31}')
COMPONENT_ID = re.compile(r'[a-z0-9][a-z0-9_.-]{0,39}')
QUANT = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,22}')
REPOSITORY = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,47}/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}')
REVISION = re.compile(r'[0-9a-f]{40}')
LOCAL = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,95}')
REMOTE = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,95}(?:/[A-Za-z0-9][A-Za-z0-9_.-]{0,95})?')
DIGEST = re.compile(r'[0-9a-f]{64}')


class CatalogError(ValueError):
    pass


def _require(condition, message):
    if not condition:
        raise CatalogError(message)


def _keys(value, required, optional=(), where='object'):
    _require(isinstance(value, dict), f'{where} must be an object')
    unknown = set(value) - set(required) - set(optional)
    missing = set(required) - set(value)
    _require(not unknown and not missing, f'{where}: unexpected {sorted(unknown)} or missing {sorted(missing)}')


def _text(value, pattern, where):
    _require(isinstance(value, str) and pattern.fullmatch(value) is not None, f'invalid {where}: {value!r}')
    return value


def _files(entries, where, limit):
    _require(isinstance(entries, list) and 1 <= len(entries) <= limit, f'{where}: 1..{limit} files required')
    names = set()
    for entry in entries:
        _keys(entry, ('remote', 'file', 'bytes', 'sha256'), where=f'{where} file')
        _text(entry['remote'], REMOTE, f'{where} remote path')
        name = _text(entry['file'], LOCAL, f'{where} file name')
        _require(isinstance(entry['bytes'], int) and not isinstance(entry['bytes'], bool) and
                 0 < entry['bytes'] <= MAX_FILE_BYTES, f'{where}: invalid size for {name}')
        _text(entry['sha256'], DIGEST, f'{where} sha256')
        _require(name.lower() not in names, f'{where}: duplicate file {name}')
        _require(not MODIFIED.search(name) and not MODIFIED.search(entry['remote']), f'{where}: modified weights')
        names.add(name.lower())
    return entries


def pin_digest(variant, components):
    """SHA-256 over every (repository, revision, remote, file, bytes, sha256)
    of a variant and of the components it requires."""
    files = [(variant['repository'], variant['revision'], f['remote'], f['file'], f['bytes'], f['sha256'])
             for f in variant['files']]
    files += [(components[r]['repository'], components[r]['revision'], f['remote'], f['file'], f['bytes'],
               f['sha256']) for r in variant['requires'] for f in components[r]['files']]
    return hashlib.sha256(json.dumps(sorted(files), separators=(',', ':')).encode()).hexdigest()


def validate(document, originals=True):
    """Structural, identity and size checks; mirrors the host's loader."""
    _keys(document, ('schema', 'version', 'components', 'variants'), ('generator', 'source'), 'catalog')
    _require(document['schema'] == SCHEMA and document['version'] == VERSION, 'unsupported catalog schema/version')
    components, variants = document['components'], document['variants']
    _require(isinstance(components, list) and len(components) <= MAX_COMPONENTS, 'invalid components')
    _require(isinstance(variants, list) and 1 <= len(variants) <= MAX_VARIANTS, 'invalid variants')
    gguf_names, folders, by_component = {}, set(), {}
    for component in components:
        _keys(component, ('id', 'role', 'family', 'repository', 'revision', 'files'), where='component')
        identifier = _text(component['id'], COMPONENT_ID, 'component id')
        _require(identifier not in by_component, f'duplicate component {identifier}')
        _require(component['role'] == 'projector' and component['family'] in FAMILIES, f'{identifier}: invalid role/family')
        _text(component['repository'], REPOSITORY, 'repository')
        _text(component['revision'], REVISION, 'revision')
        files = _files(component['files'], identifier, 1)
        name = files[0]['file']
        _require(name.startswith(FAMILIES[component['family']] + '-mmproj-') and name.endswith('.gguf'),
                 f'{identifier}: projector name must be {FAMILIES[component["family"]]}-mmproj-*.gguf')
        gguf_names[name.lower()] = identifier
        by_component[identifier] = component
    ids = set()
    for variant in variants:
        _keys(variant, ('id', 'family', 'engine', 'quant', 'repository', 'revision', 'path', 'requires',
                        'bytes', 'files'), where='variant')
        identifier = _text(variant['id'], ID, 'variant id')
        _require(identifier not in ids, f'duplicate variant {identifier}')
        ids.add(identifier)
        family, engine = variant['family'], variant['engine']
        _require(family in FAMILIES and identifier.startswith(family + '-') and engine in ENGINES,
                 f'{identifier}: invalid family/engine')
        _text(variant['quant'], QUANT, f'{identifier} quant')
        _text(variant['repository'], REPOSITORY, f'{identifier} repository')
        _text(variant['revision'], REVISION, f'{identifier} revision')
        _require(not MODIFIED.search(identifier) and not MODIFIED.search(variant['repository']),
                 f'{identifier}: modified weights')
        prefix = FAMILIES[family] + '-'
        requires = variant['requires']
        _require(isinstance(requires, list) and all(isinstance(r, str) for r in requires) and len(set(requires)) == len(requires),
                 f'{identifier}: invalid requires')
        if engine == 'llama':
            files = _files(variant['files'], identifier, 3)
            for index, entry in enumerate(files):
                name = entry['file']
                _require(name.startswith(prefix) and name.endswith('.gguf') and '-mmproj-' not in name,
                         f'{identifier}: invalid GGUF name {name}')
                _require(name.lower() not in gguf_names, f'{identifier}: {name} already belongs to {gguf_names.get(name.lower())}')
                gguf_names[name.lower()] = identifier
                if len(files) > 1:
                    match = re.fullmatch(r'(.+)-(\d{5})-of-(\d{5})\.gguf', name)
                    first = re.fullmatch(r'(.+)-(\d{5})-of-(\d{5})\.gguf', files[0]['file'])
                    _require(match and int(match.group(2)) == index + 1 and int(match.group(3)) == len(files) and
                             match.group(1) == first.group(1), f'{identifier}: split parts must be <name>-%05d-of-%05d.gguf in order')
            _require(variant['path'] == 'gguf/' + files[0]['file'], f'{identifier}: path must be gguf/<first file>')
            needs = ['projector'] if family == 'qwen27' else []
            _require([by_component.get(r, {}).get('role') for r in requires] == needs and
                     all(by_component[r]['family'] == family for r in requires),
                     f'{identifier}: {FAMILIES[family]} on llama.cpp requires {needs or "no components"}')
        else:
            files = _files(variant['files'], identifier, 64)
            folder = variant['repository'].split('/', 1)[1]
            _require(variant['path'] == 'mlx/' + folder and folder.startswith(prefix), f'{identifier}: path must be mlx/<repository name>')
            _require(folder.lower() not in folders, f'{identifier}: duplicate MLX folder')
            folders.add(folder.lower())
            names = {entry['file'] for entry in files}
            _require({'config.json', 'model.safetensors.index.json'} <= names and
                     any(n.endswith('.safetensors') for n in names), f'{identifier}: incomplete MLX folder')
            _require(not requires, f'{identifier}: MLX variants have no components')
        total = sum(f['bytes'] for f in files) + sum(f['bytes'] for r in requires for f in by_component[r]['files'])
        _require(variant['bytes'] == total, f'{identifier}: total bytes {variant["bytes"]} != {total}')
    if originals:
        for identifier, (path, digest) in ORIGINALS.items():
            variant = next((v for v in variants if v['id'] == identifier), None)
            _require(variant is not None and variant['path'] == path, f'the original pin {identifier} is missing or moved')
            _require(pin_digest(variant, by_component) == digest, f'the original pin {identifier} changed')
    return document


def parse(data, originals=True):
    """Bounded, unambiguous JSON (no duplicate keys), then validate()."""
    _require(len(data) <= CATALOG_MAX_BYTES, 'catalog exceeds its size limit')

    def unique(pairs):
        keys = [key for key, _ in pairs]
        _require(len(keys) == len(set(keys)), 'duplicate JSON key')
        return dict(pairs)
    return validate(json.loads(data.decode('utf-8'), object_pairs_hook=unique), originals=originals)


def load(path=None):
    """The validated catalog; the shipped file must also keep the original pins.

    An explicit path is a maintainer or test catalog: its variants need not
    include the original pins."""
    with open(Path(path) if path else CATALOG, 'rb') as stream:
        data = stream.read(CATALOG_MAX_BYTES + 1)
    return parse(data, originals=path is None)


def find(document, identifier):
    variant = next((v for v in document['variants'] if v['id'] == identifier), None)
    if variant is None:
        raise CatalogError(f'Unknown Qwen variant: {identifier} (see --list)')
    components = {c['id']: c for c in document['components']}
    # Required components are fetched from their own pinned repository.
    jobs = [(variant['repository'], variant['revision'], f) for f in variant['files']]
    if variant['engine'] == 'mlx':
        # config.json last: a folder is not listed as a model before its
        # weights are complete. Presence is still not readiness.
        jobs.sort(key=lambda job: job[2]['file'] == 'config.json')
    jobs += [(components[r]['repository'], components[r]['revision'], f)
             for r in variant['requires'] for f in components[r]['files']]
    return variant, jobs


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

    Each preparation has one persistent empty lock file and one resumable
    partial bounded by the exact file size. The OS lock, not file presence/PID text, denotes ownership.
    Failures retain the partial; verified publication uses an atomic hard link
    on the same volume. No existing target is overwritten or deleted.
    """
    import fcntl  # POSIX only; main() refuses other hosts.
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
        prepared = private_directory(root, STAGE)
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


def stop_download(_signal, _frame):
    raise KeyboardInterrupt


def base_url(value):
    if value is None:
        return HUB
    parts = urlsplit(value)
    # Only the hub itself, or a loopback HTTP fixture for behavioral tests.
    if value.rstrip('/') == HUB or (parts.scheme == 'http' and parts.hostname in ('127.0.0.1', '::1') and
                                    not parts.username and not parts.password and parts.path in ('', '/')):
        return value.rstrip('/')
    raise ValueError('--base-url must be the Hugging Face hub or a loopback test fixture')


def label(variant):
    engine = 'MLX' if variant['engine'] == 'mlx' else 'llama.cpp'
    return f"{FAMILIES[variant['family']]} {variant['quant']} ({engine})"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--variant', help='catalog id, for example qwen36-q4_k_m or qwen27-mlx-4bit')
    parser.add_argument('--directory', type=Path, help='the store for this variant (gguf/ or the MLX folder)')
    parser.add_argument('--root', type=Path, help='the ds4 model root; the store is resolved from the catalog')
    parser.add_argument('--list', action='store_true', help='list the pinned variants; no disk or network access')
    parser.add_argument('--manifest', action='store_true', help='print the pins of --variant; no disk or network access')
    parser.add_argument('--field', choices=('engine', 'store', 'bytes', 'label'), help='print one field of --variant')
    parser.add_argument('--verify-only', action='store_true', help='verify existing files; never download')
    parser.add_argument('--progress-fd', type=int, help='owned host pipe: D=transfer, V=SHA-256 verification')
    parser.add_argument('--directory-identity', help='admitted store device:inode; reject a replaced directory')
    parser.add_argument('--catalog', type=Path, help=argparse.SUPPRESS)  # maintainers and behavioral tests
    parser.add_argument('--base-url', help=argparse.SUPPRESS)            # loopback test fixtures only
    args = parser.parse_args()
    try:
        document = load(args.catalog)
    except (OSError, ValueError) as error:
        print(f'Invalid Qwen variant catalog: {error}', file=sys.stderr)
        return 2
    if args.list:
        for variant in document['variants']:
            print(f"{variant['id']:<22} {variant['engine']:<6} {variant['quant']:<12} "
                  f"{variant['bytes'] / 1e9:7.1f} GB  {FAMILIES[variant['family']]}")
        return 0
    if not args.variant:
        parser.error('--variant is required')
    try:
        variant, jobs = find(document, args.variant)
    except CatalogError as error:
        print(str(error), file=sys.stderr)
        return 2
    store = 'gguf' if variant['engine'] == 'llama' else variant['path']
    if args.field:
        print({'engine': variant['engine'], 'store': store, 'bytes': variant['bytes'], 'label': label(variant)}[args.field])
        return 0
    if args.manifest:
        print(json.dumps({'id': variant['id'], 'repository': variant['repository'], 'revision': variant['revision'],
                          'engine': variant['engine'], 'path': variant['path'], 'bytes': variant['bytes'],
                          'files': [{'repository': r, 'revision': v, **f} for r, v, f in jobs]}))
        return 0
    if (args.directory is None) == (args.root is None):
        parser.error('give exactly one of --directory or --root')
    directory = args.directory if args.directory is not None else args.root / store
    expected_store = None
    if args.directory_identity:
        if not re.fullmatch(r'[0-9]{1,20}:[0-9]{1,20}', args.directory_identity):
            parser.error('invalid store identity')
        expected_store = tuple(int(value) for value in args.directory_identity.split(':'))
    if os.name != 'posix':
        parser.error('Qwen variant downloads currently require a POSIX host')
    hub = base_url(args.base_url)
    signal.signal(signal.SIGTERM, stop_download)
    # Phase hints only; readiness still comes from this process's exit status.
    if args.progress_fd is not None:
        os.set_inheritable(args.progress_fd, False)

    def progress(phase):
        if args.progress_fd is not None:
            try:
                os.write(args.progress_fd, phase.encode('ascii'))
            except OSError:
                pass

    if expected_store is None and not args.verify_only:
        directory.mkdir(parents=True, exist_ok=True)
    token = os.environ.get('HF_TOKEN', '')
    verified = []
    for repository, revision, item in jobs:
        url = f"{hub}/{repository}/resolve/{revision}/{quote(item['remote'], safe='/')}"
        if args.verify_only:
            progress('V')
            verify(directory / item['file'], item['bytes'], item['sha256'], expected_store)
        else:
            download(directory, token, name=item['file'], size=item['bytes'], expected=item['sha256'],
                            url=url, progress=progress, expected_store=expected_store)
        verified.append({'file': item['file'], 'bytes': item['bytes'], 'sha256': item['sha256']})
    print(json.dumps({'id': variant['id'], 'repository': variant['repository'], 'revision': variant['revision'],
                      'verifiedFiles': verified}), flush=True)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('Download stopped; partial files preserved for resume.', file=sys.stderr)
        sys.exit(130)
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
