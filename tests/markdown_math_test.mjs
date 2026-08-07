import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync('web/index.html', 'utf8');
const moduleMatch = html.match(/<script type="module">([\s\S]*?)<\/script>/);
assert.ok(moduleMatch, 'module script not found');
const source = moduleMatch[1];

function sliceBetween(startText, endText, from = 0) {
  const start = source.indexOf(startText, from);
  assert.notEqual(start, -1, `${startText} not found`);
  const end = source.indexOf(endText, start);
  assert.notEqual(end, -1, `${endText} not found`);
  return source.slice(start, end);
}

const texSource = sliceBetween(
  'const TEX_GREEK =',
  '/* ==================== Markdown (escape-first, XSS-safe) ==================== */',
);
const markdownSource = sliceBetween(
  "const CODE = '\\u0000'",
  'const MD_CACHE_MAX =',
);
const context = {};
vm.runInNewContext(`
${texSource}
${markdownSource}
this.texToMathML = texToMathML;
this.asciiMatrixGroupToLatex = asciiMatrixGroupToLatex;
this.fencedMathToLatex = fencedMathToLatex;
this.normalizeAssistantDiagramFences = normalizeAssistantDiagramFences;
this.renderMarkdown = renderMarkdown;
`, context);

const simpleAscii = [
  'A = [ 1  2  3 ]',
  '    [ 4  5  6 ]',
].join('\n');
const simpleLatex = context.fencedMathToLatex('', simpleAscii);
assert.equal(
  simpleLatex,
  String.raw`A = \; \begin{bmatrix}1 & 2 & 3 \\ 4 & 5 & 6\end{bmatrix}`,
  'legacy ASCII matrices should become real bmatrix LaTeX',
);

const symbolicAscii = [
  'A = [ a₁₁  a₁₂  ...  a₁ₙ ]',
  '    [ a₂₁  a₂₂  ...  a₂ₙ ]',
  '    [ ...  ...  ...  ... ]',
  '    [ aₘ₁  aₘ₂  ...  aₘₙ ]',
].join('\n');
const symbolicLatex = context.fencedMathToLatex('', symbolicAscii);
assert.match(symbolicLatex, /a_\{11\}/, 'Unicode matrix subscripts should become LaTeX subscripts');
assert.match(symbolicLatex, /a_\{mn\}/, 'mixed letter/number subscripts should remain grouped');
assert.match(symbolicLatex, /\\cdots/, 'ASCII ellipses should become mathematical ellipses');

const sideBySide = [
  'A = [ 1  2 ]      Aᵀ = [ 1  3 ]',
  '    [ 3  4 ]           [ 2  4 ]',
].join('\n');
const sideBySideLatex = context.fencedMathToLatex('', sideBySide);
assert.match(sideBySideLatex, /\\quad A\^\{T\} = \\; \\begin\{bmatrix\}/,
  'Unicode superscripts should be normalized inside recovered formulas');
assert.equal((sideBySideLatex.match(/\\begin\{bmatrix\}/g) || []).length, 2,
  'side-by-side matrices should remain two matrices');

const multiplication = [
  'A = [ 1  2 ]    B = [ 5  6 ]',
  '    [ 3  4 ]        [ 7  8 ]',
  '',
  'AB = [ 1×5+2×7   1×6+2×8 ] = [ 19  22 ]',
  '     [ 3×5+4×7   3×6+4×8 ]   [ 43  50 ]',
].join('\n');
const multiplicationLatex = context.fencedMathToLatex('', multiplication);
assert.match(multiplicationLatex, /^\\begin\{gathered\}/,
  'separate ASCII equations should become one multiline display formula');
assert.match(multiplicationLatex, /\\times/,
  'Unicode multiplication signs should be normalized to LaTeX');

const matrixMathML = context.texToMathML(simpleLatex, true);
assert.ok(matrixMathML, 'recovered matrix LaTeX should convert to MathML');
assert.equal((matrixMathML.match(/<mtr>/g) || []).length, 2, 'MathML should keep both rows');
assert.equal((matrixMathML.match(/<mtd>/g) || []).length, 6, 'MathML should keep all cells');
assert.equal((matrixMathML.match(/<mpadded height="\+0\.12em" depth="\+0\.12em">/g) || []).length, 6,
  'every matrix cell should have explicit vertical breathing room');
assert.equal((matrixMathML.match(/<mspace width="0\.42em"><\/mspace>/g) || []).length, 12,
  'every matrix cell should have explicit horizontal padding on both sides');
assert.match(matrixMathML, /<mtable class="math-matrix" columnspacing="0\.2em" rowspacing="0\.38em">/,
  'matrix tables should carry dedicated row and column spacing');
assert.match(matrixMathML, /<mo>\[<\/mo>[\s\S]*<mo>\]<\/mo>/,
  'bmatrix should retain square matrix fences');

const sideBySideMathML = context.texToMathML(sideBySideLatex, true);
assert.match(sideBySideMathML, /<mspace width="1em"><\/mspace>/,
  'independent side-by-side matrices should keep a full quad of separation');

const nativeLatexHtml = context.renderMarkdown(
  String.raw`\[A = \begin{bmatrix}1 & 2 \\ 3 & 4\end{bmatrix}\]`,
);
assert.match(nativeLatexHtml, /class="math-wrap math-wrap--block"/,
  'display LaTeX emitted by new answers should use the math surface');
assert.match(nativeLatexHtml, /<mtable /, 'display matrix LaTeX should emit a MathML table');
assert.doesNotMatch(nativeLatexHtml, /class="code-block"/,
  'display matrix LaTeX should not use code chrome');

const complexNumberHtml = context.renderMarkdown(
  String.raw`Il coniugato è \(\bar{z}=a-bi\) e il modulo è \(r=\sqrt{a^2+b^2}\).`,
);
assert.equal((complexNumberHtml.match(/class="math-wrap math-wrap--inline"/g) || []).length, 2,
  'inline complex-number formulas should render as two MathML expressions');
assert.match(complexNumberHtml, /<mover accent="true">/, 'the conjugate bar should use a MathML accent');
assert.match(complexNumberHtml, /<msqrt>/, 'the complex modulus should use a MathML square root');

const nthRootsLatex = String.raw`z^{1/n} = \sqrt[n]{r} \, e^{i\left(\frac{\theta + 2\pi k}{n}\right)}, \qquad k = 0,1,\dots,n-1`;
const nthRootsMathML = context.texToMathML(nthRootsLatex, true);
assert.ok(nthRootsMathML, 'nth-root formulas with a symbolic index should convert to MathML');
assert.match(nthRootsMathML, /<mroot><mrow><mi>r<\/mi><\/mrow><mrow><mi>n<\/mi><\/mrow><\/mroot>/,
  'the nth-root index should remain attached to the radical');
assert.equal((nthRootsMathML.match(/<mfrac>/g) || []).length, 1,
  'the fraction in the exponential argument should remain structured');
assert.match(nthRootsMathML, /<msup><mi>z<\/mi><mrow><mn>1<\/mn><mo lspace="0\.08em" rspace="0\.08em">\/<\/mo><mi>n<\/mi><\/mrow><\/msup>/,
  'the slash-form fraction in the root exponent should remain attached to z');
assert.match(nthRootsMathML, /<mo lspace="0\.28em" rspace="0\.28em">=<\/mo>/,
  'relations should retain explicit readable spacing in native MathML');
const nthRootsHtml = context.renderMarkdown(`\\[${nthRootsLatex}\\]`);
assert.match(nthRootsHtml, /class="math-wrap math-wrap--block"[\s\S]*<mroot>/,
  'the complete roots formula should render on the display-math surface');

const recoveredHtml = context.renderMarkdown(`\`\`\`\n${simpleAscii}\n\`\`\``);
assert.match(recoveredHtml, /class="math-wrap math-wrap--block"/,
  'legacy ASCII matrix fences should use the rendered math surface');
assert.match(recoveredHtml, /<mtable /, 'legacy ASCII matrix fences should emit a MathML table');
assert.doesNotMatch(recoveredHtml, /class="code-block"/,
  'legacy ASCII matrix fences should no longer show code chrome');

const remainingLegacyExamples = [
  [
    '[ 1  2 ]   [ 5  6 ]   [ 6   8 ]',
    '[ 3  4 ] + [ 7  8 ] = [ 10 12 ]',
  ],
  [
    '2 × [ 1  2 ] = [ 2  4 ]',
    '    [ 3  4 ]   [ 6  8 ]',
  ],
  [
    'det([ a  b ]) = ad - bc',
    '    [ c  d ]',
  ],
  [
    'A⁻¹ = (1/det(A)) × [ d  -b ]',
    '                    [ -c  a ]',
  ],
  [
    'A = [ 1  2 ]    det(A) = -2',
    '    [ 3  4 ]',
    '',
    'A⁻¹ = (1/-2) × [ 4  -2 ] = [ -2   1 ]',
    '               [ -3  1 ]   [ 1.5 -0.5 ]',
  ],
  [
    'a + bi  →  [ a  -b ]',
    '            [ b   a ]',
  ],
];
for (const [index, lines] of remainingLegacyExamples.entries()) {
  const htmlResult = context.renderMarkdown(`\`\`\`\n${lines.join('\n')}\n\`\`\``);
  assert.match(htmlResult, /<mtable /, `legacy matrix example ${index + 1} should emit MathML`);
  assert.doesNotMatch(htmlResult, /class="code-block"/,
    `legacy matrix example ${index + 1} should not retain code chrome`);
}

assert.equal(
  context.fencedMathToLatex('js', 'const a = [1, 2];\nconst b = [3, 4];'),
  null,
  'labeled source-code fences must stay code',
);
assert.equal(
  context.fencedMathToLatex('latex', String.raw`\frac{1}{2}`),
  null,
  'a LaTeX source-code fence should stay copyable source code',
);
assert.equal(
  context.fencedMathToLatex('', 'items = [ one two ]\nother = [ three four ]'),
  null,
  'ambiguous bracketed text must not be misclassified as a matrix',
);
const codeHtml = context.renderMarkdown('```js\nconst a = [1, 2];\nconst b = [3, 4];\n```');
assert.match(codeHtml, /class="code-block"/, 'actual source code should retain code chrome');
assert.match(codeHtml, /data-copy[^>]*>Copy<\/button>/, 'actual source code should retain its Copy action');
assert.doesNotMatch(codeHtml, /<math/, 'actual source code should not become MathML');
const asciiDiagramHtml = context.renderMarkdown('```text\ninput --> transform --> output\n```');
assert.match(asciiDiagramHtml, /class="code-block code-block--diagram"/,
  'labeled ASCII diagrams should use their dedicated visual surface');
assert.match(asciiDiagramHtml, /code-block__lang">Diagram<\/span>/,
  'ASCII explanation diagrams should carry a clear Diagram label');
assert.doesNotMatch(asciiDiagramHtml, /<code class="hl">/,
  'ASCII diagrams should remain monochrome instead of receiving syntax highlighting');
assert.match(html, /\.code-block--diagram pre\s*\{[\s\S]*white-space:\s*pre;[\s\S]*overflow-x:\s*auto;/,
  'ASCII diagrams should preserve alignment and scroll instead of wrapping');
assert.match(html, /\.code-block--diagram code\s*\{[\s\S]*font-variant-ligatures:\s*none;[\s\S]*font-feature-settings:\s*"liga" 0, "calt" 0;/,
  'ASCII diagrams should disable glyph substitutions that can disturb fixed columns');

const untaggedDiagram = [
  'Prima viene spiegato il flusso.',
  '',
  '```',
  'input --> validation --> output',
  '             |   ^',
  '             v   |',
  '           error-+',
  '```',
  '',
  'La freccia torna alla validazione.',
].join('\n');
const taggedDiagram = context.normalizeAssistantDiagramFences(untaggedDiagram);
assert.match(taggedDiagram, /```text\ninput --> validation/,
  'completed assistant diagrams should receive a deterministic text fence when the model omits it');
const untaggedNumberLine = '```\nopen   <---o------o--->\n          -2      3\nclosed <---*------*--->\n          -2      3\n```';
assert.match(context.normalizeAssistantDiagramFences(untaggedNumberLine), /```text\nopen/,
  'untagged number lines should also receive the canonical text fence');
const ordinaryFence = '```\nplain words only\nsecond line\n```';
assert.equal(context.normalizeAssistantDiagramFences(ordinaryFence), ordinaryFence,
  'untagged non-diagram fences must not be rewritten');

const legacyUnicodeDiagram = [
  '            immaginario (i)',
  '                ↑',
  '                │  z = r(cos θ + i sin θ)',
  '                │   /│',
  '                │  / θ│',
  '                │ /  │ b',
  '                │/   │',
  '      ──────────●────┴──────────→ reale',
  '              O     a',
].join('\n');
const legacyUnicodeDiagramHtml = context.renderMarkdown(`\`\`\`\n${legacyUnicodeDiagram}\n\`\`\``);
assert.match(legacyUnicodeDiagramHtml, /class="code-block code-block--diagram"/,
  'unlabeled legacy coordinate sketches should be recognized as diagrams');
assert.doesNotMatch(legacyUnicodeDiagramHtml, /[↑↓←→│┃║─━═●•○┴]/,
  'legacy variable-width drawing glyphs should be normalized before rendering');
assert.match(legacyUnicodeDiagramHtml, /\^|\|[\s\S]*\*[\s\S]*\+.*&gt; reale/,
  'normalized diagrams should keep ASCII axes, points, intersections, and arrows');

assert.match(html, /\.md math\[display="block"\]\s*\{[\s\S]*overflow:\s*visible;/,
  'tall display MathML should not clip radicals or exponents');
assert.match(html, /\.math-wrap--block\s*\{[\s\S]*padding:\s*0\.5em 0\.35em;[\s\S]*overflow-y:\s*auto;/,
  'display formulas should have vertical breathing room around tall notation');

assert.match(source, /const CHAT_MATH_OUTPUT_PROTOCOL = String\.raw/,
  'normal chat should include a mathematical typesetting protocol');
assert.match(source, /const CHAT_EXPLANATION_STYLE_PROTOCOL = String\.raw/,
  'normal chat should include the progressive explanation and ASCII diagram style');
assert.match(source, /Before emitting a diagram, make one brief internal layout pass:[\s\S]*Limit diagram-layout reasoning to at most two short sentences\.[\s\S]*There is no fixed column limit\.[\s\S]*Do not count characters one by one, explore multiple drafts, narrate the layout work, or dwell on it/,
  'the model should do one bounded diagram check instead of prolonged character counting');
assert.match(html, /<option value="high">Thinking: high<\/option>/,
  'the UI should name DS4 high reasoning honestly instead of calling it normal');
assert.doesNotMatch(html, /Thinking: normal/,
  'the removed normal label must not imply that DS4 exposes a medium reasoning tier');
assert.doesNotMatch(source, /Keep the diagram under about 60 columns/,
  'diagram width should be chosen from the content, not a fixed column limit');
assert.doesNotMatch(source, /Assign exact row and column anchors/,
  'the diagram prompt should not trigger exhaustive coordinate-by-coordinate reasoning');
assert.match(source, /For an angle, draw both rays meeting at an explicit vertex and put an ASCII angle marker such as <theta immediately beside that vertex, inside the sector; a bare theta floating halfway along a side is ambiguous and is not acceptable/,
  'angle labels should be visibly attached to their vertex and sector');
assert.match(source, /On the single row immediately above O, begin the oblique ray in the next column and write the exact local pattern \/<theta:[\s\S]*Never place theta higher up or near the middle of the radial side[\s\S]*Put r around the middle of the radial path, x below its projection foot on Re, and y beside the vertical projection/,
  'polar diagrams should give every geometric label an unambiguous location');
assert.match(source, /explicitly say that theta is the angle from the positive Re ray O->x to the radial ray O->z/,
  'the sentence after a polar sketch should name both rays that bound theta');
assert.match(source, /orthogonal projection:[\s\S]*\n  \/<theta     \|[\s\S]*\nO-------------\+ 90 deg -----> L/,
  'orthogonal-projection theta should use the same vertex-attached angle marker');
assert.match(source, /settings\.systemPrompt\?\.trim\(\),\s*\(!hasDeepResearchContext && !hasSynthesizedResearchReport\) \? CHAT_EXPLANATION_STYLE_PROTOCOL : '',\s*CHAT_MATH_OUTPUT_PROTOCOL,\s*CHAT_FILE_OUTPUT_PROTOCOL/,
  'the mathematical typesetting protocol should be sent in normal chat history');
assert.match(source, /function renderFence\([\s\S]*fencedMathToLatex\(lang, code\)[\s\S]*texToMathML\(latex, true\)/,
  'closed mathematical fences should take the MathML path');
assert.match(source, /const generated = extractGeneratedFilesFromAssistant\(content\);\s*content = normalizeAssistantDiagramFences\(generated\.content\);/,
  'the canonical diagram-fence repair should run before the assistant response is committed');

console.log('markdown_math_test: ok');
