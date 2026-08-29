#!/usr/bin/env python3

import importlib.util
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
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
