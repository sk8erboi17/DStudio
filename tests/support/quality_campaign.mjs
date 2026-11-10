// Coverage accounting for the macOS quality campaign (PLAN.MD P0). It reads
// the declared matrix and terminal receipts and reports, per selection and
// suite, what ran on the current identities and what did not. It runs no
// model, changes no receipt and never turns a missing run into a pass.
import fs from 'node:fs';
import path from 'node:path';

export function loadCampaign(file) {
  const campaign = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (campaign.schema !== 'dstudio.quality-campaign.v1') throw new Error('unknown campaign schema');
  const ids = campaign.selections.map((s) => s.id);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate selection id');
  for (const s of campaign.selections) {
    if (!['maintainer', 'contributor'].includes(s.plan)) throw new Error(`selection ${s.id}: unknown plan`);
    if (!['ds4', 'ds4-laguna', 'llama', 'mlx'].includes(s.engine)) throw new Error(`selection ${s.id}: unknown engine`);
  }
  return campaign;
}

// One attempt extracted from a receipt, in the shape coverage() consumes.
// Host runner: tests/live/host_common_quality.mjs.
export function attemptFromHostReceipt(receipt, source) {
  if (receipt?.schema !== 'dstudio.host-common-quality.v1') return null;
  const receiptCommit = (receipt.engine?.identity?.receipts?.['.dstudio-source.json']?.content?.commit)
    || (receipt.engine?.identity?.receipts?.['.dstudio-llama.json']?.content?.bundledSources?.commit) || null;
  const summary = receipt.summary || null;
  return { source, suite: 'common-100', modelFile: receipt.selection?.modelFile, engine: receipt.selection?.engine,
    engineCommit: receiptCommit, ssdStreamingEffective: receipt.effective?.ssdStreamingEffective ?? null,
    weightsVerified: receipt.weights?.verified ?? null, weightFiles: (receipt.weights?.files || []).map((f) => ({ name: f.name, sha256: f.sha256 })),
    qualityUse: receipt.qualityUse, started: receipt.started, finished: receipt.finished || null,
    terminal: ['pass', 'fail'].includes(receipt.status) && Boolean(receipt.finished),
    interrupted: receipt.status === 'interrupted', summary,
    loaded: Boolean(receipt.effective), error: receipt.error ? String(receipt.error).split('\n')[0].slice(0, 300) : null };
}

// Native runner: tests/live/engine_acceptance.mjs --common-quality.
export function attemptsFromNativeReceipt(receipt, source) {
  if (receipt?.schema !== 'dstudio.engine-acceptance.v1') return [];
  const out = [];
  for (const entry of receipt.results || []) {
    const quality = entry.quality?.report;
    if (!quality) continue;
    const modelPath = entry.inference?.model?.path || '';
    out.push({ source, suite: 'common-100', modelFile: modelPath ? `gguf/${path.basename(modelPath)}` : null,
      engine: entry.engine === 'laguna' ? 'ds4-laguna' : 'ds4', engineCommit: entry.inference?.installer?.commit || entry.inference?.sourceCommit || null,
      ssdStreamingEffective: entry.inference ? false : null, weightsVerified: null,
      weightFiles: entry.inference?.model?.sha256 ? [{ name: path.basename(modelPath), sha256: entry.inference.model.sha256 }] : [],
      qualityUse: quality.evaluationUse, started: quality.started || receipt.started, finished: quality.finished || null,
      terminal: ['pass', 'fail'].includes(quality.status) && Boolean(quality.finished), interrupted: Boolean(receipt.interrupted),
      summary: quality.summary || null, loaded: Boolean(entry.inference?.models),
      error: entry.error ? String(entry.error).split('\n')[0].slice(0, 300) : null });
  }
  return out;
}

// Why an attempt does not count for a selection, or '' when it does.
export function mismatch(selection, attempt) {
  if (attempt.modelFile !== selection.modelFile) return 'another model';
  if (attempt.engine !== selection.engine) return `engine ${attempt.engine}, selection needs ${selection.engine}`;
  if (selection.engineCommit && attempt.engineCommit !== selection.engineCommit)
    return `engine revision ${attempt.engineCommit || 'unrecorded'}, pin is ${selection.engineCommit}`;
  if (selection.ssdStreaming && attempt.ssdStreamingEffective !== (selection.ssdStreaming === 'on'))
    return `effective SSD streaming ${attempt.ssdStreamingEffective}, selection is qualified with streaming ${selection.ssdStreaming}`;
  return '';
}

// States follow the plan's evidence contract. A contributor selection is
// BLOCKED whatever exists on this machine; missing weights are BLOCKED; a run
// that never reached a terminal result does not count as executed.
export function coverage(campaign, attempts, { weightsPresent = () => true } = {}) {
  const rows = [];
  for (const selection of campaign.selections) for (const suite of campaign.suites) {
    const row = { selection: selection.id, label: selection.label, suite: suite.id, denominator: suite.cases,
      plan: selection.plan, passed: 0, failed: 0, notRun: suite.cases, attempts: [], excluded: [] };
    for (const attempt of attempts.filter((a) => a.suite === suite.id && a.modelFile === selection.modelFile)) {
      const reason = mismatch(selection, attempt);
      (reason ? row.excluded : row.attempts).push(reason ? { source: attempt.source, reason } : attempt);
    }
    row.attempts.sort((a, b) => String(a.started).localeCompare(String(b.started)));
    const terminal = row.attempts.filter((a) => a.terminal && a.summary);
    // Every terminal attempt stays listed. The cell reports the first one on the
    // current identities: a later rerun of unchanged deterministic work is not
    // new evidence and must not replace an initial failure.
    const counted = terminal[0];
    if (selection.plan === 'contributor') { row.status = 'BLOCKED'; row.reason = 'left to contributor hardware'; }
    else if (!weightsPresent(selection)) { row.status = 'BLOCKED'; row.reason = 'weights not installed on this machine'; }
    else if (!counted) { row.status = 'NOT_RUN'; row.reason = row.attempts.length ? 'no attempt reached a terminal result' : 'no attempt on the current identities'; }
    else {
      const s = counted.summary;
      if (s.denominator !== suite.cases) { row.status = 'FAIL'; row.reason = `receipt denominator ${s.denominator} differs from ${suite.cases}`; }
      else {
        Object.assign(row, { passed: s.passed, failed: s.failed, notRun: s.notRun + (s.pending || 0), counted: counted.source });
        row.status = s.passed === suite.cases ? 'PASS' : 'FAIL';
        if (row.status === 'FAIL') row.reason = `${s.failed} failed, ${row.notRun} not run`;
      }
    }
    rows.push(row);
  }
  const total = (key) => rows.reduce((sum, row) => sum + row[key], 0);
  return { rows, totals: { cells: rows.length, denominator: total('denominator'), passed: total('passed'), failed: total('failed'), notRun: total('notRun'),
    byStatus: Object.fromEntries(['PASS', 'FAIL', 'NOT_RUN', 'BLOCKED'].map((status) => [status, rows.filter((row) => row.status === status).length])) } };
}

// Reads every receipt below the given run directories; an unreadable file is
// reported, never silently skipped.
export function collectAttempts(artifactRoot) {
  const attempts = [], unreadable = [];
  const read = (dir, parse) => {
    const base = path.join(artifactRoot, dir);
    if (!fs.existsSync(base)) return;
    for (const name of fs.readdirSync(base).sort()) {
      const file = path.join(base, name, 'results.json');
      if (!fs.existsSync(file)) continue;
      try { attempts.push(...parse(JSON.parse(fs.readFileSync(file, 'utf8')), `${dir}/${name}`)); }
      catch (error) { unreadable.push({ source: `${dir}/${name}`, error: String(error.message).slice(0, 200) }); }
    }
  };
  read('host-common-quality', (receipt, source) => { const a = attemptFromHostReceipt(receipt, source); return a ? [a] : []; });
  read('engine-acceptance', attemptsFromNativeReceipt);
  return { attempts, unreadable };
}
