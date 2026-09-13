"""Regression for equivalent ordered interval representations.

The common-100 v1 question requires ordered disjoint closed intervals and input
preservation. It does not require mutable pair/list containers. This test must
not be used to relax explicit list/type requirements of unrelated tasks.
"""
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests/support"))
import common_model_quality as quality  # noqa: E402

REFERENCE = """def solve(intervals):
    merged = []
    for left, right in sorted(intervals):
        if merged and left <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], right))
        else:
            merged.append((left, right))
    return merged
"""


class IntervalRepresentationTest(unittest.TestCase):
    def test_ordered_immutable_pairs_satisfy_the_same_interval_contract(self):
        case = next(c for c in quality.CASES if c['id'] == 'code-merge-intervals')
        result = quality.execute_code(case, REFERENCE)
        parent = ROOT / 'tests/.artifacts/common-interval-oracle'
        parent.mkdir(parents=True, exist_ok=True)
        artifact = Path(tempfile.mkdtemp(prefix='run-', dir=parent))
        (artifact / 'result.json').write_text(json.dumps({
            'scope': 'Independent author-written reference, not a model-quality rerun',
            'prompt': case['prompt'], 'source': REFERENCE, 'original_grade': result,
        }, indent=2) + '\n')
        print(f'Interval oracle evidence: {artifact}')
        self.assertEqual(len(result.get('checks', [])), 4)
        for check in result['checks']:
            # The actual JSON boundary already represents tuples as arrays;
            # these independent checks prove identical values/order and inputs.
            self.assertEqual(check['actual'], check['expected'])
            self.assertTrue(check['inputs_preserved'])
        self.assertTrue(result['passed'], 'valid immutable interval pairs were rejected by an unstated Python list-type condition')

    def test_equivalent_materialized_sequences(self):
        case = next(c for c in quality.CASES if c['id'] == 'code-merge-intervals')
        for result in ('merged', 'tuple(merged)', '[list(pair) for pair in merged]',
                       'tuple(list(pair) for pair in merged)'):
            with self.subTest(representation=result):
                source = REFERENCE.replace('return merged', 'return ' + result)
                self.assertTrue(quality.execute_code(case, source)['passed'])

    def test_bad_values_order_shape_and_mutation_still_fail(self):
        case = next(c for c in quality.CASES if c['id'] == 'code-merge-intervals')
        for expression in ('list(reversed(merged))', 'merged[:-1]',
                           '[(left, right + 1) for left, right in merged]',
                           '[(left, right, 0) for left, right in merged]',
                           '[(False, right) for left, right in merged]'):
            with self.subTest(expression=expression):
                self.assertFalse(quality.execute_code(case, REFERENCE.replace('return merged', 'return ' + expression))['passed'])
        mutation = REFERENCE.replace('    return merged', '    intervals.sort()\n    return merged')
        self.assertFalse(quality.execute_code(case, mutation)['passed'])

    def test_other_output_and_input_types_are_not_relaxed(self):
        case = next(c for c in quality.CASES if c['id'] == 'code-lru')
        source = case['golden'].replace('return answers', 'return tuple(answers)')
        self.assertFalse(quality.execute_code(case, source)['passed'], 'LRU explicitly requests a list')
        self.assertFalse(quality.equal([(1, 2)], [[1, 2]]), 'input preservation remains type-strict')


if __name__ == '__main__':
    unittest.main(verbosity=2)
