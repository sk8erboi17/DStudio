#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  csrfHeaders,
  jsonFetch,
  listGgufs,
  normalizeBaseUrl,
  pollAgent,
  repoRoot,
  sleep,
  startDStudio,
  startMode,
} from "../../../tests/real_harness.mjs";

const root = repoRoot;
const fixturesRoot = path.join(root, "extension", "gsa", "fixtures");
const indexPath = path.join(fixturesRoot, "index.json");
const benchmarkRoot = path.join(root, "extension", "gsa", "benchmark");

function usage() {
  console.error([
    "usage: node extension/gsa/bench/run.mjs [options]",
    "",
    "Options:",
    "  --out <dir>             Output run directory (default: extension/gsa/benchmark/gsa-<timestamp>)",
    "  --base-url <url>        Use an already running DStudio server",
    "  --case <id>             Run one case id",
    "  --cases <id,id,...>     Run a comma-separated list of case ids",
    "  --failures-from <dir>   Run cases with incorrect/missing outcomes from a previous benchmark run",
    "  --category <name>       Filter category",
    "  --difficulty <name>     Filter difficulty",
    "  --limit <n>             Limit selected cases",
    "  --resume                Skip project folders that already contain report.md or run-error.json",
    "  --list-cases            Print selected case ids and exit without starting DStudio",
    "  --timeout-min <n>       Timeout per agent turn (default: 45)",
    "  --ctx <n>               Agent context tokens (default: 65536)",
    "  --think <ignored>        Accepted for compatibility; GSA always uses thinking=max",
    "  --gguf <relpath>        Model file relative to ds4 dir (default: first uncensored/flash gguf)",
    "  --install-tools         Install/check managed GSA tools before running",
    "  --no-score              Do not run the scorer after cases complete",
    "  --fail-fast             Stop at the first failed case instead of continuing",
    "  --report-only           Regenerate summary/BENCHMARK.md from an existing run directory",
    "",
    "The runner never copies extension/gsa/answer-key into a workspace. Answer keys are",
    "used only by score.mjs after report generation.",
  ].join("\n"));
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      usage();
      process.exit(0);
    }
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "1";
    args[key] = value;
  }
  return args;
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeText(file, text) {
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, text);
}

function writeJson(file, value) {
  writeText(file, JSON.stringify(value, null, 2) + "\n");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function splitList(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveBenchmarkDir(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const direct = path.resolve(root, raw);
  if (fs.existsSync(direct)) return direct;
  const underBenchmark = path.join(benchmarkRoot, raw);
  if (fs.existsSync(underBenchmark)) return underBenchmark;
  return direct;
}

function parseSimpleCsv(text) {
  const lines = String(text || "").trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].split(",").map((s) => s.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = (cells[i] || "").trim();
    return row;
  });
}

function failureCaseIdsFromRun(value) {
  const dir = resolveBenchmarkDir(value);
  if (!dir || !fs.existsSync(dir)) throw new Error(`--failures-from does not exist: ${value}`);
  const ids = new Set();
  const csvPath = path.join(dir, "summary.csv");
  if (fs.existsSync(csvPath)) {
    for (const row of parseSimpleCsv(fs.readFileSync(csvPath, "utf8"))) {
      if (!row.id) continue;
      if (row.outcomeCorrect !== "true" || row.predicted === "missing" || row.reportFile === "missing") {
        ids.add(row.id);
      }
    }
  }
  const failuresPath = path.join(dir, "failures.md");
  if (fs.existsSync(failuresPath)) {
    const text = fs.readFileSync(failuresPath, "utf8");
    for (const m of text.matchAll(/^##\s+([a-z0-9][a-z0-9-]*)\s*$/gmi)) ids.add(m[1]);
  }
  const resultsPath = path.join(dir, "run-results.json");
  if (fs.existsSync(resultsPath)) {
    try {
      for (const r of readJson(resultsPath)) if (r?.id && r.status === "failed") ids.add(r.id);
    } catch {}
  }
  return [...ids];
}

function copyWorkspace(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, {
    recursive: true,
    filter: (p) => !p.split(path.sep).includes(".dstudio"),
  });
}

function stripTranscript(raw) {
  return String(raw || "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\x01USER\x02[\s\S]*?\x01ENDUSER\x02\n?/g, "")
    .replace(/\x1e[^\n]*(?:\n|$)/g, "")
    .replace(/<\/?think>/g, "")
    .trim();
}

function usefulTranscriptText(raw) {
  return stripTranscript(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^new session started$/i.test(line))
    .filter((line) => !/^switched to session\b/i.test(line))
    .filter((line) => !/^saved session\b/i.test(line))
    .filter((line) => !/^time elapsed\b/i.test(line))
    .join("\n")
    .trim();
}

function hasUsefulAgentOutput(raw) {
  return usefulTranscriptText(raw).length > 0;
}

function isNoUsefulOutputError(error) {
  return /without useful output|no transcript started/i.test(error?.message || String(error || ""));
}

function eventLines(raw) {
  const out = [];
  const re = /\x1e([^\n]*)/g;
  let m;
  while ((m = re.exec(String(raw || ""))) !== null) {
    try { out.push(JSON.parse(m[1])); } catch {}
  }
  return out;
}

function collectToolUse(raw) {
  const skillCalls = [];
  const toolCalls = [];
  for (const ev of eventLines(raw)) {
    if (ev?.type !== "tool_call") continue;
    const name = ev.name || ev.tool || "";
    const input = ev.input || {};
    toolCalls.push({ name, input });
    if (name === "skill" && (input.name || input.id)) skillCalls.push(String(input.name || input.id));
  }
  return { skillCalls: [...new Set(skillCalls)], toolCalls };
}

function selectionSkillIds(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  const ids = [];
  for (const h of Array.isArray(parsed?.hypotheses) ? parsed.hypotheses : []) {
    for (const id of Array.isArray(h?.skills) ? h.skills : []) {
      const s = String(id || "").trim();
      if (s) ids.push(s);
    }
  }
  return [...new Set(ids)];
}

function extractBalancedObjects(text) {
  const out = [];
  const s = String(text || "");
  for (let start = s.indexOf("{"); start >= 0; start = s.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inString) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          out.push(s.slice(start, i + 1));
          break;
        }
      }
    }
  }
  return out;
}

function parsePhaseJsonCandidate(candidate, phase) {
  const variants = [candidate];
  if (phase === "preflight") {
    // Schema-based repair for a common strict-JSON failure: the model closes the
    // last hypothesis object, then emits a top-level field while the hypotheses
    // array is still open. Keep the data, but restore the array boundary.
    variants.push(String(candidate).replace(/(\}\s*),\s*"chain_candidates"\s*:/s, "$1],\"chain_candidates\":"));
  }
  for (const variant of variants) {
    try {
      const parsed = JSON.parse(variant);
      if (!phase || phaseJsonIsConcrete(parsed, phase)) {
        return JSON.stringify(parsed, null, 2) + "\n";
      }
    } catch {}
  }
  return "";
}

function containsPlaceholder(value) {
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    return s === "..." ||
      s === "file:line" ||
      s === "relative/path" ||
      s === "why this file matters" ||
      s === "concrete risk" ||
      s === "reachable code path" ||
      s === "what would make this audit not worth continuing";
  }
  if (Array.isArray(value)) return value.some(containsPlaceholder);
  if (value && typeof value === "object") return Object.values(value).some(containsPlaceholder);
  return false;
}

function phaseJsonIsConcrete(parsed, phase) {
  if (!parsed || parsed.phase !== phase || containsPlaceholder(parsed)) return false;
  if (phase === "selection") {
    return Array.isArray(parsed.files) &&
      parsed.files.some((f) => typeof f?.path === "string" && f.path.trim()) &&
      Array.isArray(parsed.hypotheses) &&
      parsed.hypotheses.some((h) => typeof h?.title === "string" && h.title.trim());
  }
  if (phase === "preflight") {
    return Array.isArray(parsed.hypotheses) &&
      parsed.hypotheses.some((h) =>
        typeof h?.title === "string" && h.title.trim() &&
        Array.isArray(h.entrypoints) && h.entrypoints.length);
  }
  if (phase === "validation") {
    return Array.isArray(parsed.findings) &&
      parsed.findings.some((f) =>
        typeof f?.title === "string" && f.title.trim() &&
        typeof f?.confidence === "string" && f.confidence.trim());
  }
  return true;
}

function extractPhaseJson(raw, phase) {
  const cleaned = stripTranscript(raw)
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const candidates = extractBalancedObjects(cleaned).reverse();
  for (const c of candidates) {
    const parsed = parsePhaseJsonCandidate(c, phase);
    if (parsed) return parsed;
  }
  throw new Error(`could not extract ${phase} JSON from agent output`);
}

function extractReportMarkdown(raw) {
  const cleaned = stripTranscript(raw)
    .replace(/^```(?:markdown|md)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const verdict = cleaned.lastIndexOf("## Verdict");
  if (verdict >= 0) return cleaned.slice(verdict).trim();
  return cleaned;
}

function reportVerdict(report) {
  const text = String(report || "");
  const m = text.match(/^##\s*Verdict\b([\s\S]{0,240})/im);
  if (!m) return "";
  const v = m[1].toLowerCase().replace(/[\s-]+/g, "_");
  if (v.includes("confirmed_issue")) return "confirmed_issue";
  if (v.includes("no_issue")) return "no_issue";
  if (v.includes("inconclusive")) return "inconclusive";
  return "";
}

function meaningfulText(value) {
  const text = fieldText(value).trim().toLowerCase();
  return text &&
    !["none", "n/a", "na", "unknown", "no impact", "no exploit path", "not applicable"].includes(text) &&
    !/^no\s+(known\s+)?(impact|exploit path|vulnerability|issue)/.test(text);
}

function fieldText(value) {
  if (Array.isArray(value)) return value.map(fieldText).join(" ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value || "");
}

function compactForPrompt(text, limit = 5000) {
  const s = String(text || "").trim();
  if (s.length <= limit) return s;
  const head = Math.floor(limit * 0.35);
  const tail = limit - head;
  return `${s.slice(0, head)}\n\n[... ${s.length - limit} chars omitted ...]\n\n${s.slice(-tail)}`;
}

function hasDecisiveMissingLink(finding) {
  const missing = fieldText(finding?.missing_evidence).toLowerCase();
  if (!missing || ["none", "n/a", "na", "not applicable"].includes(missing.trim())) return false;
  const decisive = [
    /\bno\s+(direct\s+)?(caller|call\s*chain|callsite|entry\s*point|route|parser|trace|dataset|consumer|output\s+channel)\b/,
    /\b(caller|route|parser|trace|dataset|consumer|dispatch|attacker[-\s]?controlled input).{0,80}\b(absent|missing|not present|unverified|unproved|cannot be demonstrated|cannot demonstrate)\b/,
    /\b(source|artifacts|workspace).{0,80}\b(do not|does not|cannot)\s+prove\s+reachability\b/,
    /\bwould\s+(need|require)\b.{0,80}\b(caller|consumer|route|trace|dataset|primary module|larger service)\b/,
    /\bdepends\s+on\b.{0,80}\b(external|larger service|caller|consumer|downstream|outside)\b/,
    /\bif\b.{0,80}\b(external caller|larger service|downstream consumer|primary module|caller passes|passes untrusted|passes attacker)\b/,
    /\boutside\s+(this\s+)?workspace\b.{0,80}\b(caller|module|consumer|route|evidence)\b/,
    /\bunverifiable\b|\bcontradictory evidence\b|\bdecisive .* absent\b|\bmissing decisive\b/,
  ];
  const limitationOnly = /\bmissing direct (source )?call chain\b/.test(missing) &&
    /\b(functions\.map|trace\.log|reachability-notes|source_excerpt|source excerpt|fuzz-summary|strings\.txt)\b/.test(fieldText(finding).toLowerCase()) &&
    !/\bno artifact supports reachability\b|\bartifacts contradict\b/.test(missing);
  const primitiveLimitationOnly = findingHasExportedPrimitiveEvidence(finding) &&
    /\b(no|missing)\s+(downstream\s+)?(production\s+)?(caller|consumer|controller|middleware|handler|route|service wiring|direct service wiring|call\s*path|caller\s*path)\b|\bservice wiring\b|\bdownstream consumer\b/.test(missing) &&
    !/\b(no artifact supports|artifacts contradict|not exported|not public|no intended use)\b/.test(fieldText(finding).toLowerCase());
  return decisive.some((pattern) => pattern.test(missing)) && !limitationOnly && !primitiveLimitationOnly;
}

function exploitPathIsOnlyConditional(finding) {
  const pathText = fieldText(finding?.exploit_path || finding?.attack_chain || finding?.description || finding?.summary).toLowerCase();
  if (findingHasExportedPrimitiveEvidence(finding)) return false;
  return /\b(if|would|could|may|depends on|requires)\b.{0,100}\b(external caller|larger service|primary module|downstream consumer|outside workspace|not present|missing caller|no caller)\b/.test(pathText);
}

function findingHasExportedPrimitiveEvidence(finding) {
  const text = fieldText(finding).toLowerCase();
  const primitive =
    /\b(crypto|cryptographic|hmac|signature|signing|token|jwt|nonce|key_ref|secret_ref|parser|serializer|policy|verify_|sign_|envelope)\b/.test(text);
  const exported =
    /\b(exported|exports|public api|package api|library api|module api)\b|__init__\.py/.test(text);
  const intendedUse =
    /\b(test|tests|config|artifact|artifacts|inventory|case_notes|policy|intended use|operational)\b/.test(text);
  const lacksContradiction =
    !/\b(no artifact supports reachability|artifacts contradict|not exported|not public|dead code)\b/.test(text);
  return primitive && exported && intendedUse && lacksContradiction;
}

function findingIsReadyConfirmed(finding) {
  const confidence = String(finding?.confidence || "").toLowerCase();
  const severity = String(finding?.severity || "").toLowerCase();
  const title = String(finding?.title || "").toLowerCase();
  if (!["medium", "high"].includes(confidence)) return false;
  if (!["medium", "high", "critical"].includes(severity)) return false;
  if (/^no\s+|no vulnerability|no issue|not vulnerable|no .*overflow|no .*exposure/.test(title)) return false;
  if (hasDecisiveMissingLink(finding) || exploitPathIsOnlyConditional(finding)) return false;
  return meaningfulText(finding?.exploit_path || finding?.attack_chain) && meaningfulText(finding?.impact);
}

function validationImpliesConfirmedIssue(validationText) {
  let parsed;
  try {
    parsed = JSON.parse(validationText);
  } catch {
    return false;
  }
  return (Array.isArray(parsed?.findings) ? parsed.findings : []).some(findingIsReadyConfirmed);
}

function validationBlocksConfirmedIssue(validationText) {
  let parsed;
  try {
    parsed = JSON.parse(validationText);
  } catch {
    return false;
  }
  const findings = Array.isArray(parsed?.findings) ? parsed.findings : [];
  if (!findings.length || findings.some(findingIsReadyConfirmed)) return false;
  return findings.some((finding) =>
    hasDecisiveMissingLink(finding) ||
    exploitPathIsOnlyConditional(finding) ||
    /inconclusive|insufficient|cannot conclude|missing evidence|no confirmed|no reportable/.test(fieldText(finding).toLowerCase())
  );
}

function validationMayHaveArtifactReachabilityConflict(validationText) {
  let parsed;
  try {
    parsed = JSON.parse(validationText);
  } catch {
    return false;
  }
  const text = String(validationText || "").toLowerCase();
  const hasReachabilityArtifacts =
    /functions\.map|trace\.log|reachability-notes|strings\.txt|fuzz-summary|source_excerpt|source excerpt/.test(text);
  const downgraded =
    /\bunreachable\b|not compiled|not linked|no call site|source_excerpt\.c is not in makefile|distinct function/.test(text);
  const vulnPattern =
    /overflow|out-of-bounds|memcpy|strcpy|format string|signature bypass|policy bypass|authorization bypass|exposure/.test(text);
  const hasOnlyLow = (Array.isArray(parsed?.findings) ? parsed.findings : []).some((f) =>
    String(f?.confidence || "").toLowerCase() === "low" &&
    String(f?.severity || "").toLowerCase() === "low"
  );
  const localSourcePrimitiveDowngrade = (Array.isArray(parsed?.findings) ? parsed.findings : []).some((f) => {
    const fText = fieldText(f).toLowerCase();
    return findingHasExportedPrimitiveEvidence(f) &&
      /\b(inconclusive|low)\b/.test(fText) &&
      /\b(no|missing)\s+(downstream\s+)?(production\s+)?(caller|consumer|controller|middleware|handler|route|service wiring|direct service wiring|call\s*path|caller\s*path)\b|\bservice wiring\b|\bdownstream consumer\b/.test(fieldText(f?.missing_evidence).toLowerCase());
  });
  return (hasReachabilityArtifacts && downgraded && vulnPattern && hasOnlyLow) || localSourcePrimitiveDowngrade;
}

function validationRepairPrompt(validationText, evidenceText, preflightText) {
  return [
    "Repair the GSA Phase 3 validation JSON.",
    "The validation appears to treat artifact-based or local-source API reachability as impossible solely because a local Makefile, exact local symbol/call-site, HTTP route, controller, or service wiring is missing.",
    "Use only preflight.json, evidence.jsonl and the existing validation JSON below. Do not use answer keys and do not invent findings.",
    "General rule: in reverse-engineering and production-artifact reviews, function maps, strings, trace logs, reachability notes, fuzz summaries, source excerpts and config may establish intended operational reachability.",
    "A source excerpt may describe a mapped production function even if the local symbol name differs. If multiple artifacts consistently point to a fallback/parser path and the excerpt shows a concrete memory-safety defect, preserve it as a security finding with confidence `medium`; put the missing direct source call chain in `missing_evidence` instead of marking the whole finding unreachable.",
    "Authorized-local-source-review rule: when the reviewed unit is a library/package and an exported cryptographic, token, signature, serializer, parser, or policy primitive is cited with tests/config/artifacts showing intended use, the public API parameter is the reviewed trust boundary. Missing HTTP/server wiring is a limitation, not a decisive missing link.",
    "`minimum_confidence_to_report: high` means high confidence in the defect within the submitted reviewed unit; it does not require proof of an outside service that was not included in the workspace.",
    "Tool-output rule: external scanner output is advisory only. A clean/empty tool result must not erase a finding unless source/artifact evidence also kills the path; a positive tool result still needs reachability evidence.",
    "Attack-chain rule: if several weaker facts compose into impact, preserve the chain as ordered `attack_chain` links instead of judging each weakness in isolation.",
    "Confirmation gate: confirmed findings require defect/control gap, reachable untrusted input, attacker capability, propagation/consumer or execution path, and concrete impact. If the chain depends on an external caller/consumer/route/dataset that is absent or unverified, return inconclusive or no_issue instead of confirmed.",
    "Local-source exception: for exported cryptographic, token, signature, serializer, parser, or policy primitives, caller-controlled function parameters plus tests/config/artifacts showing intended use can satisfy reachable data-source/consumer links for a bounded code-level finding; missing service wiring belongs in missing_evidence instead of automatic kill criteria.",
    "If that local-source exception applies and the source defect, attacker-controlled parameter, exploit path inside the primitive, and impact on the primitive's security guarantee are clear, preserve the finding at medium/high confidence. Put missing production caller/consumer/route/service wiring in `missing_evidence`; do not downgrade the verdict solely for that absence.",
    "Generic helper rule: open(path), CSV output, string parsing, or loader defects are not confirmed vulnerabilities unless a caller/artifact/test shows attacker influence over the argument and a concrete consumer/impact.",
    "If the artifacts truly contradict each other or no artifact supports reachability, keep the low/no-issue/inconclusive conclusion.",
    "Return one strict JSON object only with phase `validation` and the same schema.",
    "",
    "preflight.json:",
    preflightText.trim(),
    "",
    "evidence.jsonl:",
    String(evidenceText || "").trim() || "(empty)",
    "",
    "Previous validation.json:",
    validationText.trim(),
  ].join("\n");
}

function reportRepairPrompt(report, validationText, evidenceText) {
  return [
    "Repair the GSA Phase 4 report.",
    "The report verdict contradicts validation.json.",
    "Use only validation.json and evidence.jsonl below. Do not add new findings, do not call tools, and do not re-litigate validation.",
    "If validation.json contains a medium/high-confidence security finding with non-empty exploit_path and impact, the Markdown must start with `## Verdict: confirmed_issue`.",
    "Exception: if missing_evidence or the exploit path says the caller, route, parser, trace, dataset, downstream consumer, dispatch link, or attacker-controlled input is absent/unverified, the report must not be confirmed_issue unless another finding has a complete chain or validation explicitly accepted an exported/default primitive as a bounded code-level finding.",
    "For authorized local source reviews, if validation accepted an exported cryptographic/token/signature/parser/serializer/policy primitive as the reviewed boundary, missing HTTP/controller/service wiring stays as a limitation inside the finding and must not flip the verdict.",
    "If validation.json contains `attack_chain`, preserve it as ordered chain links in the report.",
    "If validation mentions external-tool output, present it as advisory evidence and keep the manual/code citations as the deciding evidence.",
    "If validation only proves that an expected attack surface is absent from a reduced or contradictory workspace, the report verdict must be `inconclusive`, not `no_issue`, unless validation cites a present reviewed control that blocks the exploit path.",
    "Mention missing_evidence as a limitation inside the confirmed finding; do not convert it into the overall verdict unless validation blocked every finding.",
    "Start with `## Verdict: confirmed_issue`, `## Verdict: no_issue`, or `## Verdict: inconclusive`.",
    "Return Markdown only, no preamble and no code fences.",
    "",
    "validation.json:",
    validationText.trim(),
    "",
    "evidence.jsonl:",
    String(evidenceText || "").trim() || "(empty)",
    "",
    "Previous report:",
    report.trim(),
  ].join("\n");
}

function reportOverconfirmRepairPrompt(report, validationText, evidenceText) {
  return [
    "Repair the GSA Phase 4 report.",
    "The report appears over-confirmed: validation.json does not contain a complete medium/high-confidence finding after applying the confirmation gate.",
    "Use only validation.json and evidence.jsonl below. Do not add findings, do not call tools, and do not use answer keys.",
    "Confirmation gate: confirmed_issue requires defect/control gap, reachable untrusted input, attacker capability, propagation/consumer or execution path, and concrete impact.",
    "If the report relies on phrases like `if an external caller passes`, `larger service would need`, no caller present, no downstream consumer, no route/parser/trace/dataset, or unverified dispatch, start with `## Verdict: inconclusive` and name the missing link unless validation explicitly accepted an exported/default primitive as a bounded code-level finding.",
    "For authorized local source reviews, do not overrule validation solely because the submitted package lacks a server/controller when the validated boundary is an exported primitive with tests/config/artifacts.",
    "Use `## Verdict: no_issue` only when validation cites present reviewed controls that block the exploit path.",
    "Start with exactly one verdict heading: `## Verdict: confirmed_issue`, `## Verdict: no_issue`, or `## Verdict: inconclusive`.",
    "Return Markdown only, no preamble and no code fences.",
    "",
    "validation.json:",
    validationText.trim(),
    "",
    "evidence.jsonl:",
    String(evidenceText || "").trim() || "(empty)",
    "",
    "Previous report:",
    report.trim(),
  ].join("\n");
}

function thinkControl(value) {
  return `\x1e${JSON.stringify({ type: "control", name: "think", value })}\n`;
}

function phaseThinkLevel(_phase, _opts) {
  return "max";
}

function phaseTimeoutMs(_phase, opts) {
  const base = Number(opts.turnTimeoutMs || 30 * 60 * 1000);
  return base;
}

async function waitAgentQuiet(baseUrl, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastLen = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    try {
      const r = await pollAgent(baseUrl, 0);
      const len = Number.isFinite(Number(r.len)) ? Number(r.len) : -1;
      if (r.working === false && len === lastLen) {
        stable++;
        if (stable >= 2) return true;
      } else {
        stable = 0;
      }
      lastLen = len;
    } catch {
      return false;
    }
    await sleep(1000);
  }
  return false;
}

function interruptStatusForReason(reason) {
  const r = String(reason || "").toLowerCase();
  if (r.includes("json captured")) return "completed";
  if (r.includes("stalled") ||
      r.includes("timed out") ||
      r.includes("transcript budget exceeded") ||
      r.includes("failed")) return "incomplete";
  return "canceled";
}

async function safeInterruptAgent(baseUrl, reason = "benchmark runner cleanup", status = "") {
  const finalStatus = status || interruptStatusForReason(reason);
  try {
    await jsonFetch(baseUrl, "/api/agent/interrupt", {
      method: "POST",
      headers: csrfHeaders,
      body: JSON.stringify({ reason, status: finalStatus }),
      timeoutMs: 5_000,
    });
  } catch {}
  await waitAgentQuiet(baseUrl, 30_000);
}

function candidatePaths(caseDir) {
  const file = path.join(caseDir, "gsa", "candidates.txt");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.split("\t")[0].trim())
    .filter(Boolean);
}

function relExists(workspace, rel) {
  if (!rel || path.isAbsolute(rel) || rel.includes("\0")) return false;
  const clean = rel.replace(/^\.\/+/, "");
  if (clean.split(/[\\/]+/).includes("..")) return false;
  try {
    return fs.existsSync(path.join(workspace, clean));
  } catch {
    return false;
  }
}

function normalizeSelectedPath(raw, workspace, candidates) {
  let rel = String(raw || "").trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  rel = rel.replace(/^workspace\/+/, "");
  if (relExists(workspace, rel)) return rel;
  if (candidates.includes(rel)) return rel;
  const base = path.posix.basename(rel);
  const suffixMatches = candidates.filter((c) => c === rel || c.endsWith(`/${rel}`));
  if (suffixMatches.length === 1) return suffixMatches[0];
  const baseMatches = candidates.filter((c) => path.posix.basename(c) === base);
  if (baseMatches.length === 1) return baseMatches[0];
  return rel;
}

function normalizeSelectionJson(jsonText, workspace, caseDir, manifest) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return jsonText;
  }
  const candidates = candidatePaths(caseDir);
  let changed = 0;
  if (Array.isArray(parsed.files)) {
    parsed.files = parsed.files.map((f) => {
      if (!f || typeof f !== "object") return f;
      const before = f.path;
      const after = normalizeSelectedPath(before, workspace, candidates);
      if (after && after !== before) {
        changed++;
        return { ...f, path: after };
      }
      return f;
    });
  }
  if (changed) manifest.normalizedSelectionPaths = changed;
  return JSON.stringify(parsed, null, 2) + "\n";
}

function invalidSelectionPaths(jsonText, workspace, caseDir) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return ["<invalid-json>"];
  }
  const candidates = new Set(candidatePaths(caseDir));
  const invalid = [];
  for (const f of Array.isArray(parsed.files) ? parsed.files : []) {
    const rel = String(f?.path || "").trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^workspace\/+/, "");
    if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]+/).includes("..")) {
      invalid.push(rel || "<empty>");
      continue;
    }
    if (!candidates.has(rel) || !relExists(workspace, rel)) invalid.push(rel);
  }
  return [...new Set(invalid)];
}

function selectionRepairPrompt(jsonText, caseDir) {
  const candidates = candidatePaths(caseDir);
  return [
    "Repair the Phase 1 selection JSON.",
    "Some `files[].path` values were not exact entries from candidates.txt.",
    "Output one JSON object only with phase `selection` and the same schema.",
    "Rules:",
    "- Every `files[].path` must be copied exactly from the candidate list below.",
    "- Drop any file that does not have an exact listed candidate.",
    "- Do not add prose, markdown, tool calls, scripts, or evidence.",
    "",
    "Candidate list:",
    candidates.map((c) => `- ${c}`).join("\n"),
    "",
    "Previous JSON:",
    jsonText.trim(),
  ].join("\n");
}

function selectionFinalizePrompt(rawText, caseDir) {
  const candidates = candidatePaths(caseDir);
  return [
    "Finalize GSA Phase 1 selection JSON.",
    "The previous selection turn produced useful analysis but did not emit a valid JSON artifact.",
    "Use only the previous raw transcript excerpt and the candidate list below. Do not read files, call tools, write scripts, or use answer keys.",
    "Return one compact strict JSON object only with this schema:",
    "{\"phase\":\"selection\",\"files\":[{\"path\":\"candidate/path\",\"why\":\"why this file matters\"}],\"targetUrl\":\"\",\"localScripts\":[{\"path\":\"scripts/name.py\",\"purpose\":\"optional targeted helper\"}],\"hypotheses\":[{\"title\":\"...\",\"why\":\"...\",\"skills\":[\"skill-id\"]}],\"stop_if\":\"what would make this audit not worth continuing\"}",
    "Rules:",
    "- The first non-whitespace character must be `{` and the last non-whitespace character must be `}`.",
    "- Every files[].path must be copied exactly from the candidate list.",
    "- Candidate paths are relative to the workspace root, not the GSA run directory.",
    "- Select only files that the previous transcript already made relevant.",
    "- Keep at most 6 files, 3 hypotheses, and 2 localScripts.",
    "- Leave localScripts empty unless the previous transcript explicitly justified a targeted Python helper.",
    "- Do not add prose, markdown, or code fences.",
    "",
    "Candidate list:",
    candidates.map((c) => `- ${c}`).join("\n"),
    "",
    "Previous selection raw excerpt:",
    usefulTranscriptText(rawText).slice(-9000) || "(empty)",
  ].join("\n");
}

function projectReadCount(rawText, workspace) {
  const root = String(workspace || "").replace(/\/+$/, "");
  if (!root) return 0;
  const seen = new Set();
  const re = new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/[^\\s\"\\u001e]+", "g");
  for (const match of String(rawText || "").matchAll(re)) {
    const file = match[0];
    if (file.includes("/.dstudio/")) continue;
    seen.add(file.split(":")[0]);
  }
  return seen.size;
}

function selectionEvidencePrompt(rawText, workspace, caseDir) {
  const candidates = candidatePaths(caseDir);
  return [
    "Redo GSA Phase 1 selection with evidence.",
    "The previous selection returned JSON before reading enough real project files.",
    `Workspace root: ${workspace}`,
    "Before the final JSON, use the read tool on 4-6 candidate files from the workspace root: include core source plus at least one config/test/artifact when available.",
    "After those reads, output one compact strict JSON object with phase `selection` and the same schema.",
    "Do not use answer keys. Do not create scripts. Do not write files. Do not use conventional filenames that are not in the candidate list.",
    "Every files[].path must be copied exactly from the candidate list below.",
    "Candidate paths are relative to the workspace root, not the GSA run directory.",
    "If the title/theme is misleading, select the actual pipeline files and hypotheses supported by the reads.",
    "",
    "Candidate list:",
    candidates.map((c) => `- ${c}`).join("\n"),
    "",
    "Previous selection JSON/raw excerpt:",
    usefulTranscriptText(rawText).slice(-5000) || "(empty)",
  ].join("\n");
}

function parseShortlistedSkills(text) {
  const skills = [];
  const re = /^##\s+([a-z0-9-]+)\s*$/gm;
  let m;
  while ((m = re.exec(text || "")) !== null) skills.push(m[1]);
  return skills;
}

function chooseGguf(ds4Dir, explicit) {
  if (explicit) return explicit;
  const ggufs = listGgufs(ds4Dir).map((g) => g.file);
  return ggufs.find((g) => /abliterated|uncensored/i.test(g)) ||
         ggufs.find((g) => /flash/i.test(g)) ||
         ggufs[0] ||
         "";
}

function selectCases(args) {
  let items = readJson(indexPath);
  const allIds = new Set(items.map((i) => i.id));
  const explicitIds = new Set();
  if (args.case) explicitIds.add(args.case);
  for (const id of splitList(args.cases)) explicitIds.add(id);
  if (args["failures-from"]) {
    for (const id of failureCaseIdsFromRun(args["failures-from"])) explicitIds.add(id);
  }
  if (explicitIds.size) {
    const missing = [...explicitIds].filter((id) => !allIds.has(id));
    if (missing.length) throw new Error(`unknown benchmark case id(s): ${missing.join(", ")}`);
    items = items.filter((i) => explicitIds.has(i.id));
  }
  if (args.category) items = items.filter((i) => i.category === args.category);
  if (args.difficulty) items = items.filter((i) => i.difficulty === args.difficulty);
  if (args.limit) items = items.slice(0, Number(args.limit));
  if (!items.length) throw new Error("no benchmark cases selected");
  return items;
}

function missionFor(item) {
  const lines = [
    `Perform a high-signal local-only GSA security review for project "${item.title}".`,
    `Domain: ${item.category}.`,
    "Inspect the copied workspace source and artifacts only.",
    "Do not assume a vulnerability exists.",
    "Return confirmed_issue, no_issue, or inconclusive only when the evidence supports it.",
    "A confirmed issue requires a complete chain: defect/control gap, reachable untrusted input, attacker capability, propagation or consumer/execution path, and concrete impact.",
    "For exported cryptographic, token, signature, serializer, parser, or policy primitives, caller-controlled function parameters plus tests/config/artifacts showing intended use can satisfy reachable data-source/consumer links for a bounded code-level finding.",
    "Generic helpers such as readers, loaders, open(path), CSV writers, and parsers are not reportable by themselves without a caller/artifact/test that proves attacker influence and impact.",
    "If an early hypothesis from the title is dead but the reviewed pipeline reveals a stronger concrete issue, pivot to that concrete issue and cite why the original hypothesis is dead.",
    "Use concrete file:line citations and create scratch Python scripts in scripts/ only when useful.",
    "If tools are available, treat them as advisory only; manual source/artifact reasoning remains decisive.",
    "A missing external command is not a hard failure: state what is missing, then continue with source, artifacts and bounded Python helpers when possible.",
    "A clean or empty scanner result is never proof of safety by itself; only close a hypothesis when code/artifact evidence also shows the relevant control or unreachable path.",
    "A positive scanner result is not enough by itself either; tie it to a cited reachable code path, artifact, request flow, trace or concrete consumer before reporting it.",
    "If a script or external command remains only planned and was not created/run, treat that as incomplete evidence, not success.",
    "Consider attack chains where multiple weaker findings compose into impact, but report them only with evidence for each link.",
    "External recon is out of scope for this benchmark case unless target.md contains an authorized target URL.",
  ];
  if (item.category === "crypto") {
    lines.push(
      "Crypto review focus: inspect sign/verify/envelope/key-registry/policy/canonicalization paths; explicitly separate safe constant-time comparison controls from key-binding, key-material/reference, nonce/replay, and canonicalization defects."
    );
  }
  return lines.join("\n");
}

async function sendAgentTurn(baseUrl, prompt, displayPrompt, timeoutMs, caseDir, phase, thinkLevel, opts = {}) {
  const sent = await jsonFetch(baseUrl, "/api/agent/send", {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ prompt: `${thinkControl("max")}${prompt}`, displayPrompt }),
    timeoutMs: 30_000,
  });
  writeJson(path.join(caseDir, `${phase}.send.json`), sent);
  const start = Number.isFinite(Number(sent.at)) ? Number(sent.at) : Number(sent.from || 0);
  const deadline = Date.now() + timeoutMs;
  let pos = start;
  let raw = "";
  let last = null;
  let lastProgressAt = Date.now();
  let lastLiveWriteAt = 0;
  let lastLiveWriteBytes = 0;
  let emptyReadySince = 0;
  const defaultStallMs = thinkLevel === "max" ? 12 * 60 * 1000 : 4 * 60 * 1000;
  const stallTimeoutMs = opts.stallTimeoutMs || Math.min(timeoutMs, defaultStallMs);
  const noStartTimeoutMs = opts.noStartTimeoutMs || Math.min(timeoutMs, thinkLevel === "max" ? 5 * 60 * 1000 : 90_000);
  const emptyReadyGraceMs = opts.emptyReadyGraceMs || 15_000;
  const maxRawBytes = opts.maxRawBytes || (thinkLevel === "max" ? 320_000 : 70_000);
  const liveRawPath = path.join(caseDir, `${phase}.raw.live.txt`);
  while (Date.now() < deadline) {
    const r = await pollAgent(baseUrl, pos);
    last = r;
    if (r.text) {
      raw += r.text;
      lastProgressAt = Date.now();
    }
    if (raw && (Date.now() - lastLiveWriteAt > 15_000 || raw.length - lastLiveWriteBytes > 4096)) {
      writeText(liveRawPath, raw);
      lastLiveWriteAt = Date.now();
      lastLiveWriteBytes = raw.length;
    }
    pos = Number.isFinite(Number(r.len)) ? Number(r.len) : pos;
    if (!raw.trim()) {
      if (r.working === false) {
        emptyReadySince ||= Date.now();
        if (Date.now() - emptyReadySince > emptyReadyGraceMs) {
          writeText(path.join(caseDir, `${phase}.raw.txt`), raw);
          throw new Error(`agent turn no transcript started during ${phase}; send response: ${JSON.stringify(sent)}; last poll: ${JSON.stringify(last)}`);
        }
      } else {
        emptyReadySince = 0;
      }
      if (Date.now() - lastProgressAt > noStartTimeoutMs) {
        writeText(path.join(caseDir, `${phase}.raw.txt`), raw);
        await safeInterruptAgent(baseUrl, `phase ${phase} no transcript started`);
        throw new Error(`agent turn no transcript started during ${phase} after ${Math.round(noStartTimeoutMs / 1000)}s; send response: ${JSON.stringify(sent)}; last poll: ${JSON.stringify(last)}`);
      }
    }
    if (phase !== "report" && raw.trim()) {
      try {
        extractPhaseJson(raw, phase);
        writeText(path.join(caseDir, `${phase}.raw.txt`), raw);
        await safeInterruptAgent(baseUrl, `phase ${phase} JSON captured`);
        return raw;
      } catch {}
    }
    if (r.working === false && raw.trim()) {
      writeText(path.join(caseDir, `${phase}.raw.txt`), raw);
      if (!hasUsefulAgentOutput(raw)) {
        throw new Error(`agent turn ended without useful output during ${phase}; last poll: ${JSON.stringify(last)}`);
      }
      return raw;
    }
    if (raw.length > maxRawBytes) {
      writeText(path.join(caseDir, `${phase}.raw.txt`), raw);
      await safeInterruptAgent(baseUrl, `phase ${phase} transcript budget exceeded`);
      throw new Error(`agent turn exceeded transcript budget during ${phase}; raw bytes=${raw.length}; last poll: ${JSON.stringify(last)}`);
    }
    if (raw.trim() && Date.now() - lastProgressAt > stallTimeoutMs) {
      writeText(path.join(caseDir, `${phase}.raw.txt`), raw);
      await safeInterruptAgent(baseUrl, `phase ${phase} stalled`);
      throw new Error(`agent turn stalled during ${phase}; no transcript progress for ${Math.round((Date.now() - lastProgressAt) / 1000)}s; last poll: ${JSON.stringify(last)}`);
    }
    await sleep(1000);
  }
  writeText(path.join(caseDir, `${phase}.raw.txt`), raw);
  await safeInterruptAgent(baseUrl, `phase ${phase} timed out`);
  throw new Error(`agent turn timed out during ${phase}; last poll: ${JSON.stringify(last)}`);
}

async function sendAgentTurnWithRetry(baseUrl, prompt, displayPrompt, timeoutMs, caseDir, phase, thinkLevel, manifest, opts = {}) {
  try {
    return await sendAgentTurn(baseUrl, prompt, displayPrompt, timeoutMs, caseDir, phase, thinkLevel, opts);
  } catch (e) {
    if (!isNoUsefulOutputError(e)) throw e;
    const key = `${phase.replace(/[^a-z0-9]+/gi, "_")}Retry`;
    manifest[key] = {
      reason: e?.message || String(e),
      attempts: 1,
    };
    await resetAgentSession(baseUrl);
    const raw = await sendAgentTurn(
      baseUrl,
      prompt,
      `${displayPrompt} retry`,
      timeoutMs,
      caseDir,
      phase,
      thinkLevel,
      opts,
    );
    manifest[key].attempts = 2;
    return raw;
  }
}

function preflightFinalizePrompt(selectionText, rawText) {
  return [
    "Finalize GSA Phase 2 preflight JSON.",
    "The previous preflight turn did not emit the required JSON artifact before it was interrupted.",
    "Use only selection.json and the previous raw transcript excerpt below. Do not call tools, do not read files, do not write scripts.",
    "Return one compact strict JSON object only with phase `preflight` and this schema:",
    "{\"phase\":\"preflight\",\"hypotheses\":[{\"title\":\"...\",\"entrypoints\":[\"file:line\"],\"attacker\":\"...\",\"evidence_needed\":[\"...\"],\"kill_criteria\":[\"...\"],\"chain_candidates\":[\"optional evidence-backed composed path\"]}]}",
    "Top-level keys must be exactly `phase` and `hypotheses`; `chain_candidates` belongs inside each hypothesis object, never beside the hypotheses array.",
    "Every `[` must be closed before adding any next object key. If unsure, omit optional fields instead of adding invalid JSON.",
    "Do not continue debating once the entrypoint, missing link, and kill criteria are clear. Preserve that as JSON.",
    "If a selected hypothesis does not apply, keep it only if it is important to kill in validation; otherwise include the strongest 1-3 hypotheses.",
    "For generic helper hypotheses, include the concrete caller/artifact/test that supplies untrusted input; if none exists, put that absence in kill_criteria.",
    "For exported cryptographic, token, signature, serializer, parser, or policy primitives, do not use missing service wiring as automatic kill criteria when tests/config/artifacts show intended use; carry it as missing_evidence.",
    "If selected files show a different concrete security issue than the original selection guess, include that stronger issue and state which guess was killed.",
    "",
    "selection.json:",
    String(selectionText || "").trim() || "(missing)",
    "",
    "Previous preflight raw excerpt:",
    stripTranscript(String(rawText || "")).slice(-7000) || "(empty)",
  ].join("\n");
}

function validationFinalizePrompt(preflightText, evidenceText, rawText) {
  return [
    "Finalize GSA Phase 3 validation JSON.",
    "The previous validation turn produced evidence but did not emit the required JSON artifact before it was interrupted.",
    "Use only preflight.json, evidence.jsonl, and the previous raw transcript excerpt below. Do not call tools, do not read files, and do not invent new evidence.",
    "If evidence.jsonl is empty but the raw transcript excerpt contains concrete source reads, file:line citations, script output, or artifact excerpts, treat that raw transcript as provisional evidence and cite it in the validation JSON.",
    "Do not return inconclusive solely because evidence.jsonl is empty or because the prior turn was interrupted; return inconclusive only when the raw transcript and preflight still lack a decisive chain.",
    "Return one compact strict JSON object only with phase `validation` and this schema:",
    "{\"phase\":\"validation\",\"findings\":[{\"title\":\"...\",\"severity\":\"low|medium|high|critical\",\"evidence\":[\"file:line\"],\"exploit_path\":\"...\",\"impact\":\"...\",\"confidence\":\"low|medium|high\",\"missing_evidence\":\"...\",\"attack_chain\":[\"optional ordered evidence-backed chain link\"]}]}",
    "Make one decision matrix pass only: complete chain -> medium/high confidence finding; missing decisive caller/route/dataset/consumer -> inconclusive; present blocking controls -> no_issue. Then emit JSON immediately.",
    "If evidence is insufficient or contradictory, return one finding whose title clearly says inconclusive/no confirmed issue, with confidence `low` and explicit missing_evidence.",
    "Confirmed findings require all five links: defect/control gap, reachable untrusted input, attacker capability, propagation/consumer or execution path, and concrete impact.",
    "For exported cryptographic, token, signature, serializer, parser, or policy primitives, caller-controlled function parameters plus tests/config/artifacts showing intended use can satisfy reachable data-source/consumer links for a bounded code-level finding.",
    "In an authorized local source review of a package/library, the exported public API is itself a valid boundary; do not require an HTTP route, controller, CLI, or service main if the workspace did not include one.",
    "`minimum_confidence_to_report: high` applies to confidence in the reviewed-unit defect and evidence chain, not to unseen production wiring outside the submitted workspace.",
    "If all preflight hypotheses are dead but the same evidence contains a different concrete issue with a complete chain, validate that issue instead of returning a false no-issue.",
    "If the chain depends on an absent external caller, missing route/parser/trace/dataset, unverified dispatch, or unknown downstream consumer, return inconclusive or no_issue instead of confirmed unless the exported/default primitive rule above establishes a bounded code-level finding.",
    "Generic helper issues such as open(path), CSV output, string parsing, or loader behavior are not confirmed unless a caller/artifact/test proves attacker influence over that argument and a concrete impact.",
    "Do not treat clean/empty external-tool output as decisive unless manual source/artifact evidence gives it coverage.",
    "If an external tool is missing or failed, record that limitation and continue from source/artifact/Python evidence instead of failing the audit.",
    "If scripts or external commands are still only planned, treat them as incomplete evidence; do not count them as validation.",
    "Positive tool output is advisory too: confirm with reachable code, artifacts, traces, configs, or a bounded Python helper before reporting.",
    "If the mission/artifacts describe an expected attack surface but the reduced workspace lacks the decisive production route, parser, binary path, trace, packet, image, or dataset needed to prove that surface, return inconclusive with that missing artifact; do not convert absence into high-confidence no_issue.",
    "Use no_issue only when the relevant implementation/control is present, cited, and demonstrably blocks the tested exploit path.",
    "For inconclusive/no-surface cases, cite both the missing expected surface and the real reachable pipeline that is present: entry route/parser, auth/session boundary, data/storage access, policy/control files, and contradictory artifacts when available.",
    "Do not use severity `none`; use severity `low` for no-issue/inconclusive evidence trails.",
    "",
    "preflight.json:",
    String(preflightText || "").trim() || "(missing)",
    "",
    "evidence.jsonl:",
    String(evidenceText || "").trim() || "(empty)",
    "",
    "Previous validation raw excerpt:",
    compactForPrompt(stripTranscript(String(rawText || "")), 3500) || "(empty)",
  ].join("\n");
}

async function resetAgentSession(baseUrl) {
  try {
    const r = await pollAgent(baseUrl, 0);
    if (r?.working) {
      await safeInterruptAgent(baseUrl, "resetting agent session before next GSA phase", "canceled");
    }
  } catch {}
  await waitAgentQuiet(baseUrl, 30_000);
  await jsonFetch(baseUrl, "/api/design/session", {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ action: "new" }),
    timeoutMs: 10_000,
  }).catch(() => {});
  await waitAgentQuiet(baseUrl, 30_000);
}

function copyGsaArtifacts(runDir, caseDir) {
  const dst = path.join(caseDir, "gsa");
  fs.rmSync(dst, { recursive: true, force: true });
  if (runDir && fs.existsSync(runDir)) fs.cpSync(runDir, dst, { recursive: true });
  return dst;
}

async function runCase(baseUrl, item, outRoot, opts) {
  const caseDir = path.join(outRoot, item.id);
  if (opts.resume && (fs.existsSync(path.join(caseDir, "report.md")) || fs.existsSync(path.join(caseDir, "run-error.json")))) {
    return { id: item.id, skipped: true, caseDir };
  }
  mkdirp(caseDir);
  const workspace = path.join(caseDir, "workspace");
  copyWorkspace(path.join(root, item.workspace), workspace);
  writeJson(path.join(caseDir, "case.json"), {
    id: item.id,
    title: item.title,
    category: item.category,
    difficulty: item.difficulty,
    sourceWorkspace: item.workspace,
    workspace,
  });

  await resetAgentSession(baseUrl);
  const startedAt = Date.now();
  const transcriptParts = [];
  const manifest = {
    id: item.id,
    title: item.title,
    category: item.category,
    difficulty: item.difficulty,
    workspace,
    status: "running",
    startedAt: new Date(startedAt).toISOString(),
    phases: {},
    shortlistedSkills: [],
    skillCalls: [],
    toolCalls: [],
  };
  let start = null;

  try {
    start = await jsonFetch(baseUrl, "/api/gsa/start", {
      method: "POST",
      headers: csrfHeaders,
      body: JSON.stringify({ workdir: workspace, mission: missionFor(item), targetUrl: "" }),
      timeoutMs: 30_000,
    });
    writeJson(path.join(caseDir, "gsa-start.json"), start);
    manifest.gsaRunId = start.runId;
    manifest.gsaRunDir = start.runDir;
    manifest.candidateCount = start.candidateCount;
    manifest.skillCount = start.skillCount;
    copyGsaArtifacts(start.runDir, caseDir);
    const skillsPath = path.join(caseDir, "gsa", "skills.md");
    if (fs.existsSync(skillsPath)) {
      manifest.shortlistedSkills = parseShortlistedSkills(fs.readFileSync(skillsPath, "utf8"));
    }

    let prompt = start.prompt;
    const phaseOrder = ["selection", "preflight", "validation"];
    for (let phaseIndex = 0; phaseIndex < phaseOrder.length; phaseIndex++) {
      const phase = phaseOrder[phaseIndex];
      if (phaseIndex > 0) {
        await resetAgentSession(baseUrl);
        manifest.phaseFreshSessions ||= [];
        manifest.phaseFreshSessions.push(phase);
      }
      let raw;
      let rawReadEvidence = "";
      try {
        raw = await sendAgentTurnWithRetry(
          baseUrl,
          prompt,
          `/gsa ${item.id} ${phase}`,
          phaseTimeoutMs(phase, opts),
          caseDir,
          phase,
          phaseThinkLevel(phase, opts),
          manifest,
          phase === "selection"
            ? { stallTimeoutMs: 90_000, maxRawBytes: 75_000 }
            : phase === "preflight"
              ? { stallTimeoutMs: 120_000, maxRawBytes: 90_000 }
              : phase === "validation"
                ? { stallTimeoutMs: 120_000, maxRawBytes: 140_000 }
                : {},
        );
        rawReadEvidence = raw;
      } catch (e) {
        if (phase === "selection") {
          const rawPath = path.join(caseDir, `${phase}.raw.txt`);
          const rawText = fs.existsSync(rawPath) ? fs.readFileSync(rawPath, "utf8") : "";
          if (!hasUsefulAgentOutput(rawText)) throw e;
          rawReadEvidence = rawText;
          manifest.selectionFinalize = {
            reason: e?.message || String(e),
            rawBytes: rawText.length,
            freshSession: true,
          };
          await resetAgentSession(baseUrl);
          const finalizeRaw = await sendAgentTurnWithRetry(
            baseUrl,
            selectionFinalizePrompt(rawText, caseDir),
            `/gsa ${item.id} selection finalize`,
            phaseTimeoutMs("selection-finalize", opts),
            caseDir,
            "selection-finalize",
            phaseThinkLevel("selection-finalize", opts),
            manifest,
            { stallTimeoutMs: 60_000, maxRawBytes: 30_000 },
          );
          transcriptParts.push(`\n\n===== SELECTION INTERRUPTED BEFORE JSON =====\n\n${rawText}`);
          raw = finalizeRaw;
        } else if (phase === "preflight") {
          const rawPath = path.join(caseDir, `${phase}.raw.txt`);
          const rawText = fs.existsSync(rawPath) ? fs.readFileSync(rawPath, "utf8") : "";
          if (!hasUsefulAgentOutput(rawText)) throw e;
          rawReadEvidence = rawText;
          const selectionText = fs.existsSync(path.join(caseDir, "selection.json"))
            ? fs.readFileSync(path.join(caseDir, "selection.json"), "utf8")
            : "";
          manifest.preflightFinalize = {
            reason: e?.message || String(e),
            rawBytes: rawText.length,
            freshSession: true,
          };
          await resetAgentSession(baseUrl);
          const finalizeRaw = await sendAgentTurnWithRetry(
            baseUrl,
            preflightFinalizePrompt(selectionText, rawText),
            `/gsa ${item.id} preflight finalize`,
            phaseTimeoutMs("preflight-finalize", opts),
            caseDir,
            "preflight",
            phaseThinkLevel("preflight-finalize", opts),
            manifest,
            { stallTimeoutMs: 60_000, maxRawBytes: 30_000 },
          );
          transcriptParts.push(`\n\n===== PREFLIGHT INTERRUPTED BEFORE JSON =====\n\n${rawText}`);
          raw = finalizeRaw;
        } else {
          copyGsaArtifacts(start.runDir, caseDir);
          const rawPath = path.join(caseDir, `${phase}.raw.txt`);
          const rawText = fs.existsSync(rawPath) ? fs.readFileSync(rawPath, "utf8") : "";
          rawReadEvidence = rawText;
          const evidenceText = fs.existsSync(path.join(caseDir, "gsa", "evidence.jsonl"))
            ? fs.readFileSync(path.join(caseDir, "gsa", "evidence.jsonl"), "utf8")
            : "";
          if (!evidenceText.trim() && !hasUsefulAgentOutput(rawText)) throw e;
          const preflightText = fs.existsSync(path.join(caseDir, "preflight.json"))
            ? fs.readFileSync(path.join(caseDir, "preflight.json"), "utf8")
            : "";
          manifest.validationFinalize = {
            reason: e?.message || String(e),
            evidenceBytes: evidenceText.length,
            rawBytes: rawText.length,
            freshSession: true,
          };
          await resetAgentSession(baseUrl);
          const finalizeRaw = await sendAgentTurnWithRetry(
            baseUrl,
            validationFinalizePrompt(preflightText, evidenceText, rawText),
            `/gsa ${item.id} validation finalize`,
            phaseTimeoutMs("validation-finalize", opts),
            caseDir,
            "validation",
            phaseThinkLevel("validation-finalize", opts),
            manifest,
            { stallTimeoutMs: 90_000, maxRawBytes: 80_000 },
          );
          transcriptParts.push(`\n\n===== VALIDATION INTERRUPTED BEFORE JSON =====\n\n${rawText}`);
          raw = finalizeRaw;
        }
      }
      const projectReadTranscript = [rawReadEvidence, raw].filter(Boolean).join("\n");
      if (phase === "selection" && projectReadCount(projectReadTranscript, workspace) < 2) {
        manifest.selectionEvidencePass = {
          reason: "selection returned before reading project files",
          projectReadsBefore: projectReadCount(projectReadTranscript, workspace),
        };
        const evidenceRaw = await sendAgentTurnWithRetry(
          baseUrl,
          selectionEvidencePrompt(projectReadTranscript || raw, workspace, caseDir),
          `/gsa ${item.id} selection evidence`,
          phaseTimeoutMs("selection", opts),
          caseDir,
          "selection",
          phaseThinkLevel("selection-evidence", opts),
          manifest,
          { stallTimeoutMs: 90_000, maxRawBytes: 75_000 },
        );
        transcriptParts.push(`\n\n===== SELECTION EVIDENCE PASS =====\n\n${evidenceRaw}`);
        const evidenceUse = collectToolUse(evidenceRaw);
        manifest.skillCalls.push(...evidenceUse.skillCalls);
        manifest.toolCalls.push(...evidenceUse.toolCalls);
        manifest.selectionEvidencePass.projectReadsAfter = projectReadCount(evidenceRaw, workspace);
        raw = evidenceRaw;
      }
      transcriptParts.push(`\n\n===== ${phase.toUpperCase()} =====\n\n${raw}`);
      const phaseToolText = [rawReadEvidence, raw].filter(Boolean).join("\n");
      const use = collectToolUse(phaseToolText);
      manifest.skillCalls.push(...use.skillCalls);
      manifest.toolCalls.push(...use.toolCalls);
      let json;
      try {
        json = extractPhaseJson(raw, phase);
      } catch (e) {
        if (phase !== "selection" || !hasUsefulAgentOutput(raw)) throw e;
          manifest.selectionFinalize = {
            reason: e?.message || String(e),
            rawBytes: raw.length,
            freshSession: true,
        };
        await resetAgentSession(baseUrl);
          const finalizeRaw = await sendAgentTurnWithRetry(
            baseUrl,
            selectionFinalizePrompt(raw, caseDir),
            `/gsa ${item.id} selection finalize`,
            phaseTimeoutMs("selection-finalize", opts),
          caseDir,
          "selection-finalize",
          phaseThinkLevel("selection-finalize", opts),
          manifest,
          { stallTimeoutMs: 60_000, maxRawBytes: 30_000 },
        );
        transcriptParts.push(`\n\n===== SELECTION FINALIZE =====\n\n${finalizeRaw}`);
        const finalizeUse = collectToolUse(finalizeRaw);
        manifest.skillCalls.push(...finalizeUse.skillCalls);
        manifest.toolCalls.push(...finalizeUse.toolCalls);
        raw = finalizeRaw;
        json = extractPhaseJson(finalizeRaw, "selection");
      }
      if (phase === "selection") {
        json = normalizeSelectionJson(json, workspace, caseDir, manifest);
        manifest.selectedSkillIds = selectionSkillIds(json);
        let invalid = invalidSelectionPaths(json, workspace, caseDir);
        if (invalid.length) {
          manifest.selectionRepair = { invalidBeforeRepair: invalid };
          const repairRaw = await sendAgentTurnWithRetry(
            baseUrl,
            selectionRepairPrompt(json, caseDir),
            `/gsa ${item.id} selection repair`,
            phaseTimeoutMs("selection-repair", opts),
            caseDir,
            "selection-repair",
            phaseThinkLevel("selection-repair", opts),
            manifest,
          );
          transcriptParts.push(`\n\n===== SELECTION REPAIR =====\n\n${repairRaw}`);
          const repairUse = collectToolUse(repairRaw);
          manifest.skillCalls.push(...repairUse.skillCalls);
          manifest.toolCalls.push(...repairUse.toolCalls);
          json = normalizeSelectionJson(extractPhaseJson(repairRaw, "selection"), workspace, caseDir, manifest);
          invalid = invalidSelectionPaths(json, workspace, caseDir);
          manifest.selectionRepair.invalidAfterRepair = invalid;
        }
        if (invalid.length) {
          throw new Error(`selection contains non-candidate paths: ${invalid.join(", ")}`);
        }
      } else if (phase === "preflight" && (manifest.selectedSkillIds || []).length && !use.skillCalls.length) {
        throw new Error(`preflight did not load a selected GSA skill; selected skills: ${manifest.selectedSkillIds.join(", ")}`);
      }
      writeText(path.join(caseDir, `${phase}.json`), json);
      const next = await jsonFetch(baseUrl, "/api/gsa/phase", {
        method: "POST",
        headers: csrfHeaders,
        body: JSON.stringify({ workdir: workspace, runId: start.runId, phase, output: json }),
        timeoutMs: 30_000,
      });
      writeJson(path.join(caseDir, `${phase}.phase-response.json`), next);
      manifest.phases[phase] = { ok: true };
      copyGsaArtifacts(start.runDir, caseDir);
      prompt = next.nextPrompt;
      if (!prompt) throw new Error(`GSA phase ${phase} did not return a nextPrompt`);
    }

    let validationText = fs.existsSync(path.join(caseDir, "validation.json"))
      ? fs.readFileSync(path.join(caseDir, "validation.json"), "utf8")
      : "";
    if (validationMayHaveArtifactReachabilityConflict(validationText)) {
      manifest.validationRepair = {
        reason: "validation downgraded artifact-supported reachability to unreachable",
      };
      const evidenceText = fs.existsSync(path.join(caseDir, "gsa", "evidence.jsonl"))
        ? fs.readFileSync(path.join(caseDir, "gsa", "evidence.jsonl"), "utf8")
        : "";
      const preflightText = fs.existsSync(path.join(caseDir, "preflight.json"))
        ? fs.readFileSync(path.join(caseDir, "preflight.json"), "utf8")
        : "";
      await resetAgentSession(baseUrl);
      const repairRaw = await sendAgentTurnWithRetry(
        baseUrl,
        validationRepairPrompt(validationText, evidenceText, preflightText),
        `/gsa ${item.id} validation repair`,
        phaseTimeoutMs("validation-repair", opts),
        caseDir,
        "validation",
        phaseThinkLevel("validation-repair", opts),
        manifest,
      );
      transcriptParts.push(`\n\n===== VALIDATION REPAIR =====\n\n${repairRaw}`);
      const repairedValidation = extractPhaseJson(repairRaw, "validation");
      writeText(path.join(caseDir, "validation.json"), repairedValidation);
      validationText = repairedValidation;
      const next = await jsonFetch(baseUrl, "/api/gsa/phase", {
        method: "POST",
        headers: csrfHeaders,
        body: JSON.stringify({ workdir: workspace, runId: start.runId, phase: "validation", output: repairedValidation }),
        timeoutMs: 30_000,
      });
      writeJson(path.join(caseDir, "validation.repair-phase-response.json"), next);
      prompt = next.nextPrompt;
      if (!prompt) throw new Error("GSA validation repair did not return a report prompt");
      copyGsaArtifacts(start.runDir, caseDir);
    }

    await resetAgentSession(baseUrl);
    manifest.phaseFreshSessions ||= [];
    manifest.phaseFreshSessions.push("report");
    let rawReport = await sendAgentTurnWithRetry(baseUrl, prompt, `/gsa ${item.id} report`, phaseTimeoutMs("report", opts), caseDir, "report", phaseThinkLevel("report", opts), manifest);
    transcriptParts.push(`\n\n===== REPORT =====\n\n${rawReport}`);
    const use = collectToolUse(rawReport);
    manifest.skillCalls.push(...use.skillCalls);
    manifest.toolCalls.push(...use.toolCalls);
    let report = extractReportMarkdown(rawReport);
    const evidenceText = fs.existsSync(path.join(caseDir, "gsa", "evidence.jsonl"))
      ? fs.readFileSync(path.join(caseDir, "gsa", "evidence.jsonl"), "utf8")
      : "";
    if (validationImpliesConfirmedIssue(validationText) && reportVerdict(report) !== "confirmed_issue") {
      manifest.reportRepair = {
        reason: "report verdict contradicted medium/high-confidence validation finding",
        before: reportVerdict(report) || "unknown",
      };
      await resetAgentSession(baseUrl);
      const repairRaw = await sendAgentTurnWithRetry(
        baseUrl,
        reportRepairPrompt(report, validationText, evidenceText),
        `/gsa ${item.id} report repair`,
        phaseTimeoutMs("report-repair", opts),
        caseDir,
        "report",
        phaseThinkLevel("report-repair", opts),
        manifest,
      );
      transcriptParts.push(`\n\n===== REPORT REPAIR =====\n\n${repairRaw}`);
      rawReport = repairRaw;
      report = extractReportMarkdown(repairRaw);
      manifest.reportRepair.after = reportVerdict(report) || "unknown";
    } else if (validationBlocksConfirmedIssue(validationText) && reportVerdict(report) === "confirmed_issue") {
      manifest.reportRepair = {
        reason: "report over-confirmed a validation with decisive missing evidence",
        before: reportVerdict(report) || "unknown",
      };
      await resetAgentSession(baseUrl);
      const repairRaw = await sendAgentTurnWithRetry(
        baseUrl,
        reportOverconfirmRepairPrompt(report, validationText, evidenceText),
        `/gsa ${item.id} report overconfirm repair`,
        phaseTimeoutMs("report-repair", opts),
        caseDir,
        "report",
        phaseThinkLevel("report-repair", opts),
        manifest,
      );
      transcriptParts.push(`\n\n===== REPORT OVERCONFIRM REPAIR =====\n\n${repairRaw}`);
      rawReport = repairRaw;
      report = extractReportMarkdown(repairRaw);
      manifest.reportRepair.after = reportVerdict(report) || "unknown";
    }
    writeText(path.join(caseDir, "report.md"), report + "\n");
    writeText(path.join(caseDir, `${item.id}.md`), report + "\n");
    await jsonFetch(baseUrl, "/api/gsa/phase", {
      method: "POST",
      headers: csrfHeaders,
      body: JSON.stringify({ workdir: workspace, runId: start.runId, phase: "report", output: report }),
      timeoutMs: 30_000,
    });
    copyGsaArtifacts(start.runDir, caseDir);

    manifest.status = "complete";
    manifest.finishedAt = new Date().toISOString();
    manifest.durationMs = Date.now() - startedAt;
    manifest.skillCalls = [...new Set(manifest.skillCalls)];
    writeText(path.join(caseDir, "transcript.txt"), transcriptParts.join("\n"));
    writeJson(path.join(caseDir, "manifest.json"), manifest);
    return manifest;
  } catch (e) {
    await safeInterruptAgent(baseUrl, `case ${item.id} failed`).catch(() => {});
    if (start?.runDir) copyGsaArtifacts(start.runDir, caseDir);
    manifest.status = "failed";
    manifest.error = e?.message || String(e);
    manifest.finishedAt = new Date().toISOString();
    manifest.durationMs = Date.now() - startedAt;
    manifest.skillCalls = [...new Set(manifest.skillCalls)];
    writeText(path.join(caseDir, "transcript.txt"), transcriptParts.join("\n"));
    writeJson(path.join(caseDir, "run-error.json"), manifest);
    throw e;
  }
}

function runScore(outRoot) {
  const res = spawnSync(process.execPath, ["extension/gsa/bench/score.mjs", "--reports", outRoot, "--out", outRoot], {
    cwd: root,
    encoding: "utf8",
  });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.status !== 0) throw new Error(`score.mjs failed with exit ${res.status}`);
}

function writeBenchmarkReport(outRoot, selectedCount, meta) {
  const datasetTotal = readJson(indexPath).length;
  const summaryPath = path.join(outRoot, "summary.json");
  const summary = fs.existsSync(summaryPath) ? readJson(summaryPath).summary : null;
  const manifests = fs.readdirSync(outRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const p = path.join(outRoot, e.name, "manifest.json");
      const err = path.join(outRoot, e.name, "run-error.json");
      if (fs.existsSync(p)) return readJson(p);
      if (fs.existsSync(err)) return readJson(err);
      return null;
    })
    .filter(Boolean);
  const completed = manifests.filter((m) => m.status === "complete");
  const failed = manifests.filter((m) => m.status === "failed");
  const topSkills = new Map();
  for (const m of manifests) for (const s of m.skillCalls || []) topSkills.set(s, (topSkills.get(s) || 0) + 1);
  const topSkillRows = [...topSkills.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  const partial = !summary || summary.cases < datasetTotal || summary.reports_found < summary.cases;
  const lines = [
    "# DStudio GSA Benchmark",
    "",
    partial
      ? `**Status: partial run. Do not publish this as the full benchmark until all ${datasetTotal} reports are present.**`
      : "**Status: full balanced benchmark run.**",
    "",
    "## Methodology",
    "",
    `- Dataset: ${datasetTotal} local-only workspaces balanced for an 8-hour run target: 2 per category and 4 per difficulty overall.`,
    "- Categories: crypto, web, reverse engineering, forensics, OSINT, network security, malware analysis and pwn.",
    "- Each case is copied into `extension/gsa/benchmark/<run>/<project>/workspace` before GSA starts.",
    "- Answer keys are not copied into the workspace and are not sent to the model.",
    "- Calibration policy: no answer-key hints, no benchmark-specific prompts, and no prompts that reveal whether a case contains a vulnerability.",
    "- Tool policy: external tools are advisory only; scanner success/failure must be cross-checked with source, artifacts, manual reasoning, or targeted Python helpers.",
    "- Chain policy: reports may confirm an attack chain only when each link has cited evidence; weak standalone facts are not upgraded without a concrete composed path.",
    "- GSA uses the vendored `extension/gsa/third_party/anthropic-cybersecurity-skills` catalog and records `skills.md` plus actual `skill()` tool calls per case.",
    "- Scoring runs after report generation and measures outcome, evidence citation and false positives/false negatives.",
    "",
    "## Run",
    "",
    `- Run directory: \`${path.relative(root, outRoot)}\``,
    `- Selected cases this invocation: ${selectedCount}`,
    `- Completed reports: ${completed.length}`,
    `- Failed runs: ${failed.length}`,
    `- Agent ctx: ${meta.ctx}`,
    `- Thinking: ${meta.think}`,
    `- GGUF: ${meta.gguf || "(default)"}`,
    "",
  ];
  if (summary) {
    lines.push(
      "## Score",
      "",
      `- Reports found by scorer: ${summary.reports_found}/${summary.cases}`,
      `- Average score: ${summary.average_score}`,
      `- True positives: ${summary.true_positive}`,
      `- False negatives: ${summary.false_negative}`,
      `- True negatives: ${summary.true_negative}`,
      `- False positives: ${summary.false_positive}`,
      `- Correct inconclusive: ${summary.inconclusive_correct}`,
      "",
      "### By Category",
      "",
      "| Category | Cases | Reports | Outcome Correct | Average Score |",
      "|---|---:|---:|---:|---:|",
      ...Object.entries(summary.by_category).map(([k, v]) =>
        `| ${k} | ${v.cases} | ${v.reports_found} | ${v.outcome_correct} | ${v.average_score} |`),
      "",
      "### By Difficulty",
      "",
      "| Difficulty | Cases | Reports | Outcome Correct | Average Score |",
      "|---|---:|---:|---:|---:|",
      ...Object.entries(summary.by_difficulty).map(([k, v]) =>
        `| ${k} | ${v.cases} | ${v.reports_found} | ${v.outcome_correct} | ${v.average_score} |`),
      "",
    );
  }
  lines.push(
    "## Skill Routing",
    "",
    `- Cases with at least one actual \`skill()\` call: ${manifests.filter((m) => (m.skillCalls || []).length).length}/${manifests.length}`,
    "",
    "| Skill | Cases |",
    "|---|---:|",
    ...(topSkillRows.length ? topSkillRows.map(([s, n]) => `| ${s} | ${n} |`) : ["| (none recorded) | 0 |"]),
    "",
    "## Reproduce",
    "",
    "```sh",
    "node extension/gsa/bench/validate.mjs",
    `node extension/gsa/bench/run.mjs --out ${path.relative(root, outRoot)}`,
    `node extension/gsa/bench/score.mjs --reports ${path.relative(root, outRoot)} --out ${path.relative(root, outRoot)}`,
    "```",
    "",
    "Detailed per-case artifacts are in each project folder: `manifest.json`, `skills.md` under `gsa/`, raw phase output, parsed phase JSON and `report.md`.",
    "",
  );
  if (failed.length) {
    lines.push("## Failed Runs", "");
    for (const m of failed.slice(0, 30)) lines.push(`- ${m.id}: ${m.error || "unknown error"}`);
    if (failed.length > 30) lines.push(`- ... ${failed.length - 30} more`);
    lines.push("");
  }
  const body = lines.join("\n");
  writeText(path.join(outRoot, "BENCHMARK.md"), body);
  writeText(path.join(root, "extension", "gsa", "BENCHMARK.md"), body);
}

const args = parseArgs(process.argv);
const items = selectCases(args);
if (args["list-cases"]) {
  for (const item of items) console.log(item.id);
  process.exit(0);
}
const outRoot = path.resolve(root, args.out || path.join(benchmarkRoot, `gsa-${timestamp()}`));
mkdirp(outRoot);
process.env.DSTUDIO_REAL_DS4_DIR ||= path.join(root, "ds4");

let server = null;
let baseUrl = args["base-url"] ? normalizeBaseUrl(args["base-url"]) : "";
let shuttingDown = false;

async function stopServerAndExit(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`\nReceived ${signal}; stopping benchmark server...`);
  try {
    if (server) await server.stop();
  } catch (e) {
    console.error(`Failed to stop benchmark server: ${e?.message || e}`);
  }
  process.exit(signal === "SIGINT" ? 130 : 143);
}

process.on("SIGINT", () => { void stopServerAndExit("SIGINT"); });
process.on("SIGTERM", () => { void stopServerAndExit("SIGTERM"); });

if (args["report-only"]) {
  const cfgPath = path.join(outRoot, "run-config.json");
  const cfg = fs.existsSync(cfgPath) ? readJson(cfgPath) : {};
  if (!args["no-score"]) runScore(outRoot);
  writeBenchmarkReport(outRoot, Number(cfg.selectedCases || items.length), {
    ctx: cfg.ctx || args.ctx || 0,
    think: "max",
    gguf: cfg.gguf || args.gguf || "",
  });
  console.log(`Benchmark report regenerated at ${path.relative(root, outRoot)}`);
  process.exit(0);
}

try {
  if (!baseUrl) {
    server = await startDStudio({ binaryArg: args.binary, label: "dstudio-gsa-bench" });
    baseUrl = server.baseUrl;
  } else {
    await jsonFetch(baseUrl, "/api/status", { timeoutMs: 10_000 });
  }

  const status = await jsonFetch(baseUrl, "/api/status", { timeoutMs: 10_000 });
  const ds4Dir = status.ds4dir || process.env.DSTUDIO_REAL_DS4_DIR;
  const gguf = chooseGguf(ds4Dir, args.gguf);
  const ctx = Number(args.ctx || 65536);
  const think = "max";
  const turnTimeoutMs = Number(args["timeout-min"] || 45) * 60_000;
  writeJson(path.join(outRoot, "run-config.json"), {
    baseUrl,
    ds4Dir,
    gguf,
    ctx,
    think,
    selectedCases: items.length,
    startedAt: new Date().toISOString(),
    filters: args,
  });

  if (args["install-tools"]) {
    const tools = await jsonFetch(baseUrl, "/api/gsa/tools/install", {
      method: "POST",
      headers: csrfHeaders,
      timeoutMs: 10 * 60_000,
    });
    writeJson(path.join(outRoot, "gsa-tools-install.json"), tools);
  } else {
    const tools = await jsonFetch(baseUrl, "/api/gsa/tools", { timeoutMs: 10_000 });
    writeJson(path.join(outRoot, "gsa-tools.json"), tools);
  }

  await startMode(baseUrl, {
    mode: "agent",
    model: "uncensored",
    variant: "flash",
    gguf,
    ctx,
    power: 100,
    think,
    workdir: root,
    jsonl: true,
    build: "off",
  }, 30 * 60_000);

  const results = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    console.log(`[${i + 1}/${items.length}] GSA ${item.id}`);
    try {
      const result = await runCase(baseUrl, item, outRoot, {
        resume: !!args.resume,
        turnTimeoutMs,
        think,
      });
      results.push(result);
      if (result.skipped) console.log(`  skipped`);
      else console.log(`  ${result.status} ${Math.round((result.durationMs || 0) / 1000)}s`);
    } catch (e) {
      results.push({ id: item.id, status: "failed", error: e?.message || String(e) });
      console.error(`  failed: ${e?.message || e}`);
      if (args["fail-fast"]) {
        writeJson(path.join(outRoot, "run-results.json"), results);
        throw e;
      }
    }
  }
  writeJson(path.join(outRoot, "run-results.json"), results);
  if (!args["no-score"]) runScore(outRoot);
  writeBenchmarkReport(outRoot, items.length, { ctx, think, gguf });
  console.log(`Benchmark artifacts written to ${path.relative(root, outRoot)}`);
} catch (e) {
  writeText(path.join(outRoot, "RUN-ERROR.md"), `# GSA benchmark run failed\n\n${e?.stack || e}\n`);
  throw e;
} finally {
  if (server) await server.stop();
}
