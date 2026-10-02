import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../fixtures/retired-qwen-next/', import.meta.url));
const provenance = JSON.parse(fs.readFileSync(path.join(directory, 'provenance.json')));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const historicalQwenInspectRevision = provenance.inspectionRevision;

// Exact, bounded regression inputs. No installed checkout, network fallback,
// model state or surrounding repository's Git identity participates.
export function historicalQwenSource(revision, file) {
  const entry = provenance.files[`${revision}/${file}`];
  if (!entry || entry.bytes > 8 * 1024 * 1024 || entry.compressedBytes > 2 * 1024 * 1024)
    throw Error(`Unavailable historical Qwen fixture: ${revision}/${file}`);
  const compressed = fs.readFileSync(path.join(directory, entry.path));
  if (compressed.length !== entry.compressedBytes || sha256(compressed) !== entry.compressedSHA256)
    throw Error(`Corrupt compressed historical Qwen fixture: ${revision}/${file}`);
  const bytes = gunzipSync(compressed, { maxOutputLength: entry.bytes });
  if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256)
    throw Error(`Historical Qwen source identity mismatch: ${revision}/${file}`);
  return bytes;
}
