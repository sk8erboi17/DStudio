#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const scriptDir = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(scriptDir, "../../..");
const fixturesRoot = path.join(root, "extension", "gsa", "fixtures");
const answersRoot = path.join(root, "extension", "gsa", "answer-key");
const indexPath = path.join(fixturesRoot, "index.json");

const categories = [
  "crypto",
  "web",
  "reverse-engineering",
  "forensics",
  "osint",
  "network-security",
  "malware-analysis",
  "pwn",
];
const difficulties = ["easy", "medium", "hard", "impossible"];
const validOutcomes = new Set(["confirmed_issue", "no_issue", "inconclusive"]);
const targetCaseCount = 16;
const expectedPerCategory = 2;
const expectedPerDifficulty = 4;

const workspaceLeakPatterns = [
  /\banswer key\b/i,
  /\bgroundtruth\b/i,
  /\bground_truth\b/i,
  /\bexpected_outcome\b/i,
  /\bschema_version\b/i,
  /\bissue_class\b/i,
  /\brequired_evidence/i,
  /\bconfirmed_issue\b/i,
  /\bno_issue\b/i,
  /\bvuln(?:erability)?\s+here\b/i,
  /\bCVE-\d{4}-\d+\b/i,
];

const toolHintPattern = /\b(nuclei|subfinder|httpx|nmap|tshark|gdb|radare2|radare|rizin|ghidra|yara|volatility|binwalk|amass|assetfinder|katana|dnsx|tlsx|naabu|ffuf|feroxbuster)\b/i;

function fail(message) {
  failures.push(message);
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

function sha1(input) {
  return crypto.createHash("sha1").update(input).digest("hex");
}

function isTextFile(file) {
  const buf = fs.readFileSync(file);
  return !buf.includes(0);
}

function workspaceTextFiles(workspace) {
  return walk(workspace).filter((file) => isTextFile(file));
}

const failures = [];

if (!fs.existsSync(indexPath)) fail(`missing ${path.relative(root, indexPath)}`);
if (fs.existsSync(path.join(root, "extension", "gsa", "fixture_projects_gen.mjs"))) {
  fail("gsa/fixture_projects_gen.mjs must not be the source of truth for curated benchmark workspaces");
}

for (const marker of [...walk(fixturesRoot), ...walk(answersRoot)].filter((file) => {
  const base = path.basename(file);
  return base === ".generated-by-dstudio-gsa-fixtures" || base === ".DS_Store";
})) {
  fail(`forbidden generated/system marker: ${path.relative(root, marker)}`);
}

const index = fs.existsSync(indexPath) ? readJson(indexPath) : [];
if (index.length !== targetCaseCount) fail(`expected ${targetCaseCount} fixture index entries, found ${index.length}`);

const bucketCounts = new Map();
const categoryCounts = new Map();
const difficultyCounts = new Map();
const sourceSignatures = new Map();

for (const item of index) {
  if (!categories.includes(item.category)) fail(`${item.id}: invalid category ${item.category}`);
  if (!difficulties.includes(item.difficulty)) fail(`${item.id}: invalid difficulty ${item.difficulty}`);
  const bucket = `${item.category}/${item.difficulty}`;
  bucketCounts.set(bucket, (bucketCounts.get(bucket) || 0) + 1);
  categoryCounts.set(item.category, (categoryCounts.get(item.category) || 0) + 1);
  difficultyCounts.set(item.difficulty, (difficultyCounts.get(item.difficulty) || 0) + 1);

  const workspace = path.join(root, item.workspace || "");
  if (!fs.existsSync(workspace)) {
    fail(`${item.id}: missing workspace ${item.workspace}`);
    continue;
  }

  const answerPath = path.join(answersRoot, item.category, item.difficulty, `${item.id}.json`);
  if (!fs.existsSync(answerPath)) {
    fail(`${item.id}: missing answer key`);
    continue;
  }
  const answer = readJson(answerPath);
  if (answer.schema_version !== 2) fail(`${item.id}: answer key must use schema_version 2`);
  if (!validOutcomes.has(answer.expected_outcome)) fail(`${item.id}: invalid expected_outcome ${answer.expected_outcome}`);
  if (!Array.isArray(answer.required_evidence_paths) || answer.required_evidence_paths.length < 2) {
    fail(`${item.id}: required_evidence_paths must list at least two paths`);
  }
  for (const evidence of answer.required_evidence_paths || []) {
    if (!evidence.startsWith("workspace/")) fail(`${item.id}: evidence path must start with workspace/: ${evidence}`);
    const local = path.join(workspace, evidence.replace(/^workspace\//, ""));
    if (!fs.existsSync(local)) fail(`${item.id}: evidence path does not exist: ${evidence}`);
  }
  if (answer.expected_outcome === "confirmed_issue" && (!answer.issue_class || !answer.severity)) {
    fail(`${item.id}: confirmed cases require issue_class and severity`);
  }
  if (answer.expected_outcome === "no_issue" && (!Array.isArray(answer.clean_controls) || answer.clean_controls.length < 2)) {
    fail(`${item.id}: clean cases require clean_controls`);
  }
  if (answer.expected_outcome === "inconclusive" && (!Array.isArray(answer.missing_evidence) || answer.missing_evidence.length < 2)) {
    fail(`${item.id}: inconclusive cases require missing_evidence`);
  }

  const files = workspaceTextFiles(workspace);
  const sourceFiles = files.filter((file) => {
    const rel = path.relative(workspace, file);
    return /^(src|include)\//.test(rel) && /\.(ts|py|c|h)$/.test(rel);
  });
  if (sourceFiles.length < 3) fail(`${item.id}: expected at least three source files, found ${sourceFiles.length}`);
  if (!fs.existsSync(path.join(workspace, "case-profile.json"))) fail(`${item.id}: missing case-profile.json`);
  if (!fs.existsSync(path.join(workspace, "PROJECT.md"))) fail(`${item.id}: missing PROJECT.md`);
  if (!fs.existsSync(path.join(workspace, "docs", "architecture.md"))) fail(`${item.id}: missing docs/architecture.md`);

  for (const file of files) {
    const rel = path.relative(workspace, file);
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of workspaceLeakPatterns) {
      if (pattern.test(text)) fail(`${item.id}: answer leak pattern ${pattern} in ${rel}`);
    }
    if (toolHintPattern.test(text)) fail(`${item.id}: external tool hint in ${rel}`);
  }

  const scriptFiles = walk(path.join(workspace, "scripts")).map((file) => path.basename(file));
  for (const name of scriptFiles) {
    if (name !== ".gitkeep") fail(`${item.id}: scripts/ must start empty, found ${name}`);
  }

  const sourceBundle = sourceFiles
    .sort()
    .map((file) => `${path.relative(workspace, file)}\n${fs.readFileSync(file, "utf8")}`)
    .join("\n---\n");
  const sig = sha1(sourceBundle);
  const sigKey = `${item.category}:${sig}`;
  if (sourceSignatures.has(sigKey)) {
    fail(`${item.id}: source bundle duplicates ${sourceSignatures.get(sigKey)} in category ${item.category}`);
  } else {
    sourceSignatures.set(sigKey, item.id);
  }
}

for (const category of categories) {
  const count = categoryCounts.get(category) || 0;
  if (count !== expectedPerCategory) fail(`${category}: expected ${expectedPerCategory} cases, found ${count}`);
}
for (const difficulty of difficulties) {
  const count = difficultyCounts.get(difficulty) || 0;
  if (count !== expectedPerDifficulty) fail(`${difficulty}: expected ${expectedPerDifficulty} cases, found ${count}`);
}
for (const [bucket, count] of bucketCounts.entries()) {
  if (count > 1) fail(`${bucket}: expected at most 1 case in each category/difficulty bucket, found ${count}`);
}

if (failures.length) {
  console.error(`GSA benchmark validation failed (${failures.length} issue${failures.length === 1 ? "" : "s"}):`);
  for (const line of failures.slice(0, 80)) console.error(`- ${line}`);
  if (failures.length > 80) console.error(`... ${failures.length - 80} more`);
  process.exit(1);
}

console.log(`GSA benchmark validation OK: ${index.length} curated workspaces (${expectedPerCategory}/category, ${expectedPerDifficulty}/difficulty), ${sourceSignatures.size} source signatures.`);
