"""Real file/Poppler/OOXML tests. Candidate extraction is fixture-driven, no LLM."""
import concurrent.futures
import hashlib
import importlib.util
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "src/harness/cowork/office_tool.py"
spec = importlib.util.spec_from_file_location("table_office_test", HELPER)
office = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = office
spec.loader.exec_module(office)


# The production module, loaded as office.dispatch loads it, so a test can
# shrink one of its bounds and call its run() directly.
tspec = importlib.util.spec_from_file_location("table_under_test", ROOT / "src/harness/cowork/document_table.py")
table = importlib.util.module_from_spec(tspec)
tspec.loader.exec_module(table)


class DocumentTableTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dstudio-document-table-test-")
        self.root = Path(self.temp.name) / "workspace"
        self.root.mkdir()
        # Never the user's cache: a private one per test.
        self.cache = Path(self.temp.name) / "cache"
        self.saved_cache = os.environ.get("DSTUDIO_TABLE_CACHE_DIR")
        os.environ["DSTUDIO_TABLE_CACHE_DIR"] = str(self.cache)
        self.ws = office.Workspace.open(str(self.root))

    def tearDown(self):
        if self.saved_cache is None:
            os.environ.pop("DSTUDIO_TABLE_CACHE_DIR", None)
        else:
            os.environ["DSTUDIO_TABLE_CACHE_DIR"] = self.saved_cache
        self.temp.cleanup()

    def call(self, action, path="comparison.table.json", **kwargs):
        args = {"action": action, "path": path, **kwargs}
        args = {k: json.dumps(v, ensure_ascii=False) if k.endswith("_json") else str(v) for k, v in args.items()}
        return json.loads(office.dispatch({"protocol": office.PROTOCOL, "tool": "document_table", "args": args}, self.ws))

    def ref(self, path, text, segment="line:1"):
        doc = self.call("read_source", path)
        return {"path": doc["path"], "sha256": doc["sha256"], "segment": segment, "quote": text}

    def value(self, value, ref):
        return {"value": value, "evidence": [ref]}

    def simple(self, text="Duration: 12 hours", value="12", col=None, **kwargs):
        (self.root / "source.txt").write_text(text, encoding="utf8")
        ref = self.ref("source.txt", text)
        return self.call("create", columns_json=[col or {"id": "field", "type": "text"}],
                         rows_json=[{"id": "item", "cells": {"field": self.value(value, ref)}}], **kwargs)

    def test_general_purpose_courses_specs_and_minutes(self):
        cases = [("Course", "Duration: 12 hours", "duration", "12", "number", "hours"),
                 ("Sensor", "Resolution: 24 pixels", "resolution", "24", "number", "pixels"),
                 ("Meeting", "Owner: Zoë", "owner", "Zoë", "text", ""),
                 ("Study", "Method: randomized", "method", "randomized", "text", ""),
                 ("Catalog", "Code: 00124", "code", "00124", "text", "")]
        for title, text, key, value, kind, unit in cases:
            with self.subTest(title=title):
                file = title + ".txt"
                (self.root / file).write_text(text, encoding="utf8")
                result = self.call("create", title + ".table.json", title=title,
                                   columns_json=[{"id": key, "type": kind, "unit": unit}, {"id": "optional", "required": True}],
                                   rows_json=[{"id": "a", "cells": {key: self.value(value, self.ref(file, text))}}])
                self.assertEqual(result["summary"], {"sourced": 1, "missing": 1})
                self.assertEqual(result["rows"][0]["cells"][key]["value"], value)
                self.assertIn("not semantic correctness", result["notice"])
                self.assertNotIn("price", [c["id"] for c in result["columns"]])

    def test_actual_pdf_and_docx_sources(self):
        self.assertTrue(shutil.which("pdftotext") or Path("/opt/homebrew/bin/pdftotext").exists(), "Poppler required for this real PDF test")
        office.create_pdf(self.root / "course.pdf", "Course", "Duration: 12 hours\n" + "\n".join(f"Topic {i}: practice" for i in range(130)))
        doc = self.call("read_source", "course.pdf")
        self.assertGreater(doc["totalSegments"], 1)
        self.assertEqual(doc["segments"][0]["id"], "page:1")
        self.assertEqual(doc["sha256"], hashlib.sha256((self.root / "course.pdf").read_bytes()).hexdigest())
        ref = {"path": "course.pdf", "sha256": doc["sha256"], "segment": "page:1", "quote": "Duration: 12 hours"}
        result = self.call("create", columns_json=[{"id": "duration", "type": "number", "unit": "hours"}],
                           rows_json=[{"id": "course", "cells": {"duration": self.value("12", ref)}}])
        self.assertEqual(result["summary"], {"sourced": 1})
        office.create_docx(self.root / "minutes.docx", "Minutes", "Owner: Zoë\nStatus: Active")
        docx = self.call("read_source", "minutes.docx")
        self.assertIn("Owner: Zoë", [s["text"] for s in docx["segments"]])
        wrong = {**ref, "segment": "page:99"}
        result = self.call("update", revision=1, replace_json=["course:duration"],
                           rows_json=[{"id": "course", "cells": {"duration": self.value("12", wrong)}}])
        self.assertEqual(result["summary"], {"needs_review": 1})

    def test_quote_value_and_numeric_boundaries(self):
        for i, (text, value, kind) in enumerate([("Rate: 312", "12", "number"), ("Rate: 12.5", "12", "number"),
                                                ("Owner: Joanna", "Anna", "text"), ("Count: 12", "13", "number")]):
            file = f"source{i}.txt"
            (self.root / file).write_text(text)
            result = self.call("create", f"case{i}.table.json", columns_json=[{"id": "field", "type": kind}],
                               rows_json=[{"id": "item", "cells": {"field": self.value(value, self.ref(file, text))}}])
            self.assertEqual(result["summary"], {"needs_review": 1})
        result = self.simple("Weight: 12 kg", "12", {"id": "field", "type": "number", "unit": "hours"})
        self.assertEqual(result["summary"], {"needs_review": 1})

    def test_spreadsheet_source_rejects_dimension_that_omits_real_cells(self):
        target = self.root / "stale-dimension.xlsx"
        office.create_xlsx(target, [("Data", [["Header"], ["Must not disappear"]])], header=True)
        with zipfile.ZipFile(target) as archive:
            entries = [(item, archive.read(item.filename)) for item in archive.infolist()]
        with zipfile.ZipFile(target, "w") as archive:
            for item, payload in entries:
                if item.filename == "xl/worksheets/sheet1.xml":
                    root = office.ET.fromstring(payload)
                    root.find(f"{{{office.NS_MAIN}}}dimension").set("ref", "A1")
                    payload = office.xml_bytes(root)
                archive.writestr(item, payload)
        before = target.read_bytes()
        with self.assertRaisesRegex(office.ToolError, "dimension.*omit"):
            self.call("read_source", target.name)
        self.assertEqual(target.read_bytes(), before)

    def test_partial_numeric_quotes_cannot_fabricate_source_match(self):
        for i, (text, quote) in enumerate([("312 hours", "12 hours"), ("-12 hours", "12 hours"), ("12.5 hours", "12")]):
            name = f"a{i}.txt"
            (self.root / name).write_text(text)
            ref = self.ref(name, quote)
            result = self.call("create", f"a{i}.table.json", columns_json=[{"id": "x", "type": "number"}],
                               rows_json=[{"id": "a", "cells": {"x": self.value("12", ref)}}])
            self.assertEqual(result["summary"], {"needs_review": 1})

    def test_conflict_is_never_silently_selected(self):
        text = "Duration: 12 hours or 16 hours"
        (self.root / "a.txt").write_text(text)
        ref = self.ref("a.txt", text)
        result = self.call("create", columns_json=[{"id": "duration"}], rows_json=[{"id": "a", "cells": {
            "duration": {"candidates": [self.value("12", ref), self.value("16", ref)]}}}])
        self.assertEqual(result["summary"], {"conflict": 1})
        self.assertIsNone(result["rows"][0]["cells"]["duration"]["value"])

    def test_stale_and_missing_sources_rechecked_on_inspect_and_export(self):
        self.simple()
        (self.root / "source.txt").write_text("Duration: 16 hours")
        result = self.call("inspect")
        self.assertEqual(result["summary"], {"stale_source": 1})
        exported = self.call("export", output="comparison.html")
        self.assertEqual(exported["summary"], {"stale_source": 1})
        self.assertIn("Source changed", (self.root / "comparison.html").read_text())
        (self.root / "source.txt").unlink()
        self.assertEqual(self.call("export", output="unavailable.xlsx")["summary"], {"unavailable": 1})

    def test_updates_preserve_existing_cells_and_use_revision(self):
        self.simple()
        ref = self.ref("source.txt", "Duration: 12 hours")
        added = self.call("update", revision=1, rows_json=[{"id": "b", "cells": {"field": self.value("12", ref)}}])
        self.assertEqual(added["revision"], 2)
        self.assertEqual(added["totalRows"], 2)
        before = (self.root / "comparison.table.json").read_bytes()
        with self.assertRaisesRegex(office.ToolError, "revision"):
            self.call("update", revision=1, rows_json=[])
        with self.assertRaisesRegex(office.ToolError, "preserved"):
            self.call("update", revision=2, rows_json=[{"id": "item", "cells": {"field": self.value("hours", ref)}}])
        self.assertEqual((self.root / "comparison.table.json").read_bytes(), before)
        result = self.call("update", revision=2, replace_json=["item:field"],
                           rows_json=[{"id": "item", "cells": {"field": self.value("hours", ref)}}])
        self.assertEqual(result["rows"][0]["cells"]["field"]["value"], "hours")
        self.assertEqual(result["rows"][1]["cells"]["field"]["value"], "12")

    def test_actual_helper_concurrent_revision_updates(self):
        self.simple()
        request = self.root / "request.json"
        request.write_text(json.dumps({"protocol": office.PROTOCOL, "tool": "document_table", "args": {
            "action": "update", "path": "comparison.table.json", "revision": "1", "rows_json": "[]"}}))
        def execute():
            return subprocess.run([sys.executable, str(HELPER), "--workspace", str(self.root), "--request-json", str(request)], capture_output=True, text=True)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: execute(), range(2)))
        self.assertEqual(sorted(r.returncode for r in results), [0, 2])
        self.assertTrue(any("revision" in r.stdout for r in results if r.returncode == 2))
        self.assertEqual(self.call("inspect")["revision"], 2)

    def test_decimal_checks_are_exact_and_skip_missing(self):
        text = "Duration: 0,1 hours\nDuration: 0,2 hours"
        (self.root / "a.txt").write_text(text)
        doc = self.call("read_source", "a.txt")
        rs = []
        for i, value in enumerate(["0,1", "0,2"]):
            ref = {"path": "a.txt", "sha256": doc["sha256"], "segment": f"line:{i+1}", "quote": text.splitlines()[i]}
            rs.append({"id": f"r{i}", "cells": {"duration": self.value(value, ref)}})
        result = self.call("create", columns_json=[{"id": "duration", "type": "number", "decimal": ",", "unit": "hours"}],
                           rows_json=rs, checks_json=[{"kind": "sum", "column": "duration", "expected": "0,3"}, {"kind": "unique", "column": "duration"}])
        self.assertEqual([c["status"] for c in result["checks"]], ["passed", "passed"])
        self.assertEqual(result["checks"][0]["actual"], "0.3")
        result = self.call("update", revision=1, rows_json=[{"id": "missing", "cells": {}}])
        self.assertEqual([c["status"] for c in result["checks"]], ["not_checked", "not_checked"])

    def test_xlsx_literal_roundtrip_and_clickable_html_evidence(self):
        self.simple("Formula label: =1+1 <script>alert(1)</script>", "=1+1")
        self.call("export", output="comparison.xlsx")
        with office.open_office_zip(self.root / "comparison.xlsx") as archive:
            sheets, _, shared = office.workbook_parts(archive)
            self.assertEqual([s[0] for s in sheets], ["Data", "Status", "Evidence", "Checks", "About"])
            xml = archive.read("xl/worksheets/sheet1.xml")
            self.assertNotIn(b"<f>", xml)
            self.assertEqual(office.xlsx_matrix(archive, sheets[0][1], shared, (1, 1, 2, 2))[1][1], "=1+1")
            self.assertIn(b"line:1", archive.read("xl/worksheets/sheet3.xml"))
        self.call("export", output="comparison.html")
        page = (self.root / "comparison.html").read_text()
        self.assertIn("<details><summary>", page)
        self.assertIn("&lt;script&gt;", page)
        self.assertNotIn("<script>", page)
        with self.assertRaisesRegex(office.ToolError, "existing files"):
            self.call("export", output="comparison.html")

    def test_pagination_and_missing_are_explicit(self):
        (self.root / "a.txt").write_text("\n".join(f"Line {i}" for i in range(81)))
        first = self.call("read_source", "a.txt")
        self.assertEqual(first["nextOffset"], 40)
        self.assertEqual(self.call("read_source", "a.txt", offset=80)["nextOffset"], None)
        result = self.call("create", columns_json=[{"id": "field"}], rows_json=[{"id": f"r{i}", "cells": {}} for i in range(25)])
        self.assertEqual(len(result["rows"]), 20)
        self.assertEqual(result["nextOffset"], 20)
        self.assertEqual(len(self.call("inspect", offset=20)["rows"]), 5)

    def test_source_bounds_and_invalid_schema(self):
        with self.assertRaises((office.ToolError, OSError)):
            self.call("read_source", "../outside.txt")
        with self.assertRaisesRegex(office.ToolError, "duplicate column"):
            self.call("create", columns_json=[{"id": "x"}, {"id": "x"}], rows_json=[])
        with self.assertRaisesRegex(office.ToolError, "unknown column"):
            self.call("create", columns_json=[{"id": "x"}], rows_json=[{"id": "a", "cells": {"y": {"missing": True}}}])
        self.assertFalse((self.root / "comparison.table.json").exists())

    def test_date_enum_and_number_ambiguity(self):
        for i, (value, col) in enumerate([("03/04/2026", {"type": "date"}), ("2026-02-30", {"type": "date"}),
                                         ("1,200", {"type": "number"}), ("Active", {"type": "enum", "values": ["Draft", "Done"]})]):
            name = f"a{i}.txt"
            (self.root / name).write_text(value)
            result = self.call("create", f"a{i}.table.json", columns_json=[{"id": "x", **col}],
                               rows_json=[{"id": "a", "cells": {"x": self.value(value, self.ref(name, value))}}])
            self.assertEqual(result["summary"], {"needs_review": 1})

    def test_xlsx_source_segments_and_zero_padded_identifiers(self):
        office.create_xlsx(self.root / "catalog.xlsx", [("Specs", [["Code", "Capacity"], ["00124", "64 GB"]])], header=True)
        doc = self.call("read_source", "catalog.xlsx")
        self.assertEqual(doc["segments"][1]["id"], "sheet:Specs:row:2")
        self.assertIn("00124", doc["segments"][1]["text"])


    # ---- extraction cache, bounds and large sources ----

    def counting_pdftotext(self):
        """Put a pdftotext first on PATH that logs each extraction, then runs
        the real one: a deterministic visit counter for cache hits/misses."""
        real = shutil.which("pdftotext") or "/opt/homebrew/bin/pdftotext"
        self.assertTrue(Path(real).exists(), "Poppler required for this real PDF test")
        bin_dir = Path(self.temp.name) / "bin"
        bin_dir.mkdir(exist_ok=True)
        log = Path(self.temp.name) / "pdftotext.log"
        shim = bin_dir / "pdftotext"
        shim.write_text(f'#!/bin/sh\ncase "$1" in -v) ;; *) echo x >> "{log}" ;; esac\nexec "{real}" "$@"\n')
        shim.chmod(0o755)
        saved = os.environ["PATH"]
        os.environ["PATH"] = f"{bin_dir}{os.pathsep}{Path(real).parent}{os.pathsep}{saved}"
        self.addCleanup(os.environ.__setitem__, "PATH", saved)
        return lambda: len(log.read_text().split()) if log.exists() else 0

    def test_cache_hit_returns_the_extraction_without_running_it(self):
        extractions = self.counting_pdftotext()
        office.create_pdf(self.root / "course.pdf", "Course", "Duration: 12 hours\n" + "\n".join(f"Topic {i}" for i in range(90)))
        first = self.call("read_source", "course.pdf")
        self.assertEqual(extractions(), 1)
        second = self.call("read_source", "course.pdf")
        self.assertEqual(extractions(), 1, "the second read is a cache hit")
        self.assertEqual(second, first)
        os.environ["DSTUDIO_TABLE_CACHE_DIR"] = "off"
        self.assertEqual(self.call("read_source", "course.pdf"), first, "the miss path gives the same result")
        self.assertEqual(extractions(), 2)
        os.environ["DSTUDIO_TABLE_CACHE_DIR"] = str(self.cache)
        # A table rechecks every source on inspect/export; cached, nothing is re-extracted.
        ref = {"path": "course.pdf", "sha256": first["sha256"], "segment": "page:1", "quote": "Duration: 12 hours"}
        self.call("create", columns_json=[{"id": "d", "type": "number", "unit": "hours"}],
                  rows_json=[{"id": "c", "cells": {"d": self.value("12", ref)}}])
        self.call("inspect")
        self.call("export", output="out.xlsx")
        self.assertEqual(extractions(), 2)
        self.assertEqual(oct(self.cache.stat().st_mode & 0o777), "0o700", "extracted text is private")

    def test_changed_bytes_and_bad_cache_entries_are_never_served(self):
        (self.root / "a.txt").write_text("Owner: Ada\n")
        first = self.call("read_source", "a.txt")
        (self.root / "a.txt").write_text("Owner: Bob\n")
        changed = self.call("read_source", "a.txt")
        self.assertNotEqual(changed["sha256"], first["sha256"])
        self.assertEqual(changed["segments"][0]["text"], "Owner: Bob")
        for entry in self.cache.glob("*.json"):
            entry.write_text("{not json")
        self.assertEqual(self.call("read_source", "a.txt"), changed)
        rewritten = [e for e in self.cache.glob("*.json") if e.read_text().startswith("{\"")]
        self.assertEqual(len(rewritten), 1, "the corrupt entry of the current bytes was replaced")
        for entry in rewritten:
            stored = json.loads(entry.read_text())
            stored["key"]["sha256"] = "0" * 64
            stored["segments"] = [{"id": "line:1", "text": "Owner: Mallory"}]
            entry.write_text(json.dumps(stored))
        self.assertEqual(self.call("read_source", "a.txt"), changed, "an entry whose key does not match is recomputed")

    def test_cache_is_bounded_and_keeps_recently_used_entries(self):
        saved = table.CACHE_ENTRIES
        table.CACHE_ENTRIES = 3
        self.addCleanup(setattr, table, "CACHE_ENTRIES", saved)
        read = lambda name: json.loads(table.run(self.ws, {"action": "read_source", "path": name}, office))
        for i in range(3):
            (self.root / f"s{i}.txt").write_text(f"Source {i}\n")
            read(f"s{i}.txt")
        os.utime(next(self.cache.glob("*.json")), (1, 1))  # make an entry look old...
        oldest = min(self.cache.glob("*.json"), key=lambda e: e.stat().st_mtime_ns)
        survivor = json.loads(oldest.read_text())["segments"][0]["text"]
        read(f"s{survivor.split()[1]}.txt")               # ...then use it: it is recent again
        for i in range(3, 6):
            (self.root / f"s{i}.txt").write_text(f"Source {i}\n")
            read(f"s{i}.txt")
            self.assertLessEqual(len(list(self.cache.glob("*.json"))), 3)
        kept = {json.loads(e.read_text())["segments"][0]["text"] for e in self.cache.glob("*.json")}
        self.assertEqual(kept, {"Source 3", "Source 4", "Source 5"})

    def test_table_bounds(self):
        self.assertEqual((table.MAX_ROWS, table.MAX_COLUMNS, table.MAX_SOURCES, table.MAX_CELLS), (5000, 128, 512, 100_000))
        cols = lambda n: [{"id": f"c{i}"} for i in range(n)]
        missing = lambda n: [{"id": f"r{i}", "cells": {}} for i in range(n)]
        self.assertEqual(self.call("create", "wide.table.json", columns_json=cols(128), rows_json=missing(781))["totalRows"], 781)
        with self.assertRaisesRegex(office.ToolError, "1..128 columns"):
            self.call("create", "wider.table.json", columns_json=cols(129), rows_json=[])
        self.assertEqual(self.call("create", "long.table.json", columns_json=cols(20), rows_json=missing(5000))["totalRows"], 5000)
        with self.assertRaisesRegex(office.ToolError, "at most 5000 rows"):
            self.call("create", "longer.table.json", columns_json=cols(1), rows_json=missing(5001))
        with self.assertRaisesRegex(office.ToolError, "100,000 cells"):
            self.call("create", "big.table.json", columns_json=cols(128), rows_json=missing(782))
        with self.assertRaisesRegex(office.ToolError, "100,000 cells"):
            self.call("update", "wide.table.json", revision=1, rows_json=[{"id": "extra", "cells": {}}])
        self.assertFalse((self.root / "big.table.json").exists())

    def test_up_to_512_sources_in_one_table(self):
        def rows_for(count):
            out = []
            for i in range(count):
                name = f"doc{i}.txt"
                (self.root / name).write_text(f"Code: X{i:04d}\n")
                out.append({"id": f"r{i}", "cells": {"code": self.value(f"X{i:04d}", self.ref(name, f"Code: X{i:04d}"))}})
            return out
        rows = rows_for(513)
        result = self.call("create", "s512.table.json", columns_json=[{"id": "code"}], rows_json=rows[:512])
        self.assertEqual(result["summary"], {"sourced": 512})
        with self.assertRaisesRegex(office.ToolError, "512 unique sources"):
            self.call("create", "s513.table.json", columns_json=[{"id": "code"}], rows_json=rows)

    def test_xlsx_source_larger_than_the_old_read_window(self):
        rows = [["Code"] + [f"F{c}" for c in range(1, 30)]] + [[f"{r:05d}"] + [f"v{r}-{c}" for c in range(1, 30)] for r in range(1, 400)]
        office.create_xlsx(self.root / "wide.xlsx", [("Data", rows)], header=True)  # 12,000 cells
        doc = self.call("read_source", "wide.xlsx")
        self.assertEqual(doc["totalSegments"], 400)
        last = self.call("read_source", "wide.xlsx", segment="sheet:Data:row:400")["segments"][0]["text"]
        self.assertEqual(last.split("\t")[:2], ["00399", "v399-1"])

    def test_sheet_segments_match_the_dense_reader(self):
        # Reference: the Office helper's dense reader over the declared
        # dimension (bounded to its 8,000-cell window), then one TSV per row.
        rng = random.Random(3)
        for case in range(60):
            nrows, ncols = rng.randrange(1, 40), rng.randrange(1, 12)
            matrix = [[rng.choice(["", "", "0", "x", "a b", "007", "=1+1", "è\ttab", "line\nbreak"]) for _ in range(ncols)] for _ in range(nrows)]
            path = self.root / f"m{case}.xlsx"
            office.create_xlsx(path, [("S", matrix)], header=False, literal=True)
            with office.open_office_zip(path) as zf:
                sheets, _, shared = office.workbook_parts(zf)
                name, target = sheets[0]
                root = office.ET.fromstring(zf.read(target))
                bounds = office.parse_range(root.find(f"{{{office.NS_MAIN}}}dimension").get("ref"))
                dense = office.xlsx_matrix(zf, target, shared, bounds)
                want = [{"id": f"sheet:{name}:row:{i}", "text": office.tsv([row])} for i, row in enumerate(dense, bounds[0])]
                self.assertEqual(table.sheet_segments(zf, name, target, shared, office), want, f"case {case}")

    def test_long_export_sheets_continue_with_their_header(self):
        saved = table.XLSX_SHEET_ROWS
        table.XLSX_SHEET_ROWS = 4  # 3 data rows per part
        self.addCleanup(setattr, table, "XLSX_SHEET_ROWS", saved)
        (self.root / "a.txt").write_text("Code: A1\n")
        ref = self.ref("a.txt", "Code: A1")
        rows = [{"id": f"r{i}", "cells": {"code": self.value("A1", ref)}} for i in range(7)]
        self.call("create", columns_json=[{"id": "code"}], rows_json=rows)
        table.run(self.ws, {"action": "export", "path": "comparison.table.json", "output": "split.xlsx"}, office)
        with office.open_office_zip(self.root / "split.xlsx") as zf:
            sheets, _, shared = office.workbook_parts(zf)
            names = [n for n, _ in sheets]
            self.assertEqual(names, ["Data", "Data 2", "Data 3", "Status", "Status 2", "Status 3",
                                     "Evidence", "Evidence 2", "Evidence 3", "Checks", "About", "About 2"])
            read = lambda n: office.xlsx_matrix(zf, dict(sheets)[n], shared, (1, 1, 10, 12))
            self.assertEqual([r[0] for r in read("Data") + read("Data 2") + read("Data 3") if r[0] != "Document / item"],
                             [f"r{i}" for i in range(7)])
            self.assertTrue(all(read(n)[0][0] == "Row" for n in ("Status", "Status 2", "Status 3")))

    def test_extraction_stops_when_the_runtime_that_asked_for_it_exits(self):
        # A stand-in runtime starts the helper's owned subprocess and exits;
        # the subprocess must not keep running until it finishes on its own.
        pidfile = Path(self.temp.name) / "child.pid"
        script = (f"import importlib.util,sys,subprocess,os\n"
                  f"spec=importlib.util.spec_from_file_location('o',{str(HELPER)!r});o=importlib.util.module_from_spec(spec);sys.modules['o']=o;spec.loader.exec_module(o)\n"
                  f"spec=importlib.util.spec_from_file_location('t',{str(ROOT / 'src/harness/cowork/document_table.py')!r});t=importlib.util.module_from_spec(spec);spec.loader.exec_module(t)\n"
                  f"orig=subprocess.Popen.__init__\n"
                  f"def init(self,*a,**k):\n orig(self,*a,**k); open({str(pidfile)!r},'w').write(str(self.pid))\n"
                  f"subprocess.Popen.__init__=init\n"
                  f"try: t.run_owned(['sleep','60'],o)\nexcept o.ToolError as e: open({str(pidfile)!r}+'.err','w').write(str(e))\n")
        runtime = subprocess.Popen([sys.executable, "-c",
                                    f"import subprocess,sys,time\np=subprocess.Popen([sys.executable,'-c',{script!r}])\n"
                                    f"import pathlib\nwhile not pathlib.Path({str(pidfile)!r}).exists(): time.sleep(0.05)\n"])
        self.assertEqual(runtime.wait(timeout=30), 0)
        child = int(pidfile.read_text())
        for _ in range(100):
            try:
                os.kill(child, 0)
            except ProcessLookupError:
                break
            time.sleep(0.05)
        else:
            os.kill(child, 9)
            self.fail("the extraction subprocess outlived the runtime")
        for _ in range(100):
            if Path(str(pidfile) + ".err").exists():
                break
            time.sleep(0.05)
        self.assertIn("cancelled", Path(str(pidfile) + ".err").read_text())


    # ---- OCR of PDF pages without a text layer (real dstudio-ocr helper) ----

    def scanned_pdf(self, name, pages):
        """A PDF whose pages are pictures of text (no text layer), or text
        pages for None entries: rendered by Poppler, embedded as images."""
        import zlib
        pdftoppm = shutil.which("pdftoppm") or "/opt/homebrew/bin/pdftoppm"
        self.assertTrue(Path(pdftoppm).exists(), "Poppler pdftoppm required")
        objects, kids = ["", ""], []
        for index, lines in enumerate(pages):
            office.create_pdf(self.root / "render.pdf", "Scan", "\n".join(lines))
            subprocess.run([pdftoppm, "-r", "150", "-singlefile", "-f", "1", "-l", "1", str(self.root / "render.pdf"),
                            str(self.root / "render")], check=True, capture_output=True)
            ppm = (self.root / "render.ppm").read_bytes()
            parts = ppm.split(b"\n", 3)
            width, height = map(int, parts[1].split())
            data = zlib.compress(parts[3])
            page = len(objects) + 1
            kids.append(f"{page} 0 R")
            objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 {page + 2} 0 R >> >> /Contents {page + 1} 0 R >>".encode())
            draw = b"q 595 0 0 842 0 0 cm /Im1 Do Q"
            objects.append(b"<< /Length %d >>\nstream\n" % len(draw) + draw + b"\nendstream")
            objects.append(b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceRGB /BitsPerComponent 8 "
                           b"/Filter /FlateDecode /Length %d >>\nstream\n" % (width, height, len(data)) + data + b"\nendstream")
        objects[0] = b"<< /Type /Catalog /Pages 2 0 R >>"
        objects[1] = f"<< /Type /Pages /Kids [{' '.join(kids)}] /Count {len(kids)} >>".encode()
        out, offsets = b"%PDF-1.4\n", []
        for i, obj in enumerate(objects, 1):
            offsets.append(len(out))
            out += b"%d 0 obj\n" % i + (obj if isinstance(obj, bytes) else obj.encode()) + b"\nendobj\n"
        xref = len(out)
        out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offsets)
        out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
        (self.root / name).write_bytes(out)
        for leftover in ("render.pdf", "render.ppm"):
            (self.root / leftover).unlink()

    def use_ocr_helper(self):
        helper = ROOT / "build/dstudio-ocr"
        if sys.platform != "darwin" or not helper.exists():
            self.skipTest("NOT RUN: build/dstudio-ocr (macOS Vision) is not built on this system")
        saved = os.environ.get("DSTUDIO_OCR_HELPER")
        os.environ["DSTUDIO_OCR_HELPER"] = str(helper)
        self.addCleanup(lambda: os.environ.pop("DSTUDIO_OCR_HELPER") if saved is None
                        else os.environ.__setitem__("DSTUDIO_OCR_HELPER", saved))

    def test_scanned_pdf_pages_are_ocr_read_and_matches_need_review(self):
        self.use_ocr_helper()
        self.scanned_pdf("scan.pdf", [["Course code: ST-0042", "Duration: 48 hours"], ["Owner: Zoe Martin, Bologna"]])
        doc = self.call("read_source", "scan.pdf")
        self.assertEqual(doc["extraction"], "pdf-text-layer+ocr")
        self.assertEqual(doc["ocrSegments"], ["page:1", "page:2"])
        self.assertIn("Zoe Martin", doc["segments"][1]["text"])
        self.assertIn("Duration: 48 hours", doc["segments"][0]["text"])
        self.assertIn("read with OCR", doc["notice"])
        ref = {"path": "scan.pdf", "sha256": doc["sha256"], "segment": "page:1", "quote": "Duration: 48 hours"}
        result = self.call("create", columns_json=[{"id": "hours", "type": "number", "unit": "hours"}],
                           rows_json=[{"id": "course", "cells": {"hours": self.value("48", ref)}}])
        self.assertEqual(result["summary"], {"needs_review": 1})
        self.assertIn("OCR", " ".join(result["rows"][0]["cells"]["hours"]["issues"]))

    def test_ocr_work_per_call_is_bounded_and_continues(self):
        self.use_ocr_helper()
        self.scanned_pdf("book.pdf", [[f"Chapter {i}: the lighthouse logbook entry number {i}"] for i in range(1, 4)])
        saved = dict(table._OCR)
        self.addCleanup(table._OCR.update, saved)
        read = lambda: json.loads(table.run(self.ws, {"action": "read_source", "path": "book.pdf"}, office))
        table._OCR["budget"] = 2
        first = read()
        self.assertEqual(first["ocrPendingPages"], 1)
        self.assertEqual(len(first["ocrSegments"]), 2)
        self.assertIn("call read_source again", first["notice"])
        table._OCR["budget"] = 64
        second = read()
        self.assertEqual(second["ocrPendingPages"], 0)
        self.assertEqual(second["ocrSegments"], ["page:1", "page:2", "page:3"])
        self.assertIn("logbook entry number 3", second["segments"][2]["text"])

    def test_without_an_ocr_engine_text_less_pages_stay_empty(self):
        os.environ["DSTUDIO_OCR_HELPER"] = str(self.root / "no-such-helper")
        self.addCleanup(os.environ.pop, "DSTUDIO_OCR_HELPER", None)
        self.scanned_pdf("scan.pdf", [["Course code: ST-0042", "Duration: 48 hours"]])
        doc = self.call("read_source", "scan.pdf")
        self.assertEqual(doc["ocrSegments"], [])
        self.assertFalse(doc["ocrAvailable"])
        self.assertEqual(doc["emptySegments"], ["page:1"])
        self.assertIn("no OCR engine", doc["notice"])


if __name__ == "__main__":
    unittest.main()
