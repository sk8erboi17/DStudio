"""Aggregation unit tests using synthetic receipts, not model/PDF benchmarks."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    "library_report", Path(__file__).resolve().parents[1] / "support/pdf_library_report.py")
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


class LibraryReportTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dstudio-report-unit-")
        self.addCleanup(self.temp.cleanup)
        self.run = Path(self.temp.name)
        (self.run / "reference").mkdir()
        (self.run / "inputs").mkdir()
        (self.run / "retrieval-unit").mkdir()
        docs, reads, questions, results = [], [], [], []
        for number in range(1, 4):
            id = f"{number:03d}"
            source = f"synthetic integrity bytes {id}".encode()
            (self.run / "inputs" / f"{id}.pdf").write_bytes(source)
            (self.run / "reference" / f"{id}.info.txt").write_text("Title:   \nSubject: not a title\n")
            docs.append(dict(id=id, file=f"{id}.pdf", bytes=len(source), pages=10,
                             sha256=hashlib.sha256(source).hexdigest(), sparsePages=[], referenceExtractionMs=12))
            reads.append(dict(id=id, firstReadMs=100 * number, status="pass",
                              warm=[dict(ms=10)], overview=dict(result=dict(completeText=False))))
            case = dict(id=id+"-a", document=id, page=3, question="Independent question", quote="Expected passage")
            if number == 3:
                case["groundTruth"] = "rendered-page"
            questions.append(copy.deepcopy(case))
            case.update(status="error" if number == 1 else "miss", pageRecall=number == 1, quoteRecall=number == 1,
                        cold=dict(ms=1000 * number, httpStatus=200, result=dict(hybrid=True, embeddingIndexCached=False,
                                  documentId=hashlib.sha256(source).hexdigest())),
                        warmMs=20, indexReuse=dict(ms=40, httpStatus=200, result=dict(embeddingIndexCached=True)))
            if number == 1:
                case["proof"] = dict(status="not_found")
                case["error"] = "legacy highlight assertion failed after successful retrieval"
            results.append(dict(id=id, cases=[case]))
        self.write("inventory.json", dict(root=str(self.run / "inputs"), documents=docs,
                                          summary=dict(files=3, pages=30, bytes=sum(d["bytes"] for d in docs)), referenceWallMs=50))
        self.write("read.json", dict(finished="now", documents=reads))
        self.write("questions.json", dict(cases=questions))
        self.write("retrieval-unit/retrieval.json", dict(finished="now", wallMs=6000, reader={}, embedding={}, documents=results))

    def write(self, name, value):
        (self.run / name).write_text(json.dumps(value))

    def test_separate_retrieval_from_legacy_evidence_error(self):
        s, _ = report.aggregate(self.run)
        self.assertEqual(s["retrieval"]["found"], 1)
        self.assertEqual(s["retrieval"]["total"], 3)
        self.assertEqual(s["retrieval"]["textTotal"], 2)
        self.assertEqual(s["retrieval"]["visualFound"], 0)
        self.assertEqual(s["evidence"]["matched"], 0)
        self.assertEqual(s["evidence"]["total"], 1)
        self.assertEqual(s["originalsVerifiedSha256"], 3)
        self.assertEqual(s["documents"][0]["title"], "PDF 001")

    def test_missing_question_is_not_smaller_denominator(self):
        p = self.run / "retrieval-unit/retrieval.json"
        r = json.loads(p.read_text())
        r["documents"].pop()
        self.write(str(p.relative_to(self.run)), r)
        with self.assertRaisesRegex(AssertionError, "missing"):
            report.aggregate(self.run)

    def test_duplicate_attempt_must_be_resolved_explicitly(self):
        (self.run / "retrieval-duplicate").mkdir()
        (self.run / "retrieval-duplicate/retrieval.json").write_bytes((self.run / "retrieval-unit/retrieval.json").read_bytes())
        with self.assertRaisesRegex(AssertionError, "duplicate"):
            report.aggregate(self.run)

    def test_changed_ground_truth_rejected(self):
        q = json.loads((self.run / "questions.json").read_text())
        q["cases"][0]["page"] = 4
        self.write("questions.json", q)
        with self.assertRaisesRegex(AssertionError, "ground truth changed"):
            report.aggregate(self.run)

    def test_changed_original_rejected(self):
        (self.run / "inputs/001.pdf").write_bytes(b"changed bytes")
        with self.assertRaisesRegex(AssertionError, "original changed"):
            report.aggregate(self.run)

    def test_running_batch_rejected(self):
        p = self.run / "retrieval-unit/retrieval.json"
        r = json.loads(p.read_text())
        del r["finished"]
        self.write(str(p.relative_to(self.run)), r)
        with self.assertRaisesRegex(AssertionError, "still running"):
            report.aggregate(self.run)

    def test_excluded_timing_remains_visible_in_raw_table(self):
        self.write("timing_annotations.json", dict(cases=[dict(id="002-a", excludeColdFromIndependentTiming=True,
                                                              excludeQueryTimings=True, reason="controlled unit fixture")]))
        s, _ = report.aggregate(self.run)
        self.assertEqual(s["indexFirst"]["n"], 2)
        self.assertEqual(s["queryIdentical"]["n"], 2)
        self.assertEqual(s["documents"][1]["indexedFirstMs"], 2000)
        self.assertTrue(s["documents"][1]["coldTimingExcluded"])

    def test_wrong_source_identity_rejected(self):
        p = self.run / "retrieval-unit/retrieval.json"
        r = json.loads(p.read_text())
        r["documents"][0]["cases"][0]["cold"]["result"]["documentId"] = "another PDF"
        self.write(str(p.relative_to(self.run)), r)
        with self.assertRaisesRegex(AssertionError, "different original"):
            report.aggregate(self.run)

    def test_median_and_nearest_rank_p95(self):
        s = report.stats([40, 10, 30, 20])
        self.assertEqual(s["medianMs"], 25)
        self.assertEqual(s["p95Ms"], 40)
        self.assertEqual(s["totalMs"], 100)
        self.assertIsNone(report.stats([]))

    def test_ambiguous_or_empty_boxes_are_not_highlighting_success(self):
        p = self.run / "retrieval-unit/retrieval.json"
        r = json.loads(p.read_text())
        case = r["documents"][0]["cases"][0]
        for proof, count in [(dict(status="ambiguous", boxes=[]), 0),
                             (dict(status="matched", boxes=[]), 0),
                             (dict(status="matched", boxes=[dict(x=.1, y=.2, width=.3, height=.04)]), 1)]:
            case["proof"] = proof
            self.write(str(p.relative_to(self.run)), r)
            s, _ = report.aggregate(self.run)
            self.assertEqual(s["evidence"]["matched"], count)


if __name__ == "__main__":
    unittest.main()
