#!/usr/bin/env python3
"""A document table at its bounds, through the production Office helper:
5,000 rows x 20 columns (100,000 cells), one quoted source line per cell from
512 synthetic text files. Checks results first: every cell matches its
source, an inspect and both exports cover every row, and rechecks do not
extract unchanged sources again (counted by the extraction cache). Then it
records wall times and peak memory in tests/.artifacts/document-table-scale/.
Synthetic data; timings depend on the machine and its load.
  python3 tests/integration/document_table_scale_test.py [rows cols sources]
"""
import importlib.util
import json
import os
import platform
import resource
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("office_scale", ROOT / "src/harness/cowork/office_tool.py")
office = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = office
spec.loader.exec_module(office)

rows_n, cols_n, sources_n = (int(v) for v in (sys.argv[1:4] if len(sys.argv) >= 4 else (5000, 20, 512)))
out_dir = ROOT / "tests/.artifacts/document-table-scale"
out_dir.mkdir(parents=True, exist_ok=True)
run = Path(tempfile.mkdtemp(prefix="run-", dir=out_dir))
os.environ["DSTUDIO_TABLE_CACHE_DIR"] = str(run / "cache")
workspace = run / "workspace"
workspace.mkdir()
ws = office.Workspace.open(str(workspace))
receipt = {"scope": "Production Office helper and document_table; synthetic text sources; no model",
           "rows": rows_n, "columns": cols_n, "sources": sources_n, "machine": platform.platform(),
           "loadAverage": os.getloadavg(), "timingsSeconds": {}}


def call(action, **kwargs):
    args = {"action": action, **{k: json.dumps(v) if k.endswith("_json") else str(v) for k, v in kwargs.items()}}
    return json.loads(office.dispatch({"protocol": office.PROTOCOL, "tool": "document_table", "args": args}, ws))


def timed(name, fn):
    started = time.perf_counter()
    value = fn()
    receipt["timingsSeconds"][name] = round(time.perf_counter() - started, 3)
    return value


def cached_entries():
    return len(list((run / "cache").glob("*.json")))


try:
    line = lambda r, c, s: f"Item {r} field {c}: value {r}-{c}-{s}"
    for s in range(sources_n):
        (workspace / f"src{s}.txt").write_text("\n".join(line(r, c, s) for r in range(s, rows_n, sources_n) for c in range(cols_n)))
    digests = timed("read_source x sources", lambda: [call("read_source", path=f"src{s}.txt")["sha256"] for s in range(sources_n)])
    assert cached_entries() == sources_n, "one extraction cached per source"
    rows = []
    for r in range(rows_n):
        s, first = r % sources_n, (r // sources_n) * cols_n
        rows.append({"id": f"r{r}", "cells": {f"c{c}": {"value": f"{r}-{c}-{s}", "evidence": [{
            "path": f"src{s}.txt", "sha256": digests[s], "segment": f"line:{first + c + 1}", "quote": line(r, c, s)}]}
            for c in range(cols_n)}})
    columns = [{"id": f"c{c}"} for c in range(cols_n)]
    created = timed("create", lambda: call("create", path="big.table.json", columns_json=columns, rows_json=rows))
    assert created["summary"] == {"sourced": rows_n * cols_n}, created["summary"]
    inspected = timed("inspect", lambda: call("inspect", path="big.table.json"))
    assert inspected["summary"] == created["summary"] and inspected["totalRows"] == rows_n
    timed("export xlsx", lambda: call("export", path="big.table.json", output="big.xlsx"))
    timed("export html", lambda: call("export", path="big.table.json", output="big.html"))
    assert cached_entries() == sources_n, "rechecks reused every cached extraction"
    with office.open_office_zip(workspace / "big.xlsx") as zf:
        sheets, _, shared = office.workbook_parts(zf)
        data = dict(sheets)["Data"]
        ids = [row for row, col, value in office.xlsx_cells(zf, data, shared) if col == 1 and value.startswith("r")]
        assert len(ids) == rows_n, f"Excel Data sheet has {len(ids)} rows"
    page = (workspace / "big.html").read_text(encoding="utf-8")
    assert page.count("<tr><th scope=row>") == rows_n
    receipt["stateMB"] = round((workspace / "big.table.json").stat().st_size / 1e6, 1)
    receipt["xlsxMB"] = round((workspace / "big.xlsx").stat().st_size / 1e6, 1)
    receipt["htmlMB"] = round((workspace / "big.html").stat().st_size / 1e6, 1)
    receipt["peakRssMB"] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1e6 if sys.platform == "darwin" else 1e3))
    receipt["status"] = "PASS"
except Exception as error:  # noqa: BLE001 - recorded in the receipt, then reported
    receipt["status"] = "FAIL"
    receipt["error"] = f"{type(error).__name__}: {error}"
finally:
    (run / "receipt.json").write_text(json.dumps(receipt, indent=2))
    print(f"document_table_scale_test: {receipt['status']} {rows_n}x{cols_n} cells, {sources_n} sources "
          f"(synthetic; no model) {receipt['timingsSeconds']} peak RSS {receipt.get('peakRssMB')} MB; {run}")
    if receipt["status"] != "PASS":
        print(receipt.get("error"))
        sys.exit(1)
