#!/Users/agrilv/venv312/bin/python
"""Export per-question detail files:
./gpqa-diamond/<run>/xx-<domain>-<qid>.json with question, prompt, reasoning,
final answer, gold, result, tokens, latency, stop_reason, truncated flag.
One file per (run, question); re-run any time, overwrites in place."""
import ast, glob, json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gpqa_adapter_local import gold_map

HERE = os.path.dirname(os.path.abspath(__file__))
OUTROOT = os.path.join(os.path.dirname(HERE), "gpqa-diamond")
RUNS = [
    ("gpqa-def8", "q35-default8-gpqa", {}),
    ("gpqa-gate39", "q35-exp20-thr08-gate27-39-gpqa",
     {"q35_experts": 20, "q35_expert_threshold": 0.8,
      "env_DS4_METAL_QWEN35_SOURCE": "metal/qwen35_lay_last.metal"}),
]
# generation params are identical across runs (paired benchmark, temp 0);
# seed from evalscope task_config.yaml, rest from the run scripts
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


def parse_row(r):
    raw = str(r.get("model_output", ""))
    try:
        d = ast.literal_eval(raw)
    except Exception:
        d = None
    reasoning = answer_text = ""
    stop = None
    tok = lat = 0
    if d:
        try:
            for part in d["choices"][0]["message"]["content"]:
                if part.get("type") == "reasoning":
                    reasoning = part.get("reasoning") or ""
                elif part.get("type") == "text":
                    answer_text = part.get("text") or ""
        except Exception:
            pass
        stop = d.get("stop_reason")
        u = d.get("usage") or {}
        tok = int(u.get("output_tokens") or 0)
        p = d.get("perf_metrics") or {}
        lat = float(p.get("latency") or 0.0)
    if stop is None:
        sr = re.search(r"'stop_reason': '(\w+)'", raw)
        stop = sr.group(1) if sr else None
    if not tok:
        m = re.search(r"'output_tokens': (\d+)", raw)
        tok = int(m.group(1)) if m else 0
    if not lat:
        m = re.search(r"'latency': ([0-9.]+)", raw)
        lat = float(m.group(1)) if m else 0.0
    L = re.findall(r"ANSWER:\s*\(?([A-D])\b", raw, re.I)
    pred = L[-1].upper() if L else None
    trunc = bool(stop in ("max_tokens", "length"))
    return reasoning, answer_text, stop, tok, lat, pred, trunc


def main():
    gold = gold_map()
    # dataset rows for question/choices text
    data = {}
    for line in open(os.path.join(HERE, "gpqa_data", "gpqa_diamond_mc.jsonl")):
        row = json.loads(line)
        data[row["id"]] = row
    n = 0
    for wd, mid, extra in RUNS:
        outdir = os.path.join(OUTROOT, mid)
        os.makedirs(outdir, exist_ok=True)
        for f in glob.glob(os.path.join(HERE, wd, "predictions", mid, "*.jsonl")):
            dom = os.path.basename(f)[len("gpqa_mc_"):-len(".jsonl")]
            for line in open(f, errors="replace"):
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                md = r.get("metadata") or {}
                try:
                    qid = int(md["question_id"])
                except Exception:
                    continue
                reasoning, answer_text, stop, tok, lat, pred, trunc = parse_row(r)
                if pred is None:
                    res = "trunc" if trunc else "wrong"
                elif pred == gold.get(qid):
                    res = "correct"
                else:
                    res = "wrong"
                row = data.get(qid, {})
                msgs = r.get("messages")
                if isinstance(msgs, str):
                    try:
                        msgs = ast.literal_eval(msgs)
                    except Exception:
                        msgs = []
                prompt = msgs[0]["content"] if msgs and isinstance(msgs[0], dict) else ""
                detail = {
                    "run": mid,
                    "model": "Qwen 3.6 35B A3B->A4B+ (expert expansion)"
                    if "gate" in mid else "Qwen 3.6 35B A3B (reference implementation)",
                    "generation_config": {**GEN_PARAMS, **extra},
                    "question_id": qid,
                    "domain": dom,
                    "question": row.get("question", ""),
                    "choices": {k: row.get(k, "") for k in "ABCD"},
                    "prompt": prompt,
                    "reasoning": reasoning,
                    "answer_text": answer_text,
                    "pred": pred,
                    "gold": gold.get(qid),
                    "result": res,
                    "truncated": trunc,
                    "stop_reason": stop,
                    "tokens": tok,
                    "latency_s": lat,
                }
                slug = "xx" if res == "correct" else ("ww" if res == "wrong" else "tt")
                path = os.path.join(outdir, f"{slug}-{dom}-{qid}.json")
                with open(path, "w") as fh:
                    json.dump(detail, fh, indent=1, ensure_ascii=False)
                n += 1
    print("wrote %d detail files under %s" % (n, OUTROOT))


if __name__ == "__main__":
    main()
