"""Validate plotted data, not source spellings; no inference is performed."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
BENCH = ROOT / "extension/benchmarks/qwen-quality"
spec = importlib.util.spec_from_file_location("qwen_quality_plot", BENCH / "plot-results.py")
plot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plot)


class QualityChartTest(unittest.TestCase):
    def setUp(self):
        self.data = json.loads((BENCH / "results/2026-09-09-qwen27-common100.json").read_text())

    def test_actual_bars_denominators_and_no_input_mutation(self):
        original = copy.deepcopy(self.data)
        figure = plot.make_figure(self.data)
        try:
            bars = figure.axes[0].patches
            self.assertEqual([bar.get_width() for bar in bars[:10]], [row["passed"] for row in self.data["categories"]])
            self.assertEqual([bar.get_width() for bar in bars[10:]], [row["failed"] for row in self.data["categories"]])
            self.assertEqual(sum(bar.get_width() for bar in bars), 100)
            self.assertEqual(sum(bar.get_width() for bar in bars[:10]), 61)
            self.assertEqual(figure.axes[0].get_xlim()[0], 0)
            labels = [text.get_text() for text in figure.axes[0].texts]
            self.assertEqual(labels, [f"{row['passed']} / {row['cases']}" for row in self.data["categories"]])
            self.assertEqual(self.data, original)
        finally:
            plot.plt.close(figure)

    def test_inconsistent_incomplete_and_simulated_inputs_rejected(self):
        mutations = [lambda d: d["categories"].pop(), lambda d: d["summary"].update(pending=1),
                     lambda d: d["summary"].update(passed=62), lambda d: d["categories"][0].update(passed=-1),
                     lambda d: d["categories"][0].update(passed=2.5), lambda d: d["categories"][0].update(passed=True),
                     lambda d: d["failures"].update(transport_or_engine_error=7),
                     lambda d: d.update(evaluationUse="simulated"),
                     lambda d: d.update(sourceReceiptSha256="0" * 64),
                     lambda d: d["categories"][0].update(area="reasoning")]
        for mutation in mutations:
            data = copy.deepcopy(self.data); mutation(data)
            with self.subTest(data=data["summary"]):
                with self.assertRaises(ValueError):
                    plot.make_figure(data)

    def test_unexecuted_tasks_are_drawn_and_counted(self):
        data = copy.deepcopy(self.data)
        row = data["categories"][-1]
        moved = row["passed"]
        row.update(passed=0, notRun=moved)
        data["summary"].update(passed=61 - moved, notRun=moved)
        data["failures"]["not_run"] = moved
        figure = plot.make_figure(data)
        try:
            bars = figure.axes[0].patches
            self.assertEqual(len(bars), 21)
            self.assertEqual(bars[20].get_width(), moved)
            self.assertEqual(bars[20].get_x(), row["failed"])
            self.assertEqual(sum(bar.get_width() for bar in bars), 100)
            self.assertEqual(figure.axes[0].texts[-1].get_text(), f"0 / {row['cases']} · {moved} not run")
            self.assertIn(f"{moved} tasks not run", " ".join(text.get_text() for text in figure.texts))
        finally:
            plot.plt.close(figure)

    def test_every_reviewed_run_is_published_with_its_own_receipt(self):
        for digest, review in plot.REVIEWED.items():
            data = json.loads((plot.folder(review) / "results" / review["results"]).read_text())
            self.assertEqual(data["sourceReceiptSha256"], digest)
            self.assertIs(plot.validate(data), review)
            self.assertTrue((plot.folder(review) / review["chart"]).is_file(), review["chart"])

    def test_overview_shows_each_run_once_with_its_full_denominator(self):
        for family in plot.FAMILIES:
            runs = [json.loads((plot.folder(family) / "results" / name).read_text()) for name in family["results"]]
            figure = plot.make_family_figure(runs, family["title"], family["caption"])
            try:
                bars = figure.axes[0].patches
                self.assertEqual([bar.get_width() for bar in bars[:len(runs)]], [run["summary"]["passed"] for run in runs])
                self.assertEqual(sum(bar.get_width() for bar in bars), 100 * len(runs))
                self.assertEqual([text.get_text().split(" / ")[0] for text in figure.axes[0].texts],
                                 [str(run["summary"]["passed"]) for run in runs])
                self.assertEqual(figure.axes[0].get_xlim(), (0, 100))
            finally:
                plot.plt.close(figure)
            with self.assertRaises(ValueError):
                plot.make_family_figure(runs + runs[:1], family["title"], family["caption"])
            other = copy.deepcopy(runs); other[0]["corpus"] = "0" * 64
            with self.assertRaises(ValueError):
                plot.make_family_figure(other, family["title"], family["caption"])
            self.assertTrue((plot.folder(family) / family["chart"]).is_file())
        with self.assertRaises(ValueError):
            plot.make_family_figure([], "title", "caption")


if __name__ == "__main__":
    unittest.main()
