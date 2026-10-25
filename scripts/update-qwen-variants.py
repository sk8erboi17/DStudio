#!/usr/bin/env python3
"""Maintainer tool: regenerate scripts/qwen-variants.json from the Hugging Face API.

Reads the repository trees at the explicit revisions pinned below (never a
branch name) and writes every published standard quantization of
Qwen3.6-35B-A3B and Qwen3.8-27B as a DStudio variant with exact file names,
sizes and SHA-256 digests. Large (LFS) files take the hub's LFS SHA-256 from
the tree. Small non-LFS files (JSON, templates, vocabularies) are fetched at the
same pinned revision, checked against the tree's git blob id and hashed. Model
weights (.gguf, .safetensors) are never downloaded.

DStudio itself never runs this script or fetches the catalog: the generated
file ships with the application. Review the diff before committing it.

  python3 scripts/update-qwen-variants.py                # rewrite the catalog
  python3 scripts/update-qwen-variants.py --check        # compare, do not write
  python3 scripts/update-qwen-variants.py --heads        # report current MLX heads
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
import urllib.parse
import urllib.request

HUB = 'https://huggingface.co'
HERE = Path(__file__).resolve().parent
CATALOG = HERE / 'qwen-variants.json'
SMALL_FILE_LIMIT = 32 * 1024 * 1024
API_LIMIT = 8 * 1024 * 1024

# GGUF repositories at the revisions DStudio already pins for its default
# quantizations. Every model GGUF is included; projectors other than the pinned
# F16 one, the imatrix and the MTP draft are not DStudio models.
GGUF_REPOSITORIES = [
    {'family': 'qwen36', 'prefix': 'Qwen3.6-35B-A3B', 'repository': 'unsloth/Qwen3.6-35B-A3B-GGUF',
     'revision': 'a483e9e6cbd595906af30beda3187c2663a1118c', 'legacy': {'UD-Q6_K_XL': 'qwen36-q6'}},
    {'family': 'qwen27', 'prefix': 'Qwen3.8-27B', 'repository': 'unsloth/Qwen3.8-27B-GGUF',
     'revision': '4ca720788d1e01f1bff70c033e0d0028fd02e502', 'legacy': {'UD-Q6_K_XL': 'qwen27-q6'},
     'projector': {'id': 'qwen27-mmproj-f16', 'remote': 'mmproj-F16.gguf',
                   'file': 'Qwen3.8-27B-mmproj-F16.gguf'}},
]
# Standard mlx-community conversions of the official weights, each pinned to
# the commit that was current when it was admitted (--heads reports newer
# ones). Modified, pruned, distilled or speculative-draft repositories are not
# listed: abliterated/uncensored/obliterated, fine-tunes and fusions, REAP,
# MTP, DFlash, DWQ, OptiQ, oQ, msq and AntiLoop.
MLX_REPOSITORIES = [
    ('qwen36', 'mlx-community/Qwen3.6-35B-A3B-4bit', '38740b847e4cb78f352aba30aa41c76e08e6eb46'),
    ('qwen36', 'mlx-community/Qwen3.6-35B-A3B-5bit', 'c90c1a8b7e7a6a9e39e549f0361a96eb05bbb499'),
    ('qwen36', 'mlx-community/Qwen3.6-35B-A3B-6bit', 'cb7e092ef8efe540bc3672c8929c4adbe5f4f759'),
    ('qwen36', 'mlx-community/Qwen3.6-35B-A3B-8bit', 'e06a74e6236a60c8367e1a3214e83d8b61b637b0'),
    ('qwen36', 'mlx-community/Qwen3.6-35B-A3B-bf16', '04bbe07c3ed2d93cbf832f523fea344bca1d0fcf'),
    ('qwen36', 'mlx-community/Qwen3.6-35B-A3B-mxfp4', '833013b27a1f7c6dbb008b55d37c387ea22ea89d'),
    ('qwen36', 'mlx-community/Qwen3.6-35B-A3B-mxfp8', '5c216c8705fed28a7a16fc92555befd507628709'),
    ('qwen36', 'mlx-community/Qwen3.6-35B-A3B-nvfp4', '9c1a3a223ddd8a3425212cc421056614f149cf0f'),
    ('qwen27', 'mlx-community/Qwen3.8-27B-4bit', '10c35caafbb80f7dc6a7a432cdd11af10a6d4818'),
    ('qwen27', 'mlx-community/Qwen3.8-27B-8bit', '815b83c0df8ffd1d1b5244cf75fd6ef14fca9ef9'),
    ('qwen27', 'mlx-community/Qwen3.8-27B-bf16', '6f265714824f3c38d4452baa1628aef3d9b9aae9'),
    ('qwen27', 'mlx-community/Qwen3.8-27B-mxfp4', '97ab0819817ab1c61d7d39f9169fc71999915641'),
    ('qwen27', 'mlx-community/Qwen3.8-27B-mxfp8', 'd48d163bcdf24acaf656474854ab88ea17d65bd1'),
    ('qwen27', 'mlx-community/Qwen3.8-27B-nvfp4', '5ff8ef173ad0d7c3aae92f0be43031a6ab8067c6'),
]
MLX_LEGACY = {'mlx-community/Qwen3.6-35B-A3B-mxfp8': 'qwen36-mlx'}
FAMILY_BASE = {'qwen36': 'Qwen/Qwen3.6-35B-A3B', 'qwen27': 'Qwen/Qwen3.8-27B'}

_spec = importlib.util.spec_from_file_location('download_qwen_variant', HERE / 'download-qwen-variant.py')
_catalog = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_catalog)


def fetch(url, limit):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'dstudio-catalog'}),
                                timeout=60) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise RuntimeError(f'Response exceeds {limit} bytes: {url}')
    return data


def api(path):
    return json.loads(fetch(f'{HUB}/api/{path}', API_LIMIT))


def tree(repository, revision):
    entries = api(f'models/{repository}/tree/{revision}?recursive=1')
    return [entry for entry in entries if entry.get('type') == 'file']


_small = {}


def small_file_sha256(repository, revision, entry):
    """SHA-256 of a non-LFS file whose git blob id matches the pinned tree."""
    size, oid, name = entry['size'], entry['oid'], entry['path']
    if name.endswith(('.gguf', '.safetensors')) or size > SMALL_FILE_LIMIT:
        raise RuntimeError(f'Refusing to download weights or a large file: {repository}/{name}')
    if oid not in _small:
        quoted = urllib.parse.quote(name)
        data = fetch(f'{HUB}/{repository}/resolve/{revision}/{quoted}', SMALL_FILE_LIMIT)
        blob = hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest()
        if len(data) != size or blob != oid:
            raise RuntimeError(f'{repository}/{name} does not match the pinned tree')
        _small[oid] = hashlib.sha256(data).hexdigest()
    return _small[oid]


def file_entry(repository, revision, entry, local):
    lfs = entry.get('lfs')
    digest = lfs['oid'] if lfs else small_file_sha256(repository, revision, entry)
    if lfs and lfs.get('size') != entry['size']:
        raise RuntimeError(f'LFS size mismatch: {repository}/{entry["path"]}')
    return {'remote': entry['path'], 'file': local, 'bytes': entry['size'], 'sha256': digest}


def gguf_variants(spec, components):
    files = tree(spec['repository'], spec['revision'])
    prefix, single, split = spec['prefix'], {}, {}
    pattern = re.compile(re.escape(prefix) + r'-(.+)\.gguf')
    for entry in files:
        path = entry['path']
        if not path.endswith('.gguf') or path.startswith('MTP/') or '/mmproj' in path or \
                path.startswith('mmproj') or 'imatrix' in path:
            continue
        base = path.rsplit('/', 1)[-1]
        match = pattern.fullmatch(base)
        if not match:
            raise RuntimeError(f'Unexpected GGUF name: {path}')
        part = re.fullmatch(r'(.+)-(\d{5})-of-(\d{5})', match.group(1))
        if part:
            split.setdefault(part.group(1), []).append((int(part.group(2)), int(part.group(3)), entry))
        else:
            single[match.group(1)] = [entry]
    for quant, parts in split.items():
        parts.sort(key=lambda item: item[0])
        if [index for index, _, _ in parts] != list(range(1, parts[0][1] + 1)):
            raise RuntimeError(f'Incomplete split GGUF {quant}')
        single[quant] = [entry for _, _, entry in parts]
    requires = []
    if spec.get('projector'):
        projector = spec['projector']
        entry = next(e for e in files if e['path'] == projector['remote'])
        components.append({'id': projector['id'], 'role': 'projector', 'family': spec['family'],
                           'repository': spec['repository'], 'revision': spec['revision'],
                           'files': [file_entry(spec['repository'], spec['revision'], entry, projector['file'])]})
        requires = [projector['id']]
    variants = []
    for quant, entries in single.items():
        identifier = spec['legacy'].get(quant) or f"{spec['family']}-{re.sub(r'^ud-', '', quant.lower())}"
        own = [file_entry(spec['repository'], spec['revision'], e, e['path'].rsplit('/', 1)[-1]) for e in entries]
        extra = sum(f['bytes'] for c in components if c['id'] in requires for f in c['files'])
        variants.append({'id': identifier, 'family': spec['family'], 'engine': 'llama', 'quant': quant,
                         'repository': spec['repository'], 'revision': spec['revision'],
                         'path': 'gguf/' + own[0]['file'], 'requires': requires,
                         'bytes': sum(f['bytes'] for f in own) + extra, 'files': own})
    return variants


def mlx_variant(family, repository, revision):
    model = api(f'models/{repository}/revision/{revision}')
    if model.get('sha') != revision:
        raise RuntimeError(f'{repository} did not resolve to {revision}')
    tags = set(model.get('tags') or [])
    base = FAMILY_BASE[family]
    if f'base_model:quantized:{base}' not in tags and f'base_model:finetune:{base}' not in tags:
        raise RuntimeError(f'{repository} is not a direct conversion of {base}')
    folder = repository.split('/', 1)[1]
    quant = folder.rsplit('-', 1)[1]
    files = [file_entry(repository, revision, entry, entry['path'])
             for entry in tree(repository, revision) if entry['path'] != '.gitattributes']
    files.sort(key=lambda item: item['file'])
    return {'id': MLX_LEGACY.get(repository) or f'{family}-mlx-{quant.lower()}', 'family': family, 'engine': 'mlx',
            'quant': quant, 'repository': repository, 'revision': revision, 'path': 'mlx/' + folder,
            'requires': [], 'bytes': sum(f['bytes'] for f in files), 'files': files}


def build():
    components, variants = [], []
    for spec in GGUF_REPOSITORIES:
        variants.extend(gguf_variants(spec, components))
    for family, repository, revision in MLX_REPOSITORIES:
        variants.append(mlx_variant(family, repository, revision))
    order = {'qwen36': 0, 'qwen27': 1, 'llama': 0, 'mlx': 1}
    variants.sort(key=lambda v: (order[v['family']], order[v['engine']], v['bytes'], v['id']))
    return {'schema': _catalog.SCHEMA, 'version': _catalog.VERSION,
            'generator': 'scripts/update-qwen-variants.py',
            'source': 'Hugging Face model trees at the pinned revisions; no weights downloaded',
            'components': components, 'variants': variants}


def render(document):
    """Stable, reviewable formatting: one file per line."""
    def dumps(value):
        return json.dumps(value, ensure_ascii=True)
    lines = ['{']
    head = [k for k in document if k not in ('components', 'variants')]
    for key in head:
        lines.append(f'  {dumps(key)}: {dumps(document[key])},')
    for section in ('components', 'variants'):
        lines.append(f'  {dumps(section)}: [')
        for index, item in enumerate(document[section]):
            lines.append('    {')
            keys = list(item)
            for key in keys:
                end = ',' if key != keys[-1] else ''
                if key == 'files':
                    lines.append('      "files": [')
                    for f_index, entry in enumerate(item['files']):
                        lines.append('        ' + dumps(entry) + (',' if f_index + 1 < len(item['files']) else ''))
                    lines.append('      ]' + end)
                else:
                    lines.append(f'      {dumps(key)}: {dumps(item[key])}{end}')
            lines.append('    }' + (',' if index + 1 < len(document[section]) else ''))
        lines.append('  ]' + (',' if section == 'components' else ''))
    lines.append('}')
    return '\n'.join(lines) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--check', action='store_true', help='compare with the committed catalog; write nothing')
    parser.add_argument('--heads', action='store_true', help='report MLX repositories whose head moved')
    args = parser.parse_args()
    if args.heads:
        for _, repository, revision in MLX_REPOSITORIES:
            head = api(f'models/{repository}').get('sha')
            print(f'{repository}: pinned {revision}{"" if head == revision else f", head {head}"}')
        return 0
    text = render(build())
    _catalog.validate(json.loads(text))
    if args.check:
        same = CATALOG.read_text(encoding='utf-8') == text
        print('catalog is current' if same else 'catalog differs from the pinned trees')
        return 0 if same else 1
    CATALOG.write_text(text, encoding='utf-8')
    document = json.loads(text)
    counts = {}
    for variant in document['variants']:
        key = f"{variant['family']} {variant['engine']}"
        counts[key] = counts.get(key, 0) + 1
    print(json.dumps({'written': str(CATALOG), 'variants': counts,
                      'bytes': sum(v['bytes'] for v in document['variants'])}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
