#!/usr/bin/env python3
"""Normalize the tracked Qwen3.6/Q36 imatrix corpus."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


TOOL_BASH = {
    "type": "function",
    "function": {
        "name": "bash",
        "description": "Run a shell command in the workspace.",
        "parameters": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "The command line to execute."},
                "description": {"type": "string", "description": "Short description of intent."},
                "timeout": {"type": "integer", "description": "Timeout in seconds.", "default": 30},
            },
            "required": ["command"],
        },
    },
}

TOOL_READ = {
    "type": "function",
    "function": {
        "name": "read_file",
        "description": "Read a region of a file from the workspace.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "start": {"type": "integer", "default": 1},
                "lines": {"type": "integer", "default": 200},
            },
            "required": ["path"],
        },
    },
}

TOOL_GREP = {
    "type": "function",
    "function": {
        "name": "grep",
        "description": "Search files for a regex pattern.",
        "parameters": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string"},
                "path": {"type": "string", "default": "."},
                "glob": {"type": "string", "description": "Filename glob filter."},
                "ignore_case": {"type": "boolean", "default": False},
            },
            "required": ["pattern"],
        },
    },
}

TOOL_LIST = {
    "type": "function",
    "function": {
        "name": "list_files",
        "description": "List files matching a glob pattern, depth-limited.",
        "parameters": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string"},
                "max_depth": {"type": "integer", "default": 3},
            },
            "required": ["pattern"],
        },
    },
}

TOOL_EDIT = {
    "type": "function",
    "function": {
        "name": "edit",
        "description": "Apply a small old/new text edit to a file.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "old_string": {"type": "string"},
                "new_string": {"type": "string"},
                "line_number": {"type": "integer", "description": "Disambiguate when old_string occurs more than once."},
                "replace_all": {"type": "boolean", "default": False},
            },
            "required": ["path", "old_string", "new_string"],
        },
    },
}

TOOL_TODO = {
    "type": "function",
    "function": {
        "name": "todo",
        "description": "Maintain a todo list that survives context compaction.",
        "parameters": {
            "type": "object",
            "properties": {
                "items": {"type": "array", "items": {"type": "string"}},
                "done": {"type": "array", "items": {"type": "string"}},
            },
        },
    },
}

TOOL_THINK = {
    "type": "function",
    "function": {
        "name": "think",
        "description": "Record private reasoning. The text is not shown to the user.",
        "parameters": {
            "type": "object",
            "properties": {"note": {"type": "string"}},
            "required": ["note"],
        },
    },
}

TOOL_FETCH = {
    "type": "function",
    "function": {
        "name": "web_fetch",
        "description": "Fetch a URL and return the body as text.",
        "parameters": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "format": "uri"},
                "timeout": {"type": "integer", "default": 20},
                "headers": {
                    "type": "object",
                    "additionalProperties": {"type": "string"},
                },
            },
            "required": ["url"],
        },
    },
}

TOOLSETS = {
    "shell-only": [TOOL_BASH],
    "read-only": [TOOL_READ, TOOL_GREP, TOOL_LIST],
    "edit": [TOOL_READ, TOOL_GREP, TOOL_LIST, TOOL_EDIT],
    "edit+shell": [TOOL_BASH, TOOL_READ, TOOL_GREP, TOOL_LIST, TOOL_EDIT],
    "agent-full": [TOOL_BASH, TOOL_READ, TOOL_GREP, TOOL_LIST, TOOL_EDIT, TOOL_TODO, TOOL_THINK],
    "agent-net": [TOOL_BASH, TOOL_READ, TOOL_GREP, TOOL_LIST, TOOL_EDIT, TOOL_FETCH],
}

TOOLS_BY_NAME = {
    tool["function"]["name"]: tool
    for tools in TOOLSETS.values()
    for tool in tools
}

def sanitize_text(text: str) -> str:
    text = text.replace("<tool_result>", "<tool_response>")
    text = text.replace("</tool_result>", "</tool_response>")
    return text


def sanitize_obj(obj):
    if isinstance(obj, str):
        return sanitize_text(obj)
    if isinstance(obj, list):
        return [sanitize_obj(x) for x in obj]
    if isinstance(obj, dict):
        return {k: sanitize_obj(v) for k, v in obj.items()}
    return obj


def qwen_messages(messages: list[dict]) -> list[dict]:
    out = []
    for msg in messages:
        item = {
            k: v for k, v in msg.items()
            if k != "reasoning"
        }
        if "reasoning" in msg:
            item["reasoning_content"] = msg["reasoning"]
        out.append(sanitize_obj(item))
    return out


def called_tools(messages: list[dict]) -> list[str]:
    names = []
    seen = set()
    for msg in messages:
        for call in msg.get("tool_calls", []) or []:
            name = call.get("function", {}).get("name")
            if name and name not in seen:
                seen.add(name)
                names.append(name)
    return names


def tools_for_source(source: str) -> list[dict] | None:
    prefix = source.split(":", 1)[0]
    return TOOLSETS.get(prefix)


def tools_for_row(source: str, messages: list[dict]) -> list[dict] | None:
    tools = list(tools_for_source(source) or [])
    have = {t.get("function", {}).get("name") for t in tools}
    for name in called_tools(messages):
        if name not in have and name in TOOLS_BY_NAME:
            tools.append(TOOLS_BY_NAME[name])
            have.add(name)
    return tools or None


def load_source_prompts(path: Path) -> list[dict]:
    rows = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            obj = json.loads(line)
            messages = qwen_messages(obj["messages"])
            row = {
                "id": obj["id"],
                "category": obj["category"],
                "mode": obj["mode"],
                "source": sanitize_text(obj["source"]),
                "messages": messages,
            }
            tools = tools_for_row(row["source"], messages)
            if tools:
                row["tools"] = tools
            rows.append(row)
    return rows


def write_jsonl(path: Path, rows: list[dict]) -> None:
    with path.open("w", encoding="utf-8") as f:
        for obj in rows:
            f.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")


def counts(rows: list[dict], key: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for obj in rows:
        val = obj[key]
        out[val] = out.get(val, 0) + 1
    return dict(sorted(out.items()))


def main() -> None:
    here = Path(__file__).resolve()
    ap = argparse.ArgumentParser()
    ap.add_argument("--source-prompts", dest="source_prompts",
                    type=Path, default=here.parent / "prompts.jsonl")
    ap.add_argument("--out-dir", type=Path, default=here.parent)
    args = ap.parse_args()

    rows = load_source_prompts(args.source_prompts)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    prompts = args.out_dir / "prompts.jsonl"
    manifest = args.out_dir / "manifest.json"
    write_jsonl(prompts, rows)
    manifest.write_text(json.dumps({
        "version": 1,
        "purpose": "Qwen3.6/Q36 imatrix calibration prompts",
        "model": "Qwen3.6-35B-A3B",
        "format": "chat_messages_jsonl",
        "source_prompts": str(args.source_prompts),
        "source": str(prompts),
        "record_count": len(rows),
        "tool_record_count": sum(1 for r in rows if r.get("tools")),
        "tool_call_record_count": sum(
            1 for r in rows
            if any(m.get("tool_calls") for m in r.get("messages", []))
        ),
        "tool_schema_format": "OpenAI tools array rendered by Qwen3.6 chat_template.jinja",
        "categories": counts(rows, "category"),
        "modes": counts(rows, "mode"),
        "render_required": True,
        "llama_imatrix_input": "rendered text file generated from prompts.jsonl with the Qwen3.6 chat template",
        "files": {
            "jsonl": "prompts.jsonl",
            "all_rendered": "rendered_prompts.txt",
            "nothink_rendered": "rendered_prompts_nothink.txt",
            "think_rendered": "rendered_prompts_think.txt",
        },
    }, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {prompts}")
    print(f"wrote {manifest}")
    print(f"records: {len(rows)}")


if __name__ == "__main__":
    main()
