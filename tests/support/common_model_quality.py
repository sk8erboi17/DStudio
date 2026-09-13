"""Manifest and independent answer grader for common-100; never starts an LLM."""
import argparse
import difflib
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests/fixtures"))
from common_model_quality_cases import CASES, COUNTS, SETTINGS, VERSION  # noqa: E402
from common_quality_worker import equal  # noqa: E402

WORKER = Path(__file__).with_name("common_quality_worker.py")
FILES = [ROOT / "tests/fixtures/common_model_quality_cases.py", ROOT / "tests/fixtures/common_model_code.py",
         Path(__file__), WORKER]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def manifest():
    rows = [{key: case[key] for key in ("id", "category", "kind", "prompt", "deadline_ms", "max_tokens")}
            | ({"minimum_prompt_tokens": case["minimum_prompt_tokens"]} if "minimum_prompt_tokens" in case else {})
            for case in CASES]
    counts = {area: sum(c["category"] == area for c in CASES) for area in COUNTS}
    if counts != COUNTS or len({c["id"] for c in CASES}) != 100:
        raise ValueError("common-100 category counts or IDs changed")
    hashes = {str(file.relative_to(ROOT)): sha(file.read_bytes()) for file in FILES}
    identity = sha(json.dumps({"cases": rows, "settings": SETTINGS, "files": hashes},
                              sort_keys=True, ensure_ascii=False).encode())
    return {"schema": VERSION, "identity": identity, "files": hashes, "settings": SETTINGS,
            "counts": counts, "cases": rows, "scope": "Controlled answer quality, not numerical parity, tool-loop or desktop qualification"}


def strict_json(text):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate JSON key: {key}")
            result[key] = value
        return result

    def finite(token):
        raise ValueError(f"nonfinite JSON number: {token}")

    def number(token):
        value = float(token)
        if not math.isfinite(value):
            finite(token)
        return value

    return json.loads(text, object_pairs_hook=unique, parse_constant=finite, parse_float=number)


def sandbox_command():
    if sys.platform != "darwin" or not Path("/usr/bin/sandbox-exec").is_file():
        raise RuntimeError("NOT_RUN: this code evaluator requires the macOS OS sandbox; no unsafe fallback")
    # Pass the trusted worker as -c, so no exception opens a path under /Users.
    # Python/framework/system reads are available; personal volumes, profiles
    # and temporary directories are denied. No file writes/network/forks.
    profile = f'''(version 1) (deny default) (allow process-exec) (allow sysctl-read)
        (allow mach-lookup)
        (allow file-read* (require-all
            (require-not (subpath "/Users")) (require-not (subpath "/Volumes"))
            (require-not (subpath "/private/var/folders"))
            (require-not (subpath "/private/tmp")) (require-not (subpath "/tmp"))))'''
    return ["/usr/bin/sandbox-exec", "-p", profile, sys.executable, "-I", "-B", "-c", WORKER.read_text()]


def execute_code(case, source):
    payload = {"source": source, "entry": case["entry"], "vectors": case["vectors"],
               "complexity": case["id"] == "code-lower-bound",
               "ordered_interval_result": case["id"] == "code-merge-intervals"}
    raw = json.dumps(payload, ensure_ascii=False).encode()
    if len(raw) > 256 * 1024:
        raise ValueError("code test input too large")
    peak_rss, started, problem = 0, time.monotonic(), None
    with subprocess.Popen(sandbox_command(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, cwd="/",
                          env={"PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8"}) as proc:
        pending = raw
        while True:
            try:
                stdout, stderr = proc.communicate(input=pending, timeout=0.025)
                break
            except subprocess.TimeoutExpired:
                pending = None
                # PID belongs to this still-unreaped direct child. Never find or
                # signal processes by name, and never stop an engine for grading.
                sample = subprocess.run(["/bin/ps", "-o", "rss=", "-p", str(proc.pid)],
                                        capture_output=True, timeout=1)
                if sample.returncode == 0 and sample.stdout.strip():
                    peak_rss = max(peak_rss, int(sample.stdout.strip()) * 1024)
                if peak_rss > 256 * 1024 ** 2:
                    problem = "worker exceeded the 256 MiB RSS termination threshold"
                elif time.monotonic() - started > 8:
                    problem = "code execution exceeded 8 seconds"
                if problem:
                    proc.kill()
                    stdout, stderr = proc.communicate(timeout=2)
                    break
        receipt = {"sampled_peak_rss_bytes": peak_rss,
                   "memory_enforcement": "256 MiB RSS watchdog; sampled, not a hard address-space cap",
                   "elapsed_ms": round((time.monotonic() - started) * 1000, 3)}
    if problem:
        return {"passed": False, "error": problem, "limits": receipt}
    if proc.returncode != 0:
        return {"passed": False, "error": "sandbox worker failed", "exit_code": proc.returncode,
                "stderr": stderr.decode(errors="replace")[:2000], "limits": receipt}
    if len(stdout) > 256 * 1024:
        return {"passed": False, "error": "worker result too large"}
    return strict_json(stdout.decode()) | {"limits": receipt}


def golden_answer(case):
    if case["kind"] != "patch":
        return case["golden"]
    return "".join(difflib.unified_diff(case["before"].splitlines(True), case["golden"].splitlines(True),
                                        fromfile="a/app.py", tofile="b/app.py"))


def patch_envelope(answer):
    """Do not let git's permissive mail-patch reader ignore prose or fences."""
    lines = answer.splitlines()
    if lines and lines[0] == "diff --git a/app.py b/app.py":
        lines.pop(0)
        if lines and re.fullmatch(r"index [0-9a-f]+\.\.[0-9a-f]+(?: 100644)?", lines[0]):
            lines.pop(0)
    if lines[:2] != ["--- a/app.py", "+++ b/app.py"]:
        return False
    index, hunks = 2, 0
    while index < len(lines):
        header = re.fullmatch(r"@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?: .*)?", lines[index])
        if not header:
            return False
        old, new = [int(v) if v is not None else 1 for v in header.groups()]
        index += 1
        hunks += 1
        while old or new:
            if index >= len(lines) or not lines[index] or lines[index][0] not in " +-":
                return False
            prefix = lines[index][0]
            old -= prefix in " -"
            new -= prefix in " +"
            if old < 0 or new < 0:
                return False
            index += 1
            if index < len(lines) and lines[index] == "\\ No newline at end of file":
                index += 1
    return hunks > 0


def grade_patch(case, answer, directory):
    workspace = directory / "workspace"
    workspace.mkdir()
    originals = {"app.py": case["before"], "tests.json": json.dumps(case["vectors"], ensure_ascii=False),
                 "KEEP.txt": "Original fixture: do not modify or remove.\n"}
    for name, source in originals.items():
        (workspace / name).write_text(source)
    before = execute_code(case, case["before"])
    (directory / "before.json").write_text(json.dumps(before, ensure_ascii=False, indent=2) + "\n")
    if before["passed"] or "checks" not in before:
        return {"passed": False, "error": "invalid fixture or worker: original behavioral failure not demonstrated", "before": before}
    # git apply is a real patch parser. Exact paths, no binary/rename/mode/git
    # metadata, no whitespace repair and no permissive header stripping.
    if not patch_envelope(answer):
        return {"passed": False, "error": "a unified diff for app.py is required", "before": before}
    if any(re.match(r"^(GIT binary patch|Binary files|rename |copy |new file mode|deleted file mode|old mode|new mode)", line) for line in answer.splitlines()):
        return {"passed": False, "error": "only text modifications to app.py are allowed", "before": before}
    env = {"PATH": "/usr/bin:/bin", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
           "GIT_CONFIG_SYSTEM": "/dev/null", "GIT_CEILING_DIRECTORIES": str(directory)}
    def git(*args):
        return subprocess.run(["/usr/bin/git", *args], cwd=workspace, env=env, input=answer.encode(),
                              capture_output=True, timeout=5)
    initialized = git("init", "--quiet")
    if initialized.returncode:
        raise RuntimeError("cannot initialize isolated patch workspace")
    stats = git("apply", "--numstat", "-z", "-")
    if stats.returncode or not re.fullmatch(rb"\d+\t\d+\tapp\.py\x00", stats.stdout):
        return {"passed": False, "error": "patch must change only app.py exactly once", "before": before}
    checked = git("apply", "--check", "--whitespace=error", "-")
    if checked.returncode:
        return {"passed": False, "error": "patch does not apply cleanly", "detail": checked.stderr.decode(errors="replace")[:2000], "before": before}
    applied = git("apply", "--whitespace=error", "-")
    if applied.returncode:
        return {"passed": False, "error": "patch application failed", "before": before}
    protected = {name: sha((workspace / name).read_bytes()) == sha(text.encode())
                 for name, text in originals.items() if name != "app.py"}
    after = execute_code(case, (workspace / "app.py").read_text())
    return {"passed": after["passed"] and all(protected.values()), "before": before,
            "after": after, "protected_files": protected,
            "patched_sha256": sha((workspace / "app.py").read_bytes())}


def grade(case, answer, directory):
    if not isinstance(answer, str) or len(answer.encode()) > 65536:
        return {"passed": False, "error": "answer missing or exceeds 64 KiB"}
    try:
        if case["kind"] == "json":
            value = strict_json(answer)
            return {"passed": equal(value, case["expected"]), "actual": value, "expected": case["expected"]}
        if case["kind"] == "literal":
            value = answer[:-2] if answer.endswith("\r\n") else answer[:-1] if answer.endswith("\n") else answer
            return {"passed": value == case["expected"], "actual": value, "expected": case["expected"]}
        if case["kind"] == "code":
            return execute_code(case, answer)
        if case["kind"] == "patch":
            return grade_patch(case, answer, directory)
        raise ValueError("unknown grader kind")
    except (ValueError, TypeError, RuntimeError, OSError, RecursionError, subprocess.SubprocessError) as error:
        return {"passed": False, "error": str(error)[:2000]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", action="store_true")
    parser.add_argument("--grade", metavar="CASE_ID")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    if args.manifest:
        print(json.dumps(manifest(), ensure_ascii=False))
        return
    if not args.grade or not args.out:
        parser.error("use --manifest or --grade CASE_ID --out NEW_DIRECTORY; answer JSON is read from stdin")
    case = next((c for c in CASES if c["id"] == args.grade), None)
    if case is None:
        parser.error("unknown case ID")
    raw = sys.stdin.buffer.read(256 * 1024 + 1)
    if len(raw) > 256 * 1024:
        parser.error("input too large")
    packet = strict_json(raw.decode())
    frozen = manifest()
    if packet.get("identity") != frozen["identity"]:
        parser.error("corpus/grader changed since request freeze")
    args.out.mkdir(parents=True, exist_ok=False)
    (args.out / "answer.json").write_text(json.dumps(packet, ensure_ascii=False, indent=2) + "\n")
    result = grade(case, packet.get("answer"), args.out)
    result.update(case_id=case["id"], identity=frozen["identity"])
    (args.out / "grade.json").write_text(json.dumps(result, ensure_ascii=False, allow_nan=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    main()
