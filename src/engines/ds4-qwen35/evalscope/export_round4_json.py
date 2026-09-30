#!/Users/agrilv/venv312/bin/python
"""Export round-4 predictions to JSON: one record per (run, question) with
model_id, question_id, subject, result (ok/ko/trunc), latency s, tokens used.
Writes evalscope/round4_results.json. Re-run any time; safe mid-run."""
import ast, glob, json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = [
    # previous full runs (210 questions each)
    ("runB-pro-full", "q35-default8", "Qwen 3.6 35B A3B (reference implementation)"),
    ("runG-gate39-pro", "q35-exp20-thr08-gate27-39", "Qwen 3.6 35B A3B->A4B+ (expert expansion)"),
    ("runH-qwen27b-pro", "qwen38-27b-nvfp4", "Qwen 3.8 27B nvfp4 (reference implementation)"),
    # round-4 (714 questions: 210 cached + 504 new at 8K budget)
    ("runD4-def8", "q35-default8-r4", "Qwen 3.6 35B A3B (reference implementation)"),
    ("runE4-gate39", "q35-exp20-thr08-gate27-39-r4", "Qwen 3.6 35B A3B->A4B+ (expert expansion)"),
]


def gold_map():
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    from datasets import load_dataset
    ds = load_dataset("TIGER-Lab/MMLU-Pro", split="test")
    return {r["question_id"]: r["answer"] for r in ds}


def extract(raw):
    """Return (pred, trunc, out_tokens, latency) from a model_output blob."""
    raw = str(raw)
    L = re.findall(r"ANSWER:\s*\(?([A-J])\b", raw, re.I)
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
    for wd, mid, desc in RUNS:
        for f in glob.glob(os.path.join(HERE, wd, "predictions", mid, "*.jsonl")):
            subject = os.path.basename(f)[len("mmlu_pro_"):-len(".jsonl")]
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
                except Exception:
                    continue
                pred, trunc, tok, lat = extract(r.get("model_output", ""))
                # result grades by the final ANSWER letter (like evalscope/live_status):
                # a question that hit the 8K budget but still emitted the letter is graded
                # normally; "trunc" only when no letter was produced before the cut.
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
                    "question_id": qid,
                    "subject": subject,
                    "pred": pred,
                    "gold": gold.get(qid),
                    "result": res,
                    "truncated": bool(trunc),
                    "latency_s": lat,
                    "tokens": tok,
                })
    path = os.path.join(HERE, "round4_results.json")
    with open(path, "w") as fh:
        json.dump(out, fh, indent=1)
    print("wrote %s (%d records)" % (path, len(out)))


if __name__ == "__main__":
    main()
