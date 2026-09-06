"""Verify plotted measurements/failures and actual rendering, not source strings."""
import importlib.util
import json
from pathlib import Path
import tempfile
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("answer_review_plot", ROOT / "extension/search/bench/plot-answer-review.py")
plot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plot)
data = [json.loads((plot.DATA / name).read_text()) for name in (
    "2026-09-06-pipeline-reviewed.json", "2026-09-06-review-generic.json",
    "2026-09-06-review-parser-failure.json", "2026-09-06-review-unsupported-gap.json",
    "2026-09-06-review-definitions.json")]
fig = plot.make_chart(*data)
quality, timing = fig.axes
expected = []
for index, receipt in enumerate(data):
    rows = {row["id"]: row for row in receipt["runs"]}
    assert quality.patches[index].get_height() == sum(row["pass"] for row in rows.values())
    expected.extend(rows[key] for key in plot.IDS)
assert len(timing.patches) == len(expected) == 20
for bar, row in zip(timing.patches, expected):
    assert abs(bar.get_height() - row["totalSeconds"]) < 1e-9
    assert bool(bar.get_hatch()) == (not row["pass"])
assert all(axis.get_ylim()[0] == 0 for axis in fig.axes)
with tempfile.TemporaryDirectory(prefix="dstudio-answer-review-chart-") as work:
    file = Path(work) / "chart.png"
    fig.savefig(file, dpi=100)
    pixels = plt.imread(file)
    assert pixels.shape[0] >= 700 and pixels.shape[1] >= 1300
plt.close(fig)
print("research_answer_review_chart: all five full scores, 20 measured durations/failures, zero baselines and rendered PNG passed")
