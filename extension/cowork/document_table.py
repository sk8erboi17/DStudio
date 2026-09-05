"""General-purpose source-backed tables. The model proposes; local code checks.

No model, network, embeddings or domain-specific fields here. A matching quote
is evidence of occurrence, NOT proof that the model chose the right field.
The JSON table is authoritative; HTML/XLSX are revision-labelled exports.
"""
from __future__ import annotations

import copy
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import tempfile
import zipfile
from contextlib import contextmanager
from collections import Counter
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path

FORMAT = "dstudio.document-table.v1"
MAX_ROWS, MAX_COLUMNS, MAX_SOURCES = 200, 32, 64
MAX_TEXT, MAX_STATE = 2_000_000, 8_000_000
NOTICE = ("Source match checks literal evidence, not semantic correctness. Missing means "
          "not extracted, not proven absent. Checks apply only to the supplied rows. "
          "No automatic OCR, inference, unit conversion or completeness guarantee.")
LABELS = {"sourced": "Source matched", "missing": "Not extracted", "needs_review": "Review needed",
          "conflict": "Conflicting candidates", "stale_source": "Source changed", "unavailable": "Source unavailable"}


def stamp():
    return datetime.now(timezone.utc).isoformat()


def encode(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def norm(value):
    return " ".join(value.split())


def require(ok, message, office):
    if not ok:
        raise office.ToolError(message)


def string(value, name, office, limit=1000, empty=False):
    require(isinstance(value, str) and (empty or bool(value.strip())) and len(value) <= limit,
            f"{name} must be a {'possibly empty ' if empty else ''}string, at most {limit} characters", office)
    return value


def identifier(value, office):
    require(isinstance(value, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,63}", value),
            "IDs must start with a letter and contain only letters, digits, _ or - (max 64)", office)
    return value


def tool(name, office):
    found = shutil.which(name)
    if not found:
        found = next((str(p) for p in (Path("/opt/homebrew/bin") / name, Path("/usr/local/bin") / name) if p.is_file()), None)
    require(found, f"PDF source reading needs Poppler ({name}); no OCR fallback was performed", office)
    return found


def source(ws, relative, office):
    """Hash and extract the SAME captured bytes, not two racing reads of a file."""
    path = ws.resolve(relative)
    with path.open("rb") as handle:
        before = os.fstat(handle.fileno())
        data = handle.read(office.MAX_INPUT_BYTES + 1)
        after = os.fstat(handle.fileno())
    require((before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
            (after.st_size, after.st_mtime_ns, after.st_ctime_ns), "source changed while being captured; retry read_source", office)
    require(len(data) <= office.MAX_INPUT_BYTES, "source exceeds 64 MiB", office)
    digest = hashlib.sha256(data).hexdigest()
    suffix = path.suffix.lower()
    with tempfile.TemporaryDirectory(prefix="dstudio-table-source-") as tmp:
        captured = Path(tmp) / ("source" + suffix)
        captured.write_bytes(data)
        if suffix == ".pdf":
            try:
                info = subprocess.run([tool("pdfinfo", office), str(captured)], capture_output=True, timeout=20, check=True)
                match = re.search(rb"(?m)^Pages:\s+(\d+)", info.stdout)
                require(match and 0 < int(match[1]) <= 400, "PDF must have 1..400 pages; split larger inputs", office)
                count = int(match[1])
                output = Path(tmp) / "pages.txt"
                subprocess.run([tool("pdftotext", office), "-layout", "-enc", "UTF-8", str(captured), str(output)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=30, check=True)
                require(output.stat().st_size <= MAX_TEXT, "PDF extracted text exceeds 2 MB; split the source", office)
                pages = output.read_text(encoding="utf-8").split("\f")
                if pages and not pages[-1].strip():
                    pages.pop()
                require(len(pages) == count, "PDF page count mismatch; evidence cannot be anchored", office)
                segments = [{"id": f"page:{i}", "page": i, "text": text} for i, text in enumerate(pages, 1)]
            except (subprocess.SubprocessError, UnicodeError) as exc:
                raise office.ToolError(f"PDF text extraction failed ({type(exc).__name__}); no evidence verified") from exc
        elif suffix == ".xlsx":
            segments = []
            with office.open_office_zip(captured) as zf:
                sheets, _, shared = office.workbook_parts(zf)
                for name, target in sheets:
                    # Respect the same bounded sheet reads as the Office helper.
                    root = office.ET.fromstring(zf.read(target))
                    dim = root.find(f"{{{office.NS_MAIN}}}dimension")
                    require(dim is not None and dim.get("ref"), "sheet dimensions missing; export to text first", office)
                    bounds = office.parse_range(dim.get("ref"))
                    matrix = office.xlsx_matrix(zf, target, shared, bounds)
                    for index, row in enumerate(matrix, bounds[0]):
                        segments.append({"id": f"sheet:{name}:row:{index}", "text": office.tsv([row])})
        else:
            text = office.read_document_text(captured)
            # Line anchors refer to extractor output, not DOCX physical pages.
            segments = [{"id": f"line:{i}", "text": text} for i, text in enumerate(text.splitlines(), 1)]
    require(sum(len(s["text"]) for s in segments) <= MAX_TEXT and len(segments) <= 20_000,
            "source extraction too large; split the source", office)
    return {"path": str(path.relative_to(ws.root)), "sha256": digest, "segments": segments,
            "emptySegments": [s["id"] for s in segments if not s["text"].strip()],
            "extraction": "pdf-text-layer" if suffix == ".pdf" else "document-text"}


def columns(spec, office):
    require(isinstance(spec, list) and 0 < len(spec) <= MAX_COLUMNS, "columns_json needs 1..32 columns", office)
    out, ids = [], set()
    for col in spec:
        require(isinstance(col, dict), "each column must be an object", office)
        key = identifier(col.get("id"), office)
        require(key not in ids, "duplicate column ID", office)
        ids.add(key)
        kind = col.get("type", "text")
        require(kind in {"text", "number", "date", "enum"}, "column type: text, number, date or enum", office)
        unit = col.get("unit", "")
        string(unit, "unit", office, 40, empty=True)
        require(not unit or kind == "number", "unit is supported only on number columns", office)
        decimal = col.get("decimal", ".")
        require(decimal in {".", ","}, "decimal must be . or ,; grouping separators are not accepted", office)
        values = col.get("values", [])
        require(isinstance(values, list) and len(values) <= 100, "values must be an array of at most 100 strings", office)
        for value in values:
            string(value, "enum value", office, 200)
        if kind == "enum":
            require(values, "enum requires values", office)
        out.append({"id": key, "label": string(col.get("label", key), "column label", office, 160),
                    "type": kind, "unit": unit, "decimal": decimal, "values": values,
                    "required": col.get("required") is True})
    return out


def number(value, col):
    sep = re.escape(col.get("decimal", "."))
    if not re.fullmatch(rf"[+-]?(?:0|[1-9]\d*)(?:{sep}\d+)?", value):
        raise ValueError("Use an ungrouped number with the declared decimal separator")
    return Decimal(value.replace(col.get("decimal", "."), "."))


def candidate(raw, office):
    require(isinstance(raw, dict), "a candidate must be an object", office)
    value = string(raw.get("value"), "value", office, 2000)
    refs = raw.get("evidence", [])
    require(isinstance(refs, list) and 0 < len(refs) <= 8, "each candidate needs 1..8 evidence references", office)
    evidence = []
    for ref in refs:
        require(isinstance(ref, dict), "evidence reference must be an object", office)
        digest = ref.get("sha256")
        require(isinstance(digest, str) and re.fullmatch(r"[a-f0-9]{64}", digest), "use sha256 returned by read_source", office)
        evidence.append({"path": string(ref.get("path"), "source path", office), "sha256": digest,
                         "segment": string(ref.get("segment"), "segment ID", office, 500),
                         "quote": string(ref.get("quote"), "quote", office, 4000)})
    return {"value": value, "evidence": evidence}


def cell(raw, office):
    require(isinstance(raw, dict), "each cell must be an object", office)
    note = string(raw.get("note", ""), "note", office, 1000, empty=True)
    if raw.get("missing") is True:
        require(not raw.get("candidates") and not raw.get("value"), "missing cells cannot contain a value", office)
        return {"candidates": [], "note": note}
    values = raw.get("candidates")
    if values is None:
        values = [raw]
    require(isinstance(values, list) and 0 < len(values) <= 8, "cell needs 1..8 candidates, or missing=true", office)
    return {"candidates": [candidate(value, office) for value in values], "note": note}


def rows(spec, cols, office):
    require(isinstance(spec, list) and len(spec) <= MAX_ROWS, "rows_json must have at most 200 rows", office)
    result, ids = [], set()
    keys = {c["id"] for c in cols}
    for row in spec:
        require(isinstance(row, dict), "row must be an object", office)
        key = identifier(row.get("id"), office)
        require(key not in ids, "duplicate row ID", office)
        ids.add(key)
        cells = row.get("cells", {})
        require(isinstance(cells, dict) and set(cells) <= keys, "unknown column in row", office)
        result.append({"id": key, "label": string(row.get("label", key), "row label", office, 200),
                       "cells": {k: cell(v, office) for k, v in cells.items()}})
    return result


def validate(table, ws, office):
    result = copy.deepcopy(table)
    cache = {}
    counts = Counter()
    for row in result["rows"]:
        for col in result["columns"]:
            value = row["cells"].setdefault(col["id"], {"candidates": [], "note": ""})
            candidates = value["candidates"]
            value.update(status="missing", value=None, issues=[])
            if not candidates:
                if col["required"]:
                    value["issues"].append("Required field was not extracted")
                counts["missing"] += 1
                continue
            statuses = []
            for item in candidates:
                issues, state = [], "sourced"
                typed = item["value"]
                try:
                    if col["type"] == "number":
                        typed = str(number(typed, col))
                    elif col["type"] == "date":
                        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", typed):
                            raise ValueError("Date must be literal YYYY-MM-DD; ambiguous dates need review")
                        date.fromisoformat(typed)
                    elif col["type"] == "enum" and typed not in col["values"]:
                        raise ValueError("Value is outside the declared choices")
                except (ValueError, InvalidOperation) as exc:
                    issues.append(str(exc))
                for ref in item["evidence"]:
                    path = ref["path"]
                    if path not in cache:
                        require(len(cache) < MAX_SOURCES, "table exceeds 64 unique sources", office)
                        try:
                            cache[path] = source(ws, path, office)
                        except (office.ToolError, OSError, UnicodeError, office.ET.ParseError, zipfile.BadZipFile) as exc:
                            cache[path] = {"error": str(exc)}
                    doc = cache[path]
                    ref["match"] = False
                    if "error" in doc:
                        state = "unavailable"
                        issues.append(doc["error"])
                    elif doc["sha256"] != ref["sha256"]:
                        state = "stale_source" if state != "unavailable" else state
                        issues.append("Source bytes changed since read_source; re-read and re-extract")
                    else:
                        segment = next((s for s in doc["segments"] if s["id"] == ref["segment"]), None)
                        quote = norm(ref["quote"])
                        ref["match"] = bool(segment and quote and re.search(
                            r"(?<![\w.,+\-])" + re.escape(quote) + r"(?![\w.,])", norm(segment["text"])))
                        if not ref["match"]:
                            issues.append("Quote does not occur in the specified source segment")
                        literal = norm(item["value"])
                        # Number/token boundaries prevent 12 matching 312 or 12.5.
                        if col["type"] == "number":
                            found = re.search(r"(?<![\w.,+\-])" + re.escape(literal) + r"(?![\w.,])", quote)
                        else:
                            found = re.search(r"(?<!\w)" + re.escape(literal) + r"(?!\w)", quote)
                        if not found:
                            issues.append("Value is not a literal in the quoted evidence; inferred/normalized values need review")
                        if col["unit"] and not re.search(r"(?<!\w)" + re.escape(col["unit"]) + r"(?!\w)", quote):
                            issues.append("Declared unit does not occur in the quote; no conversion assumed")
                if issues and state == "sourced":
                    state = "needs_review"
                item.update(status=state, issues=list(dict.fromkeys(issues)), normalized=typed)
                statuses.append(state)
            # Never pick silently between competing values, including unsupported ones.
            distinct = {x["value"] for x in candidates}
            state = "conflict" if len(distinct) > 1 else "sourced"
            for priority in ("needs_review", "stale_source", "unavailable"):
                if priority in statuses:
                    state = priority if len(distinct) == 1 else "conflict"
            value.update(status=state, value=candidates[0]["value"] if len(distinct) == 1 else None,
                         issues=list(dict.fromkeys(i for x in candidates for i in x["issues"])))
            counts[state] += 1
    result["checkedAt"] = stamp()
    result["notice"] = NOTICE
    result["summary"] = dict(counts)
    result["checks"] = check_results(result, office)
    return result


def check_results(table, office):
    out = []
    cols = {c["id"]: c for c in table["columns"]}
    specs = table.get("checks_spec", [])
    require(isinstance(specs, list) and len(specs) <= 64, "at most 64 checks", office)
    for spec in specs:
        require(isinstance(spec, dict), "check must be an object", office)
        kind = spec.get("kind")
        require(kind in {"unique", "sum"}, "check kind is unique or sum", office)
        key = spec.get("column")
        require(isinstance(key, str) and key in cols, "check references unknown column", office)
        items = [row["cells"][key] for row in table["rows"]]
        record = {"kind": kind, "column": key, "status": "not_checked", "scope": "supplied rows only"}
        if any(v["status"] != "sourced" for v in items) or not items:
            record["detail"] = "All compared cells must have matching literal sources"
        elif kind == "unique":
            duplicates = [value for value, n in Counter(v["value"] for v in items).items() if n > 1]
            record.update(status="failed" if duplicates else "passed", duplicates=duplicates)
        else:
            require(cols[key]["type"] == "number", "sum requires a number column", office)
            expected = string(spec.get("expected"), "expected sum", office, 100)
            try:
                target = number(expected, cols[key])
                with localcontext() as context:
                    context.prec = 5000  # bounded values <=2000 chars, <=200 rows
                    total = sum((number(v["value"], cols[key]) for v in items), Decimal(0))
            except (ValueError, InvalidOperation) as exc:
                raise office.ToolError(str(exc)) from exc
            record.update(status="passed" if total == target else "failed", actual=str(total), expected=expected,
                          unit=cols[key]["unit"], detail="Compared with caller-supplied expected value; not evidence of extraction correctness")
        out.append(record)
    return out


def compact(table, offset=0, limit=20):
    # Avoid returning a huge evidence corpus to the model. Inspect is paginated.
    result = {k: table[k] for k in ("format", "title", "revision", "columns", "checkedAt", "notice", "summary", "checks")}
    selected = []
    size = len(encode(result).encode("utf-8"))
    for row in table["rows"][offset:offset + limit]:
        count = len(encode(row).encode("utf-8"))
        if selected and size + count > 180_000:
            break
        selected.append(row)
        size += count
    result.update(rows=selected, totalRows=len(table["rows"]), offset=offset,
                  nextOffset=offset + len(selected) if offset + len(selected) < len(table["rows"]) else None)
    return result


def evidence_text(value):
    lines = []
    for item in value["candidates"]:
        lines.append(f"Candidate: {item['value']} — {LABELS[item['status']]}")
        for ref in item["evidence"]:
            lines.append(f"{ref['path']} · {ref['segment']} · SHA256 {ref['sha256']}\n{ref['quote']}")
        lines.extend(item["issues"])
    if value.get("note"):
        lines.append(value["note"])
    return "\n".join(lines)


def export_html(table):
    esc = html.escape
    headers = "".join(f"<th scope=col>{esc(c['label'])}{' (' + esc(c['unit']) + ')' if c['unit'] else ''}</th>" for c in table["columns"])
    body = []
    for row in table["rows"]:
        cells = []
        for col in table["columns"]:
            item = row["cells"][col["id"]]
            label = LABELS[item["status"]]
            value = item["value"] if item["value"] is not None else "—"
            cells.append(f'<td><details><summary>{esc(value)}<small>{esc(label)}</small></summary><pre>{esc(evidence_text(item) or label)}</pre></details></td>')
        body.append(f"<tr><th scope=row>{esc(row['label'])}</th>{''.join(cells)}</tr>")
    checks = "".join(f"<li>{esc(encode(c))}</li>" for c in table["checks"])
    return f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{esc(table['title'])}</title><style>body{{font:15px system-ui;margin:32px;color:#192b38;background:#faf9f6}}main{{max-width:1400px;margin:auto}}.scroll{{overflow:auto}}table{{border-collapse:collapse;width:100%;background:white}}th,td{{border:1px solid #ced6da;padding:12px;vertical-align:top;text-align:left;min-width:130px}}th{{background:#edf2f3}}summary{{cursor:pointer}}small{{display:block;color:#536676;margin-top:6px}}pre{{white-space:pre-wrap;overflow-wrap:anywhere;max-width:480px;font:13px system-ui}}p{{line-height:1.5}}li{{overflow-wrap:anywhere}}</style>
<main><h1>{esc(table['title'])}</h1><p>Revision {table['revision']} · Checked {esc(table['checkedAt'])}. Click a cell to inspect its evidence.</p><p>{esc(NOTICE)}</p><div class=scroll><table><thead><tr><th scope=col>Document / item</th>{headers}</tr></thead><tbody>{''.join(body)}</tbody></table></div><h2>Checks</h2><ul>{checks or '<li>No checks requested.</li>'}</ul></main></html>'''


def export_xlsx(table, path, office):
    data = [["Document / item"] + [c["label"] + (f" ({c['unit']})" if c["unit"] else "") for c in table["columns"]]]
    statuses = [["Row", "Column", "Status", "Note"]]
    refs = [["Row", "Column", "Candidate", "Status", "Source", "Segment", "Quote", "SHA256", "Quote matched", "Issues"]]
    for row in table["rows"]:
        data.append([row["label"]] + [row["cells"][c["id"]]["value"] for c in table["columns"]])
        for col in table["columns"]:
            item = row["cells"][col["id"]]
            statuses.append([row["id"], col["label"], LABELS[item["status"]], item.get("note", "")])
            for cand in item["candidates"]:
                for ref in cand["evidence"]:
                    refs.append([row["id"], col["label"], cand["value"], LABELS[cand["status"]], ref["path"],
                                 ref["segment"], ref["quote"], ref["sha256"], ref["match"], "; ".join(cand["issues"])])
    meta = [["Property", "Value"], ["Title", table["title"]], ["Revision", table["revision"]],
            ["Checked at", table["checkedAt"]], ["Meaning", NOTICE]]
    checks = [["Check", "Result"]] + [[c["column"], encode(c)] for c in table["checks"]]
    require(sum(len(row) for sheet in [data, statuses, refs, checks, meta] for row in sheet) <= office.MAX_WRITE_CELLS,
            "Excel export exceeds 100,000 cells including evidence; split the table or export HTML", office)
    # Literal text, including = prefixes and leading zeroes, must round-trip.
    office.create_xlsx(path, [("Data", data), ("Status", statuses), ("Evidence", refs), ("Checks", checks), ("About", meta)], header=True, literal=True)


def load(path, office):
    require(path.stat().st_size <= MAX_STATE, "table exceeds 8 MB", office)
    table = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(table, dict) and table.get("format") == FORMAT, "not a DStudio document table", office)
    require(type(table.get("revision")) is int and table["revision"] > 0, "invalid table revision", office)
    cols = columns(table.get("columns"), office)
    # Strip caller-edited derived statuses; always recompute them from sources.
    clean_rows = []
    require(isinstance(table.get("rows"), list) and len(table["rows"]) <= MAX_ROWS, "invalid table rows", office)
    for row in table["rows"]:
        require(isinstance(row, dict) and isinstance(row.get("cells"), dict), "invalid stored row", office)
        clean = copy.deepcopy(row)
        for item in clean.get("cells", {}).values():
            require(isinstance(item, dict), "invalid stored cell", office)
            if not item.get("candidates"):
                item["missing"] = True
        clean_rows.append(clean)
    return {"format": FORMAT, "title": string(table.get("title"), "title", office, 200),
            "revision": table["revision"], "columns": cols, "rows": rows(clean_rows, cols, office),
            "checks_spec": table.get("checks_spec", [])}


@contextmanager
def table_lock(path):
    # Advisory cross-process lock survives atomic table replacement, but not a
    # process exit. Never unlink it: that would let waiters lock different inodes.
    lock = path.with_name("." + path.name + ".lock")
    if lock.is_symlink():
        raise OSError("table lock must not be a symlink")
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "r+b") as handle:
        if os.name == "nt":
            import msvcrt
            if not lock.stat().st_size:
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            if os.name == "nt":
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def publish_new(path, data, office):
    with tempfile.TemporaryDirectory(prefix=".dstudio-table-export-", dir=path.parent) as tmp:
        staged = Path(tmp) / path.name
        office.atomic_bytes(staged, data)
        os.link(staged, path)  # atomic no-clobber, including concurrent exports


def run(ws, args, office):
    action = office.arg(args, "action")
    require(action in {"read_source", "create", "update", "inspect", "export"}, "unknown document_table action", office)
    if action == "read_source":
        return run_locked(ws, args, office)
    path = ws.resolve(office.arg(args, "path"), write=True)
    require(path.name.endswith(".table.json"), "table path must end in .table.json", office)
    with table_lock(path):
        return run_locked(ws, args, office)


def run_locked(ws, args, office):
    action = office.arg(args, "action")
    offset = office.arg(args, "offset", "0")
    require(offset.isdigit(), "offset must be a non-negative integer", office)
    offset = int(offset)
    relative = office.arg(args, "path")
    if action == "read_source":
        doc = source(ws, relative, office)
        wanted = office.arg(args, "segment")
        segments = [s for s in doc["segments"] if s["id"] == wanted] if wanted else doc["segments"]
        require(not wanted or segments, "unknown segment ID", office)
        # Read one physical page / line chunk at a time, with explicit continuation.
        selected, size = [], 0
        for segment in segments[offset:offset + 40]:
            if size + len(segment["text"]) > 40_000:
                require(selected, "segment exceeds 40,000 characters; split this source", office)
                break
            selected.append(segment)
            size += len(segment["text"])
        return encode({**{k: v for k, v in doc.items() if k != "segments"}, "segments": selected,
                       "totalSegments": len(segments), "offset": offset,
                       "nextOffset": offset + len(selected) if offset + len(selected) < len(segments) else None,
                       "notice": "Use these exact path, sha256, segment IDs and verbatim quotes. Empty pages are not OCR-read."})
    require(action in {"create", "update", "inspect", "export"}, "action: read_source, create, update, inspect or export", office)
    path = ws.resolve(relative, write=action == "create")
    require(path.name.endswith(".table.json"), "table path must end in .table.json", office)
    if action == "create":
        require(not path.exists(), "table already exists; use update with its revision", office)
        cols = columns(office.json_arg(args, "columns_json"), office)
        table = {"format": FORMAT, "revision": 1, "title": office.arg(args, "title", path.stem),
                 "columns": cols, "rows": rows(office.json_arg(args, "rows_json", []), cols, office),
                 "checks_spec": office.json_arg(args, "checks_json", [])}
        string(table["title"], "title", office, 200)
    else:
        table = load(path, office)
    if action == "update":
        require(office.arg(args, "revision") == str(table["revision"]), "table revision changed; inspect before updating", office)
        require(not office.arg(args, "columns_json"), "column schema is fixed; create a new table to change it", office)
        if "checks_json" in args:
            table["checks_spec"] = office.json_arg(args, "checks_json")
        if "title" in args:
            table["title"] = string(office.arg(args, "title"), "title", office, 200)
        incoming = rows(office.json_arg(args, "rows_json"), table["columns"], office)
        by_id = {row["id"]: row for row in table["rows"]}
        # Add-only merge for existing rows: an automatic rerun never overwrites
        # corrections. Explicit replacement requires listing row:column keys.
        replace = office.json_arg(args, "replace_json", [])
        require(isinstance(replace, list) and all(isinstance(k, str) for k in replace), "replace_json must list row:column keys", office)
        used = set()
        for row in incoming:
            if row["id"] not in by_id:
                table["rows"].append(row)
                by_id[row["id"]] = row
                continue
            old = by_id[row["id"]]
            for key, value in row["cells"].items():
                token = row["id"] + ":" + key
                if key not in old["cells"] or not old["cells"][key]["candidates"] or token in replace:
                    old["cells"][key] = value
                    if token in replace:
                        used.add(token)
                elif old["cells"][key] != value:
                    raise office.ToolError(f"Existing cell {token} is preserved; list it in replace_json only for an explicit correction")
        require(used == set(replace), "replace_json contains unknown or unused cells", office)
        require(len(table["rows"]) <= MAX_ROWS, "table exceeds 200 rows", office)
        table["revision"] += 1
    checked = validate(table, ws, office)
    require(all(len(encode(row).encode("utf-8")) <= 160_000 for row in checked["rows"]),
            "one row exceeds 160 KB of evidence; use shorter, precise quotes", office)
    encoded = encode(checked)
    require(len(encoded.encode("utf-8")) <= MAX_STATE, "table exceeds 8 MB", office)
    if action == "create":
        publish_new(path, encoded.encode("utf-8"), office)
    elif action == "update":
        office.atomic_bytes(path, encoded.encode("utf-8"))
    result = compact(checked, offset)
    result["path"] = relative
    if action == "export":
        output = ws.resolve(office.arg(args, "output"), write=True)
        require(output != path and not output.exists(), "export needs a new output path; existing files are preserved", office)
        if output.suffix.lower() == ".html":
            publish_new(output, export_html(checked).encode("utf-8"), office)
        elif output.suffix.lower() == ".xlsx":
            with tempfile.TemporaryDirectory(prefix=".dstudio-table-export-", dir=output.parent) as tmp:
                staged = Path(tmp) / output.name
                export_xlsx(checked, staged, office)
                os.link(staged, output)
        else:
            raise office.ToolError("export output must be .html or .xlsx")
        result["exported"] = office.arg(args, "output")
    return encode(result)
