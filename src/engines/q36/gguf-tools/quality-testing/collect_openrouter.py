#!/usr/bin/env python3
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def load_prompts(path):
    prompts = []
    with Path(path).open("r", encoding="utf-8") as fp:
        for line in fp:
            if not line.strip():
                continue
            obj = json.loads(line)
            prompt = obj.get("prompt")
            if not prompt:
                raise SystemExit(f"bad prompt row: {line[:120]}")
            prompts.append(prompt)
    if not prompts:
        raise SystemExit(f"no prompts in {path}")
    return prompts


def request_one(args, key, prompt):
    payload = {
        "model": args.model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0,
        "logprobs": True,
        "top_logprobs": args.top_logprobs,
        "stream": False,
        "max_tokens": args.max_tokens,
    }
    if args.reasoning_effort != "omit":
        payload["reasoning"] = {"effort": args.reasoning_effort}
    if args.require_parameters or args.provider_order:
        provider = {"require_parameters": args.require_parameters}
        if args.provider_order:
            provider["order"] = [x.strip() for x in args.provider_order.split(",") if x.strip()]
            provider["allow_fallbacks"] = args.allow_provider_fallbacks
        payload["provider"] = provider

    req = urllib.request.Request(
        args.endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost/q36-quality",
            "X-Title": "q36-quality",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as fp:
        return json.loads(fp.read().decode("utf-8"))


def fetch(args, key, prompt):
    delay = 1.0
    last = None
    for attempt in range(6):
        try:
            return request_one(args, key, prompt)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            last = RuntimeError(f"HTTP {e.code}: {body}")
            if e.code < 500 and e.code != 429:
                raise last
        except Exception as e:
            last = e
        if attempt == 5:
            raise last
        time.sleep(delay)
        delay *= 1.7
    raise AssertionError("unreachable")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="qwen/qwen3.6-35b-a3b")
    ap.add_argument("--endpoint", default="https://openrouter.ai/api/v1/chat/completions")
    ap.add_argument("--api-key-env", default="OPENROUTER_API_KEY")
    ap.add_argument("--prompts", default="gguf-tools/quality-testing/prompts.jsonl")
    ap.add_argument("--out", default="gguf-tools/quality-testing/data/qwen36-openrouter")
    ap.add_argument("--count", type=int, default=100)
    ap.add_argument("--max-tokens", type=int, default=24)
    ap.add_argument("--top-logprobs", type=int, default=20)
    ap.add_argument("--reasoning-effort",
                    choices=("xhigh", "high", "medium", "low", "minimal", "none", "omit"),
                    default="none")
    ap.add_argument("--provider-order", default="parasail/fp8")
    ap.add_argument("--allow-provider-fallbacks", action="store_true")
    ap.add_argument("--require-parameters", action="store_true")
    args = ap.parse_args()

    key = os.environ.get(args.api_key_env)
    if not key:
        raise SystemExit(f"{args.api_key_env} is not set")
    if args.top_logprobs < 0 or args.top_logprobs > 20:
        raise SystemExit("--top-logprobs must be between 0 and 20")

    prompts = load_prompts(args.prompts)
    out = Path(args.out)
    (out / "prompts").mkdir(parents=True, exist_ok=True)
    (out / "continuations").mkdir(parents=True, exist_ok=True)
    (out / "responses").mkdir(parents=True, exist_ok=True)

    total = min(args.count, len(prompts))
    rows = []
    print(f"model={args.model} endpoint={args.endpoint}", file=sys.stderr)
    for i, prompt in enumerate(prompts[:total]):
        case_id = f"case_{i:03d}"
        print(f"openrouter {i + 1}/{total}: {case_id}", file=sys.stderr, flush=True)
        response = fetch(args, key, prompt)
        choice = response["choices"][0]
        content = choice.get("message", {}).get("content", "")
        logprob_items = (choice.get("logprobs") or {}).get("content", []) or []
        if args.top_logprobs > 0 and not logprob_items:
            raise RuntimeError(f"{case_id}: response did not include logprobs")

        prompt_path = out / "prompts" / f"{case_id}.txt"
        cont_path = out / "continuations" / f"{case_id}.txt"
        resp_path = out / "responses" / f"{case_id}.json"
        prompt_path.write_text(prompt, encoding="utf-8")
        cont_path.write_text(content, encoding="utf-8")
        resp_path.write_text(json.dumps(response, ensure_ascii=False, indent=2), encoding="utf-8")
        rows.append((case_id, prompt_path, cont_path, resp_path))
        time.sleep(0.05)

    manifest = out / "manifest.tsv"
    with manifest.open("w", encoding="utf-8") as fp:
        fp.write("# id\tprompt_file\tcontinuation_file\tresponse_file\n")
        for row in rows:
            fp.write("\t".join([row[0], str(row[1]), str(row[2]), str(row[3])]) + "\n")
    print(f"wrote {manifest}", file=sys.stderr)


if __name__ == "__main__":
    main()
