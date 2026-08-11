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
  startMode,
  waitForModel,
  writeArtifact,
} from './real_harness.mjs';

const artifacts = artifactDir('math-explanations-real');
const resume = process.env.DSTUDIO_MATH_RESUME === '1';
let resumedCases = [];
let resumedMetadata = {};
if (resume) {
  try {
    resumedMetadata = JSON.parse(fs.readFileSync(path.join(artifacts, 'report.partial.json'), 'utf8'));
    resumedCases = resumedMetadata.cases || [];
  } catch {}
} else {
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
  'Keep this stress-test answer focused and within 220 words.',
].join('\n\n');

const diagramTopics = [
  ['complex-plane', 'la rappresentazione di un numero complesso sul piano di Argand e la forma polare', 'assi Re/Im, origine, punto, proiezioni, modulo e angolo'],
  ['pythagoras', 'il teorema di Pitagora', 'un triangolo rettangolo con cateti, ipotenusa e angolo retto'],
  ['intervals', 'la differenza fra intervalli aperti, chiusi e semiaperti', 'una retta numerica con estremi inclusi ed esclusi'],
  ['parabola', 'perche il grafico di una funzione quadratica e una parabola', 'assi, vertice e due rami simmetrici'],
  ['projection', 'la proiezione ortogonale di un vettore su una retta', 'vettore, retta, piede e angolo retto'],
  ['unit-circle', 'come il cerchio unitario definisce seno e coseno', 'assi, raggio, punto e proiezioni'],
  ['tangent', 'il significato geometrico della derivata come retta tangente', 'curva, punto di tangenza e retta tangente'],
  ['integral-area', 'il significato dell integrale definito come area firmata', 'assi, curva e regioni sopra e sotto l asse'],
  ['line-slope', 'come il coefficiente angolare misura la pendenza di una retta', 'assi, retta e triangolo incremento verticale/orizzontale'],
  ['similar-triangles', 'perche triangoli simili hanno lati proporzionali', 'due triangoli etichettati e angoli corrispondenti'],
  ['thales', 'il teorema di Talete nelle rette parallele tagliate da trasversali', 'parallele, trasversali e segmenti corrispondenti'],
  ['vector-sum', 'la somma di due vettori con la regola del parallelogramma', 'origine, due vettori e diagonale risultante'],
  ['linear-map', 'come una trasformazione lineare modifica una base del piano', 'assi e vettori di base prima e dopo la trasformazione'],
  ['composition', 'la composizione di funzioni come applicazione in sequenza', 'un flusso da x attraverso f e g fino al risultato'],
  ['set-relations', 'unione, intersezione e differenza fra due insiemi', 'due regioni sovrapposte con parti chiaramente etichettate'],
  ['absolute-value', 'il valore assoluto come distanza da zero', 'una retta numerica con punti simmetrici'],
  ['asymptote', 'che cosa sono gli asintoti verticali e orizzontali', 'assi, curva e asintoti distinti'],
  ['piecewise', 'come leggere una funzione definita a tratti', 'assi con due tratti e punti pieni o vuoti agli estremi'],
  ['secant-limit', 'come una secante tende alla tangente nella definizione di derivata', 'curva, due punti, secante e posizione limite'],
  ['polar-area', 'perche l area in coordinate polari contiene il fattore un mezzo r quadro', 'settore, due raggi e piccolo angolo'],
];

const formulaTopics = [
  ['linear-equation', 'come si risolve un equazione lineare e perche le operazioni sui due membri conservano le soluzioni'],
  ['quadratic-formula', 'come si ricava la formula risolutiva dell equazione di secondo grado completando il quadrato'],
  ['factorization', 'la differenza tra raccoglimento, differenza di quadrati e scomposizione di un trinomio'],
  ['fractions', 'perche per sommare frazioni serve un denominatore comune'],
  ['exponents', 'perche nel prodotto di potenze con la stessa base si sommano gli esponenti'],
  ['logarithms', 'perche il logaritmo trasforma prodotti in somme'],
  ['induction', 'come funziona una dimostrazione per induzione e perche servono base e passo'],
  ['contradiction', 'come funziona una dimostrazione per assurdo'],
  ['contrapositive', 'la differenza logica tra implicazione, inversa e contronominale'],
  ['limit', 'il significato della definizione epsilon-delta di limite'],
  ['chain-rule', 'perche la derivata di una funzione composta segue la regola della catena'],
  ['product-rule', 'come si ricava la regola di derivazione del prodotto'],
  ['fundamental-theorem', 'il legame tra derivata e integrale nel teorema fondamentale del calcolo'],
  ['integration-parts', 'perche la formula di integrazione per parti deriva dalla regola del prodotto'],
  ['geometric-series', 'quando converge una serie geometrica e come si trova la sua somma'],
  ['taylor', 'come un polinomio di Taylor approssima localmente una funzione'],
  ['conditional-probability', 'la probabilita condizionata e il significato della formula di Bayes'],
  ['expected-value', 'il valore atteso come media pesata e perche e lineare'],
  ['variance', 'la varianza e la relazione tra varianza, secondo momento e media'],
  ['binomial', 'perche la distribuzione binomiale contiene il coefficiente binomiale'],
  ['normal', 'che cosa rappresentano media e deviazione standard in una distribuzione normale'],
  ['determinant', 'il determinante come fattore di scala orientato di una trasformazione lineare'],
  ['eigenvectors', 'il significato di autovalori e autovettori'],
  ['matrix-product', 'perche il prodotto tra matrici rappresenta la composizione di trasformazioni lineari'],
  ['linear-independence', 'la differenza tra generatori, indipendenza lineare e base'],
  ['modular-arithmetic', 'come funziona l aritmetica modulare e perche si possono sommare le congruenze'],
  ['gcd-euclid', 'perche l algoritmo di Euclide calcola il massimo comune divisore'],
  ['countability', 'la differenza tra insieme numerabile e non numerabile'],
  ['bayes-vs-likelihood', 'la differenza tra probabilita, verosimiglianza e distribuzione a posteriori'],
  ['lagrange', 'come i moltiplicatori di Lagrange esprimono il vincolo tramite gradienti paralleli'],
];

const cases = [];
for (const [id, topic, diagram] of diagramTopics) {
  cases.push({
    id: `${id}-intuition`,
    expectsDiagram: true,
    prompt: `Spiega in italiano ${topic}. Integra nella spiegazione un solo diagramma ASCII compatto che mostri ${diagram}, poi spiegami come leggerlo.`,
  });
  cases.push({
    id: `${id}-example`,
    expectsDiagram: true,
    prompt: `Fammi capire ${topic} con un piccolo esempio numerico. Usa un solo diagramma ASCII essenziale per mostrare ${diagram}; formule esatte in LaTeX e nessun disegno decorativo.`,
  });
}
for (const [id, topic] of formulaTopics) {
  cases.push({
    id: `${id}-intuition`,
    expectsDiagram: false,
    prompt: `Spiega in italiano ${topic}, partendo dall intuizione e arrivando alla notazione precisa con un esempio breve. Non forzare un diagramma se formule e prosa sono piu chiare.`,
  });
  cases.push({
    id: `${id}-worked`,
    expectsDiagram: false,
    prompt: `Insegnami in italiano ${topic} mediante un esempio svolto passo per passo e segnala un errore comune. Usa ASCII art soltanto se aggiunge davvero informazione spaziale.`,
  });
}
assert.equal(cases.length, 100, 'the stress suite must contain exactly 100 questions');

function fencedBlocks(text) {
  return [...String(text || '').matchAll(/```([^\n`]*)\n([\s\S]*?)```/g)].map((match) => ({
    lang: match[1].trim().toLowerCase(),
    body: match[2].replace(/\n$/, ''),
  }));
}

function looksLikeAsciiDiagram(block) {
  if (block.lang && !['text', 'ascii', 'ascii-art', 'asciiart', 'diagram'].includes(block.lang)) return false;
  const drawingLines = block.body.split('\n').filter((line) => {
    const glyphs = line.match(/[-+*/\\|<>^]/g) || [];
    return glyphs.length >= 2;
  });
  return drawingLines.length >= 1 && drawingLines.join('').match(/[-+*/\\|<>^]/g)?.length >= 4;
}

function normalizedTokens(text) {
  return String(text || '').toLowerCase().match(/[\p{L}\p{N}]+|[-+*/\\|<>^=]{1,}/gu) || [];
}

function consecutiveTokenLoop(tokens) {
  for (let width = 10; width <= Math.min(80, Math.floor(tokens.length / 3)); width++) {
    for (let start = Math.max(0, tokens.length - width * 5); start + width * 3 <= tokens.length; start++) {
      const unit = tokens.slice(start, start + width).join('\u0001');
      let repeats = 1;
      while (start + width * (repeats + 1) <= tokens.length &&
             tokens.slice(start + width * repeats, start + width * (repeats + 1)).join('\u0001') === unit) {
        repeats++;
      }
      if (repeats >= 3) return { start, width, repeats, sample: tokens.slice(start, start + width).join(' ') };
    }
  }
  return null;
}

function consecutiveLineLoop(text) {
  const lines = String(text || '').split('\n').map((line) => line.trimEnd());
  for (let width = 1; width <= 8; width++) {
    for (let start = 0; start + width * 3 <= lines.length; start++) {
      const unit = lines.slice(start, start + width).join('\n');
      if (unit.replace(/\s/g, '').length < 24) continue;
      let repeats = 1;
      while (start + width * (repeats + 1) <= lines.length &&
             lines.slice(start + width * repeats, start + width * (repeats + 1)).join('\n') === unit) {
        repeats++;
      }
      if (repeats >= 3) return { start, width, repeats, sample: unit.slice(0, 240) };
    }
  }
  return null;
}

function analyze(testCase, completion) {
  const answer = completion.content || '';
  const blocks = fencedBlocks(answer);
  const asciiBlocks = blocks.filter(looksLikeAsciiDiagram);
  const tokenLoop = consecutiveTokenLoop(normalizedTokens(answer));
  const lineLoop = consecutiveLineLoop(answer);
  const issues = [];
  if (!answer.trim()) issues.push('empty answer');
  if (tokenLoop) issues.push(`repeated token cycle (${tokenLoop.width} tokens x${tokenLoop.repeats})`);
  if (lineLoop) issues.push(`repeated line cycle (${lineLoop.width} lines x${lineLoop.repeats})`);
  if (asciiBlocks.length > 2) issues.push(`runaway diagrams (${asciiBlocks.length} ASCII blocks)`);
  if (asciiBlocks.some((block) => block.body.split('\n').length > 32)) issues.push('runaway diagram height (>32 lines)');
  if (testCase.expectsDiagram && asciiBlocks.length === 0) issues.push('requested useful diagram missing');
  if (completion.finishReason === 'length' && (tokenLoop || lineLoop || asciiBlocks.length > 2)) {
    issues.push('generation hit max_tokens while looping');
  }
  return { issues, blocks, asciiBlocks, tokenLoop, lineLoop };
}

function reanalyzeCases(savedCases) {
  const report = new Array(cases.length);
  for (const item of savedCases) {
    const index = Number(item?.index) - 1;
    if (index < 0 || index >= cases.length || item.id !== cases[index].id) continue;
    const analysis = analyze(cases[index], { content: item.answer || '' });
    report[index] = {
      ...item,
      asciiBlocks: analysis.asciiBlocks.length,
      issues: analysis.issues,
      tokenLoop: analysis.tokenLoop,
      lineLoop: analysis.lineLoop,
    };
  }
  return report;
}

function summarize(report) {
  const failed = report.filter((item) => item.issues.length);
  return {
    total: report.length,
    passed: report.length - failed.length,
    failed: failed.length,
    looped: report.filter((item) => item.tokenLoop || item.lineLoop).length,
    requestedDiagramCases: report.filter((item) => item.expectsDiagram).length,
    requestedDiagramPresent: report.filter((item) => item.expectsDiagram && item.asciiBlocks > 0).length,
    unexpectedLengthStops: report.filter((item) => item.finishReason === 'length').length,
  };
}

const resumedReport = reanalyzeCases(resumedCases);
if (resume && resumedReport.filter(Boolean).length === cases.length) {
  const report = resumedReport;
  const failed = report.filter((item) => item.issues.length);
  const summary = summarize(report);
  const metadata = {
    baseUrl: resumedMetadata.baseUrl,
    model: resumedMetadata.model,
    maxTokens: resumedMetadata.maxTokens,
    thinkLevel: resumedMetadata.thinkLevel,
    temperature: resumedMetadata.temperature,
    concurrency: resumedMetadata.concurrency,
    ssdStreaming: resumedMetadata.ssdStreaming,
  };
  writeArtifact(artifacts, 'report.partial.json', { ...metadata, completed: report.length, cases: report });
  writeArtifact(artifacts, 'report.json', { ...metadata, summary, cases: report });
  console.log(JSON.stringify(summary));
  assert.equal(failed.length, 0, `math explanation failures: ${failed.map((item) => `${item.id}: ${item.issues.join(', ')}`).join(' | ')}`);
  console.log('real_math_explanation_stress_test: ok (reanalyzed checkpoint)');
  process.exit(0);
}

let ownedServer = null;
let baseUrl = normalizeBaseUrl(process.env.DSTUDIO_MATH_BASE_URL || process.env.DSTUDIO_REAL_BASE_URL || 'http://127.0.0.1:28000');
const maxTokens = Number(process.env.DSTUDIO_MATH_MAX_TOKENS || 520);
const thinkLevel = process.env.DSTUDIO_MATH_THINK_LEVEL || 'off';
const temperature = Number(process.env.DSTUDIO_MATH_TEMPERATURE || 0.7);
const concurrency = Math.max(1, Math.min(8, Number(process.env.DSTUDIO_MATH_CONCURRENCY || 1)));
const ssdStreaming = process.env.DSTUDIO_MATH_SSD_STREAMING || 'off';
try {
  let models;
  try {
    models = await jsonFetch(baseUrl, '/v1/models', { timeoutMs: 5000 });
  } catch {
    ownedServer = await startDStudio({
      binaryArg: process.argv[2], label: 'dstudio-math-real', isolatedEnginePort: true,
    });
    baseUrl = ownedServer.baseUrl;
    const gguf = ownedServer.ggufs.find((entry) =>
      /DeepSeek-V4-Flash-IQ2XXS-w2Q2K.*chat-v2.*0731/i.test(entry.file));
    if (!gguf) throw new Error('The DeepSeek V4 Flash Q2 GGUF is required for this stress test.');
    await startMode(baseUrl, {
      mode: 'server', model: 'uncensored', variant: 'flash', gguf: gguf.file,
      port: ownedServer.enginePort, ctx: 4096, kvSpaceMb: 256, kvMinTokens: 128,
      power: 90, think: 'high', ssdStreaming,
    }, Number(process.env.DSTUDIO_REAL_TEST_TIMEOUT_MS || 1_800_000));
    await waitForModel(baseUrl);
    models = await jsonFetch(baseUrl, '/v1/models', { timeoutMs: 5000 });
    baseUrl = `http://127.0.0.1:${ownedServer.enginePort}`;
  }
  const model = models?.data?.[0]?.id || 'ds4';
  const report = resumedReport;
  const pendingIndexes = cases.map((_, index) => index).filter((index) => !report[index]);
  let nextIndex = 0;
  let completedCount = cases.length - pendingIndexes.length;
  if (completedCount) console.log(`Resuming after ${completedCount}/100 completed cases.`);
  async function runCase(index) {
    const testCase = cases[index];
    const started = performance.now();
    let lastProgressAt = 0;
    const completion = await completeTextStream(baseUrl, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: testCase.prompt },
    ], {
      model,
      maxTokens,
      temperature,
      thinkLevel,
      timeoutMs: Number(process.env.DSTUDIO_MATH_TIMEOUT_MS || 900000),
      onProgress: ({ content, reasoning }) => {
        const now = Date.now();
        if (now - lastProgressAt > 30_000) {
          lastProgressAt = now;
          console.log(`[${index + 1}/100] ${testCase.id}: generating (${content.length} answer chars, ${reasoning.length} reasoning chars)`);
        }
      },
    });
    const analysis = analyze(testCase, completion);
    const elapsedMs = Math.round(performance.now() - started);
    const item = {
      index: index + 1,
      id: testCase.id,
      prompt: testCase.prompt,
      expectsDiagram: testCase.expectsDiagram,
      elapsedMs,
      finishReason: completion.finishReason,
      completionTokens: completion.usage?.completion_tokens ?? null,
      reasoningChars: completion.reasoning.length,
      answerChars: completion.content.length,
      asciiBlocks: analysis.asciiBlocks.length,
      issues: analysis.issues,
      tokenLoop: analysis.tokenLoop,
      lineLoop: analysis.lineLoop,
      answer: completion.content,
      reasoning: completion.reasoning,
    };
    report[index] = item;
    completedCount++;
    writeArtifact(artifacts, `${String(index + 1).padStart(3, '0')}-${testCase.id}.md`, completion.content);
    const completedCases = report.filter(Boolean);
    writeArtifact(artifacts, 'report.partial.json', {
      baseUrl, model, maxTokens, thinkLevel, temperature, concurrency, ssdStreaming,
      completed: completedCount, cases: completedCases,
    });
    console.log(`[${index + 1}/100] ${testCase.id}: ${analysis.issues.length ? analysis.issues.join('; ') : 'ok'} (${elapsedMs} ms, finish=${completion.finishReason || 'unknown'})`);
  }
  async function worker() {
    for (;;) {
      const index = pendingIndexes[nextIndex++];
      if (index === undefined) return;
      await runCase(index);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const failed = report.filter((item) => item.issues.length);
  const summary = summarize(report);
  writeArtifact(artifacts, 'report.json', {
    baseUrl, model, maxTokens, thinkLevel, temperature, concurrency, ssdStreaming, summary, cases: report,
  });
  console.log(JSON.stringify(summary));
  assert.equal(failed.length, 0, `math explanation failures: ${failed.map((item) => `${item.id}: ${item.issues.join(', ')}`).join(' | ')}`);
  console.log('real_math_explanation_stress_test: ok');
} finally {
  await ownedServer?.stop();
}
