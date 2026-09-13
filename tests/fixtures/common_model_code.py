"""Original pure-Python tasks. Explicit vectors, not model-written tests.

These are answer-quality tasks, not Agent/tool-loop qualification. Golden code
only tests the evaluator; it is never included in an inference request.
"""

RULES = (
    "Use Python 3, without imports, classes, decorators, global/nonlocal, I/O, "
    "reflection, eval or exec. Ordinary functions, local variables, loops and "
    "comprehensions are allowed. Do not mutate any argument. "
    "Return only Python source, with no Markdown fences or explanation.\n"
)


def code_task(slug, requirement, golden, vectors):
    return dict(id="code-" + slug, category="code", kind="code",
                prompt=RULES + requirement, golden=golden, vectors=vectors,
                entry="solve", preserve_inputs=True)


def debug_task(slug, requirement, before, golden, vectors):
    prompt = (
        "Fix app.py. " + RULES.replace(
            "Return only Python source, with no Markdown fences or explanation.\n",
            "Return only a unified diff for app.py (--- a/app.py and +++ b/app.py), "
            "with no Markdown fences or explanation. Do not edit tests.json or KEEP.txt.\n")
        + requirement + "\nCurrent app.py:\n" + before
        + "\nThe evaluator uses independent tests, including empty and boundary inputs."
    )
    return dict(id="debug-" + slug, category="debugging", kind="patch",
                prompt=prompt, before=before, golden=golden, vectors=vectors,
                entry="solve", preserve_inputs=True)


CODE_CASES = [
    code_task("unicode-runs", "Implement solve(text): return consecutive character runs as [[character, count], ...]. Case sensitive; Unicode characters count individually.",
              "def solve(text):\n    out = []\n    for c in text:\n        if out and out[-1][0] == c:\n            out[-1][1] += 1\n        else:\n            out.append([c, 1])\n    return out\n",
              [([""], []), (["aaabbca"], [["a", 3], ["b", 2], ["c", 1], ["a", 1]]),
               (["éé🙂🙂a"], [["é", 2], ["🙂", 2], ["a", 1]]), (["AaA"], [["A", 1], ["a", 1], ["A", 1]])]),
    code_task("merge-intervals", "Implement solve(intervals): merge overlapping or touching closed [start,end] intervals, returning ascending disjoint intervals. Every start <= end; input may be unsorted.",
              "def solve(intervals):\n    out = []\n    for start, end in sorted(intervals):\n        if out and start <= out[-1][1]:\n            out[-1][1] = max(out[-1][1], end)\n        else:\n            out.append([start, end])\n    return out\n",
              [([[]], []), ([[[5, 8], [1, 3], [3, 6]]], [[1, 8]]),
               ([[[2, 2], [-4, -1], [7, 9]]], [[-4, -1], [2, 2], [7, 9]]),
               ([[[1, 9], [2, 3], [9, 10], [12, 12]]], [[1, 10], [12, 12]])]),
    code_task("stable-latest", "Implement solve(rows) for dictionaries with string id and value. Keep the last whole row for each id, but order ids by their FIRST occurrence. Do not sort ids.",
              "def solve(rows):\n    order = []\n    latest = {}\n    for row in rows:\n        key = row['id']\n        if key not in latest:\n            order.append(key)\n        latest[key] = row\n    return [latest[key] for key in order]\n",
              [([[]], []), ([[{"id": "b", "value": 1}, {"id": "a", "value": 3}, {"id": "b", "value": 9}]], [{"id": "b", "value": 9}, {"id": "a", "value": 3}]),
               ([[{"id": "", "value": None}, {"id": "", "value": False}]], [{"id": "", "value": False}])]),
    code_task("brackets", "Implement solve(text): return whether (), [] and {} are properly balanced and nested. Ignore every other character.",
              "def solve(text):\n    stack = []\n    pairs = {')': '(', ']': '[', '}': '{'}\n    for c in text:\n        if c in '([{':\n            stack.append(c)\n        elif c in pairs:\n            if not stack or stack.pop() != pairs[c]:\n                return False\n    return not stack\n",
              [([""], True), (["x{a[()]}y"], True), (["([)]"], False), (["]"], False), (["((a)"], False)]),
    code_task("rotate-rectangle", "Implement solve(matrix): rotate a rectangular nonempty-row matrix 90 degrees clockwise. An empty matrix returns []. Rows may have different values, but always equal length.",
              "def solve(matrix):\n    if not matrix:\n        return []\n    return [[matrix[r][c] for r in range(len(matrix)-1, -1, -1)] for c in range(len(matrix[0]))]\n",
              [([[]], []), ([[[1, 2, 3], [4, 5, 6]]], [[4, 1], [5, 2], [6, 3]]),
               ([[[7], [8], [9]]], [[9, 8, 7]]), ([[[False, None]]], [[False], [None]])]),
    code_task("grid-distance", "Implement solve(grid, start, goal): shortest orthogonal move count, or -1 if unreachable. 0 is open, 1 blocked; start/goal are valid [row,column] coordinates. A blocked endpoint is unreachable.",
              "def solve(grid, start, goal):\n    if grid[start[0]][start[1]] or grid[goal[0]][goal[1]]:\n        return -1\n    queue = [(start[0], start[1], 0)]\n    seen = {(start[0], start[1])}\n    index = 0\n    while index < len(queue):\n        r, c, d = queue[index]\n        index += 1\n        if [r, c] == goal:\n            return d\n        for dr, dc in [(1, 0), (-1, 0), (0, 1), (0, -1)]:\n            nr, nc = r + dr, c + dc\n            if 0 <= nr < len(grid) and 0 <= nc < len(grid[0]) and grid[nr][nc] == 0 and (nr, nc) not in seen:\n                seen.add((nr, nc))\n                queue.append((nr, nc, d + 1))\n    return -1\n",
              [([[[0]], [0, 0], [0, 0]], 0), ([[[0, 1], [1, 0]], [0, 0], [1, 1]], -1),
               ([[[0, 0, 0], [1, 1, 0], [0, 0, 0]], [0, 0], [2, 0]], 6), ([[[1]], [0, 0], [0, 0]], -1)]),
    code_task("topological-order", "Implement solve(nodes, edges): lexicographically smallest topological ordering of unique string nodes. [a,b] means a must precede b. Return null/None on a cycle. Duplicate edges count once; all endpoints are in nodes.",
              "def solve(nodes, edges):\n    pending = set(nodes)\n    out = []\n    while pending:\n        choices = [n for n in pending if not any(b == n and a in pending for a, b in edges)]\n        if not choices:\n            return None\n        item = min(choices)\n        out.append(item)\n        pending.remove(item)\n    return out\n",
              [([[], []], []), ([["c", "b", "a"], [["a", "c"], ["a", "c"]]], ["a", "b", "c"]),
               ([["x", "y"], [["x", "y"], ["y", "x"]]], None), ([["s"], [["s", "s"]]], None)]),
    code_task("quoted-row", "Implement solve(row): parse one valid comma-separated row. A field beginning with a double quote is quoted, commas inside it are literal, and doubled quotes inside it mean one quote. After its closing quote comes comma or end. Unquoted fields contain no quotes. Preserve whitespace and empty fields; empty input is one empty field. No newlines occur.",
              "def solve(row):\n    out = []\n    field = ''\n    quoted = False\n    i = 0\n    while i < len(row):\n        c = row[i]\n        if c == '\"':\n            if quoted and i + 1 < len(row) and row[i+1] == '\"':\n                field += '\"'\n                i += 1\n            else:\n                quoted = not quoted\n        elif c == ',' and not quoted:\n            out.append(field)\n            field = ''\n        else:\n            field += c\n        i += 1\n    out.append(field)\n    return out\n",
              [([""], [""]), (["a,,c,"], ["a", "", "c", ""]),
               (['"a,b","say ""hi""", z'], ["a,b", 'say "hi"', " z"]), (['""'], [""])]),
    code_task("integer-ranges", "Implement solve(values): sorted unique integers compressed into strings. Each maximal consecutive run is 'start:end' when length >= 2, otherwise just 'value'. Negative signs are retained.",
              "def solve(values):\n    items = sorted(set(values))\n    out = []\n    i = 0\n    while i < len(items):\n        start = end = items[i]\n        i += 1\n        while i < len(items) and items[i] == end + 1:\n            end = items[i]\n            i += 1\n        out.append(str(start) if start == end else str(start) + ':' + str(end))\n    return out\n",
              [([[]], []), ([[3, 1, 2, 2, 7, 9, 8]], ["1:3", "7:9"]),
               ([[-3, -2, 0, 2]], ["-3:-2", "0", "2"]), ([[4]], ["4"])]),
    code_task("lower-bound", "Implement solve(values, target): return the first index whose value >= target, or len(values) if none. values is a read-only sequence supporting len, integer indexing and iteration, sorted ascending with possible duplicates. Use logarithmically many element reads (binary search), not a linear scan or a full copy.",
              "def solve(values, target):\n    low, high = 0, len(values)\n    while low < high:\n        mid = (low + high) // 2\n        if values[mid] < target:\n            low = mid + 1\n        else:\n            high = mid\n    return low\n",
              [([[], 3], 0), ([[1, 3, 3, 3, 8], 3], 1), ([[1, 3], 9], 2), ([[1, 3], -1], 0), ([[1, 5], 4], 1)]),
    code_task("exact-decimals", "Implement solve(a,b): sum two nonnegative decimal strings, each with exactly two fractional digits. Return exactly two fractional digits, no leading integer zeros except '0'. Inputs can exceed 2^53; no binary floating point rounding is allowed.",
              "def solve(a, b):\n    def cents(s):\n        whole, fraction = s.split('.')\n        return int(whole) * 100 + int(fraction)\n    total = cents(a) + cents(b)\n    return str(total // 100) + '.' + str(total % 100).zfill(2)\n",
              [(["0.10", "0.20"], "0.30"), (["9.99", "0.01"], "10.00"),
               (["9007199254740993.99", "0.02"], "9007199254740994.01"), (["000.00", "00.09"], "0.09")]),
    code_task("edit-distance", "Implement solve(a,b): Levenshtein distance over Unicode characters, with unit cost insertion, deletion and substitution.",
              "def solve(a, b):\n    previous = list(range(len(b) + 1))\n    for i, x in enumerate(a, 1):\n        row = [i]\n        for j, y in enumerate(b, 1):\n            row.append(min(row[-1] + 1, previous[j] + 1, previous[j-1] + (x != y)))\n        previous = row\n    return previous[-1]\n",
              [(["", ""], 0), (["", "abc"], 3), (["kitten", "sitting"], 3), (["città", "citta"], 1), (["🙂a", "a🙂"], 2)]),
    code_task("lru", "Implement solve(capacity, operations): simulate an LRU cache. Operations are ['put', key, value] or ['get', key]. Return the list of get results; missing is None. Gets and puts refresh recency, put replaces an existing key. Evict the least recent when over capacity. Capacity is nonnegative and 0 stores nothing; keys are strings.",
              "def solve(capacity, operations):\n    data, order, answers = {}, [], []\n    for op in operations:\n        key = op[1]\n        if op[0] == 'get':\n            answers.append(data.get(key))\n            if key not in data:\n                continue\n        else:\n            if capacity == 0:\n                continue\n            data[key] = op[2]\n        if key in order:\n            order.remove(key)\n        order.append(key)\n        if len(order) > capacity:\n            del data[order.pop(0)]\n    return answers\n",
              [([0, [["put", "a", 1], ["get", "a"]]], [None]),
               ([2, [["put", "a", 1], ["put", "b", 2], ["get", "a"], ["put", "c", 3], ["get", "b"], ["get", "a"]]], [1, None, 1]),
               ([1, [["put", "x", 0], ["put", "x", False], ["get", "x"]]], [False])]),
    code_task("nested-lookup", "Implement solve(value, segments): follow dictionary string keys and list nonnegative integer indices. Return {'found': True, 'value': result} on success, even for None/False/0. Return {'found': False} on a missing key, out-of-range index or wrong container/index type. Empty path returns the original value.",
              "def solve(value, segments):\n    current = value\n    for part in segments:\n        if type(current) == dict and type(part) == str and part in current:\n            current = current[part]\n        elif type(current) == list and type(part) == int and 0 <= part < len(current):\n            current = current[part]\n        else:\n            return {'found': False}\n    return {'found': True, 'value': current}\n",
              [([{"a": [None, False]}, ["a", 1]], {"found": True, "value": False}),
               ([{"a": None}, ["a"]], {"found": True, "value": None}), ([[3], [-1]], {"found": False}),
               ([[3], [False]], {"found": False}), ([0, []], {"found": True, "value": 0}), ([{}, ["x"]], {"found": False})]),
    code_task("weighted-schedule", "Implement solve(jobs): maximum total weight of nonoverlapping [start,end,weight] jobs. End <= next start is compatible. Every start < end, weight >= 0. Input may be unsorted. Empty selection is allowed.",
              "def solve(jobs):\n    ordered = sorted(jobs, key=lambda x: x[1])\n    best = [0]\n    for i, (start, end, weight) in enumerate(ordered):\n        previous = i - 1\n        while previous >= 0 and ordered[previous][1] > start:\n            previous -= 1\n        best.append(max(best[-1], weight + best[previous + 1]))\n    return best[-1]\n",
              [([[]], 0), ([[[0, 3, 5], [0, 1, 3], [1, 3, 3]]], 6),
               ([[[4, 7, 5], [0, 4, 6], [3, 8, 20], [8, 9, 2]]], 22), ([[[1, 2, 0]]], 0)]),
]


DEBUG_CASES = [
    debug_task("last-element", "solve(values, target) returns whether target occurs in ascending sorted values.",
               "def solve(values, target):\n    lo, hi = 0, len(values) - 1\n    while lo < hi:\n        mid = (lo + hi) // 2\n        if values[mid] == target:\n            return True\n        if values[mid] < target:\n            lo = mid + 1\n        else:\n            hi = mid - 1\n    return False\n",
               "def solve(values, target):\n    lo, hi = 0, len(values) - 1\n    while lo <= hi:\n        mid = (lo + hi) // 2\n        if values[mid] == target:\n            return True\n        if values[mid] < target:\n            lo = mid + 1\n        else:\n            hi = mid - 1\n    return False\n",
               [([[2], 2], True), ([[1, 4, 9], 9], True), ([[], 1], False), ([[1, 4, 9], 2], False)]),
    debug_task("row-alias", "solve(n) returns an n by n identity matrix, for n >= 0.",
               "def solve(n):\n    rows = [[0] * n] * n\n    for i in range(n):\n        rows[i][i] = 1\n    return rows\n",
               "def solve(n):\n    rows = [[0] * n for _ in range(n)]\n    for i in range(n):\n        rows[i][i] = 1\n    return rows\n",
               [([3], [[1, 0, 0], [0, 1, 0], [0, 0, 1]]), ([0], []), ([1], [[1]])]),
    debug_task("false-is-present", "solve(row, key, fallback) returns row[key] if key exists, even when its value is 0, False, empty string or None. Otherwise return fallback.",
               "def solve(row, key, fallback):\n    return row.get(key) or fallback\n",
               "def solve(row, key, fallback):\n    return row[key] if key in row else fallback\n",
               [([{"x": 0}, "x", 9], 0), ([{"x": False}, "x", 9], False), ([{"x": None}, "x", 9], None), ([{}, "x", 9], 9)]),
    debug_task("sort-direction", "solve(rows) returns rows ordered by descending integer score, then ascending string name. Stable for equal score and name.",
               "def solve(rows):\n    return sorted(rows, key=lambda r: (r['score'], r['name']), reverse=True)\n",
               "def solve(rows):\n    return sorted(rows, key=lambda r: (-r['score'], r['name']))\n",
               [([[{"name": "Zo", "score": 4}, {"name": "Al", "score": 4}, {"name": "Bo", "score": 9}]], [{"name": "Bo", "score": 9}, {"name": "Al", "score": 4}, {"name": "Zo", "score": 4}]), ([[]], [])]),
    debug_task("midnight", "solve(start, minutes) adds nonnegative minutes to a valid 'HH:MM' 24-hour clock. Wrap at midnight; return exactly two digits per component.",
               "def solve(start, minutes):\n    hour, minute = [int(x) for x in start.split(':')]\n    total = hour * 60 + minute + minutes\n    return str(total // 60).zfill(2) + ':' + str(total % 60).zfill(2)\n",
               "def solve(start, minutes):\n    hour, minute = [int(x) for x in start.split(':')]\n    total = (hour * 60 + minute + minutes) % 1440\n    return str(total // 60).zfill(2) + ':' + str(total % 60).zfill(2)\n",
               [(["23:50", 25], "00:15"), (["00:00", 2881], "00:01"), (["09:04", 0], "09:04")]),
    debug_task("negative-division", "solve(total, parts) splits any integer total into positive integer parts buckets. Return integer sizes summing to total, differing by at most 1, larger sizes first.",
               "def solve(total, parts):\n    base = int(total / parts)\n    rest = total % parts\n    return [base + (i < rest) for i in range(parts)]\n",
               "def solve(total, parts):\n    base = total // parts\n    rest = total % parts\n    return [base + (i < rest) for i in range(parts)]\n",
               [([-5, 3], [-1, -2, -2]), ([5, 3], [2, 2, 1]), ([0, 2], [0, 0]), ([9007199254740993, 1], [9007199254740993])]),
    debug_task("input-mutation", "solve(values) returns the median of numeric values, or None for empty input. Even length uses the arithmetic mean of the two central values. Preserve the caller's list.",
               "def solve(values):\n    values.sort()\n    n = len(values)\n    if not n:\n        return None\n    return values[n//2] if n % 2 else (values[n//2-1] + values[n//2]) / 2\n",
               "def solve(values):\n    ordered = sorted(values)\n    n = len(ordered)\n    if not n:\n        return None\n    return ordered[n//2] if n % 2 else (ordered[n//2-1] + ordered[n//2]) / 2\n",
               [([[9, 1, 5]], 5), ([[4, 2]], 3.0), ([[]], None)]),
    debug_task("overlap-clamp", "solve(a,b) returns the length of intersection of two half-open [start,end) numeric intervals. start <= end; disjoint and touching intervals have length 0.",
               "def solve(a, b):\n    return min(a[1], b[1]) - max(a[0], b[0])\n",
               "def solve(a, b):\n    return max(0, min(a[1], b[1]) - max(a[0], b[0]))\n",
               [([[0, 1], [4, 8]], 0), ([[0, 4], [2, 7]], 2), ([[0, 2], [2, 9]], 0), ([[2, 2], [0, 8]], 0)]),
    debug_task("escape-order", "solve(text) escapes literal &, < and > into &amp;, &lt; and &gt; respectively, exactly once per ORIGINAL character. Existing entity-looking text is still literal input.",
               "def solve(text):\n    return text.replace('<', '&lt;').replace('>', '&gt;').replace('&', '&amp;')\n",
               "def solve(text):\n    return text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')\n",
               [(["<x>&"], "&lt;x&gt;&amp;"), (["&lt;"], "&amp;lt;"), ([""], "")]),
    debug_task("run-reset", "solve(values) returns the length of the longest STRICTLY increasing contiguous run of integers. Empty input returns 0; equality breaks a run.",
               "def solve(values):\n    longest = current = 0\n    for i, value in enumerate(values):\n        if i == 0 or value >= values[i-1]:\n            current += 1\n        else:\n            current = 0\n        longest = max(longest, current)\n    return longest\n",
               "def solve(values):\n    longest = current = 0\n    for i, value in enumerate(values):\n        if i == 0 or value > values[i-1]:\n            current += 1\n        else:\n            current = 1\n        longest = max(longest, current)\n    return longest\n",
               [([[4, 4, 4]], 1), ([[9, 1, 2, 3]], 3), ([[]], 0), ([[1, 2, 3, 0]], 3)]),
]
