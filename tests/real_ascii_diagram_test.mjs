import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  artifactDir,
  completeTextStream,
  jsonFetch,
  normalizeBaseUrl,
  startDStudio,
  waitForModel,
  writeArtifact,
} from './real_harness.mjs';

const artifacts = artifactDir('ascii-diagrams-real');
const keepArtifacts = process.env.DSTUDIO_ASCII_KEEP_ARTIFACTS === '1';
let previousReport = null;
if (keepArtifacts) {
  try {
    previousReport = JSON.parse(fs.readFileSync(path.join(artifacts, 'report.json'), 'utf8'));
  } catch {}
}
if (!keepArtifacts) {
  for (const name of fs.readdirSync(artifacts)) {
    fs.rmSync(path.join(artifacts, name), { recursive: true, force: true });
  }
}

const page = fs.readFileSync('web/index.html', 'utf8');
function rawProtocol(name) {
  const match = page.match(new RegExp('const ' + name + ' = String\\.raw`([\\s\\S]*?)`;'));
  assert.ok(match, `${name} not found`);
  return match[1];
}
const systemPrompt = [
  rawProtocol('CHAT_EXPLANATION_STYLE_PROTOCOL'),
  rawProtocol('CHAT_MATH_OUTPUT_PROTOCOL'),
  'Keep this test answer concise (at most 220 words) while still including the requested diagram.',
].join('\n\n');
const testThinkLevel = process.env.DSTUDIO_ASCII_THINK_LEVEL || 'off';
const testMaxTokens = Number(process.env.DSTUDIO_ASCII_MAX_TOKENS || 520);

const allCases = [
  {
    id: 'polar-angle',
    prompt: 'Spiega in italiano come un numero complesso z=x+iy si rappresenta sul piano e in coordinate polari. Inserisci durante la spiegazione un diagramma ASCII con assi Re/Im, origine, proiezioni x/y, raggio r e il marcatore angolare <theta attaccato a O fra i due raggi, mai sospeso nel mezzo del triangolo.',
  },
  {
    id: 'right-triangle',
    prompt: 'Spiega in italiano il teorema di Pitagora con un triangolo rettangolo ASCII etichettato a, b, c e con l’angolo retto chiaramente collegato al suo vertice.',
  },
  {
    id: 'number-line',
    prompt: 'Spiega in italiano l’intervallo aperto (-2,3) e quello chiuso [-2,3] usando una retta numerica ASCII durante la spiegazione. Distingui chiaramente estremi inclusi ed esclusi.',
  },
  {
    id: 'transformation',
    prompt: 'Spiega in italiano una pipeline dati input -> validazione -> trasformazione -> output usando un diagramma ASCII integrato nella spiegazione, con un ramo di errore che torna alla validazione.',
  },
  {
    id: 'hierarchy',
    prompt: 'Spiega in italiano questa gerarchia di classi con un albero ASCII integrato: Animale è la radice; Mammifero e Uccello sono figli diretti; Cane e Gatto sono figli soltanto di Mammifero. Ogni classe deve comparire una sola volta ed essere collegata senza ambiguità al proprio genitore.',
  },
  {
    id: 'vector-projection',
    prompt: 'Spiega in italiano la proiezione ortogonale di un vettore v su una retta L con un diagramma ASCII. Il piede della perpendicolare, v, la proiezione e l’angolo devono essere associati chiaramente alle rispettive parti.',
  },
  {
    id: 'parabola',
    prompt: 'Spiega in italiano il grafico di y=x^2 con assi cartesiani e una parabola ASCII integrata nella spiegazione. Origine, verso degli assi e curva devono essere distinguibili.',
  },
];
const requestedCases = new Set(String(process.env.DSTUDIO_ASCII_CASES || '')
  .split(',').map((value) => value.trim()).filter(Boolean));
const cases = requestedCases.size
  ? allCases.filter((testCase) => requestedCases.has(testCase.id))
  : allCases;
assert.ok(cases.length, `No ASCII cases matched DSTUDIO_ASCII_CASES=${[...requestedCases].join(',')}`);

function diagramsFrom(markdown) {
  const out = [];
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let match;
  while ((match = re.exec(markdown)) !== null) {
    out.push({
      lang: match[1].trim().toLowerCase(),
      text: match[2].replace(/\n$/, ''),
      start: match.index,
      end: re.lastIndex,
    });
  }
  return out;
}

function looksLikeAsciiDiagram(code) {
  const lines = String(code || '').split('\n').filter((line) => line.trim());
  if (lines.length < 3) return false;
  const structural = lines.filter((line) =>
    /(?:-{3,}|_{3,}|-->|<--|[↑↓←→│┃║─━═┌┐└┘├┤┬┴┼●○]|(?:^|\s)[|/+*\\](?:\s|$))/.test(line));
  const hasAxisOrFlow = /\b(?:re|im|reale|immaginario|asse|axis|origine|origin|input|output)\b/i.test(code) ||
    /(?:-->|<--|[↑↓←→])/.test(code);
  const hasNumberLine = /(?:o-{3,}o|\*-{3,}\*)/.test(code);
  return hasNumberLine || (structural.length >= 2 && (hasAxisOrFlow || structural.length >= 3));
}

/* Mirror the deterministic final-response repair used by DStudio. The raw
 * model output remains in the report so prompt compliance is still visible. */
function normalizeAssistantDiagramFences(markdown) {
  return String(markdown || '').replace(
    /^([^\S\n]*)```[^\S\n]*\n([\s\S]*?)^\1```[^\S\n]*$/gm,
    (whole, indent, code) => {
      const probe = indent ? code.replace(new RegExp(`^${indent}`, 'gm'), '') : code;
      if (!looksLikeAsciiDiagram(probe.replace(/\n$/, ''))) return whole;
      return `${indent}\`\`\`text\n${code}${indent}\`\`\``;
    },
  );
}

function locations(lines, pattern) {
  const found = [];
  lines.forEach((line, row) => {
    const re = new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g');
    let match;
    while ((match = re.exec(line)) !== null) {
      found.push({ row, col: match.index, text: match[0] });
      if (match[0].length === 0) re.lastIndex++;
    }
  });
  return found;
}

function evaluate(id, markdown) {
  const diagrams = diagramsFrom(markdown);
  const issues = [];
  if (diagrams.length === 0) issues.push('no fenced diagram');
  if (diagrams.length > 1) issues.push(`expected one focused diagram, found ${diagrams.length}`);
  for (const diagram of diagrams) {
    if (diagram.lang !== 'text') {
      issues.push(`diagram language is "${diagram.lang}", expected text`);
    }
    if (/[↑↓←→│┃║─━═┌┐└┘├┤┬┴┼●•○]/.test(diagram.text)) {
      issues.push('contains variable-width Unicode drawing glyphs');
    }
    if (/\t/.test(diagram.text)) issues.push('contains tabs');
    if (diagram.text.split('\n').some((line) => /\s+$/.test(line))) issues.push('contains trailing whitespace');
    if (diagram.text.split('\n').length < 3) issues.push('diagram is too shallow to explain the relationship');
  }
  if (diagrams.length) {
    const before = markdown.slice(0, diagrams[0].start).trim();
    const after = markdown.slice(diagrams[0].end).trim();
    if (before.split(/\s+/).filter(Boolean).length < 5) {
      issues.push('diagram is not introduced by a normal explanatory sentence');
    }
    if (after.split(/\s+/).filter(Boolean).length < 5) {
      issues.push('diagram is not followed by a sentence explaining how to read it');
    }
  }

  const primary = diagrams[0]?.text || '';
  const lines = primary.split('\n');
  if (id === 'polar-angle') {
    const theta = locations(lines, /\btheta\b/i);
    const origin = locations(lines, /O/);
    const points = locations(lines, /\*/);
    if (!theta.length) issues.push('polar diagram has no literal ASCII theta label');
    if (!origin.length) issues.push('polar diagram has no explicit origin');
    if (!points.length) issues.push('polar diagram has no unambiguous * point marker');
    if (theta.length && origin.length) {
      const closeToVertex = theta.some((angle) => origin.some((vertex) =>
        angle.row === vertex.row - 1 &&
        angle.col > vertex.col && angle.col - vertex.col <= 5));
      if (!closeToVertex) {
        issues.push('theta is not immediately above/right of O inside the angular sector');
      } else {
        const tiedToVertexWithAngleMarker = theta.some((angle) => origin.some((vertex) => {
          if (angle.row !== vertex.row - 1) return false;
          const localWedge = lines[angle.row]?.slice(vertex.col + 1, angle.col + angle.text.length) || '';
          return /^\/<\s*theta\b/i.test(localWedge);
        }));
        if (!tiedToVertexWithAngleMarker) {
          issues.push('theta is not part of a local /<theta angle marker attached to O');
        }
      }
    }
    if (origin.length) {
      const vertex = origin[origin.length - 1];
      const verticalAxis = lines.slice(0, vertex.row)
        .some((line) => line[vertex.col] === '|' || line[vertex.col] === '^');
      const horizontalAxis = /-{2,}.*>/.test(lines[vertex.row]?.slice(vertex.col + 1) || '');
      if (!verticalAxis || !horizontalAxis) {
        issues.push('O is not the shared intersection of the Im and Re axes');
      }
      const point = points.find((item) => item.row < vertex.row && item.col > vertex.col);
      if (!point) {
        issues.push('the * point is not above and to the right of O');
      } else {
        const projected = lines.slice(point.row + 1, vertex.row)
          .some((line) => line[point.col] === '|');
        if (!projected) issues.push('the point has no vertical projection to the Re axis');
        const radialMarks = locations(lines, /\//).filter((mark) =>
          mark.row > point.row && mark.row < vertex.row &&
          mark.col > vertex.col && mark.col < point.col);
        if (radialMarks.length < 2) issues.push('no readable rising / path connects O toward the point');
      }
    }
    if (!/\br\b/.test(primary) || !/\bx\b/.test(primary) || !/\by\b/.test(primary)) {
      issues.push('polar diagram is missing an r, x, or y feature label');
    }
    if (!/[\\/]/.test(primary) || !/>/.test(primary) || !/\^/.test(primary)) {
      issues.push('polar diagram is missing a radial segment or axis direction');
    }
  }
  if (id === 'right-triangle') {
    if (!/[\\/]/.test(primary) || !/\|/.test(primary) || !/-/.test(primary)) {
      issues.push('right triangle does not show three distinct sides');
    }
    if (!/90\s*(?:deg|gradi)?/i.test(primary)) {
      issues.push('right triangle does not label the exact right-angle corner as 90 deg');
    }
    if (lines.filter((line) => /-{3,}/.test(line)).length !== 1) {
      issues.push('right triangle should have one horizontal base, not an extra top/bottom edge');
    }
    if (!/\ba\b/.test(primary) || !/\bb\b/.test(primary) || !/\bc\b/.test(primary)) {
      issues.push('right triangle is missing an a, b, or c side label');
    }
  }
  if (id === 'number-line') {
    const openRow = lines.findIndex((line) => /o[-=]+o/.test(line));
    const closedRow = lines.findIndex((line) => /\*[-=]+\*/.test(line));
    if (openRow < 0 || closedRow < 0) {
      issues.push('number-line diagram needs separate o---o and *---* interval lines');
    } else {
      for (const [row, marker] of [[openRow, 'o'], [closedRow, '*']]) {
        const span = marker === 'o'
          ? /o[-=]+o/.exec(lines[row])
          : /\*[-=]+\*/.exec(lines[row]);
        const markerCols = span
          ? [span.index, span.index + span[0].length - 1]
          : [];
        const valueLine = lines[row + 1] || '';
        const left = valueLine.indexOf('-2');
        const rightMatch = /(?:^|\s)3(?:\s|$)/.exec(valueLine);
        const right = rightMatch ? rightMatch.index + rightMatch[0].indexOf('3') : -1;
        if (markerCols.length < 2 || left < 0 || right < 0 ||
            Math.abs(markerCols[0] - left) > 2 || Math.abs(markerCols.at(-1) - right) > 2) {
          issues.push(`${marker === 'o' ? 'open' : 'closed'} endpoint labels are not directly below their markers`);
        }
      }
    }
  }
  if (id === 'transformation') {
    if (!/input/i.test(primary) || !/output/i.test(primary) || !/error|errore/i.test(primary)) {
      issues.push('pipeline diagram is missing input, output, or error branch');
    }
    const returnMarks = locations(lines, /[\^<]/);
    if (!returnMarks.length) issues.push('pipeline error branch has no visible return arrowhead');
    const header = lines.find((line) => /input/i.test(line) && /validazione/i.test(line));
    if (header) {
      const validationCenter = header.toLowerCase().indexOf('validazione') + 'validazione'.length / 2;
      const returnArrows = locations(lines.slice(1), /\^/);
      if (!returnArrows.some((arrow) => Math.abs(arrow.col - validationCenter) <= 4)) {
        issues.push('pipeline retry arrowhead does not return to validazione');
      }
    }
  }
  if (id === 'hierarchy') {
    if ((primary.match(/[+|]/g) || []).length < 3) {
      issues.push('hierarchy does not contain enough visible connectors');
    }
    const labels = ['Animale', 'Mammifero', 'Uccello', 'Cane', 'Gatto'];
    for (const label of labels) {
      const count = (primary.match(new RegExp(`\\b${label}\\b`, 'g')) || []).length;
      if (count !== 1) issues.push(`${label} should appear exactly once, found ${count}`);
    }
    const rowFor = (label) => lines.findIndex((line) => new RegExp(`\\b${label}\\b`).test(line));
    const colFor = (label) => {
      const row = rowFor(label);
      return row >= 0 ? lines[row].indexOf(label) : -1;
    };
    const animalCol = colFor('Animale');
    const mammalCol = colFor('Mammifero');
    const birdCol = colFor('Uccello');
    const dogCol = colFor('Cane');
    const catCol = colFor('Gatto');
    if (animalCol < 0 || mammalCol <= animalCol || birdCol !== mammalCol ||
        dogCol <= mammalCol || catCol !== dogCol) {
      issues.push('hierarchy indentation does not encode root, sibling, and grandchild levels correctly');
    }
  }
  if (id === 'vector-projection') {
    if (!/90\s*(?:deg|gradi)?/i.test(primary) || !/[vV]/.test(primary)) {
      issues.push('vector projection must put 90 deg at the projection foot');
    }
    const origin = locations(lines, /O/).at(-1);
    const theta = locations(lines, /\btheta\b/i);
    if (!origin || !theta.some((angle) => {
      if (angle.row !== origin.row - 1 || angle.col <= origin.col || angle.col - origin.col > 6) return false;
      const localWedge = lines[angle.row]?.slice(origin.col + 1, angle.col + angle.text.length) || '';
      return /^\s{0,2}\/<\s*theta\b/i.test(localWedge);
    })) {
      issues.push('projection theta is not part of a local /<theta marker attached to O');
    }
  }
  if (id === 'parabola') {
    const origins = locations(lines, /O/);
    if (!/>/.test(primary) || !/\^/.test(primary) || !origins.length) {
      issues.push('parabola does not show both axes and the origin clearly');
    } else {
      const origin = origins[origins.length - 1];
      const verticalAxis = lines.slice(0, origin.row)
        .some((line) => line[origin.col] === '|' || line[origin.col] === '^');
      const horizontalAxis = /-{2,}.*>/.test(lines[origin.row]?.slice(origin.col + 1) || '') &&
        /-{2,}$/.test(lines[origin.row]?.slice(0, origin.col) || '');
      if (!verticalAxis || !horizontalAxis) {
        issues.push('the parabola vertex O is not the shared x/y axis intersection');
      }
      const leftBranch = locations(lines, /\\/).filter((mark) =>
        mark.row < origin.row && mark.col < origin.col);
      const rightBranch = locations(lines, /\//).filter((mark) =>
        mark.row < origin.row && mark.col > origin.col);
      const belowAxis = locations(lines, /[\\/*]/).filter((mark) => mark.row > origin.row);
      if (leftBranch.length < 2 || rightBranch.length < 2) {
        issues.push('y=x^2 needs symmetric left and right branches above O');
      }
      if (belowAxis.length) issues.push('y=x^2 incorrectly draws curve marks below the x axis');
    }
  }
  return { diagrams, issues };
}

let ownedServer = null;
let baseUrl = process.env.DSTUDIO_ASCII_BASE_URL || process.env.DSTUDIO_REAL_BASE_URL || 'http://127.0.0.1:28000';
baseUrl = normalizeBaseUrl(baseUrl);
try {
  let models;
  try {
    models = await jsonFetch(baseUrl, '/v1/models', { timeoutMs: 5000 });
  } catch {
    ownedServer = await startDStudio({ binaryArg: process.argv[2], label: 'dstudio-ascii-real' });
    baseUrl = ownedServer.baseUrl;
    await waitForModel(baseUrl);
    models = await jsonFetch(baseUrl, '/v1/models', { timeoutMs: 5000 });
  }
  const model = models?.data?.[0]?.id || 'ds4';
  const report = [];
  for (const testCase of cases) {
    const started = performance.now();
    const completion = await completeTextStream(baseUrl, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: testCase.prompt },
    ], {
      model,
      maxTokens: testMaxTokens,
      temperature: 0,
      thinkLevel: testThinkLevel,
      timeoutMs: Number(process.env.DSTUDIO_ASCII_TIMEOUT_MS || 900000),
    });
    const rawAnswer = completion.content;
    const answer = normalizeAssistantDiagramFences(rawAnswer);
    const result = evaluate(testCase.id, answer);
    const elapsedMs = Math.round(performance.now() - started);
    report.push({
      id: testCase.id,
      elapsedMs,
      reasoningChars: completion.reasoning.length,
      normalizedFenceTag: answer !== rawAnswer,
      issues: result.issues,
      answer,
      rawAnswer,
    });
    writeArtifact(artifacts, `${testCase.id}.md`, answer);
    console.log(`${testCase.id}: ${result.issues.length ? result.issues.join('; ') : 'ok'} (${elapsedMs} ms)`);
  }
  const mergedCases = [
    ...((previousReport?.cases || []).filter((old) => !report.some((item) => item.id === old.id))),
    ...report,
  ];
  writeArtifact(artifacts, 'report.json', {
    baseUrl, model, thinkLevel: testThinkLevel, maxTokens: testMaxTokens, cases: mergedCases,
  });
  const failed = report.filter((item) => item.issues.length);
  assert.equal(failed.length, 0, `ASCII diagram quality failures: ${failed.map((x) => `${x.id}: ${x.issues.join(', ')}`).join(' | ')}`);
  console.log('real_ascii_diagram_test: ok');
} finally {
  await ownedServer?.stop();
}
