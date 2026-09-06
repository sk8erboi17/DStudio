#!/usr/bin/env python3
"""Sequential, real local Ideogram preset renders. Never enables fixture mode.

The source images at https://hermes-agent.nousresearch.com/ are art-direction
references described in the two public captions, not pixel inputs to Ideogram.
This measures the production shell/worker, not chat prompt-authoring latency.
Each run includes a fresh Comfy process, model load, sampling, decode and exit.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("ideogram_worker", ROOT / "scripts/ideogram4-run.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def save(path, value):
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value, indent=2) + "\n")
    temp.replace(path)


def terminate(process):
    if process.poll() is None:
        process.send_signal(signal.SIGTERM)
        try:
            process.wait(timeout=60)  # worker gets 45 s to release its Comfy child
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
            raise RuntimeError("worker did not acknowledge cancellation; inspect owned processes before continuing")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cases", nargs="+", choices=("hermes-hero", "hermes-portrait", "hermes-hero-art", "hermes-portrait-art"),
                        default=["hermes-hero-art", "hermes-portrait-art"])
    parser.add_argument("--presets", nargs="+", choices=tuple(worker.PRESETS), default=list(worker.PRESETS))
    parser.add_argument("--timeout-seconds", type=int, default=10800)
    parser.add_argument("--seed", type=int, default=271828)
    args = parser.parse_args()
    if not 60 <= args.timeout_seconds <= 14400:
        parser.error("per-image deadline must be between 60 and 14400 seconds")
    if len(set(args.cases)) != len(args.cases) or len(set(args.presets)) != len(args.presets):
        parser.error("duplicate cases or presets would overwrite evidence")
    if any(os.environ.get(key) == "1" for key in ("DSTUDIO_IMAGE_TEST_MODE", "DSTUDIO_IDEOGRAM4_TEST_MODE")):
        parser.error("real benchmark refuses simulated image workers")
    # An idle router is harmless; a loaded chat/model worker is not. Do not
    # unload or kill somebody else's process to obtain an uncontended run.
    processes = subprocess.check_output(["ps", "-axo", "comm="], text=True).splitlines()
    if any(Path(name.strip()).name in ("ds4-server", "ds4-design") for name in processes):
        parser.error("a chat/Design engine is running; release it explicitly before benchmarking")
    args.output.mkdir(parents=True, exist_ok=False)
    report = {"schemaVersion": 1, "realInference": True,
              "scope": "production Ideogram shell/worker; excludes native chat prompt authoring",
              "reference": "https://hermes-agent.nousresearch.com/",
              "referenceUse": "textual art direction, not image-to-image or pixel reconstruction",
              "seed": args.seed, "perImageDeadlineSeconds": args.timeout_seconds,
              "startedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
              "hardware": subprocess.check_output(["sysctl", "-n", "machdep.cpu.brand_string"], text=True).strip(),
              "memoryBytes": int(subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True)),
              "sharedHost": True, "operatingSystem": subprocess.check_output(["sw_vers", "-productVersion"], text=True).strip(),
              "plan": [{"case": c, "preset": p} for c in args.cases for p in args.presets], "runs": []}
    save(args.output / "results.json", report)
    for case in args.cases:
        caption_path = ROOT / f"tests/fixtures/image-presets/{case}.json"
        caption = worker.verify_caption(caption_path.read_text())
        aspect = json.loads(caption_path.read_text())["aspect_ratio"]
        for preset in args.presets:
            run_dir = args.output / f"{case}-{preset}"
            run_dir.mkdir()
            status_path = run_dir / "status.json"
            started = time.monotonic()
            row = {"case": case, "preset": preset, "state": "running",
                   "startedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
                   "captionSha256": hashlib.sha256(caption.encode()).hexdigest(),
                   "expectedSize": list(worker.preset_size(aspect, preset))}
            report["runs"].append(row)
            save(args.output / "results.json", report)
            command = [str(ROOT / "scripts/ideogram4-generate.sh"), str(caption_path),
                       str(run_dir), str(status_path), aspect, str(args.seed), preset]
            print(f"START {case} {preset} {row['expectedSize']}", flush=True)
            timed_out = False
            with (run_dir / "worker.log").open("wb") as log, (run_dir / "progress.jsonl").open("w") as progress:
                process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                caffeine = subprocess.Popen(["/usr/bin/caffeinate", "-i", "-w", str(process.pid)],
                                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                previous = None
                try:
                    while process.poll() is None:
                        if time.monotonic() - started > args.timeout_seconds:
                            timed_out = True
                            terminate(process)
                            break
                        try:
                            status = json.loads(status_path.read_text())
                            identity = (status.get("stage"), status.get("step"))
                            if identity != previous:
                                previous = identity
                                status["observedSeconds"] = round(time.monotonic() - started, 3)
                                progress.write(json.dumps(status) + "\n")
                                progress.flush()
                                print(f"{case}/{preset}: {status.get('label')} ({status['observedSeconds']}s)", flush=True)
                        except (OSError, ValueError):
                            pass
                        time.sleep(2)
                except KeyboardInterrupt:
                    row["state"] = "cancelled"
                    row["elapsedSeconds"] = round(time.monotonic() - started, 3)
                    terminate(process)
                    save(args.output / "results.json", report)
                    return 130
                finally:
                    terminate(process)
                    if caffeine.poll() is None:
                        caffeine.terminate()
                    caffeine.wait(timeout=5)
            row.update(elapsedSeconds=round(time.monotonic() - started, 3), exitCode=process.returncode,
                       state="timeout" if timed_out else "failed")
            provenance_path = run_dir / "ideogram4-provenance.json"
            if not timed_out and process.returncode == 0 and provenance_path.is_file():
                provenance = json.loads(provenance_path.read_text())
                outputs = list(run_dir.glob("ideogram4-*.png"))
                if len(outputs) == 1 and provenance.get("preset") == preset:
                    row["outputValidation"] = worker.inspect_output(outputs[0], tuple(row["expectedSize"]))
                    row["outputSha256"] = hashlib.sha256(outputs[0].read_bytes()).hexdigest()
                    row["image"] = str(outputs[0].relative_to(args.output))
                    row["provenance"] = provenance
                    row["state"] = "generated"
                    row["visualReview"] = "pending"  # nonblank PNG is not aesthetic correctness
            save(args.output / "results.json", report)
            print(f"END {case}/{preset}: {row['state']} in {row['elapsedSeconds']}s", flush=True)
    report["finishedAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
    save(args.output / "results.json", report)
    return 0 if all(row["state"] == "generated" for row in report["runs"]) else 1


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, worker.handle_termination)
    raise SystemExit(main())
