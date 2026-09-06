#!/usr/bin/env python3
"""Execute real coordinator/shell dispatch with explicitly simulated image workers."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]


def main():
    with tempfile.TemporaryDirectory(prefix="dstudio-image-presets-") as temporary:
        base = Path(temporary)
        prompt = base / "prompt.txt"
        text = 'Draw a cobalt engraving. The word "preset" is part of this prompt, not a setting.'
        prompt.write_text(text)
        env = dict(os.environ, DSTUDIO_IMAGE_TEST_MODE="1", DSTUDIO_IDEOGRAM4_TEST_MODE="1",
                   DSTUDIO_HEAVY_MODEL_DIR=str(base / "lock"))
        for name, steps, quality, width, height in [
            ("low", 12, "turbo-12", 1024, 576),
            ("medium", 20, "default-20", 1024, 576),
            ("high", 48, "quality-48", 1024, 576),
            ("max", 48, "quality-48", 2048, 1152),
            (None, 48, "quality-48", 2048, 1152),
        ]:
            out = base / (name or "legacy")
            status = out / "status.json"
            cmd = [str(ROOT / "scripts/image-pipeline-run.sh"), "--prompt-file", str(prompt),
                   "--outdir", str(out), "--status-file", str(status), "--action", "generate"]
            if name:
                cmd += ["--preset", name]
            subprocess.run(cmd, env=env, check=True, timeout=20, capture_output=True)
            result = json.loads(status.read_text())
            assert result["state"] == "complete" and result["simulated"] is True
            assert (result["preset"], result["steps"], result["quality"]) == (name or "max", steps, quality)
            assert (result["requestedWidth"], result["requestedHeight"]) == (width, height)
            assert (out / "ideogram4-test.png").read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
            caption = json.loads((out / "ideogram-caption.json").read_text())
            assert caption["high_level_description"] == text
            receipt = json.loads((out / "image-pipeline-provenance.json").read_text())
            assert receipt["preset"] == (name or "max")
            assert not (out / "worker.pid").exists()

        for invalid in ("Medium", "turbo", "", "maxxxxxxxxx", "20"):
            out = base / "invalid"
            completed = subprocess.run([str(ROOT / "scripts/ideogram4-generate.sh"), str(prompt),
                                        str(out), str(out / "status.json"), "16:9", "0", invalid],
                                       env=env, capture_output=True, timeout=5)
            assert completed.returncode == 2, (invalid, completed.stderr)
            assert b"Unsupported image preset" in completed.stderr
    print("image presets: all coordinator/shell mappings and legacy default passed (simulated workers)")


if __name__ == "__main__":
    main()
