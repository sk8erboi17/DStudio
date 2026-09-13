import assert from 'node:assert/strict';

export const ds41Model = Object.freeze({
  repository: 'antirez/deepseek-v4.1-flash-gguf',
  revision: 'dd8a266f7145edc19e2334b46e19b6821f221dc7',
  file: 'DeepSeek-V4.1-Flash-Q2.gguf',
  bytes: 365713686528,
  sha256: '1ce6a8f8806205c13330d7ca287bd198331dc5ca35ccc5d8a9a92a188a6f6f42',
});

// Freeze independent expected answers before the first model run. These are
// bounded instruction/extraction checks, not a general intelligence score or
// numerical comparison against another inference implementation.
export function ds41Tasks() {
  const records = Array.from({length: 128}, (_, i) => ({
    id: `Z${String(i + 1).padStart(3, '0')}`, amount: (i * 47 + 13) % 997,
    group: ['east', 'north', 'west', 'south'][i % 4],
  }));
  const csv = Array.from({length: 24}, (_, i) =>
    `part_${String(i + 1).padStart(2, '0')},${i * 11 + 9}`).join('\n');
  const integers = [54, -17, 8, 92, 8, 0, -63, 22, 41, -3, 17, 100, -17, 6, 72, 15,
    39, -24, 66, 5, 83, 19, -1, 31, 2, 47, -50, 28, 60, 11, 7, -9];
  return {
    gates: [
      {id: 'arithmetic', kind: 'text', prompt: 'What is 43 times 29? Reply only with the integer.', expected: '1247'},
      {id: 'python-trace', kind: 'text', prompt: 'What integer does this Python code print? Reply only with that integer.\nx = [2, 7, 4, 9, 6]\nprint(sum(v * v for v in x if v % 2 == 0))', expected: '56'},
      {id: 'utf8-copy', kind: 'text', prompt: 'Copy exactly the following text, without quotes or commentary: Perché già? Caffè, città e 日本語.', expected: 'Perché già? Caffè, città e 日本語.'},
      {id: 'missing-evidence', kind: 'json', prompt: 'Record: product = lantern; units = 7. No price is provided. Return ONLY JSON with product, units and price. Use null for missing fields. Do not estimate.', expected: {product: 'lantern', units: 7, price: null}},
      {id: 'conditional-count', kind: 'json', prompt: 'From [5, 12, 19, 24, 24, 31, 42], keep the even values above 20, preserving duplicates. Return ONLY a JSON array.', expected: [24, 24, 42]},
    ],
    workloads: [
      {id: 'exact-copy', label: 'Copia controllata di 24 righe', kind: 'text', prompt: 'Return exactly these 24 CSV lines, with no header, Markdown or commentary:\n' + csv, expected: csv},
      {id: 'numeric-order', label: 'Ordinamento di 32 numeri', kind: 'json', prompt: 'Sort these integers ascending, retaining every duplicate. Return ONLY a JSON array, no Markdown:\n' + JSON.stringify(integers), expected: [...integers].sort((a, b) => a - b)},
      {id: 'long-extraction', label: 'Ricerca esatta in 128 record', kind: 'json', prompt: 'Use only the records below. Extract Z009, Z077 and Z126, in that order. Return ONLY a JSON array of objects with id, amount and group. No explanation.\n' + records.map(r => `${r.id}; amount=${r.amount}; group=${r.group}`).join('\n'), expected: [records[8], records[76], records[125]]},
    ],
  };
}

export function checkDs41Answer(task, response) {
  const choice = response?.choices?.[0];
  assert.equal(choice?.finish_reason, 'stop', 'answer must finish without truncation');
  assert.equal(choice.message.tool_calls?.length ?? 0, 0, 'these tasks authorize no tools');
  assert.equal(typeof choice.message.content, 'string', 'missing answer text');
  const answer = choice.message.content.trim();
  if (task.kind === 'json') assert.deepEqual(JSON.parse(answer), task.expected);
  else assert.equal(answer, task.expected);
}

// Consume native startup diagnostics, not a requested preference. The initial
// cache allocation can subsequently be fitted down by V4.1 memory admission.
// Rounded GiB/MiB in the log are estimates; expert counts are exact.
export function ds41MemoryMode(log) {
  const lines = log.split(/\r?\n/);
  const initial = lines.filter(line => /ds4: SSD streaming initial metal model map/.test(line));
  const cacheLines = lines.filter(line => line.startsWith('ds4: metal SSD streaming cache target '));
  if (initial.length !== 1 || cacheLines.length !== 1) return null;
  const match = cacheLines[0].match(/^ds4: metal SSD streaming cache target ([0-9.]+) GiB; effective ([0-9.]+) GiB = ([0-9.]+) GiB prefill headroom \+ ([0-9.]+) GiB dynamic cache \((\d+) experts, ([0-9.]+) MiB each\)$/);
  if (!match) return null;
  const values = match.slice(1).map(Number);
  if (values.some(n => !Number.isFinite(n) || n < 0) || Boolean(values[4]) !== Boolean(values[5])) return null;
  const [targetGiB, initialTotalGiB, prefillHeadroomGiB, initialDynamicGiB, initialExperts, expertMiB] = values;
  let effectiveExperts = initialExperts;
  const fitting = [];
  for (const line of lines.filter(line => line.startsWith('ds4: V4.1 SSD cache fitted '))) {
    const fit = line.match(/^ds4: V4.1 SSD cache fitted from (\d+) to (\d+) experts for context\/runtime headroom$/);
    if (!fit || Number(fit[1]) !== effectiveExperts || !(Number(fit[2]) > 0) || Number(fit[2]) >= effectiveExperts)
      return null;
    effectiveExperts = Number(fit[2]); fitting.push(line);
  }
  return {expertStreaming: true, backend: 'Metal', targetGiB, initialTotalGiB,
    prefillHeadroomGiB, initialDynamicGiB, initialExperts, expertMiB, effectiveExperts,
    approximateDynamicGiB: fitting.length ? effectiveExperts * expertMiB / 1024 : initialDynamicGiB,
    evidence: [initial[0], cacheLines[0], ...fitting]};
}

export function ds41TextReport(report) {
  const rows = [...(report.gates ?? []), ...(report.runs ?? [])];
  const passed = rows.filter(r => r.status === 'pass').length;
  const failed = rows.filter(r => r.status === 'fail').length;
  const planned = report.plannedRequests ?? 14;
  const number = n => Number.isFinite(n) ? n.toFixed(2) : 'non disponibile';
  const lines = [
    'DStudio — DeepSeek V4.1 Flash Q2, prova reale con SSD streaming',
    `Stato: ${report.finishedAt ? (report.allCorrect ? 'COMPLETATO' : 'FALLITO / INCOMPLETO') : 'IN CORSO'}`,
    `Aggiornato: ${report.finishedAt ?? new Date().toISOString()}`,
    '',
    `Risposte verificate: ${passed}/${planned}. Fallite: ${failed}. Non completate: ${planned - passed - failed}.`,
    'Il controllo confronta risposte e dati esatti, non soltanto la presenza di testo.',
    'È una prova limitata di funzionamento, non un voto generale al modello.',
    '',
    `Mac: ${report.host?.cpu ?? 'non rilevato'}; RAM ${number((report.host?.memoryBytes ?? NaN) / 1024 ** 3)} GiB.`,
    `Avvio del motore fino alla prima disponibilità HTTP: ${number(report.loadSeconds)} secondi.`,
    `Contesto configurato: ${report.contextTokens ?? 'non disponibile'} token (capacità, non lunghezza dei prompt).`,
    `Budget SSD richiesto (cache e spazio di prefill): ${report.expertCacheGiB ?? 'non disponibile'} GiB.`,
    `Streaming degli esperti confermato dal motore: ${report.runtimeMemory?.expertStreaming ? 'SÌ, Metal' : 'NON ANCORA CONFERMATO'}.`,
    `Cache dinamica effettiva: circa ${number(report.runtimeMemory?.approximateDynamicGiB)} GiB, ${report.runtimeMemory?.effectiveExperts ?? 'n/d'} esperti; spazio di prefill ${number(report.runtimeMemory?.prefillHeadroomGiB)} GiB.`,
    'Engram resta su disco per progetto del modello; è distinto dallo streaming degli esperti.',
    'La configurazione effettiva e le eventuali riduzioni di cache sono conservate nel log del motore.',
    '',
    'PRESTAZIONI',
    'Prefill = lettura dei token di input realmente elaborati. Decode = generazione dei token di risposta.',
    'Entrambi escludono il download; il decode esclude anche caricamento e prefill.',
    'Tre ripetizioni per attività, stesso processo, cache esperti calda; nessuna cache KV su disco.',
    'Il prefisso della richiesta cambia a ogni ripetizione per non riusare un intero prompt già elaborato.',
  ];
  if (!report.allCorrect) lines.push('Nessuna velocità qualificata finché tutti i controlli previsti non passano. Le misure grezze restano nei risultati JSON.');
  else for (const [id, summary] of Object.entries(report.summary ?? {})) {
    const label = report.cases?.workloads.find(t => t.id === id)?.label ?? id;
    lines.push('', label + ':');
    for (const [key, title] of [['prefill', 'Lettura'], ['decode', 'Generazione']]) {
      const s = summary[key];
      lines.push(`  ${title}: mediana ${number(s?.median)} token/s; intervallo ${number(s?.min)}–${number(s?.max)} token/s (3 prove).`);
    }
    for (const row of report.runs.filter(r => r.id === id))
      lines.push(`  Prova ${row.repeat}: input elaborato ${row.prefillTokens ?? 'n/d'} token in ${number(row.prefillSeconds)} s; output ${row.tokens ?? 'n/d'} token in ${number(row.decodeSeconds)} s; attesa totale ${number(row.wallSeconds)} s.`);
  }
  lines.push('', 'LIMITI E PROVENIENZA',
    'Altri programmi sono rimasti aperti. Nessun limite di memoria di macOS è stato modificato.',
    'Questi risultati descrivono questo Mac sotto il carico registrato, non un picco ideale né un confronto prima/dopo.',
    'Nessuna estensione dei risultati a CUDA, ROCm, M5, altri modelli o quantizzazioni.',
    `Engine: antirez/ds4 @ ${report.commit ?? 'non rilevato'}.`,
    `Modello: ${ds41Model.repository} @ ${ds41Model.revision}.`,
    `SHA-256 completo verificato: ${report.model?.verifiedSha256 ?? 'NON ANCORA VERIFICATO'}.`,
    `Prove e risposte: ${report.evidence ?? 'non disponibile'}.`);
  if (report.error) lines.push(`Errore: ${report.error}`);
  return lines.join('\n') + '\n';
}
