"""Behavioral export/render checks, not new benchmark or inference evidence."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("charts", ROOT / "tests/support/publish_benchmark_charts.py")
charts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(charts)


def fixture(filename):
    return json.loads((ROOT / "docs/benchmarks" / filename).read_text())


class PublishedChartsTest(unittest.TestCase):
    def test_design_preserves_failures_and_rejects_partial_comparisons(self):
        source = fixture(charts.DESIGN)
        source["results"][1]["cases"][0]["failures"] = [{"error": "PRIVATE PATH"}]
        output = charts.design_public(source)
        self.assertNotIn("PRIVATE PATH", json.dumps(output))
        self.assertEqual([r["delivered"] for r in output["results"]], [2, 2])
        self.assertEqual([r["satisfyAuditedRequirements"] for r in output["results"]], [1, 1])
        source["results"][1]["cases"].pop()
        with self.assertRaises(ValueError):
            charts.design_public(source)

    def test_pdf_exports_only_aggregate_numbers_and_hashes(self):
        source = fixture(charts.PDF)
        source.update({"schema": "dstudio.pdf-library.summary.v1",
                       "documents": [{"file": "PRIVATE PATH", "title": "PRIVATE TITLE"}],
                       "manualReview": {"equivalentPassages": ["a", "b", "c", "d"]},
                       "timingAnnotations": [],
                       "batches": [{"reader": {"sha256": "a" * 64, "binary": "PRIVATE PATH"},
                                    "embedding": {"sha256": "b" * 64, "model": "PRIVATE PATH"}}]})
        source["retrieval"]["questions"] = [{"question": "PRIVATE QUESTION", "quote": "PRIVATE QUOTE"}]
        original = copy.deepcopy(source)
        public = charts.pdf_public(source)
        self.assertEqual(source, original)
        self.assertNotIn("PRIVATE", json.dumps(public))
        self.assertEqual(public["retrieval"]["found"], 75)
        self.assertEqual(public["retrieval"]["total"], 84)
        self.assertEqual(public["evidence"]["matched"], 50)
        self.assertEqual(public["evidence"]["total"], 75)
        self.assertEqual(public["manuallyReviewedAlternatePassages"], 4)
        source["originalsVerifiedSha256"] = 77
        with self.assertRaises(ValueError):
            charts.pdf_public(source)

    def test_invalid_timings_are_not_presented_as_measurements(self):
        for invalid in (float("nan"), float("inf"), -1, "1", True):
            source = {"n": 3, "totalMs": 10, "medianMs": invalid, "p95Ms": 5, "maxMs": 5}
            with self.assertRaises(ValueError):
                charts.stats(source)

    def test_actual_charts_encode_public_values_and_render(self):
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from PIL import Image, ImageStat
        from unittest.mock import patch
        with tempfile.TemporaryDirectory(prefix="dstudio-charts-") as tmp:
            output = Path(tmp)
            figures = []
            close = plt.close
            with patch.object(plt, "close", side_effect=lambda f: figures.append(f) if hasattr(f, "axes") else None):
                main = fixture(charts.MAIN)
                charts.main_chart(plt, main, output)
                charts.design_chart(plt, fixture(charts.DESIGN), output)
                charts.pdf_chart(plt, fixture(charts.PDF), output)
            self.assertEqual(len(figures), 3)
            expected = [main["results"][0]["comparison"][k][v]["prefill"]["median"]
                        for v in ("before", "after") for k in ("csv-copy", "numeric-sort", "record-extraction")]
            self.assertEqual([p.get_height() for p in figures[0].axes[0].patches], expected)
            self.assertEqual([p.get_height() for p in figures[1].axes[0].patches], [2, 1, 2, 1])
            for figure in figures:
                close(figure)
            pngs = list(output.glob("*.png"))
            self.assertEqual(len(pngs), 3)
            for png in pngs:
                with Image.open(png) as image:
                    self.assertGreater(image.width, 1000)
                    self.assertGreater(image.height, 600)
                    self.assertGreater(max(ImageStat.Stat(image.convert("RGB")).stddev), 20)

    def test_failed_measured_answers_cannot_produce_a_speed_chart(self):
        import matplotlib.pyplot as plt
        source = fixture(charts.MAIN)
        source["results"][0]["comparison"]["csv-copy"]["before"]["allCorrect"] = False
        with tempfile.TemporaryDirectory(prefix="dstudio-chart-rejection-") as tmp:
            with self.assertRaises(ValueError):
                charts.main_chart(plt, source, Path(tmp))
            self.assertFalse(list(Path(tmp).glob("*.png")))
        plt.close("all")


if __name__ == "__main__":
    unittest.main()
