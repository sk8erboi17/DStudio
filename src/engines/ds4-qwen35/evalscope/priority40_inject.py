#!/Users/agrilv/venv312/bin/python
"""Pass prioritario: genera le 40 domande sbagliate da default8 col server
gate39 attivo e inietta i record nel cache evalscope (runG-gate39-pro),
replicando ESATTAMENTE lo schema delle righe gia presenti. Il resume di
evalscope le saltera."""
import glob, json, os, re, time, uuid

os.environ["HF_HUB_OFFLINE"] = "1"
from datasets import load_dataset
from openai import OpenAI

BASE = "/Users/agrilv/AI/antirez/ds4/evalscope/runG-gate39-pro"
MID = "q35-exp20-thr08-gate27-39"
client = OpenAI(base_url="http://127.0.0.1:8000/v1", api_key="EMPTY")

ds = load_dataset("TIGER-Lab/MMLU-Pro", split="test")
gold = {r["question_id"]: r["answer"] for r in ds}

# prompt esatto: lo prendo da una riga di cache esistente (stesso few_shot=0)
sample = json.loads(open(glob.glob(
    f"{BASE}/predictions/{MID}/mmlu_pro_math.jsonl")[0]).readline())
REF_USER = None
for m in sample["messages"]:
    if m["role"] == "user" and isinstance(m["content"], str):
        REF_USER = m["content"]
        break
assert REF_USER and REF_USER.startswith("Answer the following"), REF_USER[:100]
# mappa qid -> messages gia usate dal benchmark (per le domande gia fatte)
prompt_by_qid = {}
for f in glob.glob(f"{BASE}/predictions/{MID}/*.jsonl"):
    for line in open(f, errors="replace"):
        try:
            r = json.loads(line)
            prompt_by_qid[r["metadata"]["question_id"]] = r["messages"]
        except Exception:
            pass

rows_by_qid = {r["question_id"]: r for r in ds}
wrong = json.load(open("/tmp/def8_wrong.json"))

cache_done = set(prompt_by_qid.keys())
todo = [(s, q, i, p) for s, q, i, p in wrong if q not in cache_done]
print(f"=== da generare: {len(todo)} (gia in cache: {len(wrong)-len(todo)}) ===", flush=True)

def build_messages(row):
    q = row["question"].strip()
    lines = [q]
    for i, opt in enumerate(row["options"]):
        if opt and opt.strip():
            lines.append(f"{chr(65+i)}) {opt.strip()}")
    body = ("Question:\n" + "\n".join(lines) + "\n").replace(
        "\nA) ", "\nOptions:\nA) ", 1)
    # Replica la parte variabile del prompt di evalscope: istruzione + domanda.
    # REF_USER termina con l'istruzione + '\n\n' seguito dalla domanda di
    # riferimento; ricostruisco con lo stesso template.
    tail = REF_USER[REF_USER.index("\n\n") + 2:]  # domanda di riferimento
    ref_body_end = tail  # debug helper
    instruction = REF_USER[:REF_USER.index("\n\n") + 2]
    content = instruction + body
    return [{"id": uuid.uuid4().hex[:8], "content": content, "source": None,
             "metadata": None, "internal": None, "perf_metrics": None,
             "role": "user", "tool_call_id": None}]

for s, qid, idx, pred8 in todo:
    fn = f"mmlu_pro_{s}.jsonl"
    row = rows_by_qid[qid]
    messages = build_messages(row)
    t0 = time.time()
    try:
        resp = client.chat.completions.create(
            model="deepseek-v4-flash",
            messages=[{"role": "user", "content": messages[0]["content"]}],
            max_tokens=30000, temperature=0, timeout=7200)
    except Exception as e:
        print(f"{s} idx={idx} qid={qid}: ERROR {e}", flush=True)
        continue
    content_text = resp.choices[0].message.content or ""
    reasoning = getattr(resp.choices[0].message, "reasoning_content", None) or ""
    L = re.findall(r"ANSWER:\s*\(?([A-J])\b", content_text, re.I)
    newpred = L[-1].upper() if L else None
    ok = newpred == gold.get(qid)
    was = pred8 != gold.get(qid)
    flip = "FIX!" if (ok and was) else ("still-X" if not ok else "ok-both?")
    print(f"{s:16s} idx={idx:2d} qid={qid}: def8={pred8} gate39={newpred} "
          f"gold={gold.get(qid)} {flip} tok={resp.usage.completion_tokens} "
          f"{time.time()-t0:.0f}s", flush=True)

    msg_content = []
    if reasoning:
        msg_content.append({"internal": None, "type": "reasoning",
                            "reasoning": reasoning, "signature": None,
                            "redacted": False, "reasoning_tokens": None})
    msg_content.append({"internal": None, "type": "text",
                        "text": content_text, "refusal": None})
    latency = float(time.time() - t0)
    in_tok = resp.usage.prompt_tokens
    out_tok = resp.usage.completion_tokens
    pm = {"latency": latency, "ttft": None, "input_tokens": in_tok,
          "output_tokens": out_tok, "tpot": None}
    rec = {
        "index": idx,
        "model": "deepseek-v4-flash",
        "model_output": {
            "id": resp.id,
            "model": "deepseek-v4-flash",
            "choices": [{
                "message": {
                    "id": uuid.uuid4().hex[:8],
                    "content": msg_content,
                    "source": "generate",
                    "metadata": None,
                    "internal": None,
                    "perf_metrics": pm,
                    "role": "assistant",
                    "tool_calls": None,
                    "model": "deepseek-v4-flash",
                },
                "stop_reason": resp.choices[0].finish_reason if
                    resp.choices[0].finish_reason in ("stop", "length") else "stop",
                "logprobs": None,
            }],
            "usage": {
                "input_tokens": in_tok, "output_tokens": out_tok,
                "total_tokens": resp.usage.total_tokens,
                "input_tokens_cache_write": None,
                "input_tokens_cache_read": 0,
                "reasoning_tokens": None,
            },
            "time": latency,
            "metadata": None,
            "error": None,
            "perf_metrics": pm,
        },
        "messages": messages,
        "agent_trace": None,
        "metadata": {"cot_content": "", "subject": s, "question_id": qid},
    }
    with open(f"{BASE}/predictions/{MID}/{fn}", "a") as f:
        f.write(json.dumps(rec) + "\n")

print("=== priority pass done ===", flush=True)
