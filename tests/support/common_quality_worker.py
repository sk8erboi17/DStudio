"""Restricted Python evaluator, additionally launched inside an OS sandbox.

The AST/builtin restrictions reduce the attack surface; they are not claimed
as an OS isolation boundary. No model, network client or host state lives here.
"""
import ast
import copy
import json
import math
import resource
import signal
import sys

ALLOWED_NODES = set("""
Module FunctionDef arguments arg Return Assign AnnAssign AugAssign For While If
Break Continue Pass Expr Delete Name Load Store Del Constant List Tuple Dict Set
ListComp SetComp DictComp GeneratorExp comprehension IfExp BoolOp And Or UnaryOp
Not UAdd USub Invert BinOp Add Sub Mult Div FloorDiv Mod Pow BitAnd BitOr BitXor
LShift RShift Compare Eq NotEq Lt LtE Gt GtE Is IsNot In NotIn Call Attribute
Subscript Slice Lambda keyword JoinedStr FormattedValue Assert Raise Try
ExceptHandler
""".split())
# Public methods of the ordinary data types remain available (e.g. fromkeys,
# bit_length and format); rejecting valid Python here would be a grader defect.
# Private attributes and arbitrary object introspection remain unavailable.
METHODS = {name for cls in (str, list, tuple, dict, set, frozenset, int, float, complex, bytes, bytearray)
           for name in dir(cls) if not name.startswith('_') and name != 'mro'}
BUILTINS = {name: getattr(__import__("builtins"), name) for name in (
    "abs all any ascii bin bool bytearray bytes chr complex dict divmod enumerate "
    "filter float format frozenset hash hex int isinstance iter len list map max "
    "min next oct ord pow range repr reversed round set slice sorted str sum tuple type zip "
    "Exception ValueError TypeError KeyError IndexError RuntimeError AssertionError "
    "StopIteration ZeroDivisionError OverflowError"
).split()}


def equal(actual, expected):
    if isinstance(expected, bool) or expected is None or isinstance(expected, str):
        return type(actual) is type(expected) and actual == expected
    if isinstance(expected, (int, float)):
        return type(actual) in (int, float) and math.isfinite(actual) and actual == expected
    if isinstance(expected, list):
        return type(actual) is list and len(actual) == len(expected) and all(equal(a, b) for a, b in zip(actual, expected))
    if isinstance(expected, dict):
        return type(actual) is dict and actual.keys() == expected.keys() and all(equal(actual[k], v) for k, v in expected.items())
    return False


def interval_result_equal(actual, expected):
    # The interval task promises values/order, not mutable list containers.
    # Lists and tuples have identical JSON array representation. Do not extend
    # this to unordered/unmaterialized iterables or to input preservation.
    if type(actual) not in (list, tuple) or len(actual) != len(expected):
        return False
    return all(type(pair) in (list, tuple) and len(pair) == 2
               and equal(pair[0], wanted[0]) and equal(pair[1], wanted[1])
               for pair, wanted in zip(actual, expected))


def validate(source):
    if not isinstance(source, str) or len(source.encode()) > 65536:
        raise ValueError("source exceeds the 64 KiB limit")
    tree = ast.parse(source, filename="app.py")
    for node in ast.walk(tree):
        if type(node).__name__ not in ALLOWED_NODES:
            raise ValueError(f"unsupported Python construct: {type(node).__name__}")
        if isinstance(node, (ast.Name, ast.arg)) and "__" in (node.id if isinstance(node, ast.Name) else node.arg):
            raise ValueError("dunder identifiers are not permitted")
        if isinstance(node, ast.FunctionDef) and (node.decorator_list or "__" in node.name):
            raise ValueError("decorators and dunder functions are not permitted")
        if isinstance(node, ast.Attribute) and node.attr not in METHODS:
            raise ValueError(f"unsupported attribute: {node.attr}")
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "type" and len(node.args) != 1:
            raise ValueError("type is only available for single-argument type inspection")
    return tree


class ReadSequence:
    """No raw list escape: every candidate-observed element costs one visit."""
    def __init__(self, size, limit):
        self.size, self.limit, self.visits = size, limit, 0

    def __len__(self):
        return self.size

    def __getitem__(self, index):
        if not isinstance(index, int):
            raise TypeError("only integer indexing is available")
        if index < 0:
            index += self.size
        if not 0 <= index < self.size:
            raise IndexError(index)
        self.visits += 1
        if self.visits > self.limit:
            raise RuntimeError("logarithmic element-visit budget exceeded")
        return index * 2


def evaluate(payload):
    tree = validate(payload["source"])
    scope = {"__builtins__": BUILTINS.copy()}
    exec(compile(tree, "app.py", "exec"), scope)
    fn = scope.get(payload["entry"])
    if not callable(fn):
        raise ValueError("required function is missing")
    checks = []
    for index, (args, expected) in enumerate(payload["vectors"]):
        inputs = copy.deepcopy(args)
        row = {"vector": index, "passed": False}
        try:
            actual = fn(*inputs)
            row["actual"] = actual
            row["expected"] = expected
            row["inputs_preserved"] = equal(inputs, args)
            matches = interval_result_equal(actual, expected) if payload.get("ordered_interval_result") else equal(actual, expected)
            row["passed"] = matches and row["inputs_preserved"]
        except Exception as error:
            row["error"] = f"{type(error).__name__}: {error}"[:1000]
        checks.append(row)
    if payload.get("complexity"):
        for size in (1024, 65536):
            for target in (-1, 0, 1, size - 1, 2 * size - 2, 2 * size + 3):
                values = ReadSequence(size, size.bit_length() + 1)
                row = {"size": size, "target": target, "passed": False}
                try:
                    actual = fn(values, target)
                    expected = min(size, max(0, (target + 1) // 2))
                    row.update(actual=actual, expected=expected, passed=equal(actual, expected))
                except Exception as error:
                    row["error"] = f"{type(error).__name__}: {error}"[:1000]
                row["element_visits"] = values.visits
                checks.append(row)
    return {"passed": all(row["passed"] for row in checks), "checks": checks}


if __name__ == "__main__":
    # Bound CPU, output writes and recursion independently of the parent timeout.
    # Darwin rejects finite RLIMIT_AS on the supported host; the parent enforces
    # an RSS termination threshold instead, and does not call it a hard VM cap.
    resource.setrlimit(resource.RLIMIT_CPU, (3, 4))
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    sys.setrecursionlimit(300)
    signal.alarm(5)
    try:
        raw = sys.stdin.buffer.read(256 * 1024 + 1)
        if len(raw) > 256 * 1024:
            raise ValueError("worker input exceeds 256 KiB")
        result = evaluate(json.loads(raw))
        encoded = json.dumps(result, ensure_ascii=False, allow_nan=False)
        if len(encoded.encode()) > 256 * 1024:
            raise ValueError("worker result exceeds 256 KiB")
    except Exception as error:
        encoded = json.dumps({"passed": False, "error": f"{type(error).__name__}: {error}"[:1000]})
    print(encoded)
