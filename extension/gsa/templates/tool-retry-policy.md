# Tool retry policy

This run may use optional external tools as evidence helpers. This policy applies to every enabled tool in `toolStatus.json`, including recon, scanner, crawler, browser, SAST, dependency, forensics, reverse-engineering, debugger and utility tools. When a tool is selected or attempted, invocation errors must stay attached to that tool.

Rules:
- Do not degrade from any selected tool to curl, wget, Python requests, or a shell-only substitute just because flags, parameters, input format, or usage were wrong.
- First capture the failed command, exit status, stdout, stderr, and output path in `tool-retry-ledger.jsonl`.
- Then inspect the same tool with its local help or version output, such as `tool -h`, `tool --help`, `tool -version`, or `tool --version`, and retry the same tool with corrected arguments.
- A timeout is still a selected-tool failure. Record `reason":"timeout"`, elapsed seconds, wrapper timeout, tool-native timeout/retry flags, and output paths in `tool-retry-ledger.jsonl`; then retry the same tool with a corrected bounded invocation before using any substitute or manual replacement. Corrected timeout retries may increase the outer command budget, lower concurrency, narrow the input set, or adjust tool-native timeout/retry flags while staying in scope.
- Make up to 2 corrected attempts for the same selected tool before using a substitute.
- A substitute is allowed only when the selected tool is missing, disabled, unsupported on this platform, repeatedly fails after same-tool retries, still times out after corrected same-tool timeout retries, or would violate scope. Record `fallbackUsed:true` and why.
- curl or wget may be used as the primary tool only for a generic HTTP fetch/header capture. They must not replace an attempted scanner, prober, crawler, analyzer, browser tool, SAST tool, dependency tool, forensic tool, reverse tool, debugger, or JSON utility without the retry ledger showing why.
- Same-tool retry examples: if `httpx` rejects flags, inspect `httpx -h` and retry `httpx`; if `nuclei` rejects template arguments, inspect `nuclei -h` and retry `nuclei`; if `katana` rejects crawl options, inspect `katana -h` and retry `katana`; if `semgrep`, `trivy`, `syft`, `grype`, `plaso`, `vol`, `yara`, `binwalk`, `tshark`, `zeek`, `nmap`, `rizin`, `radare2`, `gdb`, `pwntools`, `exiftool`, `jq`, or `playwright` rejects arguments, inspect that same tool help and retry that same tool.

Timeout examples: If `nuclei` times out, retry `nuclei` with bounded corrected nuclei options such as narrowed templates/tags/severity, `-timeout`, `-retries`, `-rate-limit`, `-c`, or explicit template paths; do not jump directly to Playwright, curl, or manual XSS checks as a substitute. If `sqlmap` times out, retry `sqlmap` with corrected `--timeout`, `--retries`, `--delay`, `--level`, `--risk`, narrowed URL/parameter scope, or longer bounded wrapper timeout before manual SQLi checks. If `httpx`, `katana`, `ffuf`, `gobuster`, `nmap`, or Playwright time out, retry that same tool with narrower scope, lower concurrency/rate, or corrected timeout budget first.

Nuclei templates: DStudio installs nuclei templates into `NUCLEI_TEMPLATES_DIR` (`templatesDir` in toolStatus.json). Do not pass guessed labels such as `xss`, `sql-injection`, `server-side-request-forgery`, `subdomain-takeover`, or `tech-detect` to `nuclei -t`; those are not template file paths. Do not assume those labels are valid `-tags` either: if nuclei reports `no templates provided for scan` or a dry list loads zero templates, retry the same nuclei task with a known valid tag/path. For technology detection, use `-tags tech` or `-t "$NUCLEI_TEMPLATES_DIR/http/technologies"`, not `-tags tech-detect`. Use `-tags`, `-id`, or explicit template paths under `NUCLEI_TEMPLATES_DIR`, and if `templatesFound` is false rerun the GSA tool installer before using nuclei.

Ledger JSONL shape:
{"tool":"tool-name","attempt":1,"command":"...","status":"failed","exitStatus":1,"stderrPath":"...","reason":"bad flag or bad input shape","next":"retry_same_tool"}
{"tool":"tool-name","attempt":1,"command":"...","status":"timed_out","elapsedSec":30,"wrapperTimeoutSec":30,"reason":"timeout","next":"retry_same_tool_with_corrected_timeout_or_scope"}
{"tool":"tool-name","attempt":2,"command":"...","status":"complete","outputPath":"...","fallbackUsed":false}
