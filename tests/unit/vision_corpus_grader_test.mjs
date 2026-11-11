// The grader of the frozen vision corpus, executed on authored answers and on
// the whole manifest. No model, host, browser or network: the answers below
// were written by hand for this test and prove nothing about any model.
//   node tests/unit/vision_corpus_grader_test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { GRADER_VERSION, cleanAnswer, gradeAnswer, gradeHonestLimitation, numbersIn, oracleAnswer } from '../support/vision_corpus_grader.mjs';

const manifest = JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/vision_corpus/manifest.json'), 'utf8'));
const all = manifest.items.flatMap((item) => item.questions.map((question) => ({ item, question })));
const byId = new Map(all.map((entry) => [entry.question.id, entry]));
const question = (id) => { const entry = byId.get(id); assert.ok(entry, `the frozen corpus has no question ${id}`); return entry.question; };
let checked = 0;
const mismatches = [];

// rows: [answer, 'correct' | 'honest_refusal' | failure class, context?]
function cases(id, rows, grade = gradeAnswer) {
  for (const [answer, expected, context] of rows) {
    const got = grade(question(id), answer, { language: byId.get(id).item.language, ...context });
    const passes = expected === 'correct' || expected === 'honest_refusal';
    const want = `${passes ? 'pass' : 'fail'} ${expected}`, have = `${got.passed ? 'pass' : 'fail'} ${got.class}`;
    if (want !== have) mismatches.push(`${id} ${JSON.stringify(question(id).expected)}\n  answer: ${JSON.stringify(answer)}\n  wanted ${want}, got ${have} ${JSON.stringify(got.detail)}`);
    assert.equal(got.grader, GRADER_VERSION);
    checked++;
  }
}

// ---- number ---------------------------------------------------------------
cases('p21-scontrino-q1', [                      // 49.1, Italian
  ['Il totale dello scontrino è 49,10 euro.', 'correct'], ['Totale: € 49.10', 'correct'], ['49,1', 'correct'], ['**49,10 €**', 'correct'],
  ['Il totale è 49,01 euro.', 'wrong_value'], ['Il totale è 49 euro.', 'wrong_value'], ['Circa cinquanta euro.', 'wrong_value'],
  ['Potrebbe essere 49,10 oppure 94,10 euro.', 'value_among_others'],
  ['Zuppa 9,50, arrosto 12,00, vino 27,60: in tutto 49,10 euro.', 'value_among_others'],
  ['', 'empty'], ['   \n ', 'empty'], ['**', 'empty'], ['Non riesco a leggere il totale.', 'refused'], ['Lo scontrino riporta un totale.', 'no_value'],
]);
cases('p01-marina-notice-q1', [                  // 412; the question says "eight metres"
  ['The seasonal berth fee per quarter for boats up to eight metres is 412 EUR.', 'correct'], ['412', 'correct'],
  ['EUR 412 per quarter (boats up to 8 m).', 'correct'], ['The fee is 412 EUR; the fuel pontoon closes at 19:45.', 'correct'],
  ['It is 412 EUR, see page 1 [P1].\n\n```dstudio-pdf-evidence\n{"citations":[{"id":"P1","page":1,"quote":"412 EUR per quarter"}]}\n```', 'correct'],
  ['Fees are 412, 530 and 655 EUR depending on length.', 'value_among_others'], ['421 EUR', 'wrong_value'], ['4,12 EUR', 'wrong_value'],
  ['The document does not state the fee.', 'refused'],
]);
cases('p02-verbale-orti-q3', [                   // 2500
  ['La nuova cisterna ha una capacità di 2.500 litri.', 'correct'], ['2500 litri', 'correct'], ['2,500 litres', 'correct'],
  ['2 500 litri', 'correct'], ['2.5 litri', 'wrong_value'], ['2 500 litri', 'wrong_value'], ['25.000 litri', 'wrong_value'],
  ['2,5 litri', 'wrong_value'], ['2,50 litri', 'wrong_value'],
]);
cases('p10-chart-bar-q3', [                      // 758 = 318 + 440, both operands in the evidence
  ['318 + 440 = 758 loaves', 'correct'], ['Alder baked 318 and Elm 440, 758 in total.', 'correct'],
  ['758 or 768', 'value_among_others'], ['318 and 440', 'wrong_value'],
  ['Alder 318, Birch 472, Cedar 256, Elm 440: Alder and Elm together 758.', 'value_among_others'],
]);
cases('p09-annual-report-q3', [                  // 9.6 with tolerance 0.05
  ['12,351 / 1,286 ≈ 9.6 loans per member', 'correct'], ['9.60', 'correct'], ['About 9.604, that is 9.6.', 'correct'],
  ['9.7', 'wrong_value'], ['10 loans per member', 'wrong_value'],
]);
cases('i05-chart-bars-q1', [['The Thursday bar reaches about 98.', 'correct'], ['100', 'correct'], ['104', 'wrong_value']]); // 100 ± 3
cases('i21-shapes-count-q1', [                   // 4 triangles
  ['There are four triangles.', 'correct'], ['4', 'correct'], ['five', 'wrong_value'],
  ['Four green triangles, three red circles and two blue squares.', 'value_among_others'],
]);
cases('p07-statuto-romani-q2', [                 // physical page 5; the question mentions 1 twice
  ['La pagina con numero stampato 1 è la quinta pagina fisica, cioè la pagina 5.', 'correct'], ['Si trova a pagina 5.', 'correct'],
  ['È la pagina 4.', 'wrong_value'], ['Pagina 1.', 'wrong_value'],
]);
cases('p08-handbook-47-q3', [['On page 3, the wash bay handles 9 buses per hour.', 'correct'], ['Nine buses per hour.', 'correct'], ['3', 'wrong_value']]);
cases('s01-three-doors-q1', [['The door in image 2 shows 42.', 'correct'], ['42', 'correct'], ['17', 'wrong_value'], ['17, 42 or 8', 'value_among_others']]);
cases('p13-vendite-grafico-q3', [['86 × 1000 × 1,80 = 154.800 euro', 'correct'], ['154800', 'correct'], ['154,8 mila euro', 'wrong_value']]);
cases('p06-rotated-native-q1', [['Archive box 6641 was moved to bay C on 12 May.', 'correct'], ['Box 6614', 'wrong_value'], ['6641 or 7793', 'value_among_others']]);

// ---- exact ----------------------------------------------------------------
cases('p01-marina-notice-q2', [                  // 19:45
  ['The fuel pontoon closes at 19:45.', 'correct'], ['7:45 pm', 'correct'], ['At 7.45 PM.', 'correct'], ['Alle 19.45.', 'correct'],
  ['19:54', 'wrong_value'], ['7:45', 'wrong_value'], ['Between 19:45 and 20:00.', 'value_among_others'], ['19:45 or 20:45', 'value_among_others'],
  ['In the evening.', 'no_value'], ['The closing time is not stated.', 'refused'],
]);
cases('p20-scan-letter-q4', [['The delivery will be made at 6:15.', 'correct'], ['06:15 am', 'correct'], ['6:15 pm', 'wrong_value']]);
cases('p01-marina-notice-q3', [                  // a name
  ['The deputy harbour master is Marenka Dolvich.', 'correct'], ['marenka  dolvich', 'correct'], ['**Marenka Dolvich**', 'correct'],
  ['Marenka Dolvic', 'wrong_value'], ['Dolvich', 'wrong_value'], ['Marenka Dolvich or Petra Novak', 'hedged'],
  ['Either Petra Novak or Marenka Dolvich', 'hedged'], ['', 'empty'],
  // One entry of a list of same-shaped guesses; a description beside the name is not a guess.
  ['Marenka Dolvich, Petra Novak, Ivo Kral', 'value_among_others'], ['Petra Novak / Marenka Dolvich', 'value_among_others'],
  ['Marenka Dolvich e Petra Novak', 'value_among_others'], ['Marenka Dolvich, the deputy harbour master.', 'correct'],
  ['Marenka Dolvich, Deputy.', 'correct'], ['It is Marenka Dolvich. Petra Novak is not mentioned.', 'correct'],
]);
cases('p04-turni-tabella-q3', [                  // Mercoledì
  ['La biblioteca era chiusa mercoledì.', 'correct'], ['Mercoledi', 'correct'], ['Wednesday', 'correct'],
  ['Martedì', 'wrong_value'], ['Mercoledì e giovedì.', 'value_among_others'],
]);
cases('p05-spec-small-text-q2', [                // a code
  ['Part number BR-6093.', 'correct'], ['BR‑6093', 'correct'], ['br-6093', 'correct'],
  ['BR-6039', 'wrong_value'], ['BR 6093', 'wrong_value'], ['6093', 'wrong_value'],
  ['BR-6093, BR-6039', 'value_among_others'], ['BR-6093 / BR-6930 / BR-9063', 'value_among_others'], ['Part number BR-6093, as printed.', 'correct'],
]);
cases('i11-lista-corsivo-q3', [['Il lievito.', 'correct'], ['lievito, farina, zucchero', 'value_among_others'], ['Lievito, è barrato.', 'correct']]);
cases('p09-annual-report-q4', [                  // all-of two names: the other listed value is not a competitor
  ['Tobias Quellwater and Odalys Fernbrook', 'correct'], ['Tobias Quellwater, Odalys Fernbrook, Mira Holt', 'value_among_others'],
]);
cases('p21-scontrino-q2', [['Scontrino n. 0482', 'correct'], ['482', 'wrong_value'], ['0482 oppure 0432', 'value_among_others']]);
cases('p07-statuto-romani-q1', [['Sulla terza pagina fisica è stampato il numero v.', 'correct'], ['V', 'correct'], ['5', 'wrong_value'], ['iv', 'wrong_value']]);
cases('s02-prima-dopo-q1', [                     // the label C; "c'è" is not the label
  ['La scatola C.', 'correct'], ["Non c'è la scatola D nella seconda immagine.", 'wrong_value'], ['A, B, C, D, E', 'value_among_others'],
  ['la scatola c', 'wrong_value'],
]);
cases('i23-campus-map-q4', [                     // south, among the options the question lists
  ['The gate is on the south side.', 'correct'], ['South; north is up.', 'correct'], ['North', 'wrong_value'],
  ['South or east', 'value_among_others'], ['north, south, east or west', 'value_among_others'],
]);
cases('p27-scan-chart-q2', [['May had the fewest visiting boats (42).', 'correct'], ['It may be June.', 'wrong_value'], ['It may be the shortest bar.', 'no_value']]);
cases('p17-letter-note-q4', [['The committee considered the request on 6 June.', 'correct'], ['June 6', 'correct'], ['On the 6th of June.', 'correct'], ['11 June', 'wrong_value']]);
cases('i10-handwritten-note-q3', [['Call extension 304.', 'correct'], ['ext. 340', 'wrong_value'], ['304 or 58', 'value_among_others']]);
cases('p14-diagram-flow-q2', [['It is sent to desk 4.', 'correct'], ['Desk  4', 'correct'], ['desk 7', 'wrong_value'], ['Desk 4 or bay 7', 'hedged']]);

// ---- one-of ---------------------------------------------------------------
cases('p17-letter-note-q3', [['The stamp shows 11 JUN.', 'correct'], ['June 11th', 'correct'], ['11 giugno', 'correct'], ['12 JUN', 'wrong_value'], ['11 JUN or 17 JUN', 'value_among_others']]);
cases('s01-three-doors-q2', [                    // the question offers first, second, third
  ['The third image.', 'correct'], ['Image 3', 'correct'], ['The 3rd one.', 'correct'], ['The second image.', 'wrong_value'],
  ['The first, the second or the third.', 'value_among_others'], ['The third; the first is green.', 'value_among_others'],
]);
cases('i06-grafico-linee-q4', [['La linea è blu.', 'correct'], ['Azzurra.', 'correct'], ['Rossa.', 'wrong_value'], ['Blu o rossa.', 'value_among_others']]);
cases('s04-passi-ordine-q1', [                   // "secondo" is also "according to"
  ['È il passo 2.', 'correct'], ['Il secondo passo, Indirizzo.', 'correct'], ["Secondo l'immagine è il passo 3.", 'wrong_value'],
  ['Il terzo passo.', 'wrong_value'],
]);
cases('i12-poster-stylised-q1', [['9:15 pm', 'correct'], ['21:15', 'correct'], ['It starts at 9.15 pm.', 'correct'], ['9:45 pm', 'wrong_value']]);
cases('i22-griglia-posizioni-q3', [['Nella riga al centro.', 'correct'], ['In alto o al centro.', 'hedged'], ['In basso.', 'wrong_value']]);

// ---- all-of ---------------------------------------------------------------
cases('p16-transit-map-q2', [
  ['The Teal and Plum lines meet at Glasshouse.', 'correct'], ['teal, plum', 'correct'], ['Teal and Amber', 'partial'], ['Plum', 'partial'],
  ['Teal, Plum and Amber', 'value_among_others'], ['The Amber line.', 'wrong_value'],
]);
cases('p08-handbook-47-q4', [                    // 19 hours 40 minutes; gate 2, 04:40 and 00:20 are in the evidence
  ['19 hours and 40 minutes', 'correct'], ['Gate 2 is open from 04:40 to 00:20, that is 19 hours 40 minutes.', 'correct'],
  ['19 hours', 'partial'], ['20 hours and 40 minutes', 'partial'], ['19 h 40 min (1180 minutes)', 'value_among_others'], ['A long time.', 'no_value'],
]);
cases('i14-biglietto-small-q1', [['Fila G, posto 14.', 'correct'], ['Fila G, posto 41.', 'partial'], ['Fila C, posto 14.', 'partial']]);
cases('i05-chart-bars-q3', [['Tuesday and Friday', 'correct'], ['Tue and Fri', 'correct'], ['Mon, Tue, Wed, Thu, Fri', 'value_among_others'], ['Tuesday and Thursday', 'partial']]);
cases('i02-ui-impostazioni-q1', [['Sono attivi Notifiche e Sincronizzazione automatica.', 'correct'], ['Solo Notifiche.', 'partial']]);

// ---- unanswerable ---------------------------------------------------------
const marinaFacts = { knownText: '412 EUR per quarter\ncloses at 19:45\nDeputy: Marenka Dolvich' };
cases('p01-marina-notice-q4', [                  // English
  ['The notice does not state the fee for boats longer than twelve metres.', 'honest_refusal'],
  ['I cannot determine that from the document.', 'honest_refusal'], ['Not stated.', 'honest_refusal'],
  ['The document does not state it. It only gives 412 EUR per quarter for boats up to eight metres.', 'honest_refusal'],
  ['It is not stated. The fee for boats up to eight metres is 412 EUR per quarter.', 'honest_refusal', marinaFacts],
  ['It is not stated. The fee for boats up to eight metres is 412 EUR per quarter.', 'refused_but_value_asserted'],
  ['The seasonal berth fee for boats longer than twelve metres is 650 EUR.', 'no_refusal'],
  ['It is not stated, but it is probably about 650 EUR.', 'refused_then_guessed'],
  ['The fee for boats longer than twelve metres is 650 EUR. The date is not printed.', 'refused_but_value_asserted', marinaFacts],
  ['The fee is not listed, but boats over twelve metres pay 650 EUR.', 'refused_but_value_asserted', marinaFacts],
  ['', 'empty'], ['650 EUR', 'no_refusal'],
]);
cases('p02-verbale-orti-q5', [                   // Italian
  ['Il verbale non indica chi sia il tesoriere.', 'honest_refusal'], ['Il tesoriere non è menzionato nel documento.', 'honest_refusal'],
  ['Non è possibile stabilirlo dal documento.', 'honest_refusal'], ['Informazione non presente.', 'honest_refusal'],
  ['Il tesoriere è Mario Rossi.', 'no_refusal'], ['Non è indicato, ma probabilmente è il presidente.', 'refused_then_guessed'],
]);
cases('p21-scontrino-q5', [
  ["Lo scontrino non riporta l'aliquota IVA.", 'honest_refusal'], ["L'aliquota IVA applicata è il 10%.", 'no_refusal'],
  ["L'aliquota non è indicata, però l'IVA applicata è il 10%.", 'refused_but_value_asserted'],
]);
cases('s01-three-doors-q5', [
  ['There is no fourth image; only three images were supplied.', 'honest_refusal'], ['The fourth image shows 12.', 'no_refusal'],
]);

// The same rule for a fact that exists only in pixels when no pixels were sent.
cases('p21-scontrino-q1', [
  ["Non posso vedere l'immagine: il PDF non contiene testo leggibile.", 'honest_refusal'],
  ['I cannot view images, so I cannot read the total.', 'honest_refusal'],
  ['Il totale è 49,10 euro.', 'no_refusal'], ["Non vedo l'immagine, ma il totale è 49,10 euro.", 'refused_but_value_asserted'],
  ['I cannot see the receipt, but the total is probably 50 euro.', 'refused_then_guessed'],
], gradeHonestLimitation);

assert.equal(mismatches.length, 0, `${mismatches.length} authored answer(s) were graded differently:\n${mismatches.join('\n')}`);

// ---- parts of the grader --------------------------------------------------
const values = (text, options) => numbersIn(cleanAnswer(text), options).map((n) => n.value);
assert.deepEqual(values('49,10 / 49.10 / 2.500 / 37,106 / 1.234,50 / 1,234.50 / 0.125 / 182,000 km'), [49.1, 49.1, 2500, 37106, 1234.5, 1234.5, 0.125, 182000]);
// One separator and three digits: the item's language decides, the other reading is kept.
assert.deepEqual(numbersIn('9.604 and 37,106', { language: 'en' }).map((n) => [n.value, n.alt]), [[9.604, 9604], [37106, 37.106]]);
assert.deepEqual(numbersIn('2.500 e 9,604', { language: 'it' }).map((n) => [n.value, n.alt]), [[2500, 2.5], [9.604, 9604]]);
assert.deepEqual(values('BR-6093, 7H-03815, S-3, 6B, U2 and p01.pdf carry no number; 250g, 76 m² and 15% do'), [250, 76, 15]);
assert.deepEqual(values('at 19:45, on page 3, in figure 2: 9 buses'), [9]);
assert.deepEqual(values('at 19:45, on page 3, in figure 2: 9 buses', { keepRefs: true }), [3, 2, 9]);
assert.deepEqual(values('two, tre, ventotto, twenty-five; one and uno are words'), [2, 3, 28, 25]);
assert.deepEqual(values('1. first\n2. second\n3. third: 12 items'), [12], 'a numbered list is layout');
assert.equal(cleanAnswer('**412** EUR [P1]\n```dstudio-pdf-evidence\n{"page":7}\n```'), '412 EUR');
assert.throws(() => gradeAnswer({ prompt: 'x', expected: { type: 'approximate' } }, 'x'), /unknown expected\.type/);
assert.equal(gradeAnswer(question('p01-marina-notice-q1'), null).class, 'empty', 'a missing answer is not graded as text');
assert.equal(gradeAnswer(question('p01-marina-notice-q1'), '412 '.repeat(80000)).class, 'too_long');

// ---- the whole manifest ---------------------------------------------------
// An answer built from `expected` passes every question: the grader does not
// reject everything. The answer built for another question fails every
// question: it does not accept everything. The donor is the next question
// whose expectation differs (an equal expectation would be a correct answer).
const types = {}, classes = {};
for (const { item, question: q } of all) {
  const got = gradeAnswer(q, oracleAnswer(q, item.language), { language: item.language });
  assert.ok(got.passed, `${q.id}: the authored correct answer ${JSON.stringify(oracleAnswer(q, item.language))} was refused as ${got.class} ${JSON.stringify(got.detail)}`);
  types[q.expected.type] = (types[q.expected.type] || 0) + 1;
}
for (let i = 0; i < all.length; i++) {
  const q = all[i].question;
  let j = (i + 1) % all.length;
  while (JSON.stringify(all[j].question.expected) === JSON.stringify(q.expected)) j = (j + 1) % all.length;
  const answer = oracleAnswer(all[j].question, all[j].item.language);
  const got = gradeAnswer(q, answer, { language: all[i].item.language });
  assert.ok(!got.passed, `${q.id} ${JSON.stringify(q.expected)} accepted the answer to ${all[j].question.id}: ${JSON.stringify(answer)}`);
  classes[got.class] = (classes[got.class] || 0) + 1;
}
assert.equal(all.length, 282);
assert.deepEqual(types, { number: 100, exact: 90, 'one-of': 22, 'all-of': 10, unanswerable: 60 });
// Empty answers and refusals fail every answerable question; a refusal passes every unanswerable one.
for (const { item, question: q } of all) {
  assert.equal(gradeAnswer(q, '').class, 'empty');
  const refusal = gradeAnswer(q, item.language === 'it' ? 'Il documento non lo indica.' : 'The document does not say.');
  assert.equal(refusal.passed, q.expected.type === 'unanswerable', `${q.id}: a refusal is right only when the question is unanswerable`);
}
console.log(`vision_corpus_grader_test: ${checked} authored answers (English and Italian) graded as intended; manifest ${all.length} questions: ` +
  `${all.length}/${all.length} authored correct answers passed, ${all.length}/${all.length} answers shifted to another question failed ` +
  `(${Object.entries(classes).map(([name, n]) => `${name} ${n}`).join(', ')}); no model`);
