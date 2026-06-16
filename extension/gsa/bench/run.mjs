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
    "  --power <n>             ds4 --power launch parameter (default: 90)",
    "  --ssd-streaming <mode>  off, on, or auto (default: off)",
    "  --jsonl <on|off>        Use the structured ds4-agent-jsonl backend (default: on)",
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
  try {
    const parsed = JSON.parse(candidate);
    if (!phase || phaseJsonIsConcrete(parsed, phase)) {
      return JSON.stringify(parsed, null, 2) + "\n";
    }
  } catch {}
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

async function stopAgentRuntime(baseUrl) {
  try {
    await jsonFetch(baseUrl, "/api/stop", {
      method: "POST",
      headers: csrfHeaders,
      timeoutMs: 10_000,
    });
  } catch {}
  await sleep(1000);
}

async function restartAgentRuntime(baseUrl, launchBody) {
  await stopAgentRuntime(baseUrl);
  await startMode(baseUrl, launchBody, 30 * 60_000);
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

  await restartAgentRuntime(baseUrl, opts.launchBody);
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
      const raw = await sendAgentTurn(
        baseUrl,
        prompt,
        `/gsa ${item.id} ${phase}`,
        phaseTimeoutMs(phase, opts),
        caseDir,
        phase,
        phaseThinkLevel(phase, opts),
      );
      transcriptParts.push(`\n\n===== ${phase.toUpperCase()} =====\n\n${raw}`);
      const use = collectToolUse(raw);
      manifest.skillCalls.push(...use.skillCalls);
      manifest.toolCalls.push(...use.toolCalls);
      let json = extractPhaseJson(raw, phase);
      if (phase === "selection") {
        json = normalizeSelectionJson(json, workspace, caseDir, manifest);
        manifest.selectedSkillIds = selectionSkillIds(json);
        const invalid = invalidSelectionPaths(json, workspace, caseDir);
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

    await resetAgentSession(baseUrl);
    manifest.phaseFreshSessions ||= [];
    manifest.phaseFreshSessions.push("report");
    const rawReport = await sendAgentTurn(baseUrl, prompt, `/gsa ${item.id} report`, phaseTimeoutMs("report", opts), caseDir, "report", phaseThinkLevel("report", opts));
    transcriptParts.push(`\n\n===== REPORT =====\n\n${rawReport}`);
    const use = collectToolUse(rawReport);
    manifest.skillCalls.push(...use.skillCalls);
    manifest.toolCalls.push(...use.toolCalls);
    let report = extractReportMarkdown(rawReport);
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
    await stopAgentRuntime(baseUrl);
    return manifest;
  } catch (e) {
    await safeInterruptAgent(baseUrl, `case ${item.id} failed`).catch(() => {});
    await stopAgentRuntime(baseUrl);
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
  const power = Math.min(100, Math.max(1, Number(args.power || 90)));
  const ssdStreaming = ["off", "on", "auto"].includes(args["ssd-streaming"]) ? args["ssd-streaming"] : "off";
  const jsonl = String(args.jsonl || "on").toLowerCase() !== "off";
  const think = "max";
  const turnTimeoutMs = Number(args["timeout-min"] || 45) * 60_000;
  writeJson(path.join(outRoot, "run-config.json"), {
    baseUrl,
    ds4Dir,
    gguf,
    ctx,
    power,
    ssdStreaming,
    jsonl,
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

  const launchBody = {
    mode: "agent",
    model: "uncensored",
    variant: "flash",
    gguf,
    ctx,
    power,
    ssdStreaming,
    think,
    workdir: root,
    jsonl,
    build: "off",
  };

  const results = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    console.log(`[${i + 1}/${items.length}] GSA ${item.id}`);
    try {
      const result = await runCase(baseUrl, item, outRoot, {
        resume: !!args.resume,
        turnTimeoutMs,
        think,
        launchBody,
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
