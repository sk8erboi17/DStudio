#!/Users/agrilv/venv312/bin/python
"""GPQA-Diamond-MC benchmark: q35-default8 vs q35-exp20-thr08-gate27-39.
Paired methodology (same fixed prompts, temp 0), 8K budget, serial decode,
ctx 65536, eval-batch-size 1. 198 questions across biology/physics/chemistry.
Registers the local 'gpqa_mc' benchmark then calls evalscope run_task.

Usage: gpqa_run_one.py <model_id> <work_dir> [domain ...]
       no domain args = all three domains"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gpqa_adapter_local  # noqa: F401  (registers 'gpqa_mc')

from evalscope.run import run_task

CFG = dict(
    model='deepseek-v4-flash',
    api_url='http://127.0.0.1:8000/v1/chat/completions',
    api_key='EMPTY',
    eval_type='openai_api',
    datasets=['gpqa_mc'],
    dataset_args={'gpqa_mc': {'few_shot_num': 0}},
    generation_config={'max_tokens': 30720, 'temperature': 0, 'timeout': 10800},
    collect_perf=False,
    dataset_hub='huggingface',
    eval_batch_size=1,
    no_timestamp=True,
)

if __name__ == '__main__':
    model_id = sys.argv[1]
    wd = sys.argv[2]
    domains = sys.argv[3:]
    if domains:
        CFG['dataset_args']['gpqa_mc']['subset_list'] = domains
    CFG['model_id'] = model_id
    CFG['use_cache'] = wd
    CFG['work_dir'] = wd
    res = run_task(CFG)
    print('=== GPQA run done:', model_id, domains or '(all)')
