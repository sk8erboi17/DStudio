"""patch/mlx-lm-tool-streaming: the streamed Qwen3-Coder tool-call fragments
must concatenate to exactly what the UPSTREAM parser of the bundled wheel
returns for the same text (json.dumps of its arguments, ensure_ascii=False),
for any split of the generated text. The converter is the production module
the patch creates; the oracle is the wheel's own tool_parsers/qwen3_coder.py
(its `regex` import served by the standard `re`, which accepts its patterns).
No MLX, model or server.
  python3 tests/unit/mlx_tool_stream_test.py
"""
import importlib.util
import json
from pathlib import Path
import random
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
WHEEL = next(ROOT.glob('src/engines/mlx/wheels/mlx_lm-0.32.0-*.whl'))
PATCHES = ['patch/mlx-lm-single-model/single-model.patch', 'patch/mlx-lm-reasoning-content/reasoning-content.patch',
           'patch/mlx-lm-tool-streaming/tool-streaming.patch']


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


TMP = Path(tempfile.mkdtemp(prefix='mlx-tool-stream-'))
with zipfile.ZipFile(WHEEL) as wheel:
    (TMP / 'mlx_lm/tool_parsers').mkdir(parents=True)
    (TMP / 'mlx_lm/server.py').write_bytes(wheel.read('mlx_lm/server.py'))
    (TMP / 'mlx_lm/tool_parsers/qwen3_coder.py').write_bytes(wheel.read('mlx_lm/tool_parsers/qwen3_coder.py'))
for rel in PATCHES:
    subprocess.run(['git', 'apply', '-p1', str(ROOT / rel)], cwd=TMP, check=True)
sys.modules.setdefault('regex', __import__('re'))
oracle = load('qwen3_coder_oracle', TMP / 'mlx_lm/tool_parsers/qwen3_coder.py')
stream = load('dstudio_tool_stream', TMP / 'mlx_lm/dstudio_tool_stream.py')

TOOLS = [
    {'type': 'function', 'function': {'name': 'write', 'parameters': {'type': 'object', 'properties': {
        'path': {'type': 'string'}, 'content': {'type': 'string'}}}}},
    {'type': 'function', 'function': {'name': 'read', 'parameters': {'type': 'object', 'properties': {
        'path': {'type': 'string'}, 'offset': {'type': 'integer'}, 'limit': {'type': 'number'},
        'flags': {'type': 'array'}, 'opts': {'type': 'object'}, 'all': {'type': 'boolean'}}}}},
]
VALUES = ['index.html', '\nsite/a.md\n', 'Ciao è 🦊 "quoted" \\ back\tslash', '<h1>Title</h1>\n<p>a < b > c</p>',
          'null', 'NULL', 'nullable', 'nu', '', '\n', '\n\n', 'line one\nline two\n', '\nlead only', 'trail only\n',
          '</parametr', 'text with </function> inside', '\u0001 control   sep']
TYPED = {'offset': ['12', '\n7\n', 'null'], 'limit': ['2.5', '3.0'], 'flags': ['["a", "b"]', '[1, 2]'],
         'opts': ['{"k": "v", "n": [1, {"x": null}]}'], 'all': ['true', 'False']}


def render(name, params):
    body = ''.join(f'<parameter={k}>{v}</parameter>\n' for k, v in params)
    return f'\n<function={name}>\n{body}</function>\n'


def streamed(text, cuts):
    s = stream.QwenToolStreams(TOOLS, oracle._get_arguments_config, oracle._convert_param_value)
    deltas = s.begin()
    prev = 0
    for at in sorted(set(cuts)) + [len(text)]:
        deltas += s.feed(text[prev:at]); prev = at
    deltas += s.end()
    first = deltas[0]
    assert first['function']['name'] and first['id'] and first['type'] == 'function'
    assert all(d['index'] == 0 for d in deltas)
    return first['function']['name'], ''.join(d['function']['arguments'] for d in deltas)


def expected(text):
    parsed = oracle.parse_tool_call(text, TOOLS)
    return parsed['name'], json.dumps(parsed['arguments'], ensure_ascii=False)


class ToolStream(unittest.TestCase):
    def check(self, text, rng, splits=40):
        want = expected(text)
        for cuts in [[], list(range(1, len(text)))] + [[rng.randrange(1, len(text)) for _ in range(rng.randrange(1, 12))] for _ in range(splits)]:
            self.assertEqual(streamed(text, cuts), want, f'cuts {cuts[:20]} text {text!r}')

    def test_string_values_match_the_upstream_parser_for_any_split(self):
        rng = random.Random(7)
        for value in VALUES:
            self.check(render('write', [('path', 'out/' + str(len(value)) + '.txt'), ('content', value)]), rng, 20)

    def test_typed_and_unknown_parameters(self):
        rng = random.Random(11)
        for key, values in TYPED.items():
            for value in values:
                self.check(render('read', [('path', 'p'), (key, value), ('unknown', 'free text')]), rng, 20)

    def test_random_calls(self):
        rng = random.Random(1)
        for _ in range(150):
            keys = rng.sample(['path', 'offset', 'limit', 'flags', 'opts', 'all', 'note'], rng.randrange(0, 5))
            params = [(k, rng.choice(TYPED[k]) if k in TYPED else rng.choice(VALUES)) for k in keys]
            self.check(render('read', params), rng, 8)

    def test_arguments_stay_incomplete_where_the_result_would_differ(self):
        # A repeated parameter (upstream keeps one value) and a value the
        # converter rejects (upstream drops the call): never a valid object.
        for text in [render('write', [('path', 'a'), ('path', 'b')]), render('read', [('offset', '1.5')]),
                     '\n<function=write>\n<parameter=path>a</parameter>\n']:
            _, args = streamed(text, [])
            with self.assertRaises(json.JSONDecodeError):
                json.loads(args)


if __name__ == '__main__':
    try:
        result = unittest.main(exit=False, verbosity=1).result
    finally:
        shutil.rmtree(TMP, ignore_errors=True)
    failed = len(result.failures) + len(result.errors)
    print(f'mlx_tool_stream_test: {result.testsRun - failed}/{result.testsRun} passed (production converter vs the wheel parser; no MLX)')
    raise SystemExit(1 if failed else 0)
