import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeCreativity, creativityMarkdown } from '../support/design_creativity_gate.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds4-creativity-gate-'));

function write(name, html) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, html);
  return file;
}

try {
  const cloneA = write('clone-a.html', `<!doctype html><html><head><style>
body{font-family:Georgia,serif;color:#111;background:#eee}.hero{display:grid;grid-template-columns:1fr 1fr}.cards{display:grid;grid-template-columns:repeat(3,1fr)}
</style></head><body><header><nav>A</nav></header><main><section class="hero"><h1>Alpha</h1><img alt="a"></section><section class="cards"><article>A</article><article>B</article><article>C</article></section></main><footer>A</footer></body></html>`);
  const cloneB = write('clone-b.html', `<!doctype html><html><head><style>
body{font-family:Arial,sans-serif;color:#fff;background:#123}.hero{display:grid;grid-template-columns:1fr 1fr}.cards{display:grid;grid-template-columns:repeat(3,1fr)}
</style></head><body><header><nav>B</nav></header><main><section class="hero"><h1>Beta</h1><img alt="b"></section><section class="cards"><article>D</article><article>E</article><article>F</article></section></main><footer>B</footer></body></html>`);
  const cloneReport = analyzeCreativity([cloneA, cloneB], {
    minimumDistinctHeroSchemas: 1,
    minimumDistinctPrimaryFontStacks: 1,
  });
  assert.equal(cloneReport.pass, false, 'same skeleton with swapped font/copy/colors must fail');
  assert.equal(cloneReport.pairs[0].structuralClone, true);

  const poster = write('poster.html', `<!doctype html><html><head><style>
body{font-family:"Arial Narrow",sans-serif;background:#111;color:#fff}.masthead{position:relative}.masthead video{position:absolute;inset:0;object-fit:cover}.masthead h1{writing-mode:vertical-rl;transform:rotate(180deg);font-family:Impact,sans-serif}
</style></head><body><header>Poster</header><main><section class="masthead"><video></video><h1>Poster</h1></section><ol><li>One</li></ol></main><footer>End</footer></body></html>`);
  const reference = write('reference.html', `<!doctype html><html><head><style>
body{font-family:Rockwell,serif;background:#eee;color:#222}.specimen{display:grid;grid-template-columns:2fr 1fr}.specimen h1{font-family:Georgia,serif}
</style></head><body><header>Folio</header><main><section class="specimen"><img alt="plant"><dl><dt>Family</dt><dd>Saxifrage</dd></dl></section><article><table><tr><td>2140</td></tr></table></article></main><footer>Log</footer></body></html>`);
  const instrument = write('instrument.html', `<!doctype html><html><head><style>
body{font-family:ui-monospace,monospace;background:#02080a;color:#0ff}.transport{display:flex}.lane{display:flex;position:sticky}.transport h1{font-family:Arial,sans-serif}
</style></head><body><header>Signal</header><main><section class="transport"><button>Play</button><video></video><h1>Mix</h1></section><section class="lane"><button>Filter</button><input></section><aside>Archive</aside></main><footer>Credits</footer></body></html>`);
  const sameSectionCount = analyzeCreativity([poster, reference], {
    maximumPairwiseCloneScore: 1.01,
    minimumDistinctHeroSchemas: 1,
    minimumDistinctPrimaryFontStacks: 1,
    minimumDistinctDisplayFontStacks: 1,
    minimumDistinctTypeSystems: 1,
    minimumDistinctSectionCounts: 2,
  });
  assert.equal(sameSectionCount.pass, false,
    'a profile that requires structural count diversity must reject one shared section count');
  assert.ok(sameSectionCount.failures.some((failure) => /distinct section count/.test(failure)));

  const varied = analyzeCreativity([poster, reference, instrument], {
    minimumDistinctSectionCounts: 2,
  });
  assert.equal(varied.pass, true, varied.failures.join('; '));
  assert.ok(varied.aggregate.distinctHeroSchemas.length >= 2);
  assert.equal(varied.aggregate.distinctPrimaryFontStacks.length, 3);
  assert.equal(varied.aggregate.distinctDisplayFontStacks.length, 3);
  assert.equal(varied.aggregate.distinctTypeSystems.length, 3);
  assert.equal(varied.aggregate.distinctSectionCounts.length, 2);
  assert.match(creativityMarkdown(varied), /Result: \*\*PASS\*\*/);
  console.log('design_creativity_gate_test: ok');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
