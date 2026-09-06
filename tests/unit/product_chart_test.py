import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2] / 'extension/benchmarks/product-comparison'
spec = importlib.util.spec_from_file_location('product_plot', ROOT / 'plot-results.py')
plot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plot)


class ProductPlotTest(unittest.TestCase):
    def test_actual_measurements_and_failed_deadline(self):
        data = json.loads((ROOT / 'results/2026-09-06-m2-max.json').read_text())
        fig = plot.make_figure(data)
        bars = [bar for ax in fig.axes for bar in ax.patches]
        self.assertEqual(len(bars), len(data['runs']))
        for bar, row in zip(bars, data['runs']):
            expected = row['elapsedSeconds'] if row['elapsedSeconds'] is not None else row['deadlineSeconds']
            self.assertAlmostEqual(bar.get_height(), expected)
            self.assertEqual(bool(bar.get_hatch()), not row['pass'])
        self.assertEqual(sum(row['pass'] for row in data['runs']), 5)
        self.assertTrue(all(ax.get_ylim()[0] == 0 for ax in fig.axes))
        plot.plt.close(fig)


if __name__ == '__main__':
    unittest.main()
