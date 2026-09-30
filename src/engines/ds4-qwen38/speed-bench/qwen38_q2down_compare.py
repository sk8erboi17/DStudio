"""Compare Qwen quantizations against the saved BF16 continuation fixture.

Run with uv run --with numpy --with tokenizers. Writes per-case logits and
metrics, using the production Metal prefill and teacher-forced decode path.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

import numpy as np
from tokenizers import Tokenizer

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / 'speed-bench/qwen38-bf16-reference/fixture-100'


def chat_ids(tok, text):
    enc = lambda s: tok.encode(s, add_special_tokens=False).ids
    return ([tok.token_to_id('<|im_start|>')] + enc('user\n') + enc(text) +
            [tok.token_to_id('<|im_end|>')] + enc('\n') +
            [tok.token_to_id('<|im_start|>')] + enc('assistant\n') +
            [tok.token_to_id('</think>')] + enc('\n\n'))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--model', type=Path, required=True)
    ap.add_argument('--ple', type=Path, required=True)
    ap.add_argument('--tokenizer', type=Path, required=True)
    ap.add_argument('--out', type=Path, required=True)
    ap.add_argument('--score-only', action='store_true', help='score already generated logits')
    a = ap.parse_args()
    a.out = a.out.resolve()
    a.out.mkdir(parents=True, exist_ok=True)
    tok = Tokenizer.from_file(str(a.tokenizer))
    cases, excluded, lines = [], [], []
    for prompt in sorted((FIXTURE / 'prompts').glob('*.txt')):
        name = prompt.stem
        response = json.loads((FIXTURE / 'responses' / (name + '.json')).read_text())
        positions = response['choices'][0]['logprobs']['content']
        target = tok.encode((FIXTURE / 'continuations' / (name + '.txt')).read_text(),
                            add_special_tokens=False).ids
        # Exclude changed token boundaries, not just changed token counts.
        if len(target) != len(positions) or any(
                tok.decode([t], skip_special_tokens=False).encode() != bytes(p['bytes'])
                for t, p in zip(target, positions)):
            excluded.append(name)
            continue
        pids = chat_ids(tok, prompt.read_text())
        output = a.out / (name + '.f32')
        lines.append(','.join(map(str, pids)) + '|' + ','.join(map(str, target)) + '\t' + str(output))
        cases.append((name, target, positions, output))
    listing = a.out / 'sequences.tsv'
    listing.write_text('\n'.join(lines) + '\n')
    command = [str(ROOT / 'ds4'), '-m', str(a.model), '--ple', str(a.ple),
               '--metal', '--ctx', '4096', '--first-token-test', '--raw', '-p', 'x']
    env = dict(os.environ, DS4_QWEN4_FT_LIST=str(listing), DS4_QWEN4_GPU='1',
               DS4_QWEN4_PREFILL_CHUNK='1024')
    identity = dict(command=command, model_bytes=a.model.stat().st_size,
                    sequence_sha256=hashlib.sha256(listing.read_bytes()).hexdigest())
    provenance = a.out / 'inference.json'
    if a.score_only:
        run = json.loads(provenance.read_text())
        if any(run[k] != v for k, v in identity.items()) or run['returncode'] != 0:
            raise ValueError('Saved inference does not match this scoring request')
    else:
        print(f'Running {len(cases)} aligned cases; excluded {len(excluded)}', flush=True)
        run = dict(identity, started=time.time(),
                   executable_sha256=hashlib.sha256((ROOT/'ds4').read_bytes()).hexdigest())
        with (a.out / 'run.log').open('w') as log:
            process = subprocess.run(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
        run.update(returncode=process.returncode, elapsed_seconds=time.time()-run['started'])
        provenance.write_text(json.dumps(run, indent=2)+'\n')
        process.check_returncode()
    records = []
    # The checkpoint pads its output vocabulary beyond tokenizer entries.
    config = json.loads(a.tokenizer.with_name('config.json').read_text())
    vocab = config.get('text_config', config)['vocab_size']
    for name, target, positions, path in cases:
        raw = np.fromfile(path, dtype=np.float32)
        if raw.size != len(target) * vocab or not np.isfinite(raw).all():
            raise ValueError(f'Invalid logits: {name}: {raw.size}')
        logits = raw.reshape(len(target), vocab).astype(np.float64)
        mx = logits.max(axis=1)
        norm = mx + np.log(np.exp(logits - mx[:, None]).sum(axis=1))
        lp = logits[np.arange(len(target)), target] - norm
        ref_lp = np.array([p['logprob'] for p in positions])
        hits = logits.argmax(axis=1) == target
        records.append(dict(id=name, tokens=len(target), nll_sum=float(-lp.sum()),
                            top1_hits=int(hits.sum()), first_token_match=bool(hits[0]),
                            logprob_absolute_error_sum=float(np.abs(lp-ref_lp).sum())))
    total = sum(r['tokens'] for r in records)
    summary = dict(cases=len(records), tokens=total, excluded=excluded,
                   target_nll=sum(r['nll_sum'] for r in records)/total,
                   bf16_top1_agreement=sum(r['top1_hits'] for r in records)/total,
                   first_token_matches=sum(r['first_token_match'] for r in records),
                   logprob_mae=sum(r['logprob_absolute_error_sum'] for r in records)/total)
    result = dict(model=str(a.model), model_bytes=a.model.stat().st_size,
                  command=command, elapsed_seconds=run['elapsed_seconds'],
                  executable_sha256=run['executable_sha256'],
                  summary=summary, cases=records)
    (a.out / 'results.json').write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps(summary, indent=2), flush=True)


if __name__ == '__main__':
    main()
