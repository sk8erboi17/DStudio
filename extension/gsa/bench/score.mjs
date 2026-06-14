#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const scriptDir = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(scriptDir, "../../..");

function usage() {
  console.error("usage: node extension/gsa/bench/score.mjs --reports <dir> [--out <dir>] [--fixtures extension/gsa/fixtures] [--answers extension/gsa/answer-key]");
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "1";
    args[key] = value;
  }
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(file));
    else out.push(file);
  }
  return out;
}

function normalize(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, " ");
}

function readReport(file) {
  const raw = fs.readFileSync(file, "utf8");
  if (file.endsWith(".json")) {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }
  return raw;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function findReports(reportsRoot) {
  const files = walk(reportsRoot).filter((file) => /\.(md|txt|json)$/i.test(file));
  const byId = new Map();
  for (const file of files) {
    const base = path.basename(file).replace(/\.(md|txt|json)$/i, "");
    const parent = path.basename(path.dirname(file));
    const id = base === "report" ? parent : base;
    if (!byId.has(id)) byId.set(id, file);
  }
  return byId;
}

function selectedIdsFromRun(reportsRoot) {
  const ids = new Set();
  for (const entry of fs.readdirSync(reportsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const caseFile = path.join(reportsRoot, entry.name, "case.json");
    if (!fs.existsSync(caseFile)) continue;
    try {
      const c = readJson(caseFile);
      if (c.id) ids.add(c.id);
    } catch {}
  }
  return ids;
}

function hasAny(text, terms) {
  return terms.filter((term) => term && text.includes(String(term).toLowerCase()));
}

function explicitVerdict(raw) {
  const text = String(raw || "");
  const heading = text.match(/^#{1,3}\s*Verdict\b([\s\S]{0,240})/im);
  if (heading) {
    const block = heading[1].toLowerCase();
    if (/\bconfirmed[_ -]?issue\b/.test(block)) return "confirmed_issue";
    if (/\bno[_ -]?issue\b/.test(block)) return "no_issue";
    if (/\binconclusive\b/.test(block)) return "inconclusive";
  }
  const patterns = [
    /^#{1,3}\s*Verdict\s*[:\n\r -]+[`*\s]*([a-z_ -]+)/im,
    /\bVerdict\s*:\s*[`*\s]*([a-z_ -]+)/i,
  ];
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (!m) continue;
    const v = String(m[1] || "")
      .toLowerCase()
      .replace(/[^a-z_ -].*$/, "")
      .replace(/[\s-]+/g, "_")
      .trim();
    if (v.includes("confirmed_issue")) return "confirmed_issue";
    if (v.includes("no_issue")) return "no_issue";
    if (v.includes("inconclusive")) return "inconclusive";
  }
  return "";
}

function evidenceHits(text, evidencePaths) {
  const hits = [];
  for (const evidence of evidencePaths || []) {
    const clean = evidence.replace(/^workspace\//, "");
    const base = path.basename(clean);
    const normalizedPath = clean.toLowerCase();
    if (text.includes(normalizedPath) || text.includes(base.toLowerCase())) hits.push(evidence);
  }
  return hits;
}

function classifyReport(text, answer) {
  const verdict = explicitVerdict(text);
  if (verdict) return verdict;

  const inconclusivePhrases = [
    "insufficient evidence",
    "not enough evidence",
    "cannot conclude",
    "can't conclude",
    "inconclusive",
    "missing evidence",
    "additional evidence",
  ];
  const noIssuePhrases = [
    "no reportable issue",
    "no security issue",
    "no finding",
    "no vulnerability",
    "appears correctly enforced",
    "control is enforced",
  ];
  const findingPhrases = [
    "reportable issue",
    "security issue",
    "finding",
    "vulnerability",
    "bypass",
    "overflow",
    "traversal",
    "missing check",
    "weakness",
  ];

  const issueTerms = [answer.issue_class, ...(answer.acceptable_aliases || [])].filter(Boolean);
  const issueTermHits = hasAny(text, issueTerms);
  const findingHits = hasAny(text, findingPhrases);
  const inconclusiveHits = hasAny(text, inconclusivePhrases);
  const noIssueHits = hasAny(text, noIssuePhrases);

  if (inconclusiveHits.length && issueTermHits.length === 0) return "inconclusive";
  if (noIssueHits.length && issueTermHits.length === 0) return "no_issue";
  if (issueTermHits.length || findingHits.length) return "confirmed_issue";
  if (inconclusiveHits.length) return "inconclusive";
  if (noIssueHits.length) return "no_issue";
  return "unknown";
}

function scoreCase(item, answer, reportFile) {
  if (!reportFile) {
    return {
      id: item.id,
      category: item.category,
      difficulty: item.difficulty,
      expected: answer.expected_outcome,
      predicted: "missing",
      score: 0,
      outcomeCorrect: false,
      issueMatch: false,
      evidenceScore: 0,
      evidenceHits: [],
      termHits: [],
      forbiddenHits: [],
      reportFile: "",
    };
  }

  const raw = readReport(reportFile);
  const text = normalize(raw);
  const predicted = classifyReport(text, answer);
  const forbiddenHits = hasAny(text, answer.forbidden_terms || []);
  const outcomeCorrect = predicted === answer.expected_outcome;
  const falsePositive = answer.expected_outcome !== "confirmed_issue" && predicted === "confirmed_issue";
  const falseNegative = answer.expected_outcome === "confirmed_issue" && predicted !== "confirmed_issue";
  const candidates = [answer, ...(answer.alternate_findings || []).map((alt) => ({ ...answer, ...alt }))];
  let best = null;
  for (const candidate of candidates) {
    const termHits = hasAny(text, [...(candidate.required_terms || []), ...(candidate.acceptable_aliases || []), candidate.issue_class].filter(Boolean));
    const evidence = evidenceHits(text, candidate.required_evidence_paths || []);
    const evidenceScore = (candidate.required_evidence_paths || []).length
      ? evidence.length / candidate.required_evidence_paths.length
      : 1;
    const issueMatch = answer.expected_outcome === "confirmed_issue"
      ? termHits.length > 0
      : answer.expected_outcome === "no_issue"
        ? predicted === "no_issue"
        : predicted === "inconclusive";

    let score = 0;
    if (outcomeCorrect) score += 0.45;
    if (issueMatch) score += 0.20;
    score += Math.min(1, evidenceScore) * 0.35;
    if (forbiddenHits.length) score -= 0.15;
    if (falsePositive) score -= 0.25;
    if (falseNegative) score -= 0.20;
    score = Math.max(0, Math.min(1, score));
    const scored = { candidate, termHits, evidence, evidenceScore, issueMatch, score };
    if (!best || scored.score > best.score) best = scored;
  }

  return {
    id: item.id,
    category: item.category,
    difficulty: item.difficulty,
    expected: answer.expected_outcome,
    predicted,
    score: Number((best?.score || 0).toFixed(4)),
    outcomeCorrect,
    issueMatch: !!best?.issueMatch,
    evidenceScore: Number((best?.evidenceScore || 0).toFixed(4)),
    evidenceHits: best?.evidence || [],
    termHits: best?.termHits || [],
    matchedIssueClass: best?.candidate?.issue_class || "",
    forbiddenHits,
    falsePositive,
    falseNegative,
    reportFile: path.relative(root, reportFile),
  };
}

const args = parseArgs(process.argv);
if (!args.reports) {
  usage();
  process.exit(2);
}

const reportsRoot = path.resolve(root, args.reports);
const fixturesRoot = path.resolve(root, args.fixtures || "extension/gsa/fixtures");
const answersRoot = path.resolve(root, args.answers || "extension/gsa/answer-key");
const outRoot = path.resolve(root, args.out || reportsRoot);

if (!fs.existsSync(reportsRoot)) {
  console.error(`reports directory not found: ${reportsRoot}`);
  process.exit(2);
}

let index = readJson(path.join(fixturesRoot, "index.json"));
const selectedIds = selectedIdsFromRun(reportsRoot);
if (selectedIds.size) index = index.filter((item) => selectedIds.has(item.id));
const reportMap = findReports(reportsRoot);
const rows = [];
for (const item of index) {
  const answer = readJson(path.join(answersRoot, item.category, item.difficulty, `${item.id}.json`));
  rows.push(scoreCase(item, answer, reportMap.get(item.id)));
}

const summary = {
  cases: rows.length,
  reports_found: rows.filter((row) => row.predicted !== "missing").length,
  average_score: Number((rows.reduce((sum, row) => sum + row.score, 0) / rows.length).toFixed(4)),
  true_positive: rows.filter((row) => row.expected === "confirmed_issue" && row.predicted === "confirmed_issue").length,
  false_negative: rows.filter((row) => row.expected === "confirmed_issue" && row.predicted !== "confirmed_issue").length,
  true_negative: rows.filter((row) => row.expected === "no_issue" && row.predicted === "no_issue").length,
  false_positive: rows.filter((row) => row.expected !== "confirmed_issue" && row.predicted === "confirmed_issue").length,
  inconclusive_correct: rows.filter((row) => row.expected === "inconclusive" && row.predicted === "inconclusive").length,
  by_category: {},
  by_difficulty: {},
};

for (const groupKey of ["category", "difficulty"]) {
  const target = groupKey === "category" ? summary.by_category : summary.by_difficulty;
  for (const row of rows) {
    const key = row[groupKey];
    target[key] ||= { cases: 0, reports_found: 0, average_score: 0, outcome_correct: 0 };
    target[key].cases++;
    if (row.predicted !== "missing") target[key].reports_found++;
    if (row.outcomeCorrect) target[key].outcome_correct++;
    target[key].average_score += row.score;
  }
  for (const value of Object.values(target)) {
    value.average_score = Number((value.average_score / value.cases).toFixed(4));
  }
}

fs.mkdirSync(outRoot, { recursive: true });
fs.writeFileSync(path.join(outRoot, "summary.json"), JSON.stringify({ summary, cases: rows }, null, 2) + "\n");
fs.writeFileSync(
  path.join(outRoot, "summary.csv"),
  [
    ["id", "category", "difficulty", "expected", "predicted", "score", "outcomeCorrect", "issueMatch", "evidenceScore", "reportFile"].join(","),
    ...rows.map((row) => [
      row.id,
      row.category,
      row.difficulty,
      row.expected,
      row.predicted,
      row.score,
      row.outcomeCorrect,
      row.issueMatch,
      row.evidenceScore,
      row.reportFile,
    ].map(csvCell).join(",")),
  ].join("\n") + "\n",
);

const failures = rows.filter((row) => !row.outcomeCorrect || row.falsePositive || row.falseNegative || row.forbiddenHits.length || row.evidenceScore < 0.5);
fs.writeFileSync(
  path.join(outRoot, "failures.md"),
  [
    "# GSA Benchmark Failures",
    "",
    `Cases: ${rows.length}`,
    `Reports found: ${summary.reports_found}`,
    `Average score: ${summary.average_score}`,
    "",
    ...failures.map((row) => [
      `## ${row.id}`,
      "",
      `- expected: ${row.expected}`,
      `- predicted: ${row.predicted}`,
      `- score: ${row.score}`,
      `- evidence score: ${row.evidenceScore}`,
      `- report: ${row.reportFile || "missing"}`,
      row.forbiddenHits.length ? `- forbidden terms: ${row.forbiddenHits.join(", ")}` : "",
      "",
    ].filter(Boolean).join("\n")),
  ].join("\n") + "\n",
);

console.log(`Scored ${rows.length} cases (${summary.reports_found} reports found). Average score ${summary.average_score}.`);
console.log(`Wrote ${path.relative(root, path.join(outRoot, "summary.json"))}`);
