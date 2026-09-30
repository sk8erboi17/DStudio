#!/Users/agrilv/venv312/bin/python
"""Export GPQA-MC predictions to JSON: one record per (run, question) with
run, model, question_id, domain, pred, gold, result (correct/wrong/trunc),
truncated, latency_s, tokens. Writes evalscope/gpqa_results.json.
Re-run any time; safe mid-run."""
import ast, glob, json, os, re

from gpqa_adapter_local import gold_map

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = [
    ("gpqa-def8", "q35-default8-gpqa", "Qwen 3.6 35B A3B (reference implementation)",
     {}),
    ("gpqa-gate39", "q35-exp20-thr08-gate27-39-gpqa",
     "Qwen 3.6 35B A3B->A4B+ (expert expansion)",
     {"q35_experts": 20, "q35_expert_threshold": 0.8,
      "env_DS4_METAL_QWEN35_SOURCE": "metal/qwen35_lay_last.metal"}),
]
# generation params are identical across runs (paired benchmark, temp 0)
GEN_PARAMS = {
    "temperature": 0.0,
    "top_p": 1.0,
    "seed": 42,
    "few_shot": 0,
    "max_tokens_requested": 61440,
    "server_ctx": 65536,
    "eval_batch_size": 1,
    "decoding": "serial",
    "note": "max_tokens effective per call was 8192/30720/61440 across the "
            "8K->30K->60K escalation; a row's budget is recoverable from "
            "output_tokens when truncated",
}


def extract(raw):
    """Return (pred, trunc, out_tokens, latency) from a model_output blob."""
    raw = str(raw)
    L = re.findall(r"ANSWER:\s*\(?([A-D])\b", raw, re.I)
    pred = L[-1].upper() if L else None
    sr = re.search(r"'stop_reason': '(\w+)'", raw)
    trunc = bool(sr and sr.group(1) in ("max_tokens", "length"))
    m = re.search(r"'output_tokens': (\d+)", raw)
    la = re.search(r"'latency': ([0-9.]+)", raw)
    return (pred, trunc, int(m.group(1)) if m else 0,
            float(la.group(1)) if la else 0.0)


def main():
    gold = gold_map()
    out = []
    seen = set()
    for wd, mid, desc, extra in RUNS:
        for f in glob.glob(os.path.join(HERE, wd, "predictions", mid, "*.jsonl")):
            for line in open(f, errors="replace"):
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                md = r.get("metadata")
                if isinstance(md, str):
                    try:
                        md = ast.literal_eval(md)
                    except Exception:
                        continue
                try:
                    qid = int(md["question_id"])
                    domain = md.get("domain", "")
                except Exception:
                    continue
                pred, trunc, tok, lat = extract(r.get("model_output", ""))
                # grade by the final ANSWER letter; trunc only when no letter
                # was produced before the budget cut (same rules as round-4)
                if pred is None:
                    res = "trunc" if trunc else "wrong"
                elif pred == gold.get(qid):
                    res = "correct"
                else:
                    res = "wrong"
                if (mid, qid) in seen:
                    continue
                seen.add((mid, qid))
                out.append({
                    "run": mid,
                    "model": desc,
                    "generation_config": {**GEN_PARAMS, **extra},
                    "question_id": qid,
                    "domain": domain,
                    "pred": pred,
                    "gold": gold.get(qid),
                    "result": res,
                    "truncated": bool(trunc),
                    "latency_s": lat,
                    "tokens": tok,
                })
    path = os.path.join(HERE, "gpqa_results.json")
    with open(path, "w") as fh:
        json.dump(out, fh, indent=1)
    print("wrote %s (%d records)" % (path, len(out)))


if __name__ == "__main__":
    main()
