// Explicitly simulated compiler/linker. GNU Make and its actual argv/recursive
// backend selection are real; these receipts do NOT prove GPU compilation.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

const [tool, ...args] = process.argv.slice(2);
const root = fs.realpathSync(process.env.DSTUDIO_LINK_WORK);
assert(fs.realpathSync(process.cwd()).startsWith(root + path.sep));
const row = {tool, args, cwd: process.cwd()};
fs.appendFileSync(process.env.DSTUDIO_LINK_LOG, JSON.stringify(row) + '\n');
if (tool === 'make') process.exit(0); // Record upstream's own recursive ROCm selection.
if (args.includes('-fsyntax-only')) {
  // Design's capability check still uses the real upstream public C type.
  const result = spawnSync(process.env.DSTUDIO_LINK_REAL_CC || 'cc', args,
    {stdio: 'inherit', timeout: 10000});
  process.exit(result.status ?? 1);
}
const at = args.indexOf('-o');
assert(at >= 0 && at + 1 < args.length, 'Expected an actual compiler/link command');
const file = path.resolve(args[at + 1]);
assert(file.startsWith(root + path.sep), 'Output must stay in the test-owned directory');
fs.mkdirSync(path.dirname(file), {recursive: true});
fs.writeFileSync(file, JSON.stringify(row) + '\n');
