// Fixed content of the public vision corpus (see vision_corpus_build.mjs).
// Every organisation, person, place, code and figure below is invented for
// this corpus. Expected answers follow from this data alone: no model wrote
// or checked them. Totals that a question depends on are recomputed here and
// the build fails if the written figure differs.
import assert from 'node:assert/strict';

// Used only inside rasters; the build refuses to run without them.
export const SYSTEM_FONTS = ['Bradley Hand', 'Noteworthy', 'Chalkduster', 'Papyrus', 'American Typewriter', 'Snell Roundhand'];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sum = (list) => list.reduce((a, b) => a + b, 0);

// ---- questions ----------------------------------------------------------
const exact = (value) => ({ type: 'exact', value });
const num = (value, extra = {}) => ({ type: 'number', value, ...extra });
const oneOf = (...value) => ({ type: 'one-of', value });
const allOf = (...value) => ({ type: 'all-of', value });
const NA = { type: 'unanswerable' };
// PDF facts: in the text layer of a physical page, or only in its pixels.
const text = (page, fact, ...also) => ({ page, pixelOnly: false, fact, ...(also.length ? { also } : {}) });
const pixel = (page, fact, ...also) => ({ page, pixelOnly: true, fact, ...(also.length ? { also } : {}) });
// Image facts: always pixels. `shown` is for one image, `shownIn` for a set.
const shown = (fact, ...also) => ({ pixelOnly: true, fact, ...(also.length ? { also } : {}) });
const shownIn = (image, fact, ...also) => ({ image, pixelOnly: true, fact, ...(also.length ? { also } : {}) });
const visual = (evidence, description) => ({ ...evidence, visual: description });
const missing = (statement, absentTerms) => ({ pixelOnly: false, fact: null, missing: statement, ...(absentTerms ? { absentTerms } : {}) });
const ask = (prompt, expected, evidence, ...tags) => ({ prompt, ...(tags.length ? { tags } : {}), expected, evidence });

// ---- page pieces ----------------------------------------------------------
const P = (...lines) => lines.map((line) => `<p>${esc(line)}</p>`).join('');
const sheet = (org, title, html, foot) => `<div class="org">${esc(org)}</div><h1>${esc(title)}</h1>${html}${foot ? `<div class="foot">${esc(foot)}</div>` : ''}`;
const n = (t) => ({ t, n: true });
function table(head, rows, style = '') {
  const cell = (c, tag) => {
    const o = c !== null && typeof c === 'object' ? c : { t: c };
    return `<${tag}${o.rowspan ? ` rowspan="${o.rowspan}"` : ''}${o.colspan ? ` colspan="${o.colspan}"` : ''}${o.n ? ' class="n"' : ''}${o.b ? ' style="font-weight:600"' : ''}>${esc(o.t)}</${tag}>`;
  };
  return `<table style="${style}">${head ? `<tr>${head.map((c) => cell(c, 'th')).join('')}</tr>` : ''}${rows.map((row) => `<tr>${row.map((c) => cell(c, 'td')).join('')}</tr>`).join('')}</table>`;
}
const hand = (s, size = 20, font = 'Bradley Hand') => `<span style="font-family:'${font}';font-size:${size}pt;line-height:1.25">${esc(s)}</span>`;
// Content laid out for w x h, shown turned clockwise inside the rotated canvas.
function rotated(html, w, h, degrees) {
  const move = { 90: `translateX(${h}px) rotate(90deg)`, 180: `translate(${w}px,${h}px) rotate(180deg)`, 270: `translateY(${w}px) rotate(-90deg)` }[degrees];
  return `<div style="position:absolute;left:0;top:0;width:${w}px;height:${h}px;transform-origin:top left;transform:${move}">${html}</div>`;
}

// ---- drawings (SVG; always rasterised before they reach a file) -----------
const svg = (w, h, body, background = '#fff') => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block"><rect width="${w}" height="${h}" fill="${background}"/>${body}</svg>`;
const T = (x, y, s, { size = 13, anchor = 'start', weight = 400, fill = '#111', extra = '' } = {}) => `<text x="${x}" y="${y}" font-size="${size}" text-anchor="${anchor}" font-weight="${weight}" fill="${fill}" ${extra}>${esc(s)}</text>`;

function barChart({ title, labels, values, yMax, yStep, width = 640, height = 380, color = '#3b6ea5', showValues = true, note = '' }) {
  const m = { l: 58, r: 18, t: 48, b: note ? 62 : 44 };
  const pw = width - m.l - m.r, ph = height - m.t - m.b, band = pw / labels.length;
  const y = (v) => m.t + ph - (v / yMax) * ph;
  let s = T(m.l, 27, title, { size: 16, weight: 600 });
  for (let v = 0; v <= yMax; v += yStep) s += `<line x1="${m.l}" x2="${width - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="${v ? '#cfcfcf' : '#333'}"/>${T(m.l - 8, y(v) + 4, v, { size: 12, anchor: 'end' })}`;
  labels.forEach((label, i) => {
    const x = m.l + band * i + band * 0.2, w = band * 0.6;
    s += `<rect x="${x}" y="${y(values[i])}" width="${w}" height="${y(0) - y(values[i])}" fill="${Array.isArray(color) ? color[i] : color}"/>`;
    if (showValues) s += T(x + w / 2, y(values[i]) - 6, values[i], { size: 13, anchor: 'middle', weight: 600 });
    s += T(x + w / 2, y(0) + 18, label, { size: 13, anchor: 'middle' });
  });
  if (note) s += T(m.l, height - 12, note, { size: 11, fill: '#444' });
  return svg(width, height, s);
}

function hbarChart({ title, labels, values, xMax, xStep, unit, width = 640, height = 300, color = '#4f9d69' }) {
  const m = { l: 150, r: 60, t: 48, b: 36 };
  const pw = width - m.l - m.r, ph = height - m.t - m.b, band = ph / labels.length;
  const x = (v) => m.l + (v / xMax) * pw;
  let s = T(18, 27, title, { size: 16, weight: 600 });
  for (let v = 0; v <= xMax; v += xStep) s += `<line x1="${x(v)}" x2="${x(v)}" y1="${m.t}" y2="${m.t + ph}" stroke="${v ? '#cfcfcf' : '#333'}"/>${T(x(v), m.t + ph + 16, v, { size: 12, anchor: 'middle' })}`;
  labels.forEach((label, i) => {
    const y = m.t + band * i + band * 0.22, h = band * 0.56;
    s += `<rect x="${m.l}" y="${y}" width="${x(values[i]) - m.l}" height="${h}" fill="${color}"/>`;
    s += T(m.l - 10, y + h / 2 + 5, label, { size: 13, anchor: 'end' }) + T(x(values[i]) + 8, y + h / 2 + 5, `${values[i]} ${unit}`, { size: 13, weight: 600 });
  });
  return svg(width, height, s);
}

function lineChart({ title, labels, series, yMin, yMax, yStep, width = 640, height = 380, legend = false }) {
  const m = { l: 58, r: 26, t: legend ? 72 : 48, b: 44 };
  const pw = width - m.l - m.r, ph = height - m.t - m.b, step = pw / (labels.length - 1);
  const y = (v) => m.t + ph - ((v - yMin) / (yMax - yMin)) * ph, x = (i) => m.l + step * i;
  let s = T(m.l, 27, title, { size: 16, weight: 600 });
  for (let v = yMin; v <= yMax; v += yStep) s += `<line x1="${m.l}" x2="${width - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="${v === yMin ? '#333' : '#cfcfcf'}"/>${T(m.l - 8, y(v) + 4, v, { size: 12, anchor: 'end' })}`;
  labels.forEach((label, i) => { s += T(x(i), m.t + ph + 18, label, { size: 13, anchor: 'middle' }); });
  series.forEach((line, k) => {
    s += `<polyline fill="none" stroke="${line.color}" stroke-width="2.5" points="${line.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')}"/>`;
    line.values.forEach((v, i) => { s += `<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="${line.color}"/>${T(x(i), y(v) + (line.below ? 20 : -10), v, { size: 13, anchor: 'middle', weight: 600 })}`; });
    if (legend) s += `<line x1="${m.l + k * 220}" x2="${m.l + k * 220 + 28}" y1="50" y2="50" stroke="${line.color}" stroke-width="3"/>${T(m.l + k * 220 + 36, 54, line.name, { size: 13 })}`;
  });
  return svg(width, height, s);
}

function pieChart({ title, slices, width = 640, height = 380 }) {
  assert.equal(sum(slices.map((slice) => slice.value)), 100, `${title}: slices must add up to 100`);
  const cx = 200, cy = height / 2 + 16, r = Math.min(150, height / 2 - 40);
  let s = T(24, 27, title, { size: 16, weight: 600 }), start = -Math.PI / 2;
  slices.forEach((slice, i) => {
    const end = start + (slice.value / 100) * 2 * Math.PI;
    const at = (a, d) => `${(cx + Math.cos(a) * d).toFixed(2)} ${(cy + Math.sin(a) * d).toFixed(2)}`;
    s += `<path d="M ${cx} ${cy} L ${at(start, r)} A ${r} ${r} 0 ${end - start > Math.PI ? 1 : 0} 1 ${at(end, r)} Z" fill="${slice.color}" stroke="#fff" stroke-width="2"/>`;
    s += `<rect x="400" y="${92 + i * 34}" width="18" height="18" fill="${slice.color}"/>${T(428, 107 + i * 34, `${slice.name} ${slice.value}%`, { size: 15 })}`;
    start = end;
  });
  return svg(width, height, s);
}

// Flowchart: boxes are { id, x, y, w, h, kind, text } with x/y at the centre.
function flowchart({ width, height, title, nodes, edges }) {
  const by = Object.fromEntries(nodes.map((node) => [node.id, node]));
  const side = (id, where) => { const b = by[id]; return { top: [b.x, b.y - b.h / 2], bottom: [b.x, b.y + b.h / 2], left: [b.x - b.w / 2, b.y], right: [b.x + b.w / 2, b.y] }[where]; };
  let s = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#222"/></marker></defs>`;
  if (title) s += T(20, 26, title, { size: 16, weight: 600 });
  for (const edge of edges) {
    const points = [side(edge.from[0], edge.from[1]), ...(edge.via || []), side(edge.to[0], edge.to[1])];
    s += `<polyline fill="none" stroke="#222" stroke-width="1.6" marker-end="url(#arrow)" points="${points.map((p) => p.join(',')).join(' ')}"/>`;
    if (edge.label) s += T((points[0][0] + points[1][0]) / 2 + (points[0][0] === points[1][0] ? 10 : 0), (points[0][1] + points[1][1]) / 2 + (points[0][0] === points[1][0] ? 4 : -8), edge.label, { size: 13, weight: 600, anchor: points[0][0] === points[1][0] ? 'start' : 'middle' });
  }
  for (const b of nodes) {
    if (b.kind === 'decision') s += `<polygon points="${b.x},${b.y - b.h / 2} ${b.x + b.w / 2},${b.y} ${b.x},${b.y + b.h / 2} ${b.x - b.w / 2},${b.y}" fill="#fff6d8" stroke="#222" stroke-width="1.6"/>`;
    else s += `<rect x="${b.x - b.w / 2}" y="${b.y - b.h / 2}" width="${b.w}" height="${b.h}" rx="${b.kind === 'end' ? b.h / 2 : 4}" fill="${b.kind === 'end' ? '#dfeee3' : '#e6eef8'}" stroke="#222" stroke-width="1.6"/>`;
    s += T(b.x, b.y + 5, b.text, { size: 14, anchor: 'middle' });
  }
  return svg(width, height, s);
}

// Rooms are [name, area, x, y, w, h]; marks are extra SVG.
function floorPlan({ width, height, title, rooms, marks = '', unit = 'm²' }) {
  let s = title ? T(20, 24, title, { size: 15, weight: 600 }) : '';
  for (const [name, area, x, y, w, h] of rooms) {
    s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#fafafa" stroke="#222" stroke-width="3"/>`;
    s += T(x + w / 2, y + h / 2 - 2, name, { size: 15, anchor: 'middle', weight: 600 }) + T(x + w / 2, y + h / 2 + 18, `${area} ${unit}`, { size: 14, anchor: 'middle' });
  }
  return svg(width, height, s + marks);
}

// ---- the PDFs -------------------------------------------------------------
function pdfItems() {
  const items = [];

  items.push({
    id: 'p01-marina-notice', kind: 'pdf', language: 'en', size: 'Letter', categories: [],
    pages: async () => [{ body: sheet('Tidewell Marina Cooperative · Harbour Office', 'Notice 14/B to berth holders', P(
      'From 3 March the seasonal berth fee for boats up to eight metres is 412 EUR per quarter.',
      'The fuel pontoon opens at 06:30 and closes at 19:45.',
      'Winter storage requests must reach the office by 17 October.',
      'Radio channel 9 is monitored during opening hours.',
      'Harbour master: Ansel Brightwater. Deputy: Marenka Dolvich.')) }],
    questions: [
      ask('What is the seasonal berth fee per quarter for boats up to eight metres, in EUR?', num(412), text(1, '412 EUR per quarter')),
      ask('At what time does the fuel pontoon close?', exact('19:45'), text(1, 'closes at 19:45')),
      ask('Who is the deputy harbour master?', exact('Marenka Dolvich'), text(1, 'Deputy: Marenka Dolvich')),
      ask('What is the seasonal berth fee for boats longer than twelve metres?', NA, missing('Only the fee for boats up to eight metres is stated.', ['twelve'])),
    ],
  });

  items.push({
    id: 'p02-verbale-orti', kind: 'pdf', language: 'it', categories: [],
    pages: async () => [
      { body: sheet('Associazione Orti di Via Ginepro', "Verbale dell'assemblea ordinaria", P(
        "L'assemblea si è riunita il 9 aprile alle ore 18:30 presso la sala del circolo.",
        'Presenti 23 soci su 41 iscritti. Presiede Ilda Verrocchi; verbalizza Oreste Calmieri.',
        'Punto 1 — Bilancio consuntivo: approvato con 19 voti favorevoli, 3 contrari e 1 astenuto.',
        'Punto 2 — Quota annuale: confermata a 35 euro.'), 'Verbale · foglio 1') },
      { body: sheet('Associazione Orti di Via Ginepro', 'Verbale — seguito', P(
        "Punto 3 — Nuova cisterna per l'acqua piovana da 2.500 litri: spesa prevista 1.840 euro, approvata all'unanimità.",
        'Punto 4 — Turni di apertura del cancello: lotto 12 assegnato a Fosca Brentani.',
        'La seduta è tolta alle ore 20:10.'), 'Verbale · foglio 2') },
    ],
    questions: [
      ask("Quanti soci erano presenti all'assemblea?", num(23), text(1, 'Presenti 23 soci su 41 iscritti')),
      ask('Quanti voti contrari ha ricevuto il bilancio consuntivo?', num(3), text(1, '3 contrari')),
      ask('Qual è la capacità della nuova cisterna, in litri?', num(2500), text(2, '2.500 litri')),
      ask("Quanti minuti è durata l'assemblea, dall'inizio alla chiusura della seduta?", num(100), text(1, 'alle ore 18:30', text(2, 'tolta alle ore 20:10')), 'two-pages'),
      ask("Chi è il tesoriere dell'associazione?", NA, missing('Il verbale nomina chi presiede e chi verbalizza, non un tesoriere.', ['tesoriere'])),
    ],
  });

  {
    const rows = [['Field atlas, hardback', 12, 18.5], ['Tide tables booklet', 40, 2.25], ['Wall map, laminated', 3, 31], ['Index cards, box of 500', 6, 7.75]];
    const subtotal = sum(rows.map(([, qty, price]) => qty * price));
    assert.equal(subtotal, 451.5); assert.equal(subtotal + 14, 465.5); assert.equal(12 * 18.5 + 6 * 7.75, 268.5);
    items.push({
      id: 'p03-invoice-table', kind: 'pdf', language: 'en', size: 'Letter', font: 'mono', categories: ['table'],
      pages: async () => [{ body: sheet('Quillfeather Press', 'Invoice 2207', P('Bill to: Lanternfield School Library.')
        + table(['Item', n('Qty'), n('Unit price'), n('Line total')], [
          ...rows.map(([item, qty, price]) => [item, n(qty), n(price.toFixed(2)), n((qty * price).toFixed(2))]),
          [{ t: 'Subtotal', colspan: 3 }, n('451.50')], [{ t: 'Delivery', colspan: 3 }, n('14.00')], [{ t: 'Total due', colspan: 3, b: true }, { t: '465.50', n: true, b: true }]])
        + P('Payment terms: 30 days from the invoice date. Reference: QP-2207-LS.')) }],
      questions: [
        ask('What is the total due on the invoice?', num(465.5), text(1, 'Total due 465.50')),
        ask('How many laminated wall maps were ordered?', num(3), text(1, 'Wall map, laminated 3 31.00 93.00')),
        ask('What is the unit price of the tide tables booklet?', num(2.25), text(1, 'Tide tables booklet 40 2.25 90.00')),
        ask('What do the field atlases and the index cards cost together (sum of their two line totals)?', num(268.5), text(1, 'Field atlas, hardback 12 18.50 222.00', text(1, 'Index cards, box of 500 6 7.75 46.50'))),
        ask('What is the VAT registration number of Quillfeather Press?', NA, missing('The invoice shows no VAT or tax number.', ['VAT'])),
      ],
    });
  }

  {
    const loans = [34, 51, 28, 47, 0, 39, 62];
    assert.equal(sum(loans), 261); assert.equal(51 + 28 + 62, 141);
    items.push({
      id: 'p04-turni-tabella', kind: 'pdf', language: 'it', font: 'mono', categories: ['table'],
      pages: async () => [{ body: sheet('Biblioteca Civica di Montefosco', 'Turni del banco prestiti — settimana 14',
        table(['Giorno', 'Fascia', 'Operatore', n('Prestiti')], [
          [{ t: 'Lunedì', rowspan: 2 }, 'Mattina', 'Tullio Ardenghi', n(34)], ['Pomeriggio', 'Nives Quaranta', n(51)],
          [{ t: 'Martedì', rowspan: 2 }, 'Mattina', 'Nives Quaranta', n(28)], ['Pomeriggio', 'Tullio Ardenghi', n(47)],
          ['Mercoledì', { t: 'Chiuso per inventario', colspan: 2 }, n(0)],
          [{ t: 'Giovedì', rowspan: 2 }, 'Mattina', 'Elda Morosin', n(39)], ['Pomeriggio', 'Nives Quaranta', n(62)],
          [{ t: 'Totale settimana', colspan: 3, b: true }, { t: 261, n: true, b: true }]])
        + P('Le celle unite indicano lo stesso giorno per entrambe le fasce.')) }],
      questions: [
        ask('Quanti prestiti sono stati registrati in totale nella settimana?', num(261), text(1, 'Totale settimana 261')),
        ask('Chi era al banco prestiti martedì pomeriggio?', exact('Tullio Ardenghi'), text(1, 'Pomeriggio Tullio Ardenghi 47')),
        ask('In quale giorno la biblioteca era chiusa per inventario?', exact('Mercoledì'), text(1, 'Chiuso per inventario')),
        ask('Quanti prestiti ha registrato Nives Quaranta in tutta la settimana?', num(141), text(1, 'Pomeriggio Nives Quaranta 51', text(1, 'Mattina Nives Quaranta 28'), text(1, 'Pomeriggio Nives Quaranta 62'))),
        ask('Quanti prestiti sono stati registrati venerdì?', NA, missing('La tabella arriva a giovedì; venerdì non compare.', ['Venerdì'])),
      ],
    });
  }

  items.push({
    id: 'p05-spec-small-text', kind: 'pdf', language: 'en', size: 'Letter', categories: ['small-text'], smallestTextPt: 7,
    pages: async () => [{ body: sheet('Pellworth Observatory', 'Dome drive unit D-3 — technical sheet', P('The drive unit turns the main dome. Ratings are listed below; the notes in small print are part of this sheet.')
      + `<div style="font-size:7.5pt">${table(['Property', 'Value'], [['Rated torque', '86 N·m'], ['Supply', '48 V DC'], ['Slew rate', '3.2 degrees per second'], ['Mass', '14.6 kg'], ['Operating range', '-25 °C to +40 °C']], 'width:70%')}</div>`
      + `<div style="font-size:7pt;line-height:1.4;margin-top:6mm">${P('1. Lubricate the worm gear every 180 operating hours with grade L-22 grease.', '2. Firmware build 4.11.7 or later is required for the anemometer interlock.', '3. Replacement brush set: part number BR-6093.')}</div>`) }],
    questions: [
      ask('According to the notes in small print, after how many operating hours must the worm gear be lubricated?', num(180), text(1, 'every 180 operating hours')),
      ask('What is the part number of the replacement brush set?', exact('BR-6093'), text(1, 'part number BR-6093')),
      ask('What is the slew rate of the drive unit, in degrees per second?', num(3.2), text(1, 'Slew rate 3.2 degrees per second')),
      ask('What is the warranty period of the drive unit?', NA, missing('The sheet states no warranty.', ['warranty'])),
    ],
  });

  items.push({
    id: 'p06-rotated-native', kind: 'pdf', language: 'en', categories: ['rotated', 'table'],
    pages: async () => [
      { appears: 270, body: sheet('Brambleton Tool Library · Archive', 'Storage bay register', P('Bay C holds the map and ledger archive. The margin note on this sheet is written sideways, reading from the bottom of the page to the top.'))
        + '<div class="mono" style="position:absolute;left:24mm;top:262mm;width:190mm;font-size:12pt;transform-origin:left top;transform:rotate(-90deg)">Archive box 6641 moved to bay C on 12 May.</div>' },
      { appears: 180, body: sheet('Brambleton Tool Library · Archive', 'Returned crates', P('One slip was pasted into the register upside down. It is reproduced below exactly as found.'))
        + '<div class="mono" style="position:absolute;left:30mm;top:120mm;width:150mm;font-size:12pt;border:.8pt solid #333;padding:4mm;transform:rotate(180deg)">RETURN SLIP: crate 7793 belongs to room 204.</div>' },
      { turn: 270, rotate: 90, body: `<h1>Shelf audit — bay C (landscape sheet)</h1>${table(['Shelf', 'Section', n('Boxes'), 'Last audit'], [['C-1', 'Maps', n(18), '2 February'], ['C-2', 'Ledgers', n(27), '9 February'], ['C-3', 'Photographs', n(11), '16 February'], [{ t: 'Total', colspan: 2, b: true }, { t: 56, n: true, b: true }, '']])}` },
    ],
    questions: [
      ask('Which archive box was moved to bay C on 12 May?', exact('6641'), text(1, 'Archive box 6641 moved to bay C on 12 May')),
      ask('According to the return slip, which room does crate 7793 belong to?', exact('204'), text(2, 'crate 7793 belongs to room 204')),
      ask('How many boxes are on shelf C-2?', num(27), text(3, 'C-2 Ledgers 27 9 February')),
      ask('Who carried out the audit of shelf C-3?', NA, missing('The audit table gives dates, not names.')),
    ],
  });

  {
    const foot = (label) => `Consorzio Valfrasca · ${label}`;
    assert.equal(64 * 120, 7680);
    items.push({
      id: 'p07-statuto-romani', kind: 'pdf', language: 'it', categories: ['page-labels'],
      pages: async () => [
        { label: 'iii', body: sheet('Consorzio Valfrasca', 'Indice', table(null, [['Premessa', n('v')], ['Abbreviazioni', n('vi')], ['Art. 1 Denominazione', n('1')], ['Art. 2 Sede', n('1')], ['Art. 3 Quote', n('2')], ['Art. 4 Recesso', n('2')]], 'width:60%'), foot('iii')) },
        { label: 'iv', body: sheet('Consorzio Valfrasca', 'Nota editoriale', P('Questa edizione dello statuto sostituisce quella precedente.', 'Tiratura: 350 copie.'), foot('iv')) },
        { label: 'v', body: sheet('Consorzio Valfrasca', 'Premessa', P('Il Consorzio Valfrasca riunisce 64 aziende agricole della valle.', "Il testo è stato approvato dall'assemblea del 21 novembre."), foot('v')) },
        { label: 'vi', body: sheet('Consorzio Valfrasca', 'Abbreviazioni', P('CdA = Consiglio di amministrazione.', 'RUC = Registro unico dei consorziati.'), foot('vi')) },
        { label: '1', body: sheet('Consorzio Valfrasca', 'Statuto', P('Art. 1 — Denominazione. È costituito il Consorzio Valfrasca.', 'Art. 2 — Sede. La sede è in via delle Fornaci 8, Castelvento.'), foot('1')) },
        { label: '2', body: sheet('Consorzio Valfrasca', 'Statuto', P('Art. 3 — Quote. La quota annuale è di 120 euro per azienda.', 'Art. 4 — Recesso. Il recesso va comunicato con 90 giorni di preavviso.'), foot('2')) },
      ],
      questions: [
        ask('Quale numero di pagina è stampato sulla terza pagina fisica del file?', exact('v'), text(3, 'Consorzio Valfrasca · v'), 'printed-label', 'physical-page'),
        ask('Su quale pagina fisica del file (contando da 1 la prima) si trova la pagina con numero stampato 1?', num(5), text(5, 'Consorzio Valfrasca · 1'), 'printed-label', 'physical-page'),
        ask('Quante copie indica la tiratura riportata nella seconda pagina fisica del file?', num(350), text(2, 'Tiratura: 350 copie'), 'physical-page'),
        ask("Quanto incassa il consorzio in un anno se tutte le aziende pagano la quota annuale? Rispondi in euro.", num(7680), text(3, '64 aziende agricole', text(6, '120 euro per azienda')), 'two-pages'),
        ask("Secondo l'indice, a quale pagina stampata inizia la Premessa?", exact('v'), text(1, 'Premessa v'), 'printed-label'),
        ask('Qual è il numero di partita IVA del consorzio?', NA, missing('Lo statuto non riporta alcuna partita IVA.', ['partita IVA'])),
      ],
    });
  }

  {
    const foot = (label) => `Operations Handbook · ${label}`;
    items.push({
      id: 'p08-handbook-47', kind: 'pdf', language: 'en', size: 'Letter', font: 'mono', categories: ['page-labels'],
      pages: async () => [
        { label: '47', body: sheet('Marrowick Transit Authority', '6.1 Opening the depot', P('The duty supervisor unlocks gate 2 at 04:40.', 'First departure: route 18 at 05:05.'), foot(47)) },
        { label: '48', body: sheet('Marrowick Transit Authority', '6.2 Fuelling', P('Each bus is refuelled to 280 litres.', 'The fuel log is kept in binder F-12.'), foot(48)) },
        { label: '49', body: sheet('Marrowick Transit Authority', '6.3 Washing', P('The wash bay handles 9 buses per hour.', 'Detergent mix: 1 part to 40 parts water.'), foot(49)) },
        { label: '50', body: sheet('Marrowick Transit Authority', '6.4 Defect reports', P('Defects are recorded on form D-7 and reviewed within 24 hours.'), foot(50)) },
        { label: '51', body: sheet('Marrowick Transit Authority', '6.5 Closing', P('The last bus returns at 23:50.', 'Gate 2 is locked at 00:20 by the night controller.'), foot(51)) },
      ],
      questions: [
        ask('What page number is printed on the second physical page of this file?', exact('48'), text(2, 'Operations Handbook · 48'), 'printed-label', 'physical-page'),
        ask('On which physical page of the file (counting the first page as 1) is printed page 50?', num(4), text(4, 'Operations Handbook · 50'), 'printed-label', 'physical-page'),
        ask('On the third physical page, how many buses per hour does the wash bay handle?', num(9), text(3, '9 buses per hour'), 'physical-page'),
        ask('Gate 2 is unlocked in the morning and locked again after midnight. How long is it unlocked? Answer in hours and minutes.', allOf('19', '40'), text(1, 'unlocks gate 2 at 04:40', text(5, 'Gate 2 is locked at 00:20')), 'two-pages'),
        ask('Which form is used to record defects?', exact('D-7'), text(4, 'form D-7')),
        ask('What does printed page 46 of the handbook say?', NA, missing('The file starts at printed page 47.'), 'printed-label'),
      ],
    });
  }

  {
    assert.equal(3412 + 5960 + 2105 + 874, 12351); assert.equal(207 + 318 + 96 + 41, 662);
    assert.equal(25720 + 1986 + 9400, 37106); assert.equal(14400 + 11235 + 3180 + 4612, 33427); assert.equal(37106 - 33427, 3679);
    assert.equal(Math.round((12351 / 1286) * 10) / 10, 9.6);
    const foot = (page) => `Brambleton Tool Library · Annual report · ${page}`;
    items.push({
      id: 'p09-annual-report', kind: 'pdf', language: 'en', categories: ['table'],
      pages: async () => [
        { body: sheet('Brambleton Tool Library', 'Annual report for the twelfth season', P('Prepared by the volunteer board.', 'Members at season end: 1,286.'), foot(1)) },
        { body: sheet('Brambleton Tool Library', "Chair's letter", P('We opened on 214 days this season, more than in any season before.', 'Thank you to everyone who lent a hand at the counter.', 'Tobias Quellwater, Chair'), foot(2)) },
        { body: sheet('Brambleton Tool Library', 'Lending', table(['Category', n('Loans'), n('Late returns')], [['Power tools', n('3,412'), n(207)], ['Hand tools', n('5,960'), n(318)], ['Garden', n('2,105'), n(96)], ['Ladders', n(874), n(41)], [{ t: 'Total', b: true }, { t: '12,351', n: true, b: true }, { t: 662, n: true, b: true }]]), foot(3)) },
        { body: sheet('Brambleton Tool Library', 'Workshops', P('We ran 38 workshops with 512 participants.', 'The best attended was "Sharpening basics" with 41 participants.'), foot(4)) },
        { body: sheet('Brambleton Tool Library', 'Finances', table(['Income', n('EUR')], [['Memberships', n('25,720')], ['Late fees', n('1,986')], ['Grants', n('9,400')], [{ t: 'Total income', b: true }, { t: '37,106', n: true, b: true }]])
          + table(['Expenses', n('EUR')], [['Rent', n('14,400')], ['Tool purchases', n('11,235')], ['Insurance', n('3,180')], ['Repairs', n('4,612')], [{ t: 'Total expenses', b: true }, { t: '33,427', n: true, b: true }]]) + P('Surplus for the season: 3,679 EUR.'), foot(5)) },
        { body: sheet('Brambleton Tool Library', 'Volunteers', P('67 volunteers gave 4,930 hours.', 'Longest-serving volunteer: Odalys Fernbrook, 11 seasons.'), foot(6)) },
        { body: sheet('Brambleton Tool Library', 'Plans', P('Next season we will open a second counter at the Millrace depot.', 'Saturday hours will be extended to 17:00.'), foot(7)) },
      ],
      questions: [
        ask('On the fifth physical page, what is the total income in EUR?', num(37106), text(5, 'Total income 37,106'), 'physical-page'),
        ask('How many late returns were recorded for hand tools?', num(318), text(3, 'Hand tools 5,960 318')),
        ask('How many loans were made per member at season end? Divide the total number of loans by the number of members and round to one decimal.', num(9.6, { tolerance: 0.05 }), text(3, 'Total 12,351 662', text(1, 'Members at season end: 1,286')), 'two-pages'),
        ask("Who signed the chair's letter, and who is the longest-serving volunteer?", allOf('Tobias Quellwater', 'Odalys Fernbrook'), text(2, 'Tobias Quellwater, Chair', text(6, 'Longest-serving volunteer: Odalys Fernbrook')), 'two-pages'),
        ask('According to the last physical page, until what time will Saturday hours be extended?', exact('17:00'), text(7, 'extended to 17:00'), 'physical-page'),
        ask('How many tools does the library own in total?', NA, missing('The report counts loans, members and volunteers, never the tools owned.')),
      ],
    });
  }

  items.push({
    id: 'p10-chart-bar', kind: 'pdf', language: 'en', categories: ['chart'],
    pages: async (h) => [{ body: sheet('Harbourlight Bakery Collective', 'Weekly bread output', P('The chart shows the loaves baked at each of the five ovens during week 23.', 'Figures were recorded by the shift lead, Corwin Ashdale.')
      + `<figure>${await h.figure(barChart({ title: 'Loaves baked per oven', labels: ['Alder', 'Birch', 'Cedar', 'Dogwood', 'Elm'], values: [318, 472, 256, 391, 440], yMax: 500, yStep: 100 }), 640, 380)}<figcaption>Figure 1. Output per oven.</figcaption></figure>`) }],
    questions: [
      ask('How many loaves did the Cedar oven bake?', num(256), pixel(1, '256')),
      ask('Which oven baked the most loaves?', exact('Birch'), visual(pixel(1, '472'), 'The tallest bar is labelled Birch and carries the value 472.')),
      ask('How many loaves did the Alder and Elm ovens bake together?', num(758), pixel(1, '318', pixel(1, '440'))),
      ask('Who recorded the figures?', exact('Corwin Ashdale'), text(1, 'Corwin Ashdale')),
      ask('How many loaves were baked in week 24?', NA, missing('Only week 23 is reported.')),
    ],
  });

  items.push({
    id: 'p11-grafico-linea', kind: 'pdf', language: 'it', categories: ['chart'],
    pages: async (h) => [{ body: sheet('Acquedotto di Rivalta Piana', 'Livello del serbatoio di Colle Tasso', P('Il grafico riporta il livello medio mensile del serbatoio, in centimetri, da gennaio a giugno.', 'Rilevazioni a cura di Bruna Selvatici.')
      + `<figure>${await h.figure(lineChart({ title: 'Livello medio mensile (cm)', labels: ['Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu'], series: [{ color: '#2a6f97', values: [412, 438, 465, 451, 397, 356] }], yMin: 300, yMax: 500, yStep: 50 }), 640, 380)}<figcaption>Figura 1. Andamento del livello.</figcaption></figure>`) }],
    questions: [
      ask('Qual era il livello del serbatoio a marzo, in centimetri?', num(465), pixel(1, '465')),
      ask('In quale mese il livello è stato più basso?', oneOf('giugno', 'Giu'), visual(pixel(1, '356'), 'Il punto più basso della linea è Giu, con etichetta 356.')),
      ask('Di quanti centimetri è sceso il livello tra aprile e maggio?', num(54), pixel(1, '451', pixel(1, '397'))),
      ask('Chi ha curato le rilevazioni?', exact('Bruna Selvatici'), text(1, 'Bruna Selvatici')),
      ask('Qual è la capacità massima del serbatoio, in metri cubi?', NA, missing('Il documento riporta livelli in centimetri, non la capacità.', ['metri cubi'])),
    ],
  });

  items.push({
    id: 'p12-chart-pie', kind: 'pdf', language: 'en', size: 'Letter', categories: ['chart'],
    pages: async (h) => [{ body: sheet('Lanternfield School', 'How pupils travel to school', P('Survey of all 480 pupils, carried out in the spring term by class 6B.')
      + `<figure>${await h.figure(pieChart({ title: 'Share of pupils by way of travelling', slices: [{ name: 'Walk', value: 35, color: '#3b6ea5' }, { name: 'Bus', value: 30, color: '#e0a030' }, { name: 'Bicycle', value: 20, color: '#4f9d69' }, { name: 'Car', value: 10, color: '#c8553d' }, { name: 'Scooter', value: 5, color: '#7b5ea7' }] }), 640, 380)}<figcaption>Figure 1. Results of the survey.</figcaption></figure>`) }],
    questions: [
      ask('What percentage of pupils travel by bicycle?', num(20), pixel(1, 'Bicycle 20%')),
      ask('Which way of travelling has the smallest share?', exact('Scooter'), pixel(1, 'Scooter 5%')),
      ask('How many pupils walk to school? Use the share in the chart and the number of pupils surveyed.', num(168), pixel(1, 'Walk 35%', text(1, 'all 480 pupils'))),
      ask('Which class carried out the survey?', exact('6B'), text(1, 'class 6B')),
      ask('How many pupils took part in the survey of the previous year?', NA, missing('Only one survey is reported.')),
    ],
  });

  items.push({
    id: 'p13-vendite-grafico', kind: 'pdf', language: 'it', categories: ['chart', 'table'],
    pages: async (h) => [
      { body: sheet('Cartiera Roccabigia', 'Rapporto trimestrale — listino', P('Prezzi di listino al chilo in vigore nel terzo trimestre.') + table(['Prodotto', n('Prezzo al chilo (euro)')], [['Carta kraft', n('1,80')], ['Cartoncino', n('2,40')], ['Carta riciclata', n('1,35')]], 'width:70%'), 'Rapporto trimestrale · foglio 1') },
      { body: sheet('Cartiera Roccabigia', 'Rapporto trimestrale — vendite', P('Tonnellate vendute per prodotto nel terzo trimestre.')
        + `<figure>${await h.figure(hbarChart({ title: 'Vendite del terzo trimestre', labels: ['Carta kraft', 'Cartoncino', 'Carta riciclata'], values: [86, 54, 127], xMax: 150, xStep: 25, unit: 't' }), 640, 300)}<figcaption>Figura 1. Vendite per prodotto.</figcaption></figure>`, 'Rapporto trimestrale · foglio 2') },
    ],
    questions: [
      ask('Quante tonnellate di carta riciclata sono state vendute nel terzo trimestre?', num(127), pixel(2, '127 t')),
      ask('Qual è il prezzo al chilo del cartoncino, in euro?', num(2.4), text(1, 'Cartoncino 2,40')),
      ask('Qual è il ricavo del trimestre per la carta kraft, in euro? Moltiplica le tonnellate vendute per mille e per il prezzo al chilo.', num(154800), pixel(2, '86 t', text(1, 'Carta kraft 1,80')), 'two-pages'),
      ask('Quante tonnellate sono state vendute nel quarto trimestre?', NA, missing('Il rapporto riguarda solo il terzo trimestre.', ['quarto trimestre'])),
    ],
  });

  items.push({
    id: 'p14-diagram-flow', kind: 'pdf', language: 'en', categories: ['diagram'],
    pages: async (h) => [{ body: sheet('Pellworth Desk · Depot', 'Returned parcel procedure', P('The flowchart below is the approved procedure for parcels returned to the depot.', 'Revision C, approved by Isolde Varnham.')
      + `<figure>${await h.figure(flowchart({ width: 700, height: 650, nodes: [
        { id: 'a', x: 250, y: 40, w: 190, h: 44, kind: 'end', text: 'Parcel arrives' }, { id: 'b', x: 250, y: 120, w: 190, h: 44, text: 'Scan the label' },
        { id: 'c', x: 250, y: 215, w: 210, h: 84, kind: 'decision', text: 'Label readable?' }, { id: 'd', x: 540, y: 215, w: 190, h: 44, kind: 'end', text: 'Send to desk 4' },
        { id: 'e', x: 250, y: 320, w: 190, h: 44, text: 'Weigh the parcel' }, { id: 'f', x: 250, y: 415, w: 210, h: 84, kind: 'decision', text: 'Over 20 kg?' },
        { id: 'g', x: 540, y: 415, w: 190, h: 44, text: 'Move to bay 7' }, { id: 'i', x: 250, y: 520, w: 190, h: 44, text: 'Shelve in aisle 3' }, { id: 'j', x: 250, y: 605, w: 190, h: 44, kind: 'end', text: 'Update the log' }],
      edges: [{ from: ['a', 'bottom'], to: ['b', 'top'] }, { from: ['b', 'bottom'], to: ['c', 'top'] }, { from: ['c', 'right'], to: ['d', 'left'], label: 'No' }, { from: ['c', 'bottom'], to: ['e', 'top'], label: 'Yes' },
        { from: ['e', 'bottom'], to: ['f', 'top'] }, { from: ['f', 'right'], to: ['g', 'left'], label: 'Yes' }, { from: ['f', 'bottom'], to: ['i', 'top'], label: 'No' }, { from: ['i', 'bottom'], to: ['j', 'top'] },
        { from: ['g', 'bottom'], via: [[540, 605]], to: ['j', 'right'] }] }), 700, 650, { style: 'width:150mm;margin:0 auto' })}<figcaption>Figure 1. Procedure for returned parcels.</figcaption></figure>`) }],
    questions: [
      ask('In the flowchart, which step comes right after the label is found readable?', exact('Weigh the parcel'), pixel(1, 'Weigh the parcel')),
      ask('Where is a parcel sent when its label is not readable?', exact('desk 4'), pixel(1, 'Send to desk 4')),
      ask('Where does a parcel of more than 20 kg go?', exact('bay 7'), pixel(1, 'Move to bay 7')),
      ask('How many decision diamonds does the flowchart contain?', num(2), visual(pixel(1, 'Over 20 kg?'), 'Two diamond shapes are drawn: "Label readable?" and "Over 20 kg?".'), 'count', 'shape'),
      ask('Who approved revision C of the procedure?', exact('Isolde Varnham'), text(1, 'approved by Isolde Varnham')),
      ask('For how many days may a parcel stay on the shelf before it is sent back?', NA, missing('Neither the text nor the flowchart gives a storage time.')),
    ],
  });

  items.push({
    id: 'p15-planimetria', kind: 'pdf', language: 'it', categories: ['diagram'],
    pages: async (h) => [{ body: sheet('Azienda Larice', 'Planimetria del piano terra', P('La planimetria seguente è allegata al piano di evacuazione; le superfici sono in metri quadrati e il disegno non è in scala.', 'Responsabile della sicurezza: Demetrio Falasca.')
      + `<figure>${await h.figure(floorPlan({ width: 660, height: 470, rooms: [['Officina', 142, 20, 20, 380, 240], ['Magazzino', 76, 400, 20, 240, 150], ['Sala prove', 45, 400, 170, 240, 90], ['Ingresso', 18, 20, 260, 150, 160], ['Ufficio', 24, 170, 260, 220, 160], ['Spogliatoio', 31, 390, 260, 250, 160]],
        marks: `<rect x="170" y="14" width="60" height="12" fill="#c8553d"/>${T(200, 46, 'U1', { size: 14, anchor: 'middle', weight: 700, fill: '#c8553d' })}<rect x="634" y="70" width="12" height="60" fill="#c8553d"/>${T(618, 105, 'U2', { size: 14, anchor: 'end', weight: 700, fill: '#c8553d' })}<rect x="70" y="414" width="50" height="12" fill="#3b6ea5"/>${T(20, 452, 'U = uscita di emergenza (rosso) · ingresso principale (blu)', { size: 13 })}` }), 660, 470)}<figcaption>Figura 1. Piano terra.</figcaption></figure>`) }],
    questions: [
      ask('Qual è la superficie del magazzino, in metri quadrati?', num(76), pixel(1, '76 m²')),
      ask('Quale locale ha la superficie maggiore?', exact('Officina'), visual(pixel(1, '142 m²'), 'Il locale con il valore più alto è Officina, 142 m².')),
      ask("Quale locale si trova tra l'ingresso e lo spogliatoio?", exact('Ufficio'), visual(pixel(1, 'Ufficio'), 'Nella fila in basso Ufficio è disegnato tra Ingresso e Spogliatoio.'), 'position'),
      ask('Quante uscite di emergenza sono indicate nella planimetria?', num(2), visual(pixel(1, 'U2'), 'Sono disegnate due uscite rosse, U1 e U2.'), 'count'),
      ask('Chi è il responsabile della sicurezza?', exact('Demetrio Falasca'), text(1, 'Demetrio Falasca')),
      ask("A che altezza si trova il soffitto dell'officina?", NA, missing('La planimetria riporta solo superfici.', ['altezza', 'soffitto'])),
    ],
  });

  {
    const station = (x, y, name, dx, dy, anchor = 'start') => `<circle cx="${x}" cy="${y}" r="8" fill="#fff" stroke="#111" stroke-width="3"/>${T(x + dx, y + dy, name, { size: 14, anchor, weight: 600 })}`;
    const map = svg(700, 420, `${T(20, 28, 'Marrowick tram network', { size: 16, weight: 600 })}
      <polyline points="60,200 620,200" fill="none" stroke="#e0a030" stroke-width="8"/>
      <polyline points="340,70 340,200 430,300 590,340" fill="none" stroke="#2a9d8f" stroke-width="8"/>
      <polyline points="200,200 200,300 430,300 430,380" fill="none" stroke="#8e4585" stroke-width="8"/>
      ${station(60, 200, 'Quarry Hill', 0, -18, 'middle')}${station(200, 200, 'Saltwick', 0, -18, 'middle')}${station(340, 200, 'Founders Square', 16, -16)}${station(480, 200, 'Tannery Row', 0, 30, 'middle')}${station(620, 200, 'Eastmere', 0, -18, 'middle')}
      ${station(340, 70, 'Northgate', 16, 5)}${station(430, 300, 'Glasshouse', 16, -12)}${station(590, 340, 'Wharf End', 0, 30, 'middle')}${station(430, 380, 'Orchard Halt', 16, 6)}
      <rect x="20" y="318" width="150" height="88" fill="#fff" stroke="#888"/>
      <line x1="32" x2="62" y1="340" y2="340" stroke="#e0a030" stroke-width="8"/>${T(72, 345, 'Amber line', { size: 13 })}
      <line x1="32" x2="62" y1="364" y2="364" stroke="#2a9d8f" stroke-width="8"/>${T(72, 369, 'Teal line', { size: 13 })}
      <line x1="32" x2="62" y1="388" y2="388" stroke="#8e4585" stroke-width="8"/>${T(72, 393, 'Plum line', { size: 13 })}
      <path d="M650 60 L650 30 M642 40 L650 28 L658 40" fill="none" stroke="#111" stroke-width="2"/>${T(650, 76, 'N', { size: 14, anchor: 'middle', weight: 700 })}`);
    items.push({
      id: 'p16-transit-map', kind: 'pdf', language: 'en', size: 'Letter', categories: ['diagram', 'table'],
      pages: async (h) => [
        { body: sheet('Marrowick Transit Authority', 'Tram network leaflet', P('This leaflet shows the three tram lines of the network. North is at the top of the diagram.', 'A ticket is valid for 75 minutes. Night service runs on the Amber line only.')
          + `<figure>${await h.figure(map, 700, 420)}<figcaption>Network diagram.</figcaption></figure>`, 'Leaflet · side 1') },
        { body: sheet('Marrowick Transit Authority', 'First and last departures', table(['Line', 'First departure', 'Last departure'], [['Amber', '05:10', '01:30'], ['Teal', '05:25', '23:55'], ['Plum', '06:00', '22:40']], 'width:75%'), 'Leaflet · side 2') },
      ],
      questions: [
        ask('On the network diagram, which station lies between Saltwick and Tannery Row on the Amber line?', exact('Founders Square'), pixel(1, 'Founders Square'), 'position'),
        ask('Which two lines meet at Glasshouse?', allOf('Teal', 'Plum'), visual(pixel(1, 'Glasshouse'), 'The teal and the plum lines both pass through the station labelled Glasshouse.'), 'colour'),
        ask('Which station is the eastern end of the Amber line?', exact('Eastmere'), visual(pixel(1, 'Eastmere'), 'Eastmere is the right-hand end of the amber line; north is up.'), 'position'),
        ask('At what time is the last departure on the line that ends at Orchard Halt?', exact('22:40'), visual(pixel(1, 'Orchard Halt', text(2, 'Plum 06:00 22:40')), 'Orchard Halt is the end of the plum line.'), 'two-pages'),
        ask('For how many minutes is a ticket valid?', num(75), text(1, 'valid for 75 minutes')),
        ask('What is the price of a single ticket?', NA, missing('The leaflet gives validity and times, no prices.', ['price'])),
      ],
    });
  }

  items.push({
    id: 'p17-letter-note', kind: 'pdf', language: 'en', size: 'Letter', categories: [],
    pages: async (h) => [{ body: sheet('Tidewell Marina Cooperative', 'Pontoon lease — decision', P('Dear Ms Dolvich,', 'Thank you for your request to extend the pontoon lease. The committee considered it at its meeting on 6 June.', 'The decision is recorded in the note below, as written by the harbour master.')
      + `<figure>${await h.figure(`<div style="position:absolute;inset:0;background:#fffdf2"></div><div style="position:absolute;left:34px;top:30px;width:380px;transform:rotate(-2deg);color:#1c2f6b">${hand('Approved for 18 months', 26)}<br>${hand('ref. TM-5527', 26)}<br>${hand('A. Brightwater', 24)}</div>
        <div style="position:absolute;left:440px;top:38px;width:170px;height:170px;border:5px double #a3262a;border-radius:50%;transform:rotate(-14deg);color:#a3262a;text-align:center;font-weight:700;font-size:18px;line-height:1.35;padding-top:42px">RECEIVED<br><span style="font-size:24px">11 JUN</span><br>HARBOUR OFFICE</div>`, 640, 240, { style: 'width:150mm' })}</figure>`
      + P('Yours sincerely,', 'The lease committee')) }],
    questions: [
      ask('According to the handwritten note, for how many months was the lease extension approved?', num(18), pixel(1, '18 months')),
      ask('What reference is written in the note?', exact('TM-5527'), pixel(1, 'TM-5527')),
      ask('What date does the stamp show?', oneOf('11 JUN', '11 June', 'June 11'), pixel(1, '11 JUN')),
      ask('On what date did the committee consider the request?', exact('6 June'), text(1, 'meeting on 6 June')),
      ask('What is the monthly rent for the pontoon?', NA, missing('Neither the letter nor the note states a rent.', ['rent'])),
    ],
  });

  {
    const rows = [['101', '07:12', '07:34', '07:58', '08:21'], ['103', '09:40', '10:02', '10:26', '10:49'], ['105', '13:05', '13:27', 'non ferma', '14:06'], ['107', '17:30', '17:52', '18:16', '18:39']];
    assert.equal((8 * 60 + 21) - (7 * 60 + 12), 69);
    items.push({
      id: 'p18-orario-screenshot', kind: 'pdf', language: 'it', categories: ['table'],
      pages: async (h) => [{ body: sheet('Linea montana Valfrasca–Castelvento', 'Orario estivo', P("Di seguito l'orario in vigore dal 15 giugno, riprodotto dall'avviso affisso in stazione.", 'Informazioni: sportello di Castelvento, interno 214.')
        + `<figure>${await h.figure(`<div style="padding:18px;background:#f7f3e6;height:100%"><div style="font-weight:700;font-size:17px;margin-bottom:8px">AVVISO — Orario delle corse</div>${table(['Corsa', 'Valfrasca', 'Pieve Alta', 'Rifugio Lago', 'Castelvento'], rows, 'font-size:15px;background:#fff')}</div>`, 640, 270, { background: '#f7f3e6' })}<figcaption>Riproduzione dell'avviso.</figcaption></figure>`) }],
      questions: [
        ask('A che ora arriva a Castelvento la corsa 103?', exact('10:49'), pixel(1, '10:49')),
        ask('Quale corsa non ferma a Rifugio Lago?', exact('105'), visual(pixel(1, 'non ferma'), 'Nella riga della corsa 105 la colonna Rifugio Lago riporta "non ferma".')),
        ask('Quanti minuti impiega la corsa 101 da Valfrasca a Castelvento?', num(69), pixel(1, '07:12', pixel(1, '08:21'))),
        ask("Qual è l'interno telefonico dello sportello?", exact('214'), text(1, 'interno 214')),
        ask('Quanto costa il biglietto da Valfrasca a Castelvento?', NA, missing("Né il testo né l'avviso riportano prezzi.", ['biglietto'])),
      ],
    });
  }

  items.push({
    id: 'p19-nameplate-small', kind: 'pdf', language: 'en', categories: ['small-text'], smallestTextPt: 7,
    pages: async (h) => [{ body: sheet('Pellworth Observatory', 'Equipment register — entry 31', P('The picture below shows the rating plate of the backup generator in shed B, at its real size.', 'Inspected by Linnea Thackwell.')
      // 300 CSS px wide and shown at 300 px: the 9.33 px lines print at 7 pt.
      + `<figure>${await h.figure(`<div style="position:absolute;inset:0;background:linear-gradient(135deg,#d9dcdf,#b9bec4);border:2px solid #555;border-radius:6px"></div><div class="mono" style="position:absolute;left:16px;top:12px;right:16px;font-size:9.33px;line-height:1.55;color:#1b1b1b;font-weight:500">
        <div style="font-size:12px;font-weight:700;margin-bottom:3px">CALDERVALE GENERATORS</div>MODEL&nbsp;&nbsp;GX-240<br>SERIAL&nbsp;&nbsp;7H-03815<br>OUTPUT&nbsp;&nbsp;6.5 kVA<br>FREQUENCY&nbsp;&nbsp;50 Hz<br>YEAR OF BUILD&nbsp;&nbsp;2011<br>MASS&nbsp;&nbsp;148 kg</div>`, 300, 150, { scale: 4, style: 'width:300px' })}<figcaption>Rating plate, shed B.</figcaption></figure>`) }],
    questions: [
      ask('What is the serial number on the rating plate?', exact('7H-03815'), pixel(1, '7H-03815')),
      ask('What output does the rating plate give, in kVA?', num(6.5), pixel(1, '6.5 kVA')),
      ask('Who inspected the generator?', exact('Linnea Thackwell'), text(1, 'Inspected by Linnea Thackwell')),
      ask('When was the generator last serviced?', NA, missing('No service date appears in the text or on the plate.', ['serviced'])),
    ],
  });

  items.push({
    id: 'p20-scan-letter', kind: 'pdf', language: 'en', size: 'Letter', categories: [],
    pages: async () => [{ look: { scale: 1.5, quality: 72 }, scan: `<div style="font-size:12.5pt;line-height:1.6"><div style="font-weight:700;font-size:15pt">Harbourlight Bakery Collective</div><div>14 Kiln Lane</div><br>${P('Dear Mr Ashdale,', 'We confirm your order of 36 trays of seeded rolls for the harvest fair.', 'Delivery will be made on Saturday at 06:15 to the east gate.', 'The agreed price is 540 EUR, payable on delivery.', 'Order number HB-3068.', 'Yours sincerely,')}${hand('P. Wickhart', 24)}<br>Petronella Wickhart, Orders Clerk</div>` }],
    questions: [
      ask('How many trays were ordered?', num(36), pixel(1, '36 trays')),
      ask('What is the order number?', exact('HB-3068'), pixel(1, 'HB-3068')),
      ask('Who signed the letter?', exact('Petronella Wickhart'), pixel(1, 'Petronella Wickhart')),
      ask('At what time will the delivery be made?', exact('06:15'), pixel(1, '06:15')),
      ask('What is the telephone number of the bakery?', NA, missing('The letter gives an address but no telephone number.')),
    ],
  });

  {
    const lines = [['2 Tagliatelle ai funghi', '24,00'], ['1 Zuppa di farro', '9,50'], ['3 Coperto', '6,00'], ['1 Vino della casa 1/2 l', '7,00'], ['2 Caffè', '2,60']];
    assert.equal(Math.round(sum(lines.map(([, price]) => Number(price.replace(',', '.')))) * 100), 4910);
    const row = (a, b, style = '') => `<div style="display:flex;justify-content:space-between;${style}"><span>${esc(a)}</span><span>${esc(b)}</span></div>`;
    items.push({
      id: 'p21-scontrino', kind: 'pdf', language: 'it', categories: ['small-text', 'table'], smallestTextPt: 7,
      pages: async () => [{ look: { tint: '#e9e6df', tilt: -0.8 }, scan: `<div class="mono" style="width:84mm;margin:8mm auto 0;background:#fdfdfb;padding:7mm 6mm;font-size:10pt;line-height:1.5;box-shadow:0 0 0 1px #cfcfcf">
        <div style="text-align:center;font-weight:700;font-size:12pt">Osteria del Faggio Rosso</div><div style="text-align:center;font-size:8pt">Via dei Tigli 3 — Montefosco</div><br>${row('Tavolo 7', 'Coperti 3')}<hr style="border:0;border-top:1px dashed #555">
        ${lines.map(([a, b]) => row(a, b)).join('')}<hr style="border:0;border-top:1px dashed #555">${row('TOTALE EURO', '49,10', 'font-weight:700;font-size:12pt')}${row('Pagamento', 'contanti')}<br>
        <div style="font-size:7pt;line-height:1.4;text-align:center">Scontrino n. 0482 — Cassa 2 — operatore Livio<br>Grazie e arrivederci</div></div>` }],
      questions: [
        ask('Qual è il totale dello scontrino, in euro?', num(49.1), pixel(1, '49,10')),
        ask('Qual è il numero dello scontrino, stampato in piccolo in fondo?', exact('0482'), pixel(1, 'Scontrino n. 0482')),
        ask('Quanto costa la zuppa di farro, in euro?', num(9.5), pixel(1, '9,50')),
        ask('Quanti coperti sono indicati?', num(3), pixel(1, 'Coperti 3')),
        ask("Qual è l'aliquota IVA applicata?", NA, missing('Lo scontrino non riporta aliquote.')),
      ],
    });
  }

  {
    const nights = [['3 March', 'Linnea Thackwell', 'clear', 14, 'Dome closed at 04:50.'], ['4 March', 'Caspian Yarrow', 'thin cloud', 6, 'Dome closed at 01:15.'], ['5 March', 'Linnea Thackwell', 'overcast', 0, 'Dome not opened.'],
      ['6 March', 'Wilhelmina Stroud', 'clear', 19, 'Dome closed at 05:05.'], ['7 March', 'Caspian Yarrow', 'clear after midnight', 11, 'Dome closed at 04:20.']];
    items.push({
      id: 'p22-scan-logbook', kind: 'pdf', language: 'en', categories: [],
      pages: async () => nights.map(([night, observer, sky, targets, dome], i) => ({ look: { tilt: [0.4, -0.5, 0.7, -0.3, 0.6][i], tint: ['#f4f1e8', '#f1efe9', '#f5f2e6', '#f2f0ea', '#f4f1e8'][i] },
        scan: `<div style="font-size:13pt;line-height:1.7"><div style="font-weight:700;font-size:16pt;border-bottom:2px solid #333;margin-bottom:8mm">Pellworth Observatory — Night log</div>${P(`Night of ${night}.`, `Observer: ${observer}.`, `Sky: ${sky}.`, `Targets observed: ${targets}.`, dome)}<br>${hand(observer.split(' ')[0][0] + '. ' + observer.split(' ')[1], 22)}</div>` })),
      questions: [
        ask('Who was the observer on the night recorded on the fourth physical page?', exact('Wilhelmina Stroud'), pixel(4, 'Observer: Wilhelmina Stroud'), 'physical-page'),
        ask('On which night were no targets observed?', oneOf('5 March', 'March 5'), pixel(3, 'Targets observed: 0')),
        ask('How many targets did Caspian Yarrow observe in total over his nights?', num(17), pixel(2, 'Targets observed: 6', pixel(5, 'Targets observed: 11')), 'two-pages'),
        ask('At what time was the dome closed on the night recorded on the first physical page?', exact('04:50'), pixel(1, 'Dome closed at 04:50'), 'physical-page'),
        ask('What was the outside temperature on the night of 6 March?', NA, missing('The log records sky, targets and dome times, no temperature.')),
      ],
    });
  }

  items.push({
    id: 'p23-scan-ruotato', kind: 'pdf', language: 'it', categories: ['rotated', 'table'],
    pages: async () => [
      { scan: `<div style="font-size:12.5pt;line-height:1.6"><div style="font-weight:700;font-size:15pt">Comune di Castelvento — Ufficio tecnico</div><br>${P('Si trasmette in allegato il prospetto dei consumi idrici degli edifici comunali.', 'Protocollo n. 3391.')}</div>` },
      { turn: 90, look: { tilt: -0.4 }, scan: `<div style="font-size:14pt"><div style="font-weight:700;font-size:17pt;margin-bottom:6mm">Consumi idrici degli edifici comunali (metri cubi)</div>${table(['Edificio', n('Primo semestre'), n('Secondo semestre')], [['Municipio', n(412), n(388)], ['Scuola elementare', n('1.240'), n('1.105')], ['Palestra', n(655), n(702)], ['Biblioteca', n(198), n(176)]])}</div>` },
    ],
    questions: [
      ask('Qual è il numero di protocollo della nota di trasmissione?', exact('3391'), pixel(1, 'Protocollo n. 3391')),
      ask('Quanti metri cubi ha consumato la palestra nel secondo semestre?', num(702), pixel(2, '702')),
      ask('Quale edificio ha consumato di più nel primo semestre?', exact('Scuola elementare'), visual(pixel(2, '1.240'), 'La riga Scuola elementare ha il valore più alto della colonna Primo semestre.')),
      ask('Quanti metri cubi ha consumato il campo sportivo?', NA, missing('Il prospetto elenca quattro edifici; il campo sportivo non compare.')),
    ],
  });

  items.push({
    id: 'p24-scan-upside-down', kind: 'pdf', language: 'en', size: 'Letter', categories: ['rotated'],
    pages: async () => [
      { scan: `<div style="font-size:12.5pt;line-height:1.6"><div style="font-weight:700;font-size:15pt">Lanternfield School</div><br>${P('Trip consent forms, batch 3.', '28 forms enclosed.', 'Checked by Rosalind Pennywhistle.')}</div>` },
      { turn: 180, look: { tilt: 0.6, tint: '#f1efe9' }, scan: `<div style="font-size:12.5pt;line-height:1.6"><div style="font-weight:700;font-size:15pt">Trip to Cragmoor Lighthouse</div><br>${P('The coach leaves at 08:20 from the south car park.', 'Return is expected at 16:45.', 'Each pupil brings a packed lunch.', 'Group leader: Barnaby Oakhollow.', 'Emergency contact code: LS-7719.')}</div>` },
    ],
    questions: [
      ask('How many consent forms are enclosed?', num(28), pixel(1, '28 forms enclosed')),
      ask('At what time does the coach leave?', exact('08:20'), pixel(2, 'leaves at 08:20')),
      ask('Who is the group leader of the trip?', exact('Barnaby Oakhollow'), pixel(2, 'Group leader: Barnaby Oakhollow')),
      ask('How much does the trip cost per pupil?', NA, missing('No cost is stated on either page.')),
    ],
  });

  {
    const hours = [1.5, 0.5, 1, 2.5, 0.75, 2];
    assert.equal(sum(hours), 8.25);
    items.push({
      id: 'p25-scan-table', kind: 'pdf', language: 'en', categories: ['table'],
      pages: async () => [{ look: { gray: true, tilt: 0.3 }, scan: `<div style="font-size:12.5pt"><div style="font-weight:700;font-size:16pt;margin-bottom:6mm">Brambleton Tool Library — Repair bench record, June</div>${table(['Week', 'Tool', 'Fault', n('Hours')], [
        [{ t: 'Week 1', rowspan: 2 }, 'Hedge trimmer', 'Blunt blades', n('1.5')], ['Belt sander', 'Worn belt', n('0.5')],
        [{ t: 'Week 2', rowspan: 3 }, 'Cordless drill', 'Dead battery', n('1.0')], ['Tile cutter', 'Cracked guard', n('2.5')], ['Jigsaw', 'Loose base plate', n('0.75')],
        ['Week 3', 'Pressure washer', 'Leaking hose', n('2.0')], [{ t: 'Total hours', colspan: 3, b: true }, { t: '8.25', n: true, b: true }]])}</div>` }],
      questions: [
        ask('What is the total number of repair hours in the record?', num(8.25), pixel(1, '8.25')),
        ask('What fault was recorded for the tile cutter?', exact('Cracked guard'), pixel(1, 'Cracked guard')),
        ask('How many tools were repaired in week 2?', num(3), visual(pixel(1, 'Week 2'), 'The merged Week 2 cell spans three rows: cordless drill, tile cutter and jigsaw.'), 'count'),
        ask('Who repaired the jigsaw?', NA, missing('The record names tools and faults, no repairer.')),
      ],
    });
  }

  {
    const acts = [['112', '58', 'Manutenzione del ponte di Rio Secco.', 'Importo: 12.400 euro.', 'Voti favorevoli: 9.'], ['113', '59', 'Acquisto di 40 sedie per la sala civica.', 'Importo: 2.360 euro.', 'Voti favorevoli: 11.'],
      ['114', '60', 'Contributo alla banda musicale.', 'Importo: 1.500 euro.', 'Voti favorevoli: 8.'], ['115', '61', 'Rifacimento del tetto della palestra.', 'Importo: 31.750 euro.', 'Voti favorevoli: 10.'],
      ['116', '62', 'Nomina del revisore: Clelia Montanari.', 'Nessun impegno di spesa.', 'Voti favorevoli: 11.']];
    assert.equal(12400 + 31750, 44150);
    items.push({
      id: 'p26-scan-registro', kind: 'pdf', language: 'it', categories: ['page-labels'],
      pages: async () => acts.map(([label, number, ...body], i) => ({ label, look: { tilt: [0.5, -0.4, 0.3, -0.6, 0.4][i] },
        scan: `<div style="font-size:13pt;line-height:1.7"><div style="display:flex;justify-content:space-between;border-bottom:2px solid #333;margin-bottom:8mm"><span style="font-weight:700">Comune di Castelvento — Registro delle deliberazioni</span><span>pag. ${label}</span></div><div style="font-weight:700;font-size:15pt;margin-bottom:4mm">Deliberazione n. ${number}</div>${P(...body)}</div>` })),
      questions: [
        ask('Quale numero di pagina è stampato sulla quarta pagina fisica del file?', exact('115'), pixel(4, 'pag. 115'), 'printed-label', 'physical-page'),
        ask('Qual è il numero della deliberazione che si trova nella pagina con numero stampato 113?', exact('59'), pixel(2, 'Deliberazione n. 59'), 'printed-label'),
        ask('Qual è la somma degli importi delle deliberazioni n. 58 e n. 61, in euro?', num(44150), pixel(1, 'Importo: 12.400 euro', pixel(4, 'Importo: 31.750 euro')), 'two-pages'),
        ask("Chi viene nominato revisore nell'ultima pagina fisica del file?", exact('Clelia Montanari'), pixel(5, 'Clelia Montanari'), 'physical-page'),
        ask('Che cosa è stato deliberato nella pagina con numero stampato 111?', NA, missing('Il file inizia dalla pagina stampata 112.'), 'printed-label'),
      ],
    });
  }

  items.push({
    id: 'p27-scan-chart', kind: 'pdf', language: 'en', size: 'Letter', categories: ['chart'],
    pages: async () => [{ look: { tilt: -0.5, scale: 1.5 }, scan: `<div style="font-size:12.5pt"><div style="font-weight:700;font-size:15pt">Tidewell Marina Cooperative</div>${P('Visiting boats counted by the harbour office during season 9.')}<div style="margin-top:8mm">${barChart({ title: 'Visiting boats per month', labels: ['May', 'Jun', 'Jul', 'Aug', 'Sep'], values: [42, 67, 93, 88, 51], yMax: 100, yStep: 20, width: 660, height: 400, color: '#555' })}</div></div>` }],
    questions: [
      ask('How many visiting boats were counted in July?', num(93), pixel(1, '93')),
      ask('Which month had the fewest visiting boats?', exact('May'), visual(pixel(1, '42'), 'The shortest bar is May, with the value 42.')),
      ask('How many more boats visited in August than in September?', num(37), pixel(1, '88', pixel(1, '51'))),
      ask('How many visiting boats were counted in October?', NA, missing('The chart ends in September.')),
    ],
  });

  items.push({
    id: 'p28-mixed-agreement', kind: 'pdf', language: 'en', size: 'Letter', font: 'mono', categories: [],
    pages: async () => [
      { body: sheet('Brambleton Tool Library', 'Equipment loan agreement', P('1. Parties. Brambleton Tool Library lends to Lanternfield School.', '2. Equipment. One floor sander, model FS-90, and two dust extractors.', '3. Loan period. 14 days from collection.'), 'Agreement · sheet 1') },
      { body: sheet('Brambleton Tool Library', 'Equipment loan agreement', P('4. Deposit. 150 EUR, refundable on return.', '5. Late return. 12 EUR per day.', '6. Damage. The borrower pays for repairs up to 300 EUR.'), 'Agreement · sheet 2') },
      { look: { tilt: 0.7 }, scan: `<div style="font-size:12.5pt;line-height:1.7"><div style="font-weight:700;font-size:15pt;margin-bottom:6mm">Annex A — Collection record</div>${P('Collected on 8 September at 10:30 by Ferdinand Lowmoor.', 'Condition on collection: good.', 'Sanding belts supplied: 6.')}<br>Signature: ${hand('F. Lowmoor', 24)}<br><br>Counter-signed: ${hand('T. Quellwater', 22, 'Noteworthy')}</div>` },
      { body: sheet('Brambleton Tool Library', 'Equipment loan agreement', P('7. Contacts. Questions about this agreement go to the loans desk, extension 31.'), 'Agreement · sheet 4') },
    ],
    questions: [
      ask('What is the deposit, in EUR?', num(150), text(2, 'Deposit. 150 EUR')),
      ask('According to the collection record, who collected the equipment?', exact('Ferdinand Lowmoor'), pixel(3, 'Ferdinand Lowmoor')),
      ask('How many sanding belts were supplied at collection?', num(6), pixel(3, 'Sanding belts supplied: 6')),
      ask('The loan period starts at collection. By which date must the equipment be returned?', oneOf('22 September', 'September 22'), pixel(3, 'Collected on 8 September', text(1, '14 days from collection')), 'two-pages'),
      ask('What is the serial number of the floor sander?', NA, missing('Only the model, FS-90, is given.', ['serial'])),
    ],
  });

  {
    assert.equal(620 + 180, 800);
    const scanPage = (title, ...lines) => `<div style="font-size:12.5pt;line-height:1.7"><div style="font-weight:700;font-size:15pt;margin-bottom:6mm">${esc(title)}</div>${P(...lines)}</div>`;
    items.push({
      id: 'p29-fascicolo-misto', kind: 'pdf', language: 'it', categories: [],
      pages: async () => [
        { body: sheet('Comune di Castelvento · Sportello edilizia', 'Fascicolo della pratica n. 77/B', P('Richiedente: Azienda Larice. Oggetto: ampliamento del capannone.', 'Responsabile del procedimento: Ginevra Stolfi.')
          + table(['Documento', 'Pagina', 'Tipo'], [['Domanda', '2', 'copia scansionata'], ['Relazione tecnica', '3', 'testo'], ['Ricevuta di versamento', '4', 'copia scansionata'], ["Parere dell'ufficio", '5', 'testo'], ['Verbale di sopralluogo', '6', 'copia scansionata']]), 'Pratica 77/B · pagina 1') },
        { look: { tilt: 0.6 }, scan: scanPage('Domanda di ampliamento', 'Il sottoscritto Demetrio Falasca chiede di ampliare il capannone di 180 metri quadrati.', 'Data: 4 maggio.') + hand('D. Falasca', 24) },
        { body: sheet('Comune di Castelvento · Sportello edilizia', 'Relazione tecnica', P('Superficie attuale del capannone: 620 metri quadrati.', 'Altezza massima prevista: 7,5 metri.', 'Progettista: arch. Morgana Belisari.'), 'Pratica 77/B · pagina 3') },
        { look: { tilt: -0.5, gray: true }, scan: scanPage('Ricevuta di versamento n. 20417', 'Importo: 265,00 euro.', 'Causale: diritti di istruttoria.') },
        { body: sheet('Comune di Castelvento · Sportello edilizia', "Parere dell'ufficio", P('Parere favorevole con prescrizioni.', 'La superficie complessiva non deve superare 850 metri quadrati.'), 'Pratica 77/B · pagina 5') },
        { look: { tilt: 0.4, tint: '#f1efe9' }, scan: scanPage('Verbale di sopralluogo del 19 maggio', 'Presenti: G. Stolfi e D. Falasca.', 'Distanza dal confine misurata: 6,2 metri.', 'Esito: conforme.') },
      ],
      questions: [
        ask('Di quanti metri quadrati si chiede di ampliare il capannone?', num(180), pixel(2, '180 metri quadrati')),
        ask("Quale sarà la superficie complessiva del capannone dopo l'ampliamento richiesto, in metri quadrati?", num(800), pixel(2, '180 metri quadrati', text(3, '620 metri quadrati')), 'two-pages'),
        ask("Qual è l'importo della ricevuta che si trova nella quarta pagina fisica del file, in euro?", num(265), pixel(4, '265,00 euro'), 'physical-page'),
        ask('Chi è il progettista?', exact('Morgana Belisari'), text(3, 'Morgana Belisari')),
        ask('Quale distanza dal confine è stata misurata durante il sopralluogo, in metri?', num(6.2), pixel(6, '6,2 metri')),
        ask('Qual è il costo previsto dei lavori di ampliamento?', NA, missing('Il fascicolo non contiene un preventivo dei lavori.', ['preventivo', 'costo'])),
      ],
    });
  }

  items.push({
    id: 'p30-mixed-rotate-attr', kind: 'pdf', language: 'en', categories: ['rotated'],
    pages: async () => [
      { body: sheet('Marrowick Transit Authority', 'Vehicle inspection file — bus 4417', P('Depot: Eastmere. Inspector: Hesper Collingwood.', 'The following two pages are scans of the workshop sheets. Both carry a page rotation so that they read upright.')) },
      { turn: 270, rotate: 90, look: { tilt: 0.4 }, scan: `<div style="font-size:15pt;line-height:1.8"><div style="font-weight:700;font-size:19pt;margin-bottom:6mm">Brake test sheet</div>${P('Front axle: 61%.', 'Rear axle: 58%.', 'Parking brake: 24%.', 'Result: PASS.')}</div>` },
      { turn: 180, rotate: 180, look: { tilt: -0.5, tint: '#f1efe9' }, scan: `<div style="font-size:13pt;line-height:1.8"><div style="font-weight:700;font-size:16pt;margin-bottom:6mm">Tyre sheet</div>${P('Tread depth front left: 9 mm.', 'Tread depth front right: 8 mm.', 'Tread depth rear left: 6 mm.', 'Tread depth rear right: 7 mm.', 'Next inspection due at 182,000 km.')}</div>` },
    ],
    questions: [
      ask('Who is the inspector?', exact('Hesper Collingwood'), text(1, 'Inspector: Hesper Collingwood')),
      ask('What is the brake test result for the rear axle, in percent?', num(58), pixel(2, 'Rear axle: 58%')),
      ask('Which tyre has the lowest tread depth?', exact('rear left'), pixel(3, 'rear left: 6 mm')),
      ask('At how many kilometres is the next inspection due?', num(182000), pixel(3, '182,000 km')),
      ask('What is the registration plate of the bus?', NA, missing('The file identifies the bus by fleet number only.', ['registration'])),
    ],
  });

  {
    const dim = (x1, y1, x2, y2, label, lx, ly, anchor = 'start') => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#c8553d" stroke-width="1.6" marker-start="url(#d)" marker-end="url(#d)"/>${T(lx, ly, label, { size: 14, anchor, weight: 600, fill: '#c8553d' })}`;
    const bracket = svg(640, 400, `<defs><marker id="d" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#c8553d"/></marker></defs>
      <rect x="40" y="20" width="560" height="330" fill="#f3f3f0" stroke="#999"/><line x1="20" x2="620" y1="350" y2="350" stroke="#222" stroke-width="4"/>${T(600, 372, 'Floor', { size: 13, anchor: 'end' })}
      <rect x="240" y="110" width="160" height="70" fill="#dfe7f1" stroke="#222" stroke-width="2"/><circle cx="270" cy="145" r="7" fill="#fff" stroke="#222" stroke-width="2"/><circle cx="370" cy="145" r="7" fill="#fff" stroke="#222" stroke-width="2"/>${T(320, 100, 'Wall bracket', { size: 13, anchor: 'middle' })}
      ${dim(270, 205, 370, 205, 'Hole spacing 96 mm', 320, 226, 'middle')}${dim(200, 180, 200, 350, 'Height above floor 1350 mm', 190, 270, 'end')}${dim(450, 20, 450, 110, 'Clearance 150 mm', 460, 70)}`);
    const wire = (i, colour, name, role) => `<rect x="${70 + i * 130}" y="60" width="90" height="70" fill="#eee" stroke="#222" stroke-width="2"/>${T(115 + i * 130, 104, i + 1, { size: 26, anchor: 'middle', weight: 700 })}<line x1="${115 + i * 130}" x2="${115 + i * 130}" y1="130" y2="220" stroke="${colour}" stroke-width="10"/><line x1="${115 + i * 130}" x2="${115 + i * 130}" y1="130" y2="220" stroke="#222" stroke-width="12" stroke-opacity=".12"/>${T(115 + i * 130, 246, `${i + 1} ${name}`, { size: 14, anchor: 'middle', weight: 600 })}${T(115 + i * 130, 266, role, { size: 13, anchor: 'middle' })}`;
    const block = svg(640, 290, `${T(70, 36, 'Terminal block, seen from the front', { size: 14, weight: 600 })}${wire(0, '#8a5a2b', 'BROWN', 'LIVE')}${wire(1, '#2f6fd0', 'BLUE', 'NEUTRAL')}${wire(2, '#2e9b4f', 'GREEN', 'EARTH')}${wire(3, '#f4f4f4', 'WHITE', 'DATA')}`);
    const foot = (label) => `Installer's guide · ${label}`;
    items.push({
      id: 'p31-mixed-manual', kind: 'pdf', language: 'en', size: 'Letter', categories: ['diagram', 'page-labels'],
      pages: async (h) => [
        { body: sheet('Pellworth Desk', "Installer's guide for the model K terminal", P('Document PD-IG-014, revision 3.')) },
        { label: 'ii', body: sheet('Pellworth Desk', 'Contents', table(null, [['1 Unpacking', n('1')], ['2 Mounting', n('2')], ['3 Wiring', n('3')], ['4 First start', n('4')]], 'width:60%') + P('Appendix A, the scanned workshop notes, follows section 4.'), foot('ii')) },
        { label: '1', body: sheet('Pellworth Desk', '1 Unpacking', P('The carton contains the terminal, a wall bracket, four M5 screws and a 2.4 m power lead.', 'Keep the carton until the terminal has passed its first start.'), foot('1')) },
        { label: '2', body: sheet('Pellworth Desk', '2 Mounting', P('Fix the bracket to a solid wall. All dimensions are given in figure 2 only.') + `<figure>${await h.figure(bracket, 640, 400)}<figcaption>Figure 2. Bracket position.</figcaption></figure>`, foot('2')) },
        { label: '3', body: sheet('Pellworth Desk', '3 Wiring', P('Switch off the supply before wiring. The terminal order is given in figure 3 only.') + `<figure>${await h.figure(block, 640, 290)}<figcaption>Figure 3. Terminal block.</figcaption></figure>`, foot('3')) },
        { label: '4', body: sheet('Pellworth Desk', '4 First start', P('Hold the side button for 5 seconds.', 'The status lamp turns steady within 40 seconds.'), foot('4')) },
        { label: 'A-1', look: { tilt: 0.5 }, scan: `<div style="position:relative;height:100%"><div style="font-size:12.5pt;line-height:1.7"><div style="font-weight:700;font-size:15pt;margin-bottom:6mm">Appendix A — Workshop notes</div>${hand('Note 1: units with serial numbers below 2200', 21)}<br>${hand('need bracket shim S-3.', 21)}</div><div style="position:absolute;left:0;right:0;bottom:0;text-align:center;font-size:10pt">A-1</div></div>` },
        { label: 'A-2', look: { tilt: -0.4 }, scan: `<div style="position:relative;height:100%"><div style="font-size:12.5pt;line-height:1.7"><div style="font-weight:700;font-size:15pt;margin-bottom:6mm">Appendix A — Workshop notes</div>${hand('Note 2: torque for the M5 screws is 4.5 N·m.', 21)}<br>${hand('Checked by Ottoline Marsh.', 21)}</div><div style="position:absolute;left:0;right:0;bottom:0;text-align:center;font-size:10pt">A-2</div></div>` },
      ],
      questions: [
        ask('According to figure 2, at what height above the floor is the bracket mounted, in millimetres?', num(1350), pixel(4, '1350 mm')),
        ask('According to figure 3, which wire colour goes to terminal 3?', oneOf('green'), pixel(5, '3 GREEN'), 'colour'),
        ask('What label is printed at the bottom of the seventh physical page?', exact('A-1'), pixel(7, 'A-1'), 'printed-label', 'physical-page'),
        ask('How long is the power lead in the carton, and within how many seconds does the status lamp turn steady? Give both numbers.', allOf('2.4', '40'), text(3, '2.4 m power lead', text(6, 'within 40 seconds')), 'two-pages'),
        ask('Figure 2 gives the hole spacing and a workshop note names a shim for early units. State both.', allOf('96', 'S-3'), pixel(4, '96 mm', pixel(7, 'S-3')), 'two-pages'),
        ask('Who checked the workshop note on the last physical page?', exact('Ottoline Marsh'), pixel(8, 'Ottoline Marsh'), 'physical-page'),
        ask("What is the network address of the terminal's configuration page?", NA, missing('The guide covers unpacking, mounting, wiring and first start only.', ['address'])),
      ],
    });
  }

  {
    assert.equal(184 + 96 + 220, 500); assert.equal(232 + 305 + 141, 678); assert.equal(416 + 401 + 361, 1178); assert.equal(500 + 678, 1178);
    items.push({
      id: 'p32-prospetto-landscape', kind: 'pdf', language: 'it', font: 'mono', categories: ['rotated', 'table'],
      pages: async () => [
        { body: sheet('Consorzio Valfrasca', 'Prospetto dei conferimenti', P('Conferimenti di uva per azienda nella vendemmia in corso, in quintali.', 'Il prospetto alla pagina seguente è in formato orizzontale.', 'Compilato da Ilario Ventresca.')) },
        { turn: 270, rotate: 90, body: `<h1>Conferimenti di uva (quintali)</h1>${table(['Azienda', n('Uva bianca'), n('Uva rossa'), n('Totale')], [['Az. Colle Chiaro', n(184), n(232), n(416)], ['Az. Fontenera', n(96), n(305), n(401)], ['Az. Poggio Salice', n(220), n(141), n(361)], [{ t: 'Totale', b: true }, { t: 500, n: true, b: true }, { t: 678, n: true, b: true }, { t: '1.178', n: true, b: true }]])}` },
      ],
      questions: [
        ask("Quanti quintali di uva rossa ha conferito l'azienda Fontenera?", num(305), text(2, 'Az. Fontenera 96 305 401')),
        ask('Qual è il totale complessivo dei conferimenti, in quintali?', num(1178), text(2, 'Totale 500 678 1.178')),
        ask('Chi ha compilato il prospetto?', exact('Ilario Ventresca'), text(1, 'Compilato da Ilario Ventresca')),
        ask("Qual è il prezzo pagato al quintale per l'uva bianca?", NA, missing('Il prospetto riporta solo quantità.', ['prezzo'])),
      ],
    });
  }

  return items;
}

// ---- the images -------------------------------------------------------------
function imageItems() {
  const items = [];
  const ui = 'color:#1c2330';

  {
    const pill = (status) => `<span style="padding:4px 12px;border-radius:12px;font-size:13px;font-weight:600;background:${{ Open: '#fde8b5', 'In progress': '#cfe0fb', Closed: '#d5ecd9' }[status]}">${status}</span>`;
    const rows = [['#4102', 'Printer offline in room 12', 'Open', 'Mira K.'], ['#4103', 'Badge reader beeps twice', 'In progress', 'Jonas P.'], ['#4104', 'Projector lamp flickers', 'Open', 'Unassigned'], ['#4105', 'Door sensor battery low', 'Closed', 'Mira K.'], ['#4106', 'Wi-Fi drops in the annex', 'Open', 'Tess W.']];
    items.push({
      id: 'i01-ui-tickets', kind: 'image', language: 'en', categories: ['ui'], width: 1100, height: 560,
      html: `<div style="${ui};display:flex;height:100%"><div style="width:200px;background:#1f2a44;color:#dfe6f5;padding:22px 18px;font-size:15px;line-height:2.3"><div style="font-weight:700;font-size:19px;color:#fff;margin-bottom:14px">Pellworth Desk</div>Tickets<br>Assets<br>Rooms<br>Reports</div>
        <div style="flex:1;padding:24px 30px;background:#f5f6f9"><div style="font-size:22px;font-weight:700;margin-bottom:16px">Tickets</div>
        <div style="background:#fff;border:1px solid #d7dbe3;border-radius:8px">${rows.map(([id, title, status, who]) => `<div style="display:flex;align-items:center;padding:16px 20px;border-bottom:1px solid #e6e9ef;font-size:15px"><span style="width:80px;font-weight:600">${id}</span><span style="flex:1">${title}</span><span style="width:140px">${pill(status)}</span><span style="width:120px;color:#48536a">${who}</span></div>`).join('')}</div></div></div>`,
      questions: [
        ask('What is the status of ticket #4103?', exact('In progress'), shown('#4103 Badge reader beeps twice — In progress')),
        ask('Who is assigned to the ticket about the Wi-Fi?', exact('Tess W.'), shown('#4106 Wi-Fi drops in the annex — Tess W.')),
        ask('How many tickets in the list have the status Open?', num(3), visual(shown('#4102, #4104 and #4106 are Open'), 'Three rows carry the Open pill.'), 'count'),
        ask('On what date was ticket #4105 closed?', NA, missing('The list shows a status, never a date.')),
      ],
    });
  }

  {
    const toggle = (on) => `<span style="display:inline-block;width:52px;height:30px;border-radius:15px;background:${on ? '#2e9b4f' : '#c5cad3'};position:relative"><i style="position:absolute;top:3px;${on ? 'right' : 'left'}:3px;width:24px;height:24px;border-radius:50%;background:#fff"></i></span>`;
    const row = (label, right) => `<div style="display:flex;justify-content:space-between;align-items:center;padding:18px 24px;border-bottom:1px solid #e6e9ef;font-size:17px"><span>${label}</span>${right}</div>`;
    items.push({
      id: 'i02-ui-impostazioni', kind: 'image', language: 'it', categories: ['ui'], width: 760, height: 560,
      html: `<div style="${ui};background:#f5f6f9;height:100%;padding:26px 34px"><div style="font-size:24px;font-weight:700;margin-bottom:18px">Fogliame — Impostazioni</div><div style="background:#fff;border:1px solid #d7dbe3;border-radius:10px">
        ${row('Notifiche', toggle(true))}${row('Modalità scura', toggle(false))}${row('Sincronizzazione automatica', toggle(true))}${row('Suoni', toggle(false))}${row('Lingua', '<span style="color:#48536a">Italiano</span>')}${row('Spazio usato', '<span style="color:#48536a">412 MB di 2 GB</span>')}</div>
        <div style="margin-top:18px;color:#6b7488;font-size:14px">Versione 3.8.2</div></div>`,
      questions: [
        ask('Quali interruttori sono attivi nella schermata?', allOf('Notifiche', 'Sincronizzazione automatica'), visual(shown('Notifiche e Sincronizzazione automatica'), 'Due interruttori sono verdi con il cursore a destra; gli altri due sono grigi con il cursore a sinistra.'), 'colour', 'position'),
        ask("Quale versione dell'applicazione è indicata?", exact('3.8.2'), shown('Versione 3.8.2')),
        ask('Quanto spazio risulta usato, in MB?', num(412), shown('412 MB di 2 GB')),
        ask("Qual è l'indirizzo email dell'account?", NA, missing('La schermata non mostra alcun account.')),
      ],
    });
  }

  {
    const tile = (label, value, extra = '') => `<div style="flex:1;background:#fff;border:1px solid #d7dbe3;border-radius:10px;padding:18px 20px"><div style="color:#5a6478;font-size:14px">${label}</div><div style="font-size:30px;font-weight:700;margin-top:6px">${value}</div>${extra}</div>`;
    assert.equal(210 - 148, 62);
    items.push({
      id: 'i03-ui-dashboard', kind: 'image', language: 'en', categories: ['ui', 'chart'], width: 1100, height: 560,
      html: `<div style="${ui};background:#eef1f6;height:100%;padding:26px 30px"><div style="font-size:23px;font-weight:700">Tidewell Marina — Harbour board</div>
        <div style="margin:16px 0;background:#fde2df;border:1px solid #e3a29b;border-radius:8px;padding:12px 16px;font-size:16px;font-weight:600">Crane out of service until Thursday</div>
        <div style="display:flex;gap:16px">${tile('Berths occupied', '148 / 210')}${tile('Boats arriving today', '12')}${tile('Fuel sold (litres)', '3,460')}${tile('Wind', '17 kn NW')}</div>
        <div style="margin-top:16px;background:#fff;border:1px solid #d7dbe3;border-radius:10px;padding:14px 20px">${barChart({ title: 'Arrivals this week', labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], values: [9, 14, 12, 7, 16], yMax: 20, yStep: 5, width: 1000, height: 220 })}</div></div>`,
      questions: [
        ask('How many berths are occupied?', num(148), shown('Berths occupied 148 / 210')),
        ask('How many berths are free?', num(62), shown('Berths occupied 148 / 210')),
        ask('Until which day is the crane out of service?', exact('Thursday'), shown('Crane out of service until Thursday')),
        ask('How many arrivals does the chart show for Friday?', num(16), shown('Fri 16')),
        ask('What is the water temperature in the harbour?', NA, missing('The board shows berths, arrivals, fuel and wind only.')),
      ],
    });
  }

  {
    const bubble = (who, time, message) => `<div style="margin:0 18px 16px"><div style="font-size:13px;color:#5a6478;margin-bottom:4px"><b style="color:#1c2330">${who}</b> · ${time}</div><div style="display:inline-block;background:#fff;border:1px solid #d7dbe3;border-radius:14px;padding:11px 15px;font-size:16px;max-width:320px">${message}</div></div>`;
    items.push({
      id: 'i04-ui-chat', kind: 'image', language: 'it', categories: ['ui'], width: 420, height: 620, scale: 2,
      html: `<div style="${ui};background:#e9edf3;height:100%"><div style="background:#2a6f97;color:#fff;padding:18px;font-size:19px;font-weight:700;margin-bottom:18px">Fogliame · Gruppo Orto</div>
        ${bubble('Bruna', '08:14', 'Chi apre il cancello oggi?')}${bubble('Oreste', '08:20', 'Io, alle 9.')}${bubble('Fosca', '08:31', 'Porto io le piantine di basilico, sono 24.')}${bubble('Bruna', '08:33', 'Perfetto, ci vediamo al lotto 12.')}</div>`,
      questions: [
        ask("Chi ha scritto l'ultimo messaggio della conversazione?", exact('Bruna'), shown('Bruna · 08:33')),
        ask('Quante piantine di basilico porta Fosca?', num(24), shown('Porto io le piantine di basilico, sono 24.')),
        ask('A che ora è stato inviato il messaggio di Oreste?', exact('08:20'), shown('Oreste · 08:20')),
        ask("A che ora finisce l'incontro all'orto?", NA, missing('Nessun messaggio indica un orario di fine.')),
      ],
    });
  }

  items.push({
    id: 'i05-chart-bars', kind: 'image', language: 'en', categories: ['chart'], width: 900, height: 520,
    html: barChart({ title: 'Books borrowed per weekday — Lanternfield School Library', labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], values: [60, 80, 40, 100, 80], yMax: 120, yStep: 20, width: 900, height: 520, showValues: false, note: 'Bars carry no value labels: read the values from the axis.' }),
    questions: [
      ask('What value does the Thursday bar reach?', num(100, { tolerance: 3 }), visual(shown('Thu bar ends on the gridline 100'), 'No value is printed on the bar; it must be read against the axis.')),
      ask('Which weekday has the lowest bar?', oneOf('Wednesday', 'Wed'), visual(shown('Wed bar ends on the gridline 40'), 'The Wed bar is the shortest.')),
      ask('Which two weekdays have bars of the same height?', allOf('Tue', 'Fri'), visual(shown('Tue and Fri bars both end on the gridline 80'), 'Two bars end on the same gridline.')),
      ask('How many books were borrowed on Saturday?', NA, missing('The chart covers Monday to Friday.')),
    ],
  });

  items.push({
    id: 'i06-grafico-linee', kind: 'image', language: 'it', categories: ['chart'], width: 920, height: 540,
    html: lineChart({ title: 'Stazione meteo di Colle Tasso — settimana 20 (gradi)', labels: ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'], legend: true, width: 920, height: 540, yMin: 0, yMax: 30, yStep: 5,
      series: [{ name: 'Temperatura massima', color: '#c8553d', values: [18, 21, 24, 22, 19, 17, 20] }, { name: 'Temperatura minima', color: '#2a6f97', values: [9, 11, 13, 14, 10, 8, 9], below: true }] }),
    questions: [
      ask('Qual è stata la temperatura massima di mercoledì?', num(24), shown('Mer, linea rossa: 24')),
      ask('In quale giorno la temperatura minima è stata più bassa?', oneOf('sabato', 'Sab'), shown('Sab, linea blu: 8')),
      ask('Qual è la differenza tra massima e minima di giovedì, in gradi?', num(8), shown('Gio: 22 e 14')),
      ask('Di che colore è la linea della temperatura minima?', oneOf('blu', 'azzurro', 'blue'), visual(shown('Temperatura minima'), 'La legenda associa Temperatura minima alla linea blu.'), 'colour'),
      ask('Quanti millimetri di pioggia sono caduti domenica?', NA, missing('Il grafico riporta solo temperature.')),
    ],
  });

  items.push({
    id: 'i07-chart-pie', kind: 'image', language: 'en', categories: ['chart'], width: 700, height: 420,
    html: pieChart({ title: 'Brambleton Tool Library — Loans by category', width: 700, height: 420, slices: [{ name: 'Hand tools', value: 48, color: '#3b6ea5' }, { name: 'Power tools', value: 28, color: '#e0a030' }, { name: 'Garden', value: 17, color: '#4f9d69' }, { name: 'Ladders', value: 7, color: '#c8553d' }] }),
    questions: [
      ask('What share of the loans are power tools, in percent?', num(28), shown('Power tools 28%')),
      ask('Which category is the largest?', exact('Hand tools'), shown('Hand tools 48%')),
      ask('What is the combined share of Garden and Ladders, in percent?', num(24), shown('Garden 17%', shown('Ladders 7%'))),
      ask('Which colour is the Garden slice?', oneOf('green'), visual(shown('Garden 17%'), 'The legend square next to Garden is green.'), 'colour'),
      ask('How many loans were made in total?', NA, missing('The chart shows shares, no totals.')),
    ],
  });

  {
    const cell = 'border:1px solid #444;padding:12px 16px';
    const rows = [['18', 'Corin Vale', '4417', 'Dara Finch', '4390'], ['22', 'Mabel Thorne', '4402', 'Corin Vale', '4417'], ['31', 'Dara Finch', '4390', 'Pia Lindqvist', '4455']];
    items.push({
      id: 'i08-table-roster', kind: 'image', language: 'en', categories: ['table'], width: 900, height: 380,
      html: `<div style="${ui};padding:24px"><div style="font-size:20px;font-weight:700;margin-bottom:12px">Marrowick Transit Authority — Depot roster</div><table style="border-collapse:collapse;width:100%;font-size:16px;margin:0">
        <tr style="background:#dfe5ee;font-weight:700"><td rowspan="2" style="${cell}">Route</td><td colspan="2" style="${cell};text-align:center">Morning</td><td colspan="2" style="${cell};text-align:center">Evening</td></tr>
        <tr style="background:#edf0f5;font-weight:600"><td style="${cell}">Driver</td><td style="${cell}">Bus</td><td style="${cell}">Driver</td><td style="${cell}">Bus</td></tr>
        ${rows.map((row) => `<tr>${row.map((value) => `<td style="${cell}">${value}</td>`).join('')}</tr>`).join('')}
        <tr style="font-weight:700"><td colspan="4" style="${cell}">Buses in service</td><td style="${cell}">4</td></tr></table></div>`,
      questions: [
        ask('Who drives route 22 in the morning?', exact('Mabel Thorne'), shown('22 | Mabel Thorne | 4402')),
        ask('Which bus does Pia Lindqvist drive?', exact('4455'), shown('Pia Lindqvist | 4455')),
        ask('On which routes does Corin Vale drive?', allOf('18', '22'), shown('18 morning: Corin Vale', shown('22 evening: Corin Vale'))),
        ask('How many buses are in service according to the last row?', num(4), shown('Buses in service 4')),
        ask('Who drives route 40?', NA, missing('The roster lists routes 18, 22 and 31.')),
      ],
    });
  }

  {
    const rows = [['Acquagym', 'Lunedì', '18:00', 'Piccola', 4], ['Nuoto adulti', 'Martedì', '19:30', 'Grande', 0], ['Nuoto bambini', 'Mercoledì', '16:45', 'Piccola', 7], ['Apnea', 'Giovedì', '20:15', 'Grande', 2]];
    assert.equal(sum(rows.map((row) => row[4])), 13);
    items.push({
      id: 'i09-tabella-corsi', kind: 'image', language: 'it', categories: ['table'], width: 900, height: 380,
      html: `<div style="${ui};padding:24px"><div style="font-size:20px;font-weight:700;margin-bottom:4px">Piscina comunale di Castelvento — Corsi</div>${table(['Corso', 'Giorno', 'Ora', 'Vasca', n('Posti liberi')], [...rows.map((row) => [row[0], row[1], row[2], row[3], n(row[4])]), [{ t: 'Totale posti liberi', colspan: 4, b: true }, { t: 13, n: true, b: true }]], 'font-size:16px')}</div>`,
      questions: [
        ask('A che ora inizia il corso di apnea?', exact('20:15'), shown('Apnea | Giovedì | 20:15')),
        ask('Quale corso non ha posti liberi?', exact('Nuoto adulti'), shown('Nuoto adulti | 0')),
        ask('Quanti posti liberi ci sono in totale?', num(13), shown('Totale posti liberi 13')),
        ask("Quanto costa l'iscrizione al corso di acquagym?", NA, missing('La tabella non riporta prezzi.')),
      ],
    });
  }

  items.push({
    id: 'i10-handwritten-note', kind: 'image', language: 'en', categories: ['handwriting'], width: 640, height: 480, background: '#cfc8b8',
    html: `<div style="position:absolute;left:70px;top:50px;width:500px;height:380px;background:#fff3a6;box-shadow:4px 6px 14px rgba(0,0,0,.3);transform:rotate(-3deg);padding:34px 36px;color:#1d2a5c;font-family:'Bradley Hand';font-size:31px;line-height:1.45">Mira — the spare key for locker 58 is with Jonas.<br>Call ext. 304 before 4 pm.<br><span style="display:block;text-align:right">— Tess</span></div>`,
    questions: [
      ask('Which locker is the spare key for?', num(58), shown('locker 58')),
      ask('Who has the spare key?', exact('Jonas'), shown('is with Jonas')),
      ask('Which extension should be called?', exact('304'), shown('ext. 304')),
      ask('Why does Mira need the spare key?', NA, missing('The note gives no reason.')),
    ],
  });

  items.push({
    id: 'i11-lista-corsivo', kind: 'image', language: 'it', categories: ['handwriting'], width: 560, height: 640, background: '#fbfbf6',
    html: `<div style="position:absolute;inset:0;background:repeating-linear-gradient(#fbfbf6 0 47px,#b9cbe0 47px 48px)"></div><div style="position:absolute;left:60px;top:26px;right:30px;color:#22306b"><div style="font-family:'Snell Roundhand';font-size:44px;line-height:70px">Lista per sabato</div>
      <div style="font-family:'Noteworthy';font-size:28px;line-height:48px;margin-top:2px">6 uova<br>2 kg di farina<br>burro 250 g<br>3 limoni<br>lievito<br>1 litro di latte</div></div>`,
    questions: [
      ask('Quanti limoni ci sono nella lista?', num(3), shown('3 limoni')),
      ask('Quanti chili di farina sono indicati?', num(2), shown('2 kg di farina')),
      ask('Quale voce della lista è scritta senza quantità?', exact('lievito'), shown('lievito')),
      ask('In quale negozio va fatta la spesa?', NA, missing('La lista non nomina alcun negozio.')),
    ],
  });

  items.push({
    id: 'i12-poster-stylised', kind: 'image', language: 'en', categories: ['stylised-font'], width: 640, height: 800, background: '#1b2440',
    html: `<div style="position:absolute;inset:0;background:radial-gradient(circle at 50% 20%,#34406b,#141a30);color:#ffe9a8;text-align:center;padding:56px 40px">
      <div style="font-family:'Chalkduster';font-size:50px;line-height:1.2">MIDSUMMER LANTERN WALK</div>
      <div style="font-family:'Papyrus';font-size:30px;margin-top:38px;color:#fff">Saturday 21 June · starts 9:15 pm</div>
      <div style="font-family:'Snell Roundhand';font-size:44px;margin-top:40px">Meet at the Old Quay steps</div>
      <div style="font-family:'American Typewriter';font-size:24px;margin-top:54px;color:#fff;line-height:1.7">Bring a lantern<br>Tickets 4 EUR · Children free</div></div>`,
    questions: [
      ask('At what time does the lantern walk start?', oneOf('9:15 pm', '21:15', '9:15'), shown('starts 9:15 pm')),
      ask('Where do participants meet?', exact('Old Quay steps'), shown('Meet at the Old Quay steps')),
      ask('How much is a ticket, in EUR?', num(4), shown('Tickets 4 EUR')),
      ask('Who organises the lantern walk?', NA, missing('The poster names no organiser.')),
    ],
  });

  items.push({
    id: 'i13-label-small-text', kind: 'image', language: 'en', categories: ['small-text'], width: 640, height: 400, background: '#ddd6c8', smallestTextPx: 10,
    html: `<div style="${ui};position:absolute;left:40px;top:34px;width:560px;height:332px;background:#fbf7ec;border:2px solid #7a5b34;border-radius:10px;padding:22px 26px">
      <div style="font-size:30px;font-weight:800;color:#5a3b17">Harbourlight Rye Crispbread</div><div style="font-size:15px;margin-top:4px">Baked slowly, twice.</div>
      <div style="font-size:10px;line-height:1.6;margin-top:96px;color:#222">Ingredients: rye flour, water, sea salt, caraway. Store in a dry place.<br>Energy per 100 g: 1,420 kJ. Net weight 250 g.<br>Best before 14 NOV. Batch L-20931.</div></div>`,
    questions: [
      ask('What is the batch code on the label?', exact('L-20931'), shown('Batch L-20931')),
      ask('What is the net weight, in grams?', num(250), shown('Net weight 250 g')),
      ask('Which spice is listed among the ingredients?', exact('caraway'), shown('rye flour, water, sea salt, caraway')),
      ask('In which country was the crispbread produced?', NA, missing('The label names no country.')),
    ],
  });

  items.push({
    id: 'i14-biglietto-small', kind: 'image', language: 'it', categories: ['small-text'], width: 760, height: 320, background: '#d8d3c7', smallestTextPx: 10,
    html: `<div style="${ui};position:absolute;left:30px;top:30px;width:700px;height:260px;background:#fff8e8;border:2px dashed #8a6d3b;padding:22px 28px">
      <div style="font-size:15px;color:#6b5527">Teatro Comunale di Montefosco</div><div style="font-size:30px;font-weight:800;margin-top:4px">La lanterna del mugnaio</div>
      <div style="font-size:19px;margin-top:14px">Sabato 8 marzo, ore 20:45 · Ingresso B</div><div style="font-size:24px;font-weight:700;margin-top:10px">Fila G — Posto 14</div>
      <div style="font-size:10px;margin-top:26px;color:#333">Biglietto n. 004417 — non rimborsabile — prezzo 18,00 euro — conservare fino al termine dello spettacolo</div></div>`,
    questions: [
      ask('Quali sono la fila e il posto indicati sul biglietto?', allOf('G', '14'), shown('Fila G — Posto 14')),
      ask('A che ora inizia lo spettacolo?', exact('20:45'), shown('ore 20:45')),
      ask('Qual è il numero del biglietto, stampato in piccolo?', exact('004417'), shown('Biglietto n. 004417')),
      ask('Chi è il regista dello spettacolo?', NA, missing('Il biglietto non nomina il regista.')),
    ],
  });

  items.push({
    id: 'i15-sign-rotated', kind: 'image', language: 'en', categories: ['rotated'], width: 440, height: 760, rotation: 90, background: '#3a3f47',
    html: rotated(`<div style="${ui};position:absolute;left:30px;top:30px;width:700px;height:380px;background:#f2c230;border:8px solid #1c1c1c;padding:26px 34px;color:#1c1c1c"><div style="font-size:54px;font-weight:800">LOADING BAY 3</div><div style="font-size:30px;font-weight:600;margin-top:18px;line-height:1.6">Deliveries 7:00–15:30<br>Max height 3.8 m<br>Report to gatehouse B</div></div>`, 760, 440, 90),
    questions: [
      ask('What is the maximum height on the sign, in metres?', num(3.8), shown('Max height 3.8 m')),
      ask('Which gatehouse should drivers report to?', exact('B'), shown('Report to gatehouse B')),
      ask('Until what time are deliveries accepted?', oneOf('15:30', '3:30 pm'), shown('Deliveries 7:00–15:30')),
      ask('What is the speed limit in the yard?', NA, missing('The sign gives no speed limit.')),
    ],
  });

  items.push({
    id: 'i16-ricevuta-capovolta', kind: 'image', language: 'it', categories: ['rotated'], width: 480, height: 600, rotation: 180, background: '#c9c4b8',
    html: rotated(`<div class="mono" style="position:absolute;left:60px;top:50px;width:360px;height:500px;background:#fdfdfb;padding:30px 26px;font-size:19px;line-height:1.9;color:#111"><div style="font-weight:700;font-size:22px;text-align:center">Parcheggio<br>Piazza dei Tigli</div><br>Ingresso 14:05<br>Uscita 16:50<br>Posto n. 37<br>Tariffa 5,50 euro<br><div style="text-align:center;margin-top:18px">Grazie</div></div>`, 480, 600, 180),
    questions: [
      ask("A che ora è avvenuto l'ingresso nel parcheggio?", exact('14:05'), shown('Ingresso 14:05')),
      ask('Qual è la tariffa pagata, in euro?', num(5.5), shown('Tariffa 5,50 euro')),
      ask('Qual è il numero del posto?', num(37), shown('Posto n. 37')),
      ask('Qual è la targa del veicolo?', NA, missing('La ricevuta non riporta targhe.')),
    ],
  });

  items.push({
    id: 'i17-low-contrast', kind: 'image', language: 'en', categories: ['low-contrast'], width: 820, height: 360, background: '#c9c9c4',
    html: `<div style="${ui};position:absolute;inset:26px;border:3px solid #bdbdb7;border-radius:8px;color:#a9a9a2;text-align:center;padding-top:44px"><div style="font-size:60px;font-weight:800">ROOM 214</div><div style="font-size:34px;font-weight:700;margin-top:6px">ARCHIVE</div><div style="font-size:24px;font-weight:600;margin-top:22px">KEYHOLDER: O. FERNBROOK · OPEN TUE &amp; THU</div></div>`,
    questions: [
      ask('What is the room number on the plaque?', num(214), shown('ROOM 214')),
      ask('Who is the keyholder?', oneOf('O. Fernbrook', 'Fernbrook'), shown('KEYHOLDER: O. FERNBROOK')),
      ask('On which days is the archive open?', allOf('Tue', 'Thu'), shown('OPEN TUE & THU')),
      ask('At what time does the archive open?', NA, missing('The plaque gives days, no times.')),
    ],
  });

  items.push({
    id: 'i18-basso-contrasto', kind: 'image', language: 'it', categories: ['low-contrast'], width: 820, height: 360, background: '#10141c',
    html: `<div class="mono" style="position:absolute;inset:0;background:#10141c;color:#34425c;padding:44px 50px;font-weight:700"><div style="font-size:44px">USCITA 6 — Binario 3</div><div style="font-size:30px;margin-top:22px">Regionale per Pieve Alta</div><div style="font-size:30px;margin-top:14px">partenza 21:42 · ritardo 15 min</div></div>`,
    questions: [
      ask('Da quale binario parte il treno?', num(3), shown('Binario 3')),
      ask('Di quanti minuti è il ritardo?', num(15), shown('ritardo 15 min')),
      ask('Qual è la destinazione del treno?', exact('Pieve Alta'), shown('Regionale per Pieve Alta')),
      ask('Qual è il numero del treno?', NA, missing('Il tabellone non riporta il numero del treno.')),
    ],
  });

  items.push({
    id: 'i19-diagram-flow', kind: 'image', language: 'en', categories: ['diagram'], width: 760, height: 530,
    html: flowchart({ width: 760, height: 530, title: 'Library — returned book', nodes: [
      { id: 'a', x: 260, y: 70, w: 190, h: 44, kind: 'end', text: 'Book returned' }, { id: 'b', x: 260, y: 150, w: 190, h: 44, text: 'Scan barcode' },
      { id: 'c', x: 260, y: 255, w: 290, h: 96, kind: 'decision', text: 'Reserved by another member?' }, { id: 'd', x: 610, y: 255, w: 210, h: 44, kind: 'end', text: 'Place on hold shelf' },
      { id: 'e', x: 260, y: 385, w: 200, h: 84, kind: 'decision', text: 'Damaged?' }, { id: 'f', x: 610, y: 385, w: 210, h: 44, kind: 'end', text: 'Send to repair desk' }, { id: 'g', x: 260, y: 490, w: 190, h: 44, kind: 'end', text: 'Reshelve' }],
    edges: [{ from: ['a', 'bottom'], to: ['b', 'top'] }, { from: ['b', 'bottom'], to: ['c', 'top'] }, { from: ['c', 'right'], to: ['d', 'left'], label: 'Yes' }, { from: ['c', 'bottom'], to: ['e', 'top'], label: 'No' },
      { from: ['e', 'right'], to: ['f', 'left'], label: 'Yes' }, { from: ['e', 'bottom'], to: ['g', 'top'], label: 'No' }] }),
    questions: [
      ask('What happens to a returned book that is reserved by another member?', exact('hold shelf'), shown('Place on hold shelf')),
      ask('What is the first step after a book is returned?', exact('Scan barcode'), shown('Scan barcode')),
      ask('What happens to a book that is neither reserved nor damaged?', oneOf('Reshelve', 'reshelved'), shown('Reshelve')),
      ask('How many diamond-shaped decisions are in the diagram?', num(2), visual(shown('Reserved by another member? / Damaged?'), 'Two diamonds are drawn.'), 'count', 'shape'),
      ask('For how many days is a book kept on the hold shelf?', NA, missing('The diagram gives no durations.')),
    ],
  });

  items.push({
    id: 'i20-piantina', kind: 'image', language: 'it', categories: ['diagram'], width: 640, height: 410,
    html: floorPlan({ width: 640, height: 410, rooms: [['Balcone', 4, 20, 20, 80, 360], ['Soggiorno', 28, 100, 20, 240, 360], ['Cucina', 12, 340, 20, 170, 140], ['Bagno', 6, 510, 20, 110, 140], ['Corridoio', 5, 340, 160, 280, 56], ['Camera', 16, 340, 216, 280, 164]] }),
    questions: [
      ask('Quale stanza ha la superficie maggiore?', exact('Soggiorno'), shown('Soggiorno 28 m²')),
      ask('Qual è la superficie del bagno, in metri quadrati?', num(6), shown('Bagno 6 m²')),
      ask('Quale stanza confina con il balcone?', exact('Soggiorno'), visual(shown('Balcone'), 'Il balcone è disegnato a sinistra e tocca solo il soggiorno.'), 'position'),
      ask('Quanti locali, balcone compreso, sono disegnati nella piantina?', num(6), visual(shown('Balcone, Soggiorno, Cucina, Bagno, Corridoio, Camera'), 'Sei rettangoli con nome.'), 'count'),
      ask('Qual è l\'altezza dei soffitti?', NA, missing('La piantina riporta solo superfici.')),
    ],
  });

  {
    const circle = (x, y, fill) => `<circle cx="${x}" cy="${y}" r="42" fill="${fill}"/>`;
    const square = (x, y, fill) => `<rect x="${x - 40}" y="${y - 40}" width="80" height="80" fill="${fill}"/>`;
    const triangle = (x, y, fill) => `<polygon points="${x},${y - 46} ${x + 46},${y + 38} ${x - 46},${y + 38}" fill="${fill}"/>`;
    const star = (x, y, fill) => `<polygon points="${Array.from({ length: 10 }, (_, i) => { const r = i % 2 ? 22 : 52, a = -Math.PI / 2 + (i * Math.PI) / 5; return `${(x + r * Math.cos(a)).toFixed(1)},${(y + r * Math.sin(a)).toFixed(1)}`; }).join(' ')}" fill="${fill}"/>`;
    const red = '#d7332b', blue = '#2b62c9', green = '#2e9b4f', yellow = '#f2c230';
    items.push({
      id: 'i21-shapes-count', kind: 'image', language: 'en', categories: ['visual-attributes'], width: 900, height: 560,
      html: svg(900, 560, `${circle(110, 110, red)}${triangle(300, 120, green)}${square(490, 110, blue)}${circle(690, 120, red)}${triangle(820, 250, green)}${star(150, 300, yellow)}${circle(360, 300, blue)}${triangle(560, 300, green)}${square(130, 460, blue)}${circle(380, 460, red)}${triangle(640, 460, green)}`, '#f6f6f2'),
      questions: [
        ask('How many triangles are in the image?', num(4), shown('four green triangles'), 'count', 'shape'),
        ask('What colour is the star?', exact('yellow'), shown('one yellow star'), 'colour', 'shape'),
        ask('How many blue shapes are there in total?', num(3), shown('two blue squares and one blue circle'), 'count', 'colour'),
        ask('How many circles are there, counting every colour?', num(4), shown('three red circles and one blue circle'), 'count', 'shape'),
        ask('What number is written inside the star?', NA, missing('The image contains shapes only, no writing.')),
      ],
    });

    const cells = [[circle, red], [square, blue], [triangle, green], [square, yellow], [circle, '#111'], [triangle, '#e8792b'], [square, '#7b3fa0'], [triangle, '#8a8a8a'], [circle, '#e86aa6']];
    items.push({
      id: 'i22-griglia-posizioni', kind: 'image', language: 'it', categories: ['visual-attributes'], width: 660, height: 660,
      html: svg(660, 660, `${[220, 440].map((v) => `<line x1="${v}" x2="${v}" y1="20" y2="640" stroke="#999" stroke-width="2"/><line y1="${v}" y2="${v}" x1="20" x2="640" stroke="#999" stroke-width="2"/>`).join('')}<rect x="20" y="20" width="620" height="620" fill="none" stroke="#333" stroke-width="3"/>${cells.map(([shape, fill], i) => shape(110 + (i % 3) * 220, 110 + Math.floor(i / 3) * 220, fill)).join('')}`, '#fafaf7'),
      questions: [
        ask('Di che colore è la forma al centro della griglia?', oneOf('nero', 'nera', 'black'), shown('cerchio nero al centro'), 'colour', 'position'),
        ask('Quale forma si trova in alto a destra?', oneOf('triangolo', 'triangle'), shown('triangolo verde in alto a destra'), 'shape', 'position'),
        ask('In quale riga si trova il quadrato giallo: in alto, al centro o in basso?', oneOf('al centro', 'centrale', 'centro', 'in mezzo'), shown('quadrato giallo a sinistra nella riga centrale'), 'position'),
        ask('Quanti triangoli ci sono nella griglia?', num(3), shown('triangoli: verde, arancione, grigio'), 'count', 'shape'),
        ask('Quale forma si trova nella quarta riga della griglia?', NA, missing('La griglia ha tre righe.')),
      ],
    });
  }

  {
    const building = (x, y, letter, name) => `<rect x="${x}" y="${y}" width="200" height="110" fill="#e6dcc8" stroke="#333" stroke-width="2.5"/>${T(x + 100, y + 48, letter, { size: 30, anchor: 'middle', weight: 800 })}${T(x + 100, y + 80, name, { size: 17, anchor: 'middle' })}`;
    items.push({
      id: 'i23-campus-map', kind: 'image', language: 'en', categories: ['diagram', 'visual-attributes'], width: 720, height: 560,
      html: svg(720, 560, `${T(20, 30, 'Lanternfield School — site plan', { size: 17, weight: 600 })}${building(50, 70, 'A', 'Library')}${building(470, 70, 'B', 'Canteen')}${building(50, 360, 'C', 'Workshop')}${building(470, 360, 'D', 'Gym')}
        <ellipse cx="360" cy="270" rx="78" ry="46" fill="#bfe0ee" stroke="#3a7d99" stroke-width="2.5"/>${T(360, 276, 'Pond', { size: 17, anchor: 'middle' })}
        <line x1="360" y1="520" x2="360" y2="320" stroke="#7a6a4a" stroke-width="5" stroke-dasharray="10 8"/><rect x="320" y="520" width="80" height="16" fill="#555"/>${T(410, 534, 'Gate', { size: 16 })}
        <path d="M360 100 L360 56 M350 70 L360 54 L370 70" fill="none" stroke="#111" stroke-width="2.5"/>${T(360, 124, 'N', { size: 18, anchor: 'middle', weight: 800 })}`, '#f3f6ee'),
      questions: [
        ask('Which building is in the north-east corner of the plan?', exact('Canteen'), visual(shown('B Canteen'), 'North is up; building B, Canteen, is at the top right.'), 'position'),
        ask('Which letter marks the Workshop?', exact('C'), shown('C Workshop')),
        ask('What is drawn at the centre of the plan?', oneOf('Pond', 'a pond'), shown('Pond'), 'position'),
        ask('On which side of the site is the gate: north, south, east or west?', exact('south'), visual(shown('Gate'), 'The gate is at the bottom edge and north is up.'), 'position'),
        ask('How many metres is it from the gate to the library?', NA, missing('The plan has no scale and no distances.')),
      ],
    });
  }

  items.push({
    id: 'i24-menu-lavagna', kind: 'image', language: 'it', categories: ['stylised-font'], width: 640, height: 720, background: '#1f3a2c',
    html: `<div style="position:absolute;inset:14px;border:10px solid #7a5b34;background:#234233;color:#f3f1e4;font-family:'Chalkduster';padding:34px 30px;text-align:center"><div style="font-size:34px;line-height:1.3">Osteria del Faggio Rosso</div><div style="font-size:24px;margin:18px 0 30px;color:#ffe9a8">Menù del giorno</div>
      <div style="font-size:23px;line-height:2.5;text-align:left">Zuppa di farro<span style="float:right">9,50</span><br>Tagliatelle ai funghi<span style="float:right">12,00</span><br>Arrosto con patate<span style="float:right">14,50</span><br>Torta di nocciole<span style="float:right">5,00</span></div></div>`,
    questions: [
      ask("Quanto costa l'arrosto con patate, in euro?", num(14.5), shown('Arrosto con patate 14,50')),
      ask('Qual è il piatto meno caro del menù?', exact('Torta di nocciole'), shown('Torta di nocciole 5,00')),
      ask('Quanti piatti sono elencati nel menù del giorno?', num(4), shown('quattro righe con prezzo'), 'count'),
      ask('A che ora chiude la cucina?', NA, missing('La lavagna non riporta orari.')),
    ],
  });

  // ---- ordered sets ---------------------------------------------------------
  {
    const door = (fill, number) => ({ width: 420, height: 520, html: svg(420, 520, `<rect x="0" y="470" width="420" height="50" fill="#8d8d86"/><rect x="100" y="60" width="220" height="410" fill="${fill}" stroke="#222" stroke-width="5"/><circle cx="292" cy="280" r="10" fill="#e8d27a" stroke="#222" stroke-width="2"/><rect x="170" y="110" width="80" height="50" fill="#fff" stroke="#222" stroke-width="3"/>${T(210, 146, number, { size: 30, anchor: 'middle', weight: 800 })}`, '#e9e4d8') });
    items.push({
      id: 's01-three-doors', kind: 'image-set', language: 'en', categories: ['visual-attributes'],
      images: [door('#2e9b4f', 17), door('#d7332b', 42), door('#2b62c9', 8)],
      questions: [
        ask('What number is on the door in the second image?', num(42), shownIn(2, 'door plate 42'), 'image-order'),
        ask('In which image is the door blue: the first, the second or the third?', oneOf('third', '3rd', 'image 3'), shownIn(3, 'blue door with plate 8'), 'image-order', 'colour'),
        ask('What colour is the door in the first image?', exact('green'), shownIn(1, 'green door with plate 17'), 'image-order', 'colour'),
        ask('What is the sum of the numbers on the doors in the first and third images?', num(25), shownIn(1, 'door plate 17', shownIn(3, 'door plate 8')), 'image-order'),
        ask('What number is on the door in the fourth image?', NA, missing('Only three images are supplied.'), 'image-order'),
      ],
    });
  }

  {
    const shelf = (letters) => ({ width: 760, height: 320, html: svg(760, 320, `<rect x="30" y="230" width="700" height="18" fill="#7a5b34"/>${letters.map((letter, i) => (letter ? `<rect x="${60 + i * 112}" y="130" width="90" height="100" fill="#d9b382" stroke="#333" stroke-width="3"/>${T(105 + i * 112, 195, letter, { size: 40, anchor: 'middle', weight: 800 })}` : '')).join('')}`, '#f4f1ea') });
    items.push({
      id: 's02-prima-dopo', kind: 'image-set', language: 'it', categories: ['visual-attributes'],
      images: [shelf(['A', 'B', 'C', 'D', 'E', null]), shelf(['A', 'B', null, 'D', 'E', 'F'])],
      questions: [
        ask('Quale scatola è presente nella prima immagine ma manca nella seconda?', exact('C'), shownIn(1, 'scatole A B C D E', shownIn(2, 'scatole A B D E F')), 'image-order'),
        ask('Quale scatola compare solo nella seconda immagine?', exact('F'), shownIn(2, 'scatole A B D E F', shownIn(1, 'scatole A B C D E')), 'image-order'),
        ask('Quante scatole ci sono nella prima immagine?', num(5), shownIn(1, 'cinque scatole'), 'image-order', 'count'),
        ask('Che cosa contiene la scatola A?', NA, missing('Le immagini mostrano le scatole chiuse, senza indicazioni sul contenuto.')),
      ],
    });
  }

  {
    const gauge = (tank, level) => ({ width: 380, height: 420, html: svg(380, 420, `${T(190, 44, `Tank ${tank}`, { size: 28, anchor: 'middle', weight: 800 })}<rect x="130" y="70" width="120" height="280" fill="#fff" stroke="#222" stroke-width="4"/><rect x="132" y="${70 + 280 * (1 - level / 100)}" width="116" height="${280 * (level / 100) - 2}" fill="#3a8fc7"/>${T(190, 392, `${level}%`, { size: 30, anchor: 'middle', weight: 700 })}`, '#eef1f4') });
    assert.equal(60 - 35, 25);
    items.push({
      id: 's03-four-gauges', kind: 'image-set', language: 'en', categories: ['visual-attributes'],
      images: [gauge('K', 35), gauge('M', 80), gauge('P', 15), gauge('R', 60)],
      questions: [
        ask('What percentage is shown in the third image?', num(15), shownIn(3, 'Tank P 15%'), 'image-order'),
        ask('Which image shows the highest level: the first, second, third or fourth?', oneOf('second', '2nd', 'image 2'), shownIn(2, 'Tank M 80%'), 'image-order'),
        ask('Which tank is shown in the last image?', oneOf('R', 'Tank R'), shownIn(4, 'Tank R 60%'), 'image-order'),
        ask('By how many percentage points does the level in the fourth image exceed the level in the first?', num(25), shownIn(4, 'Tank R 60%', shownIn(1, 'Tank K 35%')), 'image-order'),
        ask('What is the capacity of tank M in litres?', NA, missing('The images show levels in percent, no capacities.')),
      ],
    });
  }

  {
    const step = (title, body) => ({ width: 600, height: 400, html: `<div style="${ui};height:100%;background:#f5f6f9;padding:30px 36px"><div style="font-size:15px;color:#5a6478">Fogliame — Nuovo ordine</div><div style="font-size:26px;font-weight:700;margin:8px 0 22px">${title}</div><div style="background:#fff;border:1px solid #d7dbe3;border-radius:10px;padding:22px 24px;font-size:18px;line-height:1.9">${body}</div><div style="margin-top:22px;text-align:right"><span style="background:#2a6f97;color:#fff;border-radius:8px;padding:10px 22px;font-size:16px;font-weight:600">Avanti</span></div></div>` });
    items.push({
      id: 's04-passi-ordine', kind: 'image-set', language: 'it', categories: ['ui'],
      images: [step('Passo 2 di 3 — Indirizzo', 'Via delle Fornaci 8<br>Castelvento'), step('Passo 3 di 3 — Conferma', 'Articoli: 3<br>Totale: 46,00 euro'), step('Passo 1 di 3 — Dati personali', 'Nome: Fosca Brentani<br>Telefono: interno 214')],
      questions: [
        ask('Quale passo della procedura è mostrato nella prima immagine fornita?', oneOf('2', 'Passo 2', 'secondo'), shownIn(1, 'Passo 2 di 3 — Indirizzo'), 'image-order'),
        ask('Quale immagine mostra il passo 1: la prima, la seconda o la terza?', oneOf('terza', 'la terza', 'immagine 3'), shownIn(3, 'Passo 1 di 3 — Dati personali'), 'image-order'),
        ask('Quale totale è indicato nella seconda immagine, in euro?', num(46), shownIn(2, 'Totale: 46,00 euro'), 'image-order'),
        ask('Quale metodo di pagamento è stato scelto?', NA, missing('Nessuna delle tre schermate riguarda il pagamento.')),
      ],
    });
  }

  return items;
}

export function corpusItems() {
  return [...pdfItems(), ...imageItems()];
}
