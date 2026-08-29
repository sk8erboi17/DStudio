import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeRenderedFontDiversity } from './design_font_diversity_gate.mjs';
import { findChrome } from './design_control_probe.mjs';

const chrome = findChrome();
if (!chrome) {
  console.log('design_font_diversity_gate_test: Chrome missing, skipping');
  process.exit(0);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds4-rendered-font-gate-'));
const write = (name, family) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, `<!doctype html><html><head><style>
body,h1{font-family:${family};}</style></head><body><main><h1>${name}</h1><p>Rendered font evidence for the primary text role.</p></main></body></html>`);
  return file;
};

try {
  const varied = [
    write('sans.html', 'Arial,sans-serif'),
    write('serif.html', 'Georgia,serif'),
    write('mono.html', '"Courier New",monospace'),
    write('user-choice.html', '"American Typewriter",serif'),
  ];
  const report = await analyzeRenderedFontDiversity(chrome, varied, {
    requiredFonts: {
      [varied[1]]: 'Georgia',
      [varied[3]]: 'American Typewriter',
    },
  });
  assert.equal(report.pass, true, report.failures.join('; '));
  assert.equal(report.aggregate.distinctPrimaryFonts.length, 4);
  assert.equal(report.aggregate.distinctDisplayFonts.length, 4);

  const clones = [
    write('clone-a.html', 'Arial,sans-serif'),
    write('clone-b.html', 'Arial,sans-serif'),
  ];
  const cloneReport = await analyzeRenderedFontDiversity(chrome, clones);
  assert.equal(cloneReport.pass, false, 'identical actual browser fonts must fail');
  assert.match(cloneReport.failures.join('; '), /distinct rendered primary font/i);
  console.log('design_font_diversity_gate_test: ok');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
