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
import sys
import tempfile
import time
import zipfile
from contextlib import contextmanager
from collections import Counter
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path

FORMAT = "dstudio.document-table.v1"
# Bounds of one table. MAX_CELLS (rows x columns) keeps validation, the JSON
# state and exports proportional; rows and columns trade within it.
MAX_ROWS, MAX_COLUMNS, MAX_SOURCES, MAX_CELLS = 5000, 128, 512, 100_000
MAX_PDF_PAGES, MAX_SEGMENTS = 2000, 100_000
MAX_TEXT, MAX_STATE = 32_000_000, 128_000_000   # extracted chars per source; table JSON bytes
MAX_EXPORT_CELLS, XLSX_SHEET_ROWS = 4_000_000, 1_048_576
EXTRACTOR = "dstudio.document-table.extract.v2"  # change whenever extraction output changes
NOTICE = ("Source match checks literal evidence, not semantic correctness. Missing means "
          "not extracted, not proven absent. Checks apply only to the supplied rows. "
          "Text read with OCR from page images can misread characters and always needs review. "
          "No inference, unit conversion or completeness guarantee.")
OCR_PAGES_PER_CALL = 64   # new OCR pages per tool call, across all sources; cached pages are free
OCR_MIN_CHARS = 24        # a PDF page with fewer visible characters has no usable text layer
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


def run_owned(cmd, office, **kwargs):
    """Run an extraction subprocess with no elapsed-time cutoff (slow hardware
    must not fail valid work), but never outlive the runtime that asked for it:
    when this helper's parent exits (Stop, runtime death), the child is killed."""
    parent = os.getppid()
    with subprocess.Popen(cmd, **kwargs) as child:
        while True:
            try:
                out, err = child.communicate(timeout=0.5)
                break
            except subprocess.TimeoutExpired:
                if os.getppid() != parent:
                    child.kill()
                    child.communicate()
                    raise office.ToolError("the Cowork runtime stopped; extraction was cancelled")
    if child.returncode:
        raise subprocess.CalledProcessError(child.returncode, cmd, out, err)
    return out


_POPPLER = {}


def poppler_version(office):
    if "v" not in _POPPLER:
        out = run_owned([tool("pdftotext", office), "-v"], office, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        _POPPLER["v"] = (out.decode("utf-8", "replace").strip().splitlines() or ["unknown"])[0]
    return _POPPLER["v"]


# ---- Extraction cache ----------------------------------------------------
# Owner: this helper (a new process per tool call), in the user's cache
# directory, never in the workspace. Key: SHA-256 of the captured source bytes,
# the suffix, EXTRACTOR and, for PDFs, the Poppler version: changed bytes or a
# changed extractor are a different key, so an entry cannot go stale. Value:
# the segments exactly as extraction returned them; on a hit the stored key and
# shape are checked, and a mismatched or corrupt entry is deleted and
# recomputed. Bounds: CACHE_ENTRIES entries and CACHE_BYTES bytes; the least
# recently used entries are evicted after each insert. Entries are written
# atomically (temp + rename), so a cancelled helper never leaves a partial one.
# Any cache failure only costs a re-extraction. It holds text extracted from
# the user's documents, so the directory is private (0700).
# DSTUDIO_TABLE_CACHE_DIR overrides the location; "off" disables the cache.
CACHE_ENTRIES, CACHE_BYTES = 2048, 1 << 30


def cache_dir():
    configured = os.environ.get("DSTUDIO_TABLE_CACHE_DIR")
    if configured:
        return None if configured == "off" else Path(configured)
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Caches" / "DStudio"
    elif os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / "DStudio" / "Cache"
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "dstudio"
    return base / "document-table-sources"


def cache_key(digest, suffix, office):
    key = {"extractor": EXTRACTOR, "sha256": digest, "suffix": suffix}
    if suffix == ".pdf":
        key["poppler"] = poppler_version(office)
        key["ocr"] = ocr_engine(office)
    name = hashlib.sha256(encode(key).encode("utf-8")).hexdigest()
    return key, name


def cache_get(key, name):
    folder = cache_dir()
    if folder is None:
        return None
    entry = folder / (name + ".json")
    try:
        stored = json.loads(entry.read_text(encoding="utf-8"))
        segments, extraction = stored["segments"], stored["extraction"]
        if stored.get("key") != key or not isinstance(segments, list) or not isinstance(extraction, str) or \
                not all(isinstance(s, dict) and isinstance(s.get("id"), str) and isinstance(s.get("text"), str) for s in segments):
            raise ValueError("cache entry does not match its key")
        os.utime(entry)  # recency for eviction
        return segments, extraction
    except FileNotFoundError:
        return None
    except (OSError, ValueError, KeyError, TypeError):
        try:
            entry.unlink()
        except OSError:
            pass
        return None


def cache_put(key, name, segments, extraction):
    folder = cache_dir()
    if folder is None:
        return
    try:
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        data = encode({"key": key, "segments": segments, "extraction": extraction}).encode("utf-8")
        if len(data) > CACHE_BYTES // 4:
            return
        fd, tmp = tempfile.mkstemp(prefix=".entry-", suffix=".tmp", dir=folder)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
            os.replace(tmp, folder / (name + ".json"))
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        entries = []
        for item in folder.iterdir():
            if item.suffix == ".json":
                try:
                    st = item.stat()
                    entries.append((st.st_mtime_ns, st.st_size, item))
                except OSError:
                    pass
        entries.sort(reverse=True)
        kept_bytes = 0
        for index, (_, size, item) in enumerate(entries):
            kept_bytes += size
            if index >= CACHE_ENTRIES or kept_bytes > CACHE_BYTES:
                try:
                    item.unlink()
                except OSError:
                    pass
    except OSError:
        return


# ---- OCR for PDF pages without a text layer ---------------------------------
# The host passes the dstudio-ocr helper (macOS Vision; src/ocr/dstudio_ocr.m)
# as DSTUDIO_OCR_HELPER. Readings are cached per document and engine in the
# extraction cache folder (same owner, bounds and eviction as above), so work
# spread over several calls is not repeated. At most OCR_PAGES_PER_CALL new
# pages per tool call; the rest is reported as pending and is read by the
# next call. The extraction itself is cached only once nothing is pending.
_OCR = {"engine": None, "budget": OCR_PAGES_PER_CALL}


def ocr_helper():
    helper = os.environ.get("DSTUDIO_OCR_HELPER", "")
    return helper if helper and os.access(helper, os.X_OK) else None


def ocr_engine(office):
    if _OCR["engine"] is None:
        helper, engine = ocr_helper(), ""
        if helper:
            try:
                out = run_owned([helper, "--version"], office, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                engine = out.decode("utf-8", "replace").strip().splitlines()[0]
            except (subprocess.SubprocessError, OSError, IndexError):
                engine = ""
        _OCR["engine"] = engine
    return _OCR["engine"]


def visible(text):
    return sum(1 for c in text if not c.isspace())


def ocr_pdf_pages(captured, digest, segments, office):
    """Fill text-less PDF pages from OCR. Returns (pending page count, engine)."""
    blank = [s for s in segments if visible(s["text"]) < OCR_MIN_CHARS]
    engine = ocr_engine(office)
    if not blank or not engine:
        return 0, engine  # nothing to read, or no engine: unavailable, not pending
    key = {"ocr": EXTRACTOR, "sha256": digest, "engine": engine}
    name = "ocr-" + hashlib.sha256(encode(key).encode("utf-8")).hexdigest()
    stored = None
    folder = cache_dir()
    entry = folder / (name + ".json") if folder else None
    try:
        stored = json.loads(entry.read_text(encoding="utf-8")) if entry else None
        if not isinstance(stored, dict) or stored.get("key") != key or not isinstance(stored.get("pages"), dict):
            stored = None
    except (OSError, ValueError):
        stored = None
    pages = dict(stored["pages"]) if stored else {}
    todo = [s["page"] for s in blank if str(s["page"]) not in pages][: max(_OCR["budget"], 0)]
    if todo:
        _OCR["budget"] -= len(todo)
        try:
            out = run_owned([ocr_helper(), str(captured), ",".join(map(str, todo))], office,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        except subprocess.CalledProcessError as exc:
            out = exc.output or b""
        for line in out.decode("utf-8", "replace").splitlines():
            try:
                reading = json.loads(line)
            except ValueError:
                continue
            if isinstance(reading, dict) and isinstance(reading.get("text"), str) and "error" not in reading:
                pages[str(reading.get("page"))] = {"text": reading["text"], "confidence": reading.get("confidence")}
        if entry is not None and len(pages) > len(stored["pages"] if stored else {}):
            try:
                folder.mkdir(mode=0o700, parents=True, exist_ok=True)
                fd, tmp = tempfile.mkstemp(prefix=".entry-", suffix=".tmp", dir=folder)
                with os.fdopen(fd, "wb") as handle:
                    handle.write(encode({"key": key, "pages": pages}).encode("utf-8"))
                os.replace(tmp, entry)
            except OSError:
                pass
    pending = 0
    for segment in blank:
        reading = pages.get(str(segment["page"]))
        if reading is None:
            pending += 1
        elif visible(reading["text"]) >= OCR_MIN_CHARS:
            segment["text"], segment["ocr"] = reading["text"], True
    return pending, engine


def sheet_segments(zf, name, target, shared, office):
    """One segment per worksheet row, as office.xlsx_matrix + tsv would give for
    the declared dimension, but built from the stored cells only: no dense
    rows x columns matrix and no 8,000-cell read window."""
    root = office.ET.fromstring(zf.read(target))
    dim = root.find(f"{{{office.NS_MAIN}}}dimension")
    require(dim is not None and dim.get("ref"), "sheet dimensions missing; export to text first", office)
    ref = dim.get("ref").strip().rsplit("!", 1)[-1].split(":", 1)
    r1, c1 = office.parse_cell(ref[0])
    r2, c2 = office.parse_cell(ref[-1])
    require(r2 >= r1 and c2 >= c1, "sheet dimension runs backwards; repair dimensions or export to text first", office)
    values, chars, extent = {}, 0, office.SheetExtent()
    for row, col, value in office.xlsx_cells(zf, target, shared):
        if not value:
            continue
        extent.include(row, col)
        values[(row, col)] = value
        chars += len(value)
        require(chars <= MAX_TEXT, "source extraction too large; split the source", office)
    require(not extent.omitted((r1, c1, r2, c2)),
            "sheet dimension metadata omits stored cells; repair dimensions or export to text first", office)
    if not values:
        return []
    last_row = max(r for r, _ in values)
    width = max(c for _, c in values) - c1 + 1
    require(last_row - r1 + 1 <= MAX_SEGMENTS, "source extraction too large; split the source", office)
    return [{"id": f"sheet:{name}:row:{row}",
             "text": office.tsv([[values.get((row, col), "") for col in range(c1, c1 + width)]])}
            for row in range(r1, last_row + 1)]


def extract(captured, suffix, office, digest=""):
    """(segments, extraction, OCR pages still pending)."""
    if suffix == ".pdf":
        try:
            info = run_owned([tool("pdfinfo", office), str(captured)], office,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            match = re.search(rb"(?m)^Pages:\s+(\d+)", info)
            require(match and 0 < int(match[1]) <= MAX_PDF_PAGES,
                    f"PDF must have 1..{MAX_PDF_PAGES} pages; split larger inputs", office)
            count = int(match[1])
            output = captured.with_name("pages.txt")
            run_owned([tool("pdftotext", office), "-layout", "-enc", "UTF-8", str(captured), str(output)], office,
                      stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            require(output.stat().st_size <= MAX_TEXT * 4, "PDF extracted text is too large; split the source", office)
            pages = output.read_text(encoding="utf-8").split("\f")
            if pages and not pages[-1].strip():
                pages.pop()
            require(len(pages) == count, "PDF page count mismatch; evidence cannot be anchored", office)
            segments = [{"id": f"page:{i}", "page": i, "text": text} for i, text in enumerate(pages, 1)]
            pending, _ = ocr_pdf_pages(captured, digest, segments, office)
            extraction = "pdf-text-layer+ocr" if any(s.get("ocr") for s in segments) else "pdf-text-layer"
            return segments, extraction, pending
        except (subprocess.SubprocessError, UnicodeError) as exc:
            raise office.ToolError(f"PDF text extraction failed ({type(exc).__name__}); no evidence verified") from exc
    if suffix == ".xlsx":
        segments = []
        with office.open_office_zip(captured) as zf:
            sheets, _, shared = office.workbook_parts(zf)
            for name, target in sheets:
                segments.extend(sheet_segments(zf, name, target, shared, office))
                require(len(segments) <= MAX_SEGMENTS, "source extraction too large; split the source", office)
        return segments, "document-text", 0
    text = office.read_document_text(captured)
    # Line anchors refer to extractor output, not DOCX physical pages.
    return [{"id": f"line:{i}", "text": text} for i, text in enumerate(text.splitlines(), 1)], "document-text", 0


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
    key, name = cache_key(digest, suffix, office)
    cached = cache_get(key, name)
    pending = 0
    if cached is None:
        with tempfile.TemporaryDirectory(prefix="dstudio-table-source-") as tmp:
            captured = Path(tmp) / ("source" + suffix)
            captured.write_bytes(data)
            segments, extraction, pending = extract(captured, suffix, office, digest)
        require(sum(len(s["text"]) for s in segments) <= MAX_TEXT and len(segments) <= MAX_SEGMENTS,
                "source extraction too large; split the source", office)
        if not pending:
            cache_put(key, name, segments, extraction)
    else:
        segments, extraction = cached
    result = {"path": str(path.relative_to(ws.root)), "sha256": digest, "segments": segments,
              "emptySegments": [s["id"] for s in segments if not s["text"].strip()],
              "extraction": extraction}
    if suffix == ".pdf":
        result["ocrSegments"] = [s["id"] for s in segments if s.get("ocr")]
        result["ocrPendingPages"] = pending
        result["ocrAvailable"] = bool(key.get("ocr"))
    return result


def segment_lookup(doc, segment_id):
    """O(1) segment and normalized-text lookup, built once per source per call."""
    if "_index" not in doc:
        doc["_index"] = {s["id"]: s for s in doc["segments"]}
        doc["_norm"] = {}
    segment = doc["_index"].get(segment_id)
    if segment is None:
        return None, ""
    if segment_id not in doc["_norm"]:
        doc["_norm"][segment_id] = norm(segment["text"])
    return segment, doc["_norm"][segment_id]


def columns(spec, office):
    require(isinstance(spec, list) and 0 < len(spec) <= MAX_COLUMNS, f"columns_json needs 1..{MAX_COLUMNS} columns", office)
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


def require_cells(row_count, cols, office):
    require(row_count * len(cols) <= MAX_CELLS,
            f"table exceeds {MAX_CELLS:,} cells (rows x columns); split it into several tables", office)


def rows(spec, cols, office):
    require(isinstance(spec, list) and len(spec) <= MAX_ROWS, f"rows_json must have at most {MAX_ROWS} rows", office)
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
                        require(len(cache) < MAX_SOURCES, f"table exceeds {MAX_SOURCES} unique sources", office)
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
                        segment, segment_text = segment_lookup(doc, ref["segment"])
                        quote = norm(ref["quote"])
                        ref["match"] = bool(segment and quote and re.search(
                            r"(?<![\w.,+\-])" + re.escape(quote) + r"(?![\w.,])", segment_text))
                        if not ref["match"]:
                            issues.append("Quote does not occur in the specified source segment")
                        elif segment.get("ocr"):
                            issues.append("Quote matched text read with OCR from the page image; characters can be "
                                          "misread, compare with the page")
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
                    context.prec = 5000  # exact: values <=2000 digits, <=5000 rows add <4 digits
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
    require(sum(len(row) for sheet in [data, statuses, refs, checks, meta] for row in sheet) <= MAX_EXPORT_CELLS,
            f"Excel export exceeds {MAX_EXPORT_CELLS:,} cells including evidence; split the table or export HTML", office)
    # A worksheet holds 1,048,576 rows: a longer sheet continues in "Name 2",
    # "Name 3"..., each repeating the header row.
    sheets = []
    for name, sheet in [("Data", data), ("Status", statuses), ("Evidence", refs), ("Checks", checks), ("About", meta)]:
        body, part = sheet[1:], 1
        for start in range(0, max(len(body), 1), XLSX_SHEET_ROWS - 1):
            sheets.append((name if part == 1 else f"{name} {part}", [sheet[0]] + body[start:start + XLSX_SHEET_ROWS - 1]))
            part += 1
    # Literal text, including = prefixes and leading zeroes, must round-trip.
    office.create_xlsx(path, sheets, header=True, literal=True)


def load(path, office):
    require(path.stat().st_size <= MAX_STATE, f"table exceeds {MAX_STATE // 1_000_000} MB", office)
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
    require_cells(len(clean_rows), cols, office)
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


def read_source_notice(doc):
    notice = "Use these exact path, sha256, segment IDs and verbatim quotes."
    if doc.get("ocrSegments"):
        notice += " Segments in ocrSegments were read with OCR from page images and can contain misread characters."
    if doc.get("ocrPendingPages"):
        notice += (f" {doc['ocrPendingPages']} pages without a text layer are not OCR-read yet; call read_source "
                   "again to continue (at most 64 new pages per call).")
    elif doc.get("ocrAvailable") is False and doc.get("emptySegments"):
        notice += " Pages without a text layer could not be OCR-read: no OCR engine is available on this system."
    return notice


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
                       "notice": read_source_notice(doc)})
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
        require_cells(len(table["rows"]), cols, office)
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
        require(len(table["rows"]) <= MAX_ROWS, f"table exceeds {MAX_ROWS} rows", office)
        require_cells(len(table["rows"]), table["columns"], office)
        table["revision"] += 1
    checked = validate(table, ws, office)
    require(all(len(encode(row).encode("utf-8")) <= 160_000 for row in checked["rows"]),
            "one row exceeds 160 KB of evidence; use shorter, precise quotes", office)
    encoded = encode(checked)
    require(len(encoded.encode("utf-8")) <= MAX_STATE, f"table exceeds {MAX_STATE // 1_000_000} MB", office)
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
