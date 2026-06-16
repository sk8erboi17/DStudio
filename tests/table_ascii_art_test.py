import pathlib
import re
import subprocess
import tempfile
import textwrap
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
HTML = (ROOT / "web" / "index.html").read_text()


def extract_function(source, name):
    match = re.search(rf"function {re.escape(name)}\(", source)
    if not match:
        raise AssertionError(f"{name} not found")
    start = match.start()
    brace = source.index("{", match.end())
    depth = 0
    for idx in range(brace, len(source)):
        ch = source[idx]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return source[start : idx + 1]
    raise AssertionError(f"{name} body not closed")


class TableAsciiArtTest(unittest.TestCase):
    def run_matrix(self, matrix, header_rows=1):
        fn = extract_function(HTML, "tableMatrixToAsciiArt")
        script = textwrap.dedent(
            f"""
            {fn}
            const matrix = {matrix!r};
            process.stdout.write(tableMatrixToAsciiArt(matrix, {header_rows}));
            """
        )
        with tempfile.NamedTemporaryFile("w", suffix=".mjs", delete=False) as f:
            f.write(script)
            path = f.name
        try:
            return subprocess.check_output(["node", path], text=True)
        finally:
            pathlib.Path(path).unlink(missing_ok=True)

    def test_markdown_table_ascii_art(self):
        out = self.run_matrix([
            ["Name", "Risk"],
            ["CSP", "medium"],
            ["HSTS", "high"],
        ])
        self.assertEqual(
            out,
            "\n".join(
                [
                    "+------+--------+",
                    "| Name | Risk   |",
                    "+------+--------+",
                    "| CSP  | medium |",
                    "| HSTS | high   |",
                    "+------+--------+",
                ]
            ),
        )

    def test_empty_matrix(self):
        self.assertEqual(self.run_matrix([], 1), "")


if __name__ == "__main__":
    unittest.main()
