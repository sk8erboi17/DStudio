import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const htmlPath = path.join(root, 'web', 'index.html');
const runtimePath = path.join(root, 'extension', 'search', 'runtime.js');
const startMarker = '      /* DSTUDIO_SEARCH_EXTENSION_START */';
const endMarker = '      /* DSTUDIO_SEARCH_EXTENSION_END */';

function fail(message) {
  console.error(`sync-search-extension: ${message}`);
  process.exit(1);
}

const html = fs.readFileSync(htmlPath, 'utf8');
const runtime = fs.readFileSync(runtimePath, 'utf8').replace(/\s*$/, '\n');
const start = html.indexOf(startMarker);
const end = html.indexOf(endMarker);
if (start < 0 || end < 0 || end <= start) fail('search extension markers not found in web/index.html');

const before = html.slice(0, start + startMarker.length);
const current = html.slice(start + startMarker.length, end).replace(/^\n/, '').replace(/\n$/, '') + '\n';
const after = html.slice(end);

if (process.argv.includes('--check')) {
  if (current !== runtime) fail('web/index.html search block is out of sync with extension/search/runtime.js');
  console.log('sync-search-extension: ok');
  process.exit(0);
}

if (current === runtime) {
  console.log('sync-search-extension: already up to date');
  process.exit(0);
}

fs.writeFileSync(htmlPath, `${before}\n${runtime}${after}`);
console.log('sync-search-extension: updated web/index.html from extension/search/runtime.js');
