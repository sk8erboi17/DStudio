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


if __name__ == "__main__":
    unittest.main()
