"""Evaluator regressions. No inference and no model-quality scores."""
import json
from fractions import Fraction
from decimal import Decimal
from itertools import permutations, product
from math import comb
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests/support"))
import common_model_quality as quality  # noqa: E402


class CommonQualityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        parent = ROOT / "tests/.artifacts/common-quality-oracle"
        parent.mkdir(parents=True, exist_ok=True)
        cls.artifacts = Path(tempfile.mkdtemp(prefix="run-", dir=parent))
        cls.receipts = []

    @classmethod
    def tearDownClass(cls):
        (cls.artifacts / "results.json").write_text(json.dumps({
            "scope": "Evaluator/reference checks only; zero model runs",
            "manifest": quality.manifest(), "receipts": cls.receipts,
        }, indent=2, ensure_ascii=False) + "\n")
        print(f"Evaluator artifacts: {cls.artifacts}")

    def directory(self, label):
        return Path(tempfile.mkdtemp(prefix=label + "-", dir=self.artifacts))

    def case(self, key):
        return next(c for c in quality.CASES if c["id"] == key)

    def test_complete_manifest_and_golden_responses(self):
        manifest = quality.manifest()
        self.assertEqual(len(manifest["cases"]), 100)
        self.assertEqual(manifest["counts"], quality.COUNTS)
        self.assertEqual(manifest["identity"], quality.manifest()["identity"])
        for case in quality.CASES:
            with self.subTest(case=case["id"]):
                self.assertNotIn("expected", next(c for c in manifest["cases"] if c["id"] == case["id"]))
                answer = quality.golden_answer(case)
                result = quality.grade(case, answer, self.directory(case["id"]))
                self.receipts.append({"id": case["id"], "variant": "author_reference", "grade": result})
                self.assertTrue(result["passed"], result)
                if case["kind"] == "patch":
                    self.assertFalse(result["before"]["passed"])
                    self.assertTrue(all(result["protected_files"].values()))
                if case["category"] == "long_context":
                    self.assertGreater(len(case["prompt"]), 100000)
                    self.assertEqual(case["minimum_prompt_tokens"], 12000)

    def test_wrong_answers_never_pass(self):
        for case in quality.CASES:
            if case["kind"] in ("code", "patch"):
                wrong = "def solve(*args):\n    return None\n" if case["kind"] == "code" else "no change"
            else:
                wrong = "false" if case["kind"] == "json" else "WRONG"
            result = quality.grade(case, wrong, self.directory("wrong"))
            self.receipts.append({"id": case["id"], "variant": "known_wrong", "grade": result})
            with self.subTest(case=case["id"]):
                self.assertFalse(result["passed"], result)

    def test_independent_arithmetic_and_constraints(self):
        fraction = Fraction(5, 6) - Fraction(1, 4) + Fraction(1, 3)
        minute = 23 * 60 + 47 + 136
        derived = [7 * 18 - 23, 3750 + 850 - 600,
                   {"numerator": fraction.numerator, "denominator": fraction.denominator},
                   float(Decimal(120) * Decimal('.85') * Decimal('1.10')),
                   sum([8] * 3 + [12] * 5 + [20] * 2) / 10,
                   dict(zip(('q', 'r'), divmod(-53, 7))),
                   sum(sorted([11, -4, 8, 8, 20, 1])[2:4]) / 2,
                   {"day": minute // 1440, "time": f"{minute // 60 % 24:02}:{minute % 60:02}"},
                   2400 / 800, int('101101', 2) + int('2A', 16),
                   64 * Fraction(3, 4) * (1 - Fraction(5, 8)), comb(4, 2) * comb(6, 2)]
        self.assertEqual(derived, [c['expected'] for c in quality.CASES if c['category'] == 'arithmetic'])
        orders = [list(p) for p in permutations('WXYZ')
                  if p[0] == 'Z' and p.index('W') + 1 == p.index('Y') and p.index('X') > p.index('Y')]
        self.assertEqual(orders, [self.case('reasoning-adjacent-order')['expected']])
        truth = [{'A_truthful': a, 'B_truthful': b} for a, b in product([False, True], repeat=2)
                 if a == (not b) and b == (a == b)]
        self.assertEqual(truth, [self.case('reasoning-truth-types')['expected']])
        assignments = [dict(zip(['Ada', 'Bo', 'Cy'], p)) for p in permutations(['cut', 'paint', 'weld'])
                       if p[0] in ['cut', 'paint'] and p[1] == 'paint' and p[2] in ['cut', 'weld']]
        self.assertEqual(assignments, [self.case('reasoning-unique-assignment')['expected']])

    def test_strict_json_types_duplicates_and_nonfinite(self):
        case = self.case("json-typed")
        valid = quality.golden_answer(case)
        for bad in [valid.replace('"count":0', '"count":false'), valid.replace('"count":0', '"count":"0"'),
                    valid[:-1] + ',"count":0}', valid + " extra", "```json\n" + valid + "\n```",
                    valid.replace('"count":0', '"count":NaN'), valid.replace('"count":0', '"count":1e999')]:
            with self.subTest(answer=bad):
                self.assertFalse(quality.grade(case, bad, self.directory("json"))["passed"])
        with self.assertRaises(ValueError):
            quality.strict_json('{"outer":{"x":1,"x":2}}')
        self.assertFalse(quality.equal(False, 0))
        self.assertFalse(quality.equal([False], [0]))
        self.assertFalse(quality.equal({"v": False}, {"v": 0}))
        self.assertTrue(quality.equal(8.0, 8))

    def test_literal_whitespace_is_not_silently_repaired(self):
        case = self.case("instructions-three-lines")
        for suffix in ("", "\n", "\r\n"):
            self.assertTrue(quality.grade(case, case["expected"] + suffix, self.directory("literal"))["passed"])
        for bad in (" " + case["expected"], case["expected"] + "\n\n", case["expected"].replace("\n", " ")):
            self.assertFalse(quality.grade(case, bad, self.directory("literal"))["passed"])

    def test_patch_paths_prose_and_original_tests(self):
        case = self.case("debug-last-element")
        valid = quality.golden_answer(case)
        for bad in ("Here is the patch:\n" + valid, valid + "Done.\n", "```diff\n" + valid + "```",
                    valid.replace("app.py", "../outside.py"), valid.replace("app.py", "tests.json"),
                    valid + valid, valid.replace("return True", "return False")):
            result = quality.grade(case, bad, self.directory("patch"))
            self.assertFalse(result["passed"], result)
        self.assertTrue(quality.patch_envelope("diff --git a/app.py b/app.py\nindex abc123..def456 100644\n" + valid))
        # An actual protected-file edit must fail without applying either hunk.
        bad = valid + "--- a/KEEP.txt\n+++ b/KEEP.txt\n@@ -1 +1 @@\n-Original fixture: do not modify or remove.\n+changed\n"
        where = self.directory("protected")
        self.assertFalse(quality.grade(case, bad, where)["passed"])
        self.assertEqual((where / "workspace/KEEP.txt").read_text(), "Original fixture: do not modify or remove.\n")
        self.assertEqual((where / "workspace/app.py").read_text(), case["before"])

    def test_source_restrictions_and_logarithmic_work(self):
        case = self.case("code-lower-bound")
        for source in ("import os\ndef solve(a,b):\n    return 0\n",
                       "def solve(a,b):\n    return a.__class__\n",
                       "def solve(a,b):\n    return open('/etc/passwd').read()\n",
                       "def solve(a,b):\n    return type('X', (), {})\n",
                       "def solve(a,b):\n    return '{0.__class__}'.format(a)\n",
                       "def solve(a,b):\n    for i, value in enumerate(a):\n        if value >= b:\n            return i\n    return len(a)\n"):
            result = quality.execute_code(case, source)
            self.assertFalse(result["passed"], result)
        result = quality.execute_code(case, case["golden"])
        self.assertTrue(result["passed"], result)
        self.assertLessEqual(max(c.get("element_visits", 0) for c in result["checks"]), 18)
        clock = self.case('debug-midnight')
        source = "def solve(start, minutes):\n    h, m = map(int, start.split(':'))\n    h, m = divmod((h * 60 + m + minutes) % 1440, 60)\n    return '{:02d}:{:02d}'.format(h, m)\n"
        self.assertTrue(quality.execute_code(clock, source)['passed'], 'ordinary Python builtins/methods must remain valid')

    def test_os_sandbox_denies_files_network_and_children(self):
        secret = self.artifacts / "private-canary.txt"
        secret.write_text("fixture only, not private user content")
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        self.addCleanup(listener.close)
        # Trusted diagnostic bypasses the AST restriction to exercise the actual
        # OS boundary. It is never passed to, or produced by, a language model.
        program = f"""
import json, os, socket
checks = {{}}
for name, action in [
    ('read', lambda: open({str(secret)!r}).read()),
    ('write', lambda: open({str(secret)!r}, 'w')),
    ('network', lambda: socket.create_connection(('127.0.0.1', {listener.getsockname()[1]}), timeout=1)),
    ('fork', os.fork),
]:
    try:
        value = action()
        if name == 'fork' and value == 0:
            os._exit(90)
        checks[name] = False
    except PermissionError:
        checks[name] = True
print(json.dumps(checks))
"""
        command = quality.sandbox_command()
        command[-1] = program
        proc = subprocess.run(command, capture_output=True, timeout=5)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout), dict(read=True, write=True, network=True, fork=True))
        self.assertEqual(secret.read_text(), "fixture only, not private user content")

    def test_runaway_code_is_terminated(self):
        case = self.case("code-brackets")
        result = quality.execute_code(case, "def solve(text):\n    while True:\n        pass\n")
        self.assertFalse(result["passed"])
        self.assertLess(result["limits"]["elapsed_ms"], 8500)
        self.receipts.append({"id": "runaway-code", "grade": result})

    def test_memory_watchdog_terminates_its_worker(self):
        result = quality.execute_code(self.case('code-brackets'),
            "def solve(text):\n    chunks = []\n    while True:\n        chunks.append([0] * 131072)\n")
        self.assertFalse(result['passed'])
        self.assertIn('RSS termination threshold', result.get('error', ''))
        self.assertLess(result['limits']['elapsed_ms'], 8500)
        self.receipts.append({'id': 'memory-watchdog', 'grade': result})

    def test_cli_freeze_and_receipt(self):
        case = self.case("arithmetic-inventory")
        directory = self.artifacts / "cli"
        command = [sys.executable, "-B", str(ROOT / "tests/support/common_model_quality.py"),
                   "--grade", case["id"], "--out", str(directory)]
        packet = {"identity": quality.manifest()["identity"], "answer": quality.golden_answer(case)}
        result = subprocess.run(command, input=json.dumps(packet), text=True, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)["passed"])
        before = (directory / "grade.json").read_bytes()
        repeated = subprocess.run(command, input=json.dumps(packet), text=True, capture_output=True, timeout=5)
        self.assertNotEqual(repeated.returncode, 0, "existing receipt must not be overwritten")
        self.assertEqual((directory / "grade.json").read_bytes(), before)
        packet["identity"] = "stale"
        stale = subprocess.run(command[:-1] + [str(self.artifacts / "stale")], input=json.dumps(packet), text=True, capture_output=True, timeout=5)
        self.assertNotEqual(stale.returncode, 0)
        self.assertFalse((self.artifacts / "stale").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
