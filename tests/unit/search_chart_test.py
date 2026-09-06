"""Exercise plotted values and a real PNG; no new benchmark measurements."""
import importlib.util
import json
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("search_chart", root / "extension/search/bench/plot-results.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
data = json.loads(module.DATA.read_text())
figure = module.make_chart(data)
quality, timing = figure.axes
assert [bar.get_height() for bar in quality.patches] == [3, 8]
assert len(timing.collections) == 16, "Do not hide failed/slow cases"
plotted = sorted(float(points.get_offsets()[0][0]) for points in timing.collections)
expected = sorted(row["timings"]["totalMs"] / 1000 for row in data["current"]["runs"])
assert plotted == expected
with tempfile.TemporaryDirectory(prefix="dstudio-search-chart-") as directory:
    png = Path(directory) / "chart.png"
    figure.savefig(png, dpi=80)
    assert png.read_bytes().startswith(b"\x89PNG\r\n\x1a\n") and png.stat().st_size > 10000
module.plt.close(figure)
print("search_chart: all 16 durations, 3/8 and 8/8 bars, PNG rendering passed")
