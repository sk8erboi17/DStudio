import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function eventFromLine(line) {
  const marker = line.indexOf('\x1e');
  if (marker < 0) return null;
  try { return JSON.parse(line.slice(marker + 1).trimEnd()); }
  catch { return null; }
}

export function trimResumeTranscript(raw, stopAfter) {
  const type = String(stopAfter?.type || '');
  const name = String(stopAfter?.name || '');
  const occurrence = Number(stopAfter?.occurrence || 0);
  if (!type || !name || !Number.isInteger(occurrence) || occurrence < 1)
    throw new Error('resume stopAfter must name an event type, tool name, and positive occurrence');

  const input = String(raw || '');
  const lines = input.match(/[^\n]*\n|[^\n]+$/g) || [];
  let prefix = '';
  let seen = 0;
  for (const line of lines) {
    prefix += line;
    const event = eventFromLine(line);
    if (event?.type === type && event?.name === name) {
      seen++;
      if (seen === occurrence) {
        return { raw: prefix, stopEvent: event, occurrence: seen };
      }
    }
  }
  throw new Error(`resume checkpoint event not found: ${type}/${name} #${occurrence}`);
}

export function loadResumeManifest(file, selectedIds) {
  const manifestPath = path.resolve(file);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest?.schema !== 'ds4.design.resume.v1')
    throw new Error('resume manifest must use ds4.design.resume.v1');
  if (!manifest.caseId || selectedIds.length !== 1 || selectedIds[0] !== manifest.caseId)
    throw new Error('resume manifest must target the one selected benchmark case');
  if (!manifest.transcript || !manifest.stopAfter || !manifest.prompt)
    throw new Error('resume manifest requires transcript, stopAfter, and prompt');
  if (!Number.isFinite(Number(manifest.priorElapsedMs)) || Number(manifest.priorElapsedMs) < 0)
    throw new Error('resume manifest priorElapsedMs must be a non-negative number');
  return { manifestPath, manifest };
}

export function verifyResumeFiles(workspace, files) {
  const root = path.resolve(workspace);
  const verified = [];
  for (const [relative, expected] of Object.entries(files || {})) {
    const absolute = path.resolve(root, relative);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`))
      throw new Error(`resume file escapes workspace: ${relative}`);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile())
      throw new Error(`resume file is missing: ${relative}`);
    const bytes = fs.statSync(absolute).size;
    if (bytes < Number(expected?.minimumBytes || 1))
      throw new Error(`resume file is too small: ${relative}`);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
    if (expected?.sha256 && sha256 !== expected.sha256)
      throw new Error(`resume file hash mismatch: ${relative}`);
    verified.push({ path: relative, bytes, sha256 });
  }
  return verified;
}
