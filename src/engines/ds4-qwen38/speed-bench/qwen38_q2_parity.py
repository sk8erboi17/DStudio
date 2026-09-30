#!/usr/bin/env python3
"""Compare full teacher-forced logits between two Qwen Metal implementations.

The FT_LIST diagnostic accepts at most 128 prompt tokens. Larger prefill
checks use the public CLI's full next-token logit dump. Neither comparison
uses independently generated continuations as a substitute for logit parity.
"""
import argparse
from array import array
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--model', type=Path, required=True)
    ap.add_argument('--ple', type=Path, required=True)
    ap.add_argument('--baseline', type=Path, required=True)
    ap.add_argument('--baseline-source', type=Path, required=True)
    ap.add_argument('--candidate', type=Path, default=ROOT / 'ds4')
    ap.add_argument('--candidate-source', type=Path, default=ROOT / 'metal/qwen4.metal')
    ap.add_argument('--prompt-file', type=Path, action='append', default=[])
    ap.add_argument('--out', type=Path, required=True)
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    common = ['-m', str(a.model.resolve()), '--ple', str(a.ple.resolve()), '--metal',
              '-c', '32768', '--nothink', '--temp', '0']
    env0 = {k: v for k, v in os.environ.items() if not k.startswith('DS4_')}
    configs = {'baseline': (a.baseline, a.baseline_source),
               'candidate': (a.candidate, a.candidate_source)}
    result = {'model': str(a.model.resolve()), 'configs': {}, 'checks': []}
    # Valid text token IDs, captured with --dump-tokens. Repetition deliberately
    # covers the single-token, paired, small batch, and GEMM dispatch boundaries.
    text = [814, 20139, 1204, 264, 6165, 20653, 264, 3370, 1622, 888,
            25804, 321, 20539, 279, 1965, 13]
    sizes = [1, 2, 8, 9, 39, 128]
    for name, (binary, source) in configs.items():
        result['configs'][name] = {'binary_sha256': digest(binary), 'source_sha256': digest(source)}
        env = dict(env0, DS4_METAL_QWEN4_SOURCE=str(source.resolve()))
        listing = a.out / f'{name}.tsv'
        listing.write_text(''.join(
            ','.join(map(str, (text * 8)[:n])) + '|' + ','.join(map(str, text * 2)) +
            '\t' + str((a.out / f'{name}-{n}.f32').resolve()) + '\n' for n in sizes))
        with (a.out / f'{name}-ft.log').open('w') as log:
            subprocess.run([str(binary.resolve()), *common, '--first-token-test', '--raw', '-p', 'x'],
                           cwd=ROOT, env=dict(env, DS4_QWEN4_FT_LIST=str(listing.resolve()),
                                             DS4_QWEN4_GPU='1'), stdout=log, stderr=subprocess.STDOUT, check=True)
        for i, prompt in enumerate(a.prompt_file):
            target = a.out / f'{name}-long-{i}.json'
            with (a.out / f'{name}-long-{i}.log').open('w') as log:
                subprocess.run([str(binary.resolve()), *common, '--prompt-file', str(prompt.resolve()),
                                '--dump-logits', str(target.resolve())], cwd=ROOT, env=env,
                               stdout=log, stderr=subprocess.STDOUT, check=True)
    for n in sizes:
        paths = [a.out / f'{name}-{n}.f32' for name in configs]
        assert paths[0].stat().st_size > 0 and paths[0].stat().st_size % (32 * 4) == 0
        assert paths[0].stat().st_size == paths[1].stat().st_size
        hashes = [digest(p) for p in paths]
        finite = True
        for path in paths:
            with path.open('rb') as f:
                while chunk := f.read(4 * 1024 * 1024):
                    values = array('f')
                    values.frombytes(chunk)
                    finite &= all(map(math.isfinite, values))
        record = {'prompt_tokens': n, 'logit_vectors': 32, 'bytes': paths[0].stat().st_size,
                  'sha256': hashes, 'exact': hashes[0] == hashes[1], 'finite': finite}
        result['checks'].append(record)
        print(json.dumps(record), flush=True)
    for i, prompt in enumerate(a.prompt_file):
        data = [json.loads((a.out / f'{name}-long-{i}.json').read_text()) for name in configs]
        vectors = [d['logits'] for d in data]
        result['checks'].append({'prompt_file': str(prompt.resolve()), 'prompt_sha256': digest(prompt),
                                 'prompt_tokens': data[0]['prompt_tokens'], 'logit_vectors': 1,
                                 'exact': vectors[0] == vectors[1],
                                 'finite': all(v and all(x is not None and math.isfinite(x) for x in v)
                                               for v in vectors)})
    (a.out / 'results.json').write_text(json.dumps(result, indent=2) + '\n')
    if not all(c['exact'] and c['finite'] for c in result['checks']):
        raise SystemExit('Full-logit parity failed')
    print('All full-logit comparisons are finite and exact.', flush=True)


if __name__ == '__main__':
    main()
