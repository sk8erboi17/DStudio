"""Check the plotted public measurements, not source strings or CSS names."""
import importlib.util
import json
from pathlib import Path
import tempfile
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("pipeline_plot", ROOT / "extension/search/bench/plot-pipeline.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
data = [json.loads((module.DATA / f"2026-09-06-pipeline-{name}.json").read_text())
        for name in ("initial", "focused", "reviewed")]
fig = module.make_chart(*data)
quality, timing = fig.axes
series = [(data[0], "before"), (data[0], "after"), (data[1], "after"), (data[2], "after")]
expected_rows = []
for index, (receipt, variant) in enumerate(series):
    rows = {r["id"]: r for r in receipt["runs"] if r["variant"] == variant}
    assert quality.patches[index].get_height() == sum(r["pass"] for r in rows.values())
    expected_rows.extend(rows[i] for i in module.IDS)
assert len(timing.patches) == len(expected_rows) == 16
for bar, row in zip(timing.patches, expected_rows):
    assert abs(bar.get_height() - row["totalSeconds"]) < 1e-9
    assert bool(bar.get_hatch()) == (not row["pass"]), "Every failed answer must remain visibly marked"
with tempfile.TemporaryDirectory(prefix="dstudio-pipeline-chart-") as work:
    file = Path(work) / "chart.png"
    fig.savefig(file, dpi=80)
    pixels = plt.imread(file)
    assert pixels.shape[0] >= 600 and pixels.shape[1] >= 1100
plt.close(fig)
print("research_pipeline_chart: four full scores, all 16 measured durations/failures and actual PNG rendering passed")
