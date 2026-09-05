"""Real file/Poppler/OOXML tests. Candidate extraction is fixture-driven, no LLM."""
import concurrent.futures
import hashlib
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "extension/cowork/office_tool.py"
spec = importlib.util.spec_from_file_location("table_office_test", HELPER)
office = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = office
spec.loader.exec_module(office)


class DocumentTableTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dstudio-document-table-test-")
        self.root = Path(self.temp.name)
        self.ws = office.Workspace.open(str(self.root))

    def tearDown(self):
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


if __name__ == "__main__":
    unittest.main()
