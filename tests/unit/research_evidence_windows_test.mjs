import assert from 'node:assert/strict';
import fs from 'node:fs';
// Execute both production excerpt passes on fictional documentation. These
// checks preserve evidence, not model-answer quality or real WCAG semantics.
const select = new Function(fs.readFileSync('extension/search/runtime.js', 'utf8') + '; return selectResearchEvidence;')();
const menu = Array.from({ length: 60 }, (_, i) => `[Menu ${i}](https://example.test/target-size/conformance/inline-link/${i})`).join(' ');
const heading = '# Target size rule (Level Silver). The required size is 31 by 31 units.';
const exception = 'Inline links within sentences are exempt from the target size rule.';
const prefix = menu.slice(0, 1420) + ' ' + heading;
const filler = Array.from({ length: 50 }, (_, i) => `Background ${i}: device usage and general interface guidance. `).join('');
const document = prefix + filler + exception + ' ' + menu.repeat(5);
const query = 'What are the target-size dimensions, conformance levels and inline-link exceptions?';
const stored = select(document, query, 18000);
const sent = select(stored, query, 5200);
assert.ok(stored.length <= 18000 && sent.length <= 5200);
assert.ok(sent.includes(heading), 'The source scope/level must survive a link-heavy menu');
assert.ok(sent.includes(exception), 'Repeated URL destinations must not displace the actual exception');
// A requested fact crossing the retained introduction must not be dropped
// merely because its ranked window overlaps that introduction.
for (const offset of [1690, 1730, 1780, 1810]) {
  const fact = 'The partial-window rule requires exactly 37 calibrated samples.';
  const source = 'Background. '.repeat(Math.ceil(offset / 12)).slice(0, offset) + fact + filler.repeat(8);
  assert.ok(select(select(source, 'How many calibrated samples does the partial-window rule require?', 18000),
    'How many calibrated samples does the partial-window rule require?', 5200).includes(fact));
}
const unicodeFact = 'The calibrated specimen identifier is prism-572.';
const unicodePage = 'İstanbul background. '.repeat(1800) + unicodeFact + filler.repeat(5);
assert.ok(select(unicodePage, 'What is the calibrated specimen identifier?', 5200).includes(unicodeFact),
  'Case folding that expands a character must not move source offsets');
console.log('research_evidence_windows: literal scope/exception retention, URL-heavy menus, compound terms, overlapping boundaries and unchanged budgets passed');
