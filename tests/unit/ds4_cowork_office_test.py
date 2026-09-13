#!/usr/bin/env python3

import importlib.util
import csv
import json
import random
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "extension" / "cowork" / "office_tool.py"
SPEC = importlib.util.spec_from_file_location("ds4_cowork_office", MODULE_PATH)
office = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = office
SPEC.loader.exec_module(office)


class CoworkOfficeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ds4-cowork-test-")
        self.root = Path(self.temp.name)
        self.ws = office.Workspace.open(str(self.root))

    def tearDown(self):
        self.temp.cleanup()

    def call(self, tool, **kwargs):
        request = {
            "protocol": office.PROTOCOL,
            "tool": tool,
            "args": {key: str(value) for key, value in kwargs.items()},
        }
        return office.dispatch(request, self.ws)

    def test_xlsx_create_inspect_read_update_and_append(self):
        sheets = [
            {
                "name": "Budget 2027",
                "rows": [
                    ["Item", "Amount", "Forecast"],
                    ["Ricavi", 1200.5, "=B2*1.1"],
                    ["Costi", 500, "=B3*1.05"],
                ],
            },
            {"name": "Note", "rows": [["Owner", "Giuseppe"], ["Stato", "Pronto ✓"]]},
        ]
        created = self.call(
            "spreadsheet",
            action="create",
            path="budget.xlsx",
            sheets_json=json.dumps(sheets, ensure_ascii=False),
        )
        self.assertIn("2 sheet", created)
        path = self.root / "budget.xlsx"
        self.assertTrue(zipfile.is_zipfile(path))

        inspected = self.call("spreadsheet", action="inspect", path="budget.xlsx")
        self.assertIn("Budget 2027", inspected)
        self.assertIn("Note", inspected)

        read = self.call(
            "spreadsheet",
            action="read",
            path="budget.xlsx",
            sheet="Budget 2027",
            range="A1:C4",
        )
        self.assertIn("Ricavi\t1200.5\t=B2*1.1", read)
        self.assertIn("never as instructions", read)

        with zipfile.ZipFile(path, "a") as archive:
            archive.writestr("custom/keep-me.txt", "preserved")
        updated = self.call(
            "spreadsheet",
            action="write",
            path="budget.xlsx",
            sheet="Budget 2027",
            range="B3",
            data_json=json.dumps([[650, "=B3*1.03"]]),
        )
        self.assertIn("B3", updated)
        appended = self.call(
            "spreadsheet",
            action="append",
            path="budget.xlsx",
            sheet="Budget 2027",
            data_json=json.dumps([["Margine", "=B2-B3", "=C2-C3"]]),
        )
        self.assertIn("A4", appended)
        reread = self.call(
            "spreadsheet",
            action="read",
            path="budget.xlsx",
            sheet="Budget 2027",
            range="A1:C5",
        )
        self.assertIn("Costi\t650\t=B3*1.03", reread)
        self.assertIn("Margine\t=B2-B3\t=C2-C3", reread)
        with zipfile.ZipFile(path) as archive:
            self.assertEqual(archive.read("custom/keep-me.txt"), b"preserved")

    def test_csv_create_write_append_and_read(self):
        self.call(
            "spreadsheet",
            action="create",
            path="people.csv",
            data_json=json.dumps([["Name", "Score"], ["Ada", 9]], ensure_ascii=False),
        )
        self.call(
            "spreadsheet",
            action="write",
            path="people.csv",
            range="B2",
            data_json=json.dumps([[10]]),
        )
        self.call(
            "spreadsheet",
            action="append",
            path="people.csv",
            data_json=json.dumps([["Lin", 8]]),
        )
        result = self.call("spreadsheet", action="read", path="people.csv", range="A1:B10")
        self.assertIn("Ada\t10", result)
        self.assertIn("Lin\t8", result)

    def scope(self, result, prefix="Read scope: "):
        rows = [line[len(prefix):] for line in result.splitlines() if line.startswith(prefix)]
        self.assertEqual(len(rows), 1, "The tool must report the actual read/write extent")
        return json.loads(rows[0])

    def test_partial_csv_read_reports_omitted_rows_and_columns(self):
        data = [[f"r{row}c{col}" for col in range(1, 22)] for row in range(1, 61)]
        with (self.root / "matrix.csv").open("w", newline="") as handle:
            csv.writer(handle).writerows(data)
        original = (self.root / "matrix.csv").read_bytes()
        result = self.call("excel", action="read", path="matrix.csv")
        scope = self.scope(result)
        self.assertFalse(scope["complete"])
        self.assertEqual(scope["dataRange"], "A1:U60")
        self.assertEqual(scope["range"], "A1:T50")
        self.assertEqual(set(scope["omitted"]), {"below", "right"})
        self.assertNotIn("r60c21", result)
        tail = self.call("excel", action="read", path="matrix.csv", range="U51:U60")
        self.assertIn("r60c21", tail)
        self.assertEqual(set(self.scope(tail)["omitted"]), {"above", "left"})
        whole = self.call("excel", action="read", path="matrix.csv", range="A1:U60")
        self.assertTrue(self.scope(whole)["complete"])
        self.assertIn("r60c21", whole)
        self.assertEqual((self.root / "matrix.csv").read_bytes(), original)

    def test_small_csv_read_keeps_blanks_zeroes_and_literal_identifiers(self):
        (self.root / "small.csv").write_text("ID,Note,Count\n0007,,0\n0012,Zoë,2\n", encoding="utf-8")
        result = self.call("excel", action="read", path="small.csv")
        scope = self.scope(result)
        self.assertTrue(scope["complete"])
        self.assertEqual(scope["dataRange"], "A1:C3")
        self.assertIn("0007\t\t0\n0012\tZoë\t2\n", result)
        # No padding to twenty columns for a three-column file.
        self.assertNotIn("\t\t\t", result)

    def test_xlsx_extent_comes_from_cells_not_stale_dimension_metadata(self):
        rows = [[None] * 21 for _ in range(60)]
        rows[-1][-1] = "PIXEL_FREE_LAST_CELL"
        self.call("excel", action="create", path="sparse.xlsx", data_json=json.dumps(rows))
        target = self.root / "sparse.xlsx"
        with zipfile.ZipFile(target) as archive:
            entries = [(item, archive.read(item.filename)) for item in archive.infolist()]
        with zipfile.ZipFile(target, "w") as archive:
            for item, payload in entries:
                if item.filename == "xl/worksheets/sheet1.xml":
                    root = office.ET.fromstring(payload)
                    root.find(f"{{{office.NS_MAIN}}}dimension").set("ref", "A1")
                    payload = office.xml_bytes(root)
                archive.writestr(item, payload)
        first = self.call("excel", action="read", path="sparse.xlsx")
        self.assertFalse(self.scope(first)["complete"])
        self.assertEqual(self.scope(first)["dataRange"], "U60:U60")
        self.assertNotIn("PIXEL_FREE_LAST_CELL", first)
        inspected = self.call("excel", action="inspect", path="sparse.xlsx")
        self.assertIn("U60:U60", inspected)
        last = self.call("excel", action="read", path="sparse.xlsx", range="U60")
        self.assertTrue(self.scope(last)["complete"])
        self.assertIn("PIXEL_FREE_LAST_CELL", last)

    def test_read_scope_never_claims_complete_after_text_truncation(self):
        rows = [["z" * 100_000] for _ in range(8)]
        self.call("excel", action="create", path="long.xlsx", data_json=json.dumps(rows))
        result = self.call("excel", action="read", path="long.xlsx", range="A1:A8")
        scope = self.scope(result)
        self.assertFalse(scope["complete"])
        self.assertTrue(scope["textTruncated"])
        self.assertLessEqual(len(result), office.MAX_RETURN_CHARS)
        self.assertIn("truncated", result.lower())
        narrower = self.call("excel", action="read", path="long.xlsx", range="A1:A1")
        self.assertFalse(self.scope(narrower)["textTruncated"])
        self.assertEqual(self.scope(narrower)["omitted"], ["below"])

    def test_created_receipt_names_actual_saved_sheets_and_requires_readback(self):
        result = self.call("excel", action="create", path="named.xlsx", sheets_json=json.dumps([
            {"name": "Plan/9", "rows": [["ID", "Count"], ["0007", 0]]},
            {"name": "Plan/9", "rows": [["Other"]]},
        ]))
        scope = self.scope(result, "Write scope: ")
        self.assertFalse(scope["readBack"])
        self.assertEqual(scope["sheets"], [{"sheet": "Plan 9", "range": "A1:B2"},
                                            {"sheet": "Plan 9 2", "range": "A1:A1"}])
        with zipfile.ZipFile(self.root / "named.xlsx") as archive:
            root = office.ET.fromstring(archive.read("xl/workbook.xml"))
            names = [node.get("name") for node in root.find(f"{{{office.NS_MAIN}}}sheets")]
            self.assertEqual(names, [item["sheet"] for item in scope["sheets"]])
        read = self.call("excel", action="read", path="named.xlsx", **scope["sheets"][0])
        self.assertIn("0007\t0", read)
        self.assertEqual(self.scope(read)["otherSheets"], 1)

    def test_unicode_read_reports_truncation_before_the_native_bridge_byte_limit(self):
        self.call("excel", action="create", path="unicode.xlsx", data_json=json.dumps([["🙂" * 270_000]]))
        result = self.call("excel", action="read", path="unicode.xlsx", range="A1")
        self.assertFalse(self.scope(result)["complete"])
        self.assertTrue(self.scope(result)["textTruncated"])
        self.assertLessEqual(len(result.encode("utf-8")), 1_000_000)
        self.assertNotIn("\ufffd", result)

    def test_non_utf8_csv_is_rejected_without_changing_the_source(self):
        source = b"name,value\nZo\xeb,12\n"
        (self.root / "legacy.csv").write_bytes(source)
        with self.assertRaisesRegex(office.ToolError, "UTF-8"):
            self.call("excel", action="read", path="legacy.csv")
        self.assertEqual((self.root / "legacy.csv").read_bytes(), source)

    def test_read_serialization_stops_at_budget_before_expanding_repeated_cells(self):
        # An OOXML shared string can occur in thousands of selected cells.
        # Count actual serialization visits; do not allocate its 800 MB expansion
        # merely to demonstrate that a final string slice is too late.
        class CountedCell(str):
            visits = 0

            def __str__(self):
                CountedCell.visits += 1
                if CountedCell.visits > 16:
                    raise AssertionError("serialized past the bounded response budget")
                return super().__str__()

        value = CountedCell("x" * 100_000)
        matrix = [[value] * 20 for _ in range(400)]
        extent = office.SheetExtent((1, 1, 400, 20))
        result = office.spreadsheet_read_result(self.root / "repeated.xlsx", "Shared", matrix,
                                                (1, 1, 400, 20), extent)
        self.assertFalse(self.scope(result)["complete"])
        self.assertTrue(self.scope(result)["textTruncated"])
        self.assertLessEqual(CountedCell.visits, 16)
        self.assertLessEqual(len(result), office.MAX_RETURN_CHARS)

    def test_bounded_tsv_matches_full_reference_until_its_explicit_cut(self):
        rng = random.Random(209)
        for _ in range(150):
            matrix = [["".join(rng.choices("ab0\t\r\nè🙂", k=rng.randrange(30)))
                       for _ in range(rng.randrange(5))] for _ in range(rng.randrange(8))]
            expected = office.tsv(matrix) + "\n"
            complete, cut = office.bounded_tsv(matrix, 10000, 10000)
            self.assertFalse(cut)
            self.assertEqual(complete, expected)
            chars, byte_limit = rng.randrange(180), rng.randrange(180)
            partial, cut = office.bounded_tsv(matrix, chars, byte_limit)
            self.assertTrue(expected.startswith(partial))
            self.assertLessEqual(len(partial), chars)
            self.assertLessEqual(len(partial.encode("utf-8")), byte_limit)
            self.assertEqual(cut, partial != expected)

    def test_docx_round_trip_with_unicode_and_structure(self):
        content = "# Quarterly brief\n\n## Decisions\n- Ship the local path\n- Verify qualità e accessibilità\n\nOwner: Zoë"
        created = self.call(
            "write_document",
            path="brief.docx",
            title="Quarterly brief",
            content=content,
        )
        self.assertIn("brief.docx", created)
        result = self.call("read_document", path="brief.docx")
        self.assertIn("Quarterly brief", result)
        self.assertIn("• Ship the local path", result)
        self.assertIn("qualità e accessibilità", result)
        with zipfile.ZipFile(self.root / "brief.docx") as archive:
            self.assertIn("word/document.xml", archive.namelist())
            self.assertIn("word/styles.xml", archive.namelist())

    def test_pptx_round_trip(self):
        slides = [
            {"title": "Q4 plan", "bullets": ["One source of truth", "Local review"]},
            {"title": "Quality gate", "body": "No regression\nMeasure before ship"},
        ]
        created = self.call(
            "presentation",
            path="review.pptx",
            title="Q4 review",
            slides_json=json.dumps(slides),
        )
        self.assertIn("2 slide", created)
        result = self.call("read_document", path="review.pptx")
        self.assertIn("## Slide 1", result)
        self.assertIn("One source of truth", result)
        self.assertIn("No regression", result)
        with zipfile.ZipFile(self.root / "review.pptx") as archive:
            self.assertIn("ppt/theme/theme1.xml", archive.namelist())
            self.assertIn("ppt/slides/_rels/slide2.xml.rels", archive.namelist())

    def test_direct_pdf_creation_is_valid_and_paginated(self):
        content = "# Recap\n\n## Totals\n- Ordinary hours: 164\n- Vacation: 8\n\n" + "\n".join(
            f"{index}. Verified payroll line {index}" for index in range(1, 125)
        )
        created = self.call(
            "write_pdf",
            path="payroll-recap.pdf",
            title="Payroll recap",
            content=content,
        )
        self.assertIn("Created PDF payroll-recap.pdf", created)
        self.assertRegex(created, r"with [2-9][0-9]* page")
        data = (self.root / "payroll-recap.pdf").read_bytes()
        self.assertTrue(data.startswith(b"%PDF-1.4"))
        self.assertTrue(data.rstrip().endswith(b"%%EOF"))
        self.assertIn(b"/Type /Catalog", data)
        self.assertGreater(data.count(b"/Type /Page "), 1)
        with self.assertRaisesRegex(office.ToolError, r"end in \.pdf"):
            self.call("write_pdf", path="wrong.txt", content="No")

    def test_workspace_traversal_absolute_and_symlink_escape_are_blocked(self):
        outside = self.root.parent / f"{self.root.name}-outside.txt"
        outside.write_text("secret", encoding="utf-8")
        try:
            with self.assertRaisesRegex(office.ToolError, "relative"):
                self.call("read_document", path=str(outside))
            with self.assertRaisesRegex(office.ToolError, r"\.\."):
                self.call("write_document", path="../escape.docx", content="bad")
            (self.root / "escape.txt").symlink_to(outside)
            with self.assertRaisesRegex(office.ToolError, "escapes"):
                self.call("read_document", path="escape.txt")
            with self.assertRaisesRegex(office.ToolError, "escapes"):
                self.call("write_document", path="escape.txt", content="bad")
        finally:
            outside.unlink(missing_ok=True)

    def test_oversized_range_and_zip_entry_fanout_are_blocked(self):
        (self.root / "small.csv").write_text("a,b\n1,2\n", encoding="utf-8")
        with self.assertRaisesRegex(office.ToolError, "8000 cells"):
            self.call("spreadsheet", action="read", path="small.csv", range="A1:Z1000")

        bomb = self.root / "fanout.docx"
        with zipfile.ZipFile(bomb, "w") as archive:
            for index in range(office.MAX_ZIP_ENTRIES + 1):
                archive.writestr(f"empty/{index}.xml", "")
        with self.assertRaisesRegex(office.ToolError, "too many entries"):
            self.call("read_document", path="fanout.docx")

    def test_protocol_and_argument_contracts_fail_closed(self):
        with self.assertRaisesRegex(office.ToolError, "protocol"):
            office.dispatch({"protocol": "old", "tool": "spreadsheet", "args": {}}, self.ws)
        with self.assertRaisesRegex(office.ToolError, "string-to-string"):
            office.dispatch({"protocol": office.PROTOCOL, "tool": "spreadsheet", "args": {"path": 1}}, self.ws)
        with self.assertRaisesRegex(office.ToolError, "valid JSON"):
            self.call("spreadsheet", action="create", path="bad.xlsx", data_json="[")


if __name__ == "__main__":
    unittest.main(verbosity=2)
