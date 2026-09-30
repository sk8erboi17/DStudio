#!/usr/bin/env python3
"""Concurrent deterministic isolation check for q36-server batching."""

import argparse
import concurrent.futures
import json
import math
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request


CASES = (
    ("short", 0, 24, 101),
    ("medium", 256, 20, 202),
    ("long", 1024, 16, 303),
    ("tiny", 16, 24, 404),
    ("very-long", 1800, 12, 505),
    ("medium-2", 512, 20, 606),
)


def percentile(values, fraction):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)]


def payload(case, number, nonce, stream):
    name, words, max_tokens, seed = case
    filler = " ".join(("alpha beta gamma delta " * ((words + 3) // 4)).split()[:words])
    prompt = (
        f"Batch isolation {nonce} case {number} ({name}). Read the filler, "
        f"then write a numbered explanation of request isolation with at least "
        f"one hundred words. Do not quote it.\n{filler}"
    )
    return {
        "model": "qwen3.6-35b-a3b",
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": 0,
        "seed": seed + number * 1000,
        "think": False,
        "stream": stream,
    }


def parse_stream(raw):
    content = []
    reasoning = []
    finish = None
    usage = None
    for line in raw.decode("utf-8", errors="replace").splitlines():
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if not data or data == "[DONE]":
            continue
        event = json.loads(data)
        if event.get("usage"):
            usage = event["usage"]
        choices = event.get("choices") or []
        if not choices:
            continue
        choice = choices[0]
        delta = choice.get("delta") or {}
        content.append(delta.get("content") or "")
        reasoning.append(delta.get("reasoning_content") or "")
        if choice.get("finish_reason") is not None:
            finish = choice["finish_reason"]
    return {
        "content": "".join(content),
        "reasoning": "".join(reasoning),
        "finish": finish,
        "tokens": (usage or {}).get("completion_tokens"),
    }


def post(url, body, timeout, start):
    start.wait()
    req = urllib.request.Request(
        url.rstrip("/") + "/v1/chat/completions",
        data=json.dumps(body, separators=(",", ":")).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"HTTP {exc.code}: {exc.read().decode(errors='replace')}") from exc
    elapsed = time.monotonic() - t0
    if body["stream"]:
        result = parse_stream(raw)
    else:
        response = json.loads(raw)
        choice = response["choices"][0]
        message = choice.get("message") or {}
        result = {
            "content": message.get("content") or "",
            "reasoning": message.get("reasoning_content") or "",
            "finish": choice.get("finish_reason"),
            "tokens": (response.get("usage") or {}).get("completion_tokens"),
        }
    result["elapsed"] = elapsed
    return result


def comparable(result):
    return tuple(result.get(key) for key in ("content", "reasoning", "finish", "tokens"))


def continuation_cases():
    tool = {
        "type": "function",
        "function": {
            "name": "echo_value",
            "description": "Return the supplied value.",
            "parameters": {
                "type": "object",
                "properties": {"value": {"type": "string"}},
                "required": ["value"],
            },
        },
    }
    chat = {
        "model": "qwen3.6-35b-a3b",
        "messages": [
            {"role": "user", "content": "Use echo_value with alpha."},
            {"role": "assistant", "content": "", "tool_calls": [{
                "id": "call_chat_isolation",
                "type": "function",
                "function": {"name": "echo_value", "arguments": "{\"value\":\"alpha\"}"},
            }]},
            {"role": "tool", "tool_call_id": "call_chat_isolation", "content": "alpha-result"},
            {"role": "user", "content": "Reply with the result in one word."},
        ],
        "tools": [tool], "max_tokens": 4, "temperature": 0,
        "think": False, "stream": False,
    }
    responses = {
        "model": "qwen3.6-35b-a3b",
        "input": [
            {"role": "user", "content": "Use echo_value with bravo."},
            {"type": "function_call", "call_id": "call_response_isolation",
             "name": "echo_value", "arguments": "{\"value\":\"bravo\"}"},
            {"type": "function_call_output", "call_id": "call_response_isolation",
             "output": "bravo-result"},
            {"role": "user", "content": "Reply with the result in one word."},
        ],
        "tools": [tool], "max_output_tokens": 4, "temperature": 0,
        "think": False, "stream": False,
    }
    anthropic_tool = {
        "name": "echo_value", "description": "Return the supplied value.",
        "input_schema": tool["function"]["parameters"],
    }
    anthropic = {
        "model": "qwen3.6-35b-a3b",
        "messages": [
            {"role": "user", "content": "Use echo_value with charlie."},
            {"role": "assistant", "content": [{"type": "tool_use",
             "id": "toolu_anthropic_isolation", "name": "echo_value",
             "input": {"value": "charlie"}}]},
            {"role": "user", "content": [{"type": "tool_result",
             "tool_use_id": "toolu_anthropic_isolation", "content": "charlie-result"},
             {"type": "text", "text": "Reply with the result in one word."}]},
        ],
        "tools": [anthropic_tool], "max_tokens": 4, "temperature": 0,
        "thinking": {"type": "disabled"}, "stream": False,
    }
    return (("/v1/chat/completions", chat),
            ("/v1/responses", responses),
            ("/v1/messages", anthropic))


def post_continuation(url, path, body, timeout, start):
    start.wait()
    req = urllib.request.Request(
        url.rstrip("/") + path,
        data=json.dumps(body, separators=(",", ":")).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as response:
        data = json.loads(response.read())
    if path.endswith("chat/completions"):
        choice = data["choices"][0]
        return ((choice.get("message") or {}).get("content") or "",
                choice.get("finish_reason"))
    if path.endswith("responses"):
        text = "".join(part.get("text") or ""
                       for item in data.get("output") or []
                       for part in item.get("content") or [])
        return text, data.get("status")
    text = "".join(block.get("text") or "" for block in data.get("content") or [])
    return text, data.get("stop_reason")


def test_continuations(url, timeout):
    requests = []
    for path, body in continuation_cases():
        requests.extend(((path, body), (path, body)))
    start = threading.Event()
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(requests)) as executor:
        futures = [executor.submit(post_continuation, url, path, body, timeout, start)
                   for path, body in requests]
        start.set()
        results = [future.result() for future in futures]
    return all(results[i] == results[i + 1] for i in range(0, len(results), 2))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    parser.add_argument("--pairs", type=int, default=5)
    parser.add_argument("--workers", type=int, default=0)
    parser.add_argument("--timeout", type=float, default=1800)
    parser.add_argument("--stream", action="store_true")
    parser.add_argument("--nonce", default="")
    parser.add_argument("--case", choices=[case[0] for case in CASES])
    parser.add_argument("--skip-continuations", action="store_true")
    args = parser.parse_args()
    if args.pairs <= 0:
        parser.error("--pairs must be positive")

    nonce = args.nonce or f"cold-{time.time_ns()}"
    requests = []
    for i in range(args.pairs):
        case = next((case for case in CASES if case[0] == args.case), None)
        body = payload(case or CASES[i % len(CASES)], i, nonce, args.stream)
        requests.extend((body, dict(body)))

    workers = args.workers or len(requests)
    start = threading.Event()
    wall_start = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(post, args.url, body, args.timeout, start)
                   for body in requests]
        start.set()
        results = [future.result() for future in futures]
    wall = time.monotonic() - wall_start

    failures = 0
    for i in range(args.pairs):
        if comparable(results[2 * i]) != comparable(results[2 * i + 1]):
            failures += 1
            print(f"MISMATCH pair={i}", file=sys.stderr)
            print(json.dumps(results[2 * i], ensure_ascii=True)[:1000], file=sys.stderr)
            print(json.dumps(results[2 * i + 1], ensure_ascii=True)[:1000], file=sys.stderr)

    latencies = [result["elapsed"] for result in results]
    tokens = [result["tokens"] for result in results if result["tokens"] is not None]
    summary = {
        "status": "PASS" if failures == 0 else "FAIL",
        "requests": len(results),
        "workers": workers,
        "stream": args.stream,
        "wall_seconds": round(wall, 3),
        "latency_p50_seconds": round(statistics.median(latencies), 3),
        "latency_p95_seconds": round(percentile(latencies, 0.95), 3),
        "decode_tokens_per_second": round(sum(tokens) / wall, 2) if tokens else None,
    }
    if not args.stream and not args.skip_continuations:
        summary["continuation_isolation"] = test_continuations(args.url, args.timeout)
        if not summary["continuation_isolation"]:
            summary["status"] = "FAIL"
    print(json.dumps(summary, sort_keys=True))
    return 0 if summary["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
