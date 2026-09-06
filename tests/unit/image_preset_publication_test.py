#!/usr/bin/env python3
"""Execute Matplotlib/export checks with synthetic timings, never publish them."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("image_preset_charts", ROOT / "extension/benchmarks/image-presets/plot-results.py")
charts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(charts)


class ImagePresetPublicationTest(unittest.TestCase):
    def data(self):
        return {"realInference": True, "plan": [{"case": "hermes-hero-art", "preset": p} for p in charts.PRESETS],
                "runs": [
                    {"case": "hermes-hero-art", "preset": "low", "state": "generated", "elapsedSeconds": 120,
                     "review": {"promptAdherencePass": False}},
                    {"case": "hermes-hero-art", "preset": "medium", "state": "generated", "elapsedSeconds": 240,
                     "review": {"promptAdherencePass": True}},
                    {"case": "hermes-hero-art", "preset": "high", "state": "timeout", "elapsedSeconds": 10800},
                ]}

    def test_real_chart_values_preserve_failed_quality_and_missing_runs(self):
        fig = charts.timing_figure(self.data())
        ax = fig.axes[0]
        self.assertEqual([bar.get_height() for bar in ax.patches], [2, 4])
        self.assertEqual(ax.patches[0].get_hatch(), "//")
        self.assertIsNone(ax.patches[1].get_hatch())
        self.assertEqual([label.get_text() for label in ax.texts], ["2m 00s", "4m 00s", "timeout", "not run"])
        self.assertIn("2/4", fig._suptitle.get_text())
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "chart.png"
            fig.savefig(image)
            self.assertGreater(image.stat().st_size, 1000)
            self.assertEqual(charts.plt.imread(image).ndim, 3)
        charts.plt.close(fig)

    def test_reject_invalid_timing(self):
        for bad in (-1, float("inf"), float("nan")):
            data = self.data()
            data["runs"][0]["elapsedSeconds"] = bad
            with self.assertRaises(ValueError):
                charts.timing_figure(data)
        charts.plt.close("all")

    def test_chart_labels_use_receipt_hardware_not_the_developers_machine(self):
        data = self.data()
        data.update(hardware="Fixture processor", memoryBytes=32 * 2**30, sharedHost=False)
        fig = charts.timing_figure(data)
        self.assertIn("Fixture processor · 32 GiB · dedicated host", fig.texts[-1].get_text())
        charts.plt.close(fig)
        fig = charts.timing_figure(self.data())
        self.assertIn("Hardware not recorded · RAM not recorded · host sharing not recorded", fig.texts[-1].get_text())
        self.assertNotIn("Apple M2 Max", fig.texts[-1].get_text())
        charts.plt.close(fig)

    def test_subject_panels_share_the_same_time_scale(self):
        data = self.data()
        data["plan"].extend({"case": "hermes-portrait-art", "preset": p} for p in charts.PRESETS)
        data["runs"].append({"case": "hermes-portrait-art", "preset": "max", "state": "generated",
                             "elapsedSeconds": 6000, "review": {"promptAdherencePass": False}})
        fig = charts.timing_figure(data)
        self.assertEqual(fig.axes[0].get_ylim(), fig.axes[1].get_ylim())
        self.assertGreater(fig.axes[0].get_ylim()[1], 100)
        self.assertEqual(fig.axes[1].patches[0].get_height(), 100)
        charts.plt.close(fig)

    def test_gallery_titles_do_not_overlap_original_image_pixels(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            data = {"plan": [], "runs": []}
            for case, width, height in (("hermes-hero-art", 64, 36), ("hermes-portrait-art", 48, 64)):
                filename = f"{case}.png"
                charts.plt.imsave(base / filename, np.full((height, width, 3), .5))
                for preset in charts.PRESETS:
                    key = {"case": case, "preset": preset}
                    data["plan"].append(key)
                    data["runs"].append(dict(key, state="generated", image=filename,
                                            expectedSize=[width, height], review={"promptAdherencePass": False}))
            fig = charts.gallery_figure(data, base)
            fig.canvas.draw()
            renderer = fig.canvas.get_renderer()
            pixels = [ax.images[0].get_window_extent(renderer) for ax in fig.axes]
            for ax in fig.axes:
                title = ax.title.get_window_extent(renderer)
                self.assertFalse(any(title.overlaps(bounds) for bounds in pixels))
            for label in [*fig.texts, *(ax.title for ax in fig.axes)]:
                bounds = label.get_window_extent(renderer)
                self.assertGreaterEqual(bounds.x0, fig.bbox.x0)
                self.assertGreaterEqual(bounds.y0, fig.bbox.y0)
                self.assertLessEqual(bounds.x1, fig.bbox.x1)
                self.assertLessEqual(bounds.y1, fig.bbox.y1)
            charts.plt.close(fig)

    def test_export_requires_review_and_exact_pixels(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            raw = base / "raw"
            out = base / "public"
            raw.mkdir()
            out.mkdir()
            image = raw / "output.png"
            image.write_bytes(b"fixture bytes used only to exercise digest validation")
            digest = hashlib.sha256(image.read_bytes()).hexdigest()
            data = self.data()
            data["runs"] = [data["runs"][0]]
            row = data["runs"][0]
            row.update(image="output.png", outputSha256=digest, privateLocalPath="/private/test/path", secret="test-only")
            (raw / "results.json").write_text(json.dumps(data))
            reviews = base / "reviews.json"
            reviews.write_text(json.dumps({"method": "synthetic unit fixture", "reviews": []}))
            with self.assertRaisesRegex(ValueError, "visual review missing"):
                charts.public_results(raw, reviews, out)
            review = {"case": row["case"], "preset": row["preset"], "outputSha256": digest, "promptAdherencePass": False}
            reviews.write_text(json.dumps({"method": "synthetic unit fixture", "reviews": [review]}))
            public = charts.public_results(raw, reviews, out)
            self.assertNotIn("privateLocalPath", public["runs"][0])
            self.assertNotIn("secret", public["runs"][0])
            self.assertFalse(public["runs"][0]["review"]["promptAdherencePass"])
            image.write_bytes(b"changed pixels")
            with self.assertRaisesRegex(ValueError, "digest"):
                charts.public_results(raw, reviews, out)
            data["realInference"] = False
            (raw / "results.json").write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, "simulated"):
                charts.public_results(raw, reviews, out)


if __name__ == "__main__":
    unittest.main()
