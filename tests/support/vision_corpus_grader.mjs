// Grader of the frozen vision corpus (tests/fixtures/vision_corpus).
//
// Input: one manifest question ({ prompt, expected, evidence, tags }) and the
// final answer text a model gave through the app. Output: pass or fail plus a
// diagnostic class. There is no partial credit, and a correct value that the
// answer does not commit to stays failed but is classified
// (`value_among_others`, `hedged`), as in tests/support/common_model_quality.py.
// It never starts a model and reads no file.
//
// The corpus prompts ask in plain language and never demand a bare value, so
// units, currency words and a sentence around the value are always allowed.
// What is not allowed is a second candidate of the same kind.
//
// number    The answer states exactly one candidate number and it equals
//           `value` within the absolute `tolerance` (0 when absent). `49,10`
//           and `49.10` are the same number. One separator followed by exactly
//           three digits (`2.500`, `37,106`, `9.604`) is read in the item's
//           language (a thousand in Italian with a dot, in English with a
//           comma; otherwise a decimal); the expected value may match either
//           reading, a competing candidate is named by the language's reading.
//           A no-break space groups thousands, a plain space never does.
//           Spelled numbers from two to ninety-nine count in English and
//           Italian ("one", "uno", "una" and "sei" are also other words: write
//           1 and 6 as digits). Not candidates: numbers of the question
//           itself, numbers of the evidence literals the answer rests on (the
//           operands of a calculation), clock times, page and figure
//           references, list markers, digits inside a code such as BR-6093.
//           Any other number is a competing candidate and fails the answer.
// exact     The answer states `value`: case, whitespace, dashes and quotes are
//           normalised; a letter of the answer may lack the accent of the
//           value, never the reverse. The value must stand as whole words.
//           A value that is a number, a clock time or a day and month is
//           compared as such (`06:15` = `6:15`, `19:45` = `7:45 pm`,
//           `6 June` = `June 6`); a digit string with a leading zero must be
//           written with it. Weekdays, months, colours, ordinals, shapes and
//           compass points are compared by meaning in both languages, and
//           another member of the same family in the answer is a competing
//           candidate. A single capital letter must stand alone as a capital.
//           A free-text value (a name, a code, a label) given as one entry of a
//           list ("X, Y", "X / Y", "X and Y", "X o Y") whose other entry has
//           the same shape (capitalisation, letters and digits: `Marenka
//           Dolvich` and `Petra Novak`, `BR-6093` and `BR-6039`) is one guess
//           among others, unless that entry is another listed value or every
//           word of it is in the question or the evidence.
// one-of    Any listed value under the `exact` rule; the other listed values
//           are synonyms, not competitors.
// all-of    Every listed value under the `exact` rule, with no competing
//           candidate (`partial` when some are missing).
// unanswerable
//           The answer says that the input does not contain or show what was
//           asked (English or Italian), offers no guess after saying so, and
//           no sentence affirms a value for the asked thing that is neither in
//           the question nor in the supplied known text.
//
// A candidate that the question or the evidence literals already contain is
// context, with one exception: when the question itself offers the expected
// value among its options ("the first, the second or the third?"), the other
// options are answers, not context. For every type an explicit alternative
// next to the stated value ("X or Y", "X oppure Y") fails as `hedged`.
//
// Limits, by rule: a free-text value has no closed family, so another name or
// label elsewhere in a sentence (not listed beside the value) is not detected;
// a made-up name after an honest refusal is not detected either.
// The raw answer stays in every receipt for that review.

export const GRADER_VERSION = 'dstudio.vision-corpus-grader.v1';

// ---------------------------------------------------------------- text ----

const ACCENTS = { a: 'àáâãä', e: 'èéêë', i: 'ìíîï', o: 'òóôõö', u: 'ùúûü', c: 'ç', n: 'ñ' };
const unaccent = (text) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The app appends its own protocol blocks and citation marks to an answer;
// Markdown and LaTeX wrappers are presentation. None of them is a value.
export function cleanAnswer(answer) {
  let s = String(answer ?? '');
  s = s.replace(/```dstudio-[a-z-]+[\s\S]*?(?:```|$)/g, ' ');
  s = s.replace(/```[a-z0-9]*[ \t]*\n?/gi, ' ');
  s = s.replace(/\[(?:[PSF]\d+)(?:\s*[,;]\s*[PSF]\d+)*\]/g, ' ');
  s = s.replace(/\\[([\])]/g, ' ').replace(/\\(?:text|mathbf|mathrm|boxed|textbf)\s*\{([^{}]*)\}/g, '$1').replace(/\$/g, ' ');
  // A no-break or thin space between digit groups is a thousands separator; a plain space is not.
  s = s.replace(/(\d)[   ](?=\d{3}(?!\d))/g, '$1').replace(/[²³]/g, '').normalize('NFKC');
  s = s.replace(/[‐-―−]/g, '-').replace(/[‘’ʼ`]/g, "'").replace(/[“”«»]/g, '"');
  s = s.replace(/\*\*|__|~~/g, ' ').replace(/(^|\s)[*_](?=\S)/g, '$1').replace(/(?<=\S)[*_](?=\s|[.,;:!?)]|$)/g, '');
  s = s.replace(/^[ \t]*#{1,6}[ \t]+/gm, '').replace(/^[ \t]*>[ \t]?/gm, '');
  // A numbered list (two or more consecutive markers) is layout.
  if (/^[ \t]*1[.)][ \t]+\S/m.test(s) && /^[ \t]*2[.)][ \t]+\S/m.test(s)) s = s.replace(/^[ \t]*\d{1,2}[.)][ \t]+/gm, '');
  s = s.replace(/^[ \t]*[-•][ \t]+/gm, '');
  return s.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
}

// A value as a pattern: accents of the value are optional in the answer, runs
// of whitespace are equal, a full stop inside the value is optional.
function phrasePattern(value) {
  let out = '';
  for (const ch of value.trim().toLowerCase()) {
    const base = Object.entries(ACCENTS).find(([, marked]) => marked.includes(ch))?.[0];
    if (base) out += `[${ch}${base}]`;
    else if (/\s/.test(ch)) out += '\\s+';
    else if (ch === '.') out += '\\.?';
    else out += escapeRegex(ch);
  }
  return out.replace(/(?:\\s\+)+/g, '\\s+');
}

// ------------------------------------------------------------- numbers ----

const UNITS = new Set(['g', 'kg', 'mg', 't', 'q', 'm', 'cm', 'mm', 'km', 'mq', 'm2', 'm3', 'l', 'ml', 'cl', 'kva', 'va', 'kw', 'w', 'kwh',
  'v', 'hz', 'h', 'hr', 'hrs', 'min', 'mins', 's', 'sec', 'secs', 'ms', 'mb', 'gb', 'kb', 'tb', 'pt', 'px', 'eur', 'euro', 'usd', 'c', 'x']);
const EN_UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen',
  'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const IT_UNITS = ['zero', 'uno', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove', 'dieci', 'undici', 'dodici', 'tredici',
  'quattordici', 'quindici', 'sedici', 'diciassette', 'diciotto', 'diciannove'];
const IT_TENS = ['', '', 'venti', 'trenta', 'quaranta', 'cinquanta', 'sessanta', 'settanta', 'ottanta', 'novanta'];
const SPELLED = new Map();
for (let n = 2; n < 20; n++) { SPELLED.set(EN_UNITS[n], n); if (IT_UNITS[n] !== 'sei') SPELLED.set(IT_UNITS[n], n); }
for (let t = 2; t < 10; t++) {
  SPELLED.set(EN_TENS[t], t * 10); SPELLED.set(IT_TENS[t], t * 10);
  for (let u = 1; u < 10; u++) {
    SPELLED.set(`${EN_TENS[t]}-${EN_UNITS[u]}`, t * 10 + u); SPELLED.set(`${EN_TENS[t]} ${EN_UNITS[u]}`, t * 10 + u);
    const stem = u === 1 || u === 8 ? IT_TENS[t].slice(0, -1) : IT_TENS[t];
    SPELLED.set(stem + IT_UNITS[u], t * 10 + u);
    if (u === 3) SPELLED.set(`${stem}tré`, t * 10 + u);
  }
}
for (const [word, n] of [['hundred', 100], ['cento', 100], ['thousand', 1000], ['mille', 1000]]) SPELLED.set(word, n);
const SPELLED_RE = new RegExp(`(?<![\\p{L}\\p{N}'-])(${[...SPELLED.keys()].sort((a, b) => b.length - a.length).map(escapeRegex).join('|')})(?![\\p{L}\\p{N}'-])`, 'giu');

// { value, alt }: `1.234,50` and `49,10` have one reading. One separator
// followed by exactly three digits has two (`9.604`: a decimal in English, a
// thousand in Italian): `value` is the reading of the item's language, the
// thousands reading when no language is given; `alt` is the other one. The
// expected value may match either, a competing candidate is named by `value`.
function numberValue(body, language) {
  const quoted = body.includes("'");
  body = body.replace(/'/g, '');
  const dot = body.includes('.'), comma = body.includes(',');
  if (dot && comma) {
    const last = Math.max(body.lastIndexOf('.'), body.lastIndexOf(','));
    return { value: Number(`${body.slice(0, last).replace(/[.,]/g, '')}.${body.slice(last + 1)}`) };
  }
  const sep = dot ? '.' : comma ? ',' : null;
  if (!sep) return { value: Number(body) };
  const parts = body.split(sep);
  if (parts.length > 2) return { value: Number(parts.join('')) };
  const decimal = Number(`${parts[0]}.${parts[1]}`);
  if (parts[1].length !== 3 || parts[0] === '0' || parts[0].length > 3) return { value: decimal };
  const thousands = Number(parts[0] + parts[1]);
  if (quoted) return { value: thousands };
  const decimalMark = language === 'en' ? '.' : language === 'it' ? ',' : null;
  return sep === decimalMark ? { value: decimal, alt: thousands } : { value: thousands, alt: decimal };
}

const CLOCK_RE = /(?<![\p{L}\p{N}:.,])(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*([ap])\.?m\b\.?)?(?![\p{N}:])/giu;
const MERIDIEM_RE = /(?<![\p{L}\p{N}:.,])(\d{1,2})(?:\.(\d{2}))?\s*([ap])\.?m\b\.?/giu;
const DOTTED_RE = /(?<![\p{L}\p{N}:.,])(\d{1,2})\.(\d{2})(?![\p{N}:]|[.,]\d)/gu;
const NUMBER_RE = /(\d{1,3}(?:([.,'])\d{3})(?:\2\d{3})*(?:[.,]\d+)?|\d+(?:[.,]\d+)?)/gu;
const PAGE_REF_RE = /(?<![\p{L}\p{N}])(?:pages?|pagin[ae]|pagg?\.|p\.)\s*(?:n\.?\s*|no\.?\s*|number\s+|numero\s+)?(\d{1,4})(?![\p{L}\p{N}])/giu;
const FIGURE_REF_RE = /(?<![\p{L}\p{N}])(?:images?|immagin[ei]|pictures?|figures?|figur[ae]|fig\.|photos?|foto)\s*(?:n\.?\s*|no\.?\s*)?(\d{1,3})(?![\p{L}\p{N}])/giu;

// Clock times of a text on the 24-hour clock: [{ minutes, index, end }].
// "19.45" is a clock time only where a time is being graded (`dotted`).
function clockTimes(text, { dotted = false } = {}) {
  const out = [];
  const taken = (m) => out.some((t) => m.index >= t.index && m.index < t.end);
  const add = (h, m, meridiem, index, end) => {
    h = Number(h); m = Number(m || 0);
    if (h > 24 || m > 59) return;
    if (meridiem) { if (h > 12) return; h = (h % 12) + (meridiem.toLowerCase() === 'p' ? 12 : 0); }
    out.push({ minutes: h * 60 + m, meridiem: Boolean(meridiem), index, end });
  };
  for (const m of text.matchAll(CLOCK_RE)) add(m[1], m[2], m[3], m.index, m.index + m[0].length);
  for (const m of text.matchAll(MERIDIEM_RE)) if (!taken(m)) add(m[1], m[2], m[3], m.index, m.index + m[0].length);
  if (dotted) for (const m of text.matchAll(DOTTED_RE)) if (!taken(m)) add(m[1], m[2], null, m.index, m.index + m[0].length);
  return out.sort((a, b) => a.index - b.index);
}

const mask = (text, spans) => { let out = text; for (const s of spans) out = out.slice(0, s.index) + ' '.repeat(s.end - s.index) + out.slice(s.end); return out; };

// Numbers of a text: [{ value, alt, raw, index }]. Page and figure references
// are left out unless `keepRefs` (a question about a page or an image position
// is graded on them) or `keepValue(value)` says the reference is the wanted value.
export function numbersIn(text, { keepRefs = false, keepValue = () => false, language } = {}) {
  let work = mask(text, clockTimes(text));
  if (!keepRefs) {
    const refs = [];
    for (const re of [PAGE_REF_RE, FIGURE_REF_RE]) for (const m of work.matchAll(re)) {
      const digits = m.index + m[0].lastIndexOf(m[1]);
      if (!keepValue(Number(m[1]))) refs.push({ index: digits, end: digits + m[1].length });
    }
    work = mask(work, refs);
  }
  const out = [];
  for (const m of work.matchAll(NUMBER_RE)) {
    const index = m.index, end = index + m[0].length;
    const before = work[index - 1] || ' ', before2 = work[index - 2] || ' ';
    if (/[\p{L}\p{N}_]/u.test(before)) continue;                          // p01, m2, U2
    if (/[-/.]/.test(before) && /\p{L}/u.test(before2)) continue;         // BR-6093, S-3
    const tail = work.slice(end).match(/^[\p{L}°%€]+/u)?.[0] || '';
    if (tail && !/^[°%€]/.test(tail) && !UNITS.has(tail.toLowerCase())) continue; // 6B, 3rd
    if (tail && /^-?\p{N}/u.test(work.slice(end + tail.length))) continue;         // 7H-03815
    const read = numberValue(m[0], language);
    const sign = before === '-' && /[\s(=:]/.test(before2) ? -1 : 1;      // a sign, not a range or a hyphen
    out.push({ value: sign * read.value, ...(read.alt === undefined ? {} : { alt: sign * read.alt }), raw: m[0], index });
  }
  for (const m of work.toLowerCase().matchAll(SPELLED_RE)) out.push({ value: SPELLED.get(m[1].replace(/\s+/g, ' ')), raw: m[1], index: m.index });
  return out.sort((a, b) => a.index - b.index);
}

// ------------------------------------------------------------ families ----

// Each entry: [canonical id, full forms (any case), abbreviations (matched as
// printed on a label: Capitalised or UPPER)]. "March" and "May" are also a
// verb, so they are listed as label forms.
const FAMILIES = {
  weekday: [
    ['mon', ['monday', 'lunedì'], ['Mon', 'Lun']], ['tue', ['tuesday', 'martedì'], ['Tue', 'Tues']],
    ['wed', ['wednesday', 'mercoledì'], ['Wed', 'Mer']], ['thu', ['thursday', 'giovedì'], ['Thu', 'Thur', 'Thurs', 'Gio']],
    ['fri', ['friday', 'venerdì'], ['Fri', 'Ven']], ['sat', ['saturday', 'sabato'], ['Sat', 'Sab']],
    ['sun', ['sunday', 'domenica'], ['Sun', 'Dom']]],
  month: [
    ['m01', ['january', 'gennaio'], ['Jan', 'Gen']], ['m02', ['february', 'febbraio'], ['Feb']], ['m03', ['marzo'], ['March', 'Mar']],
    ['m04', ['april', 'aprile'], ['Apr']], ['m05', ['maggio'], ['May', 'Mag']], ['m06', ['june', 'giugno'], ['Jun', 'Giu']],
    ['m07', ['july', 'luglio'], ['Jul', 'Lug']], ['m08', ['august', 'agosto'], ['Aug', 'Ago']],
    ['m09', ['september', 'settembre'], ['Sep', 'Sept', 'Set']], ['m10', ['october', 'ottobre'], ['Oct', 'Ott']],
    ['m11', ['november', 'novembre'], ['Nov']], ['m12', ['december', 'dicembre'], ['Dec', 'Dic']]],
  colour: [
    ['red', ['red', 'rosso', 'rossa', 'rossi', 'rosse'], []], ['green', ['green', 'verde', 'verdi'], []],
    ['blue', ['blue', 'blu', 'azzurro', 'azzurra', 'azzurri', 'azzurre'], []], ['yellow', ['yellow', 'giallo', 'gialla', 'gialli', 'gialle'], []],
    ['black', ['black', 'nero', 'nera', 'neri', 'nere'], []], ['white', ['white', 'bianco', 'bianca', 'bianchi', 'bianche'], []],
    ['grey', ['grey', 'gray', 'grigio', 'grigia', 'grigi', 'grigie'], []], ['orange', ['orange', 'arancione', 'arancioni'], []],
    ['purple', ['purple', 'violet', 'viola'], []], ['pink', ['pink'], []], ['brown', ['brown', 'marrone', 'marroni'], []],
    ['teal', ['teal'], []], ['plum', ['plum'], []], ['amber', ['amber', 'ambra'], []]],
  ordinal: [
    ['o1', ['first', '1st', 'primo', 'prima'], []], ['o2', ['second', '2nd', 'secondo', 'seconda'], []],
    ['o3', ['third', '3rd', 'terzo', 'terza'], []], ['o4', ['fourth', '4th', 'quarto', 'quarta'], []],
    ['o5', ['fifth', '5th', 'quinto', 'quinta'], []], ['o6', ['sixth', '6th', 'sesto', 'sesta'], []],
    ['o7', ['seventh', '7th', 'settimo', 'settima'], []], ['o8', ['eighth', '8th', 'ottavo', 'ottava'], []]],
  shape: [
    ['triangle', ['triangle', 'triangles', 'triangolo', 'triangoli'], []], ['square', ['square', 'squares', 'quadrato', 'quadrati'], []],
    ['circle', ['circle', 'circles', 'cerchio', 'cerchi'], []], ['star', ['star', 'stars', 'stella', 'stelle'], []],
    ['rectangle', ['rectangle', 'rectangles', 'rettangolo', 'rettangoli'], []], ['diamond', ['diamond', 'diamonds', 'rombo', 'rombi'], []]],
  direction: [
    ['north', ['north', 'northern', 'nord'], []], ['south', ['south', 'southern', 'sud'], []],
    ['east', ['east', 'eastern'], []], ['west', ['west', 'western', 'ovest'], []]],
};
// "prima di", "secondo il documento": a preposition, not an ordinal.
const NOT_ORDINAL_AFTER = /^\s+(?:(?:di|del|dello|della|dei|degli|delle|che|il|lo|la|i|gli|le|un|una|uno|quanto|me|te|lui|lei|noi|voi|loro|cui|quest[oaie]|quell[oaie]|tale)(?![\p{L}])|(?:dell'|d'|l'|un'|quest'|quell'))/iu;

function familyOf(value) {
  const plain = unaccent(value.trim().toLowerCase());
  for (const [family, entries] of Object.entries(FAMILIES)) for (const [id, forms, abbrs] of entries)
    if (forms.some((f) => unaccent(f) === plain) || abbrs.some((a) => a.toLowerCase() === plain)) return { family, id };
  return null;
}

// Family members stated in a text: [{ id, form, index }].
function familyMentions(text, family) {
  const out = [];
  for (const [id, forms, abbrs] of FAMILIES[family]) {
    for (const form of forms) {
      const re = new RegExp(`(?<![\\p{L}\\p{N}'-])${phrasePattern(form)}(?![\\p{L}\\p{N}-])`, 'giu');
      for (const m of text.matchAll(re)) {
        const after = text.slice(m.index + m[0].length);
        if (family === 'ordinal' && /^(?:prim[oa]|second[oa])$/i.test(m[0]) && NOT_ORDINAL_AFTER.test(after)) continue;
        if (family === 'ordinal' && /^second$/i.test(m[0]) && /\d\s*$/.test(text.slice(0, m.index))) continue; // "1 second"
        out.push({ id, form: m[0], index: m.index });
      }
    }
    for (const abbr of abbrs) {
      const re = new RegExp(`(?<![\\p{L}\\p{N}'-])(?:${escapeRegex(abbr)}|${escapeRegex(abbr.toUpperCase())})\\.?(?![\\p{L}\\p{N}'-])`, 'gu');
      for (const m of text.matchAll(re)) out.push({ id, form: m[0], index: m.index });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

// --------------------------------------------------------------- dates ----

const MONTH_FORMS = FAMILIES.month.flatMap(([id, forms, abbrs]) => [...forms, ...abbrs].map((form) => [form.toLowerCase(), Number(id.slice(1))]));
const MONTH_ALT = MONTH_FORMS.map(([form]) => phrasePattern(form)).sort((a, b) => b.length - a.length).join('|');
const monthNumber = (word) => MONTH_FORMS.find(([form]) => unaccent(form) === unaccent(word.toLowerCase().replace(/\.$/, '')))?.[1];

// Day-and-month dates of a text, in either order: [{ day, month, index, end }].
function datesIn(text) {
  const out = [];
  const dayFirst = new RegExp(`(?<![\\p{L}\\p{N}:.,])(\\d{1,2})(?:st|nd|rd|th|°|º)?\\s+(?:of\\s+|di\\s+)?(${MONTH_ALT})\\.?(?![\\p{L}])`, 'giu');
  const monthFirst = new RegExp(`(?<![\\p{L}\\p{N}])(${MONTH_ALT})\\.?\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?(?![\\p{L}\\p{N}:]|[.,]\\d)`, 'giu');
  for (const m of text.matchAll(dayFirst)) if (Number(m[1]) >= 1 && Number(m[1]) <= 31) out.push({ day: Number(m[1]), month: monthNumber(m[2]), index: m.index, end: m.index + m[0].length });
  for (const m of text.matchAll(monthFirst)) {
    if (!(Number(m[2]) >= 1 && Number(m[2]) <= 31) || out.some((d) => m.index < d.end && m.index + m[0].length > d.index)) continue;
    out.push({ day: Number(m[2]), month: monthNumber(m[1]), index: m.index, end: m.index + m[0].length });
  }
  return out.filter((d) => d.month).sort((a, b) => a.index - b.index);
}

// ------------------------------------------------------------- refusal ----

const STATED = '(?:stated|specified|mentioned|given|provided|shown|listed|indicated|included|present|visible|available|recorded|written|printed|displayed|supplied|attached|disclosed|reported|noted|legible|readable)';
const NON = "(?<![\\p{L}])non\\s+(?:(?:lo|la|li|le|ne|ci|vi|si|mi|ti)\\s+|l')?";
const REFUSAL = [
  // English
  new RegExp(`\\b(?:not|n't|never|nowhere)\\s+(?:\\w+ly\\s+)?(?:been\\s+)?${STATED}\\b`, 'i'),
  /\b(?:does|do|did)(?:n't| not)\s+(?:\w+ly\s+)?(?:appear to\s+|seem to\s+)?(?:say|state|specify|mention|give|provide|show|list|indicate|include|contain|appear|exist|reveal|display|have|tell|disclose|cover|address|name|identify)\b/i,
  /\b(?:can't|cannot|can not|could not|couldn't|unable to|not able to|impossible to|not possible to|no way to)\s+(?:be\s+)?(?:determine|determined|tell|find|answer|see|identify|say|confirm|read|view|access|open|inspect|analy[sz]e|know|establish|verify|provide|give|locate|extract|answered|found|known|established)\b/i,
  /\bthere\s+(?:is|are|was|were)\s+(?:no|not any|not a|n't any|n't a)\b/i, /\bthere\s+(?:isn't|aren't|wasn't|weren't)\b/i,
  /\bno\s+(?:such\s+)?(?:information|mention|indication|data|record|reference|details?|fourth|fifth|third|second|text|image|picture|page|row|value|figure|entry|label)\b/i,
  new RegExp(`\\b(?:no|none)\\b[^.!?\\n]{0,60}\\b(?:is|are|was|were)\\s+${STATED}\\b`, 'i'),
  new RegExp(`\\bonly\\b[^.!?\\n]{0,60}\\b(?:is|are|was|were)\\s+${STATED}\\b`, 'i'),
  /\bonly\s+(?:\w+\s+){0,3}?(?:images?|pages?|rows?|pictures?)\b/i,
  /\b(?:don't|do not)\s+(?:have|see|find|know)\b/i, /\b(?:unknown|unanswerable|unspecified|not applicable)\b/i,
  /\b(?:missing|absent|lacks?|lacking|omitted)\b/i, /\btext-only\b/i,
  // Italian ("non lo indica", "non ne parla": a clitic may follow "non")
  new RegExp(`${NON}(?:(?:è|e'|era|viene|vengono|sono|erano|risulta|risultano|compare|compaiono|appare|appaiono|figura|figurano|è stat[oaie]|sono stat[ie])\\s+)?(?:\\p{L}+\\s+)?(?:indicat|riportat|specificat|menzionat|present|visibil|disponibil|scritt|stampat|mostrat|fornit|citat|dichiarat|leggibil|precisat|inclus|registrat|not[oaie](?![\\p{L}])|determinabil|deducibil|possibile|ricavabil)`, 'iu'),
  new RegExp(`${NON}(?:posso|riesco|è possibile|sono in grado|può|riesce|saprei|so|vedo|trovo|leggo|ho|dispongo|conosco)(?![\\p{L}])`, 'iu'),
  new RegExp(`${NON}(?:c'è|ci sono|vi è|vi sono|esiste|esistono|c'era|c'erano)(?![\\p{L}])`, 'iu'),
  new RegExp(`${NON}(?:contiene|contengono|riporta|riportano|indica|indicano|specifica|specificano|menziona|menzionano|fornisce|forniscono|mostra|mostrano|compare|compaiono|include|includono|dice|dicono|presenta|presentano|appare|appaiono|risulta|risultano|figura|figurano|parla|parlano|vede|vedono)(?![\\p{L}])`, 'iu'),
  /(?<![\p{L}])ness(?:un|una|uno|un')\s*(?:informazione|indicazione|dato|menzione|riferimento|traccia|quart[oa]|terz[oa]|quint[oa]|testo|immagine|pagina|riga|valore|dettaglio|voce)/iu,
  /(?<![\p{L}])(?:manca|mancano|mancante|assente|assenti|sconosciut[oaie]|ignot[oaie])(?![\p{L}])/iu,
  /(?<![\p{L}])impossibile\s+(?:determinare|stabilire|dire|rispondere|ricavare|sapere|leggere|vedere)(?![\p{L}])/iu,
  /(?<![\p{L}])(?:solo|soltanto|solamente|unicamente|esclusivamente)(?![\p{L}])[^.!?\n]{0,60}(?<![\p{L}])(?:è|sono|viene|vengono|era|erano)\s+(?:\p{L}+\s+)?(?:indicat|riportat|fornit|mostrat|present|specificat|menzionat|allegat|visibil|disponibil)/iu,
  /(?<![\p{L}])(?:solo|soltanto|solamente)\s+(?:\p{L}+\s+){0,3}?(?:immagini|pagine|righe)(?![\p{L}])/iu,
];
const SPECULATION = [
  /\b(?:probably|likely|presumably|possibly|perhaps|maybe|i (?:would )?(?:guess|estimate|assume|suppose|suspect)|my (?:best )?guess|an estimate|i'd (?:guess|estimate|say)|could be|might be|may be|would be (?:about|around|roughly|approximately)|would (?:probably|likely) be|it is likely|roughly|approximately|if i had to)\b/i,
  /\b(?:probabilmente|presumibilmente|forse|magari|suppongo|ipotizzo|immagino|stimo|direi|a occhio|potrebbe essere|potrebbero essere|dovrebbe essere|dovrebbero essere|sarà (?:circa|intorno)|all'incirca|approssimativamente|verosimilmente)\b/i,
];
const NEGATION = /\b(?:not|no|none|never|nor|neither|only|without|cannot|unable|non|nessun[oa]?|né|mai|solo|soltanto|solamente|senza|manca|mancano|unknown|sconosciut[oaie])\b|n't\b/i;
const STOPWORDS = new Set(('the a an of in on at to for from by with and or is are was were be been do does did what which who whom whose when where why how many much ' +
  'it its this that these those there their as than then into about per each any all both ' +
  'il lo la i gli le un una uno di del dello della dei degli delle a ad al allo alla ai agli alle da dal dallo dalla dai dagli dalle in nel nello nella nei negli nelle ' +
  'con su sul sullo sulla sui sugli sulle per tra fra e ed o che chi cui quale quali quanto quanta quanti quante come dove quando perché è sono era si ' +
  'file page pagina image immagine').split(' '));

const sentences = (text) => text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
const refuses = (text) => REFUSAL.some((re) => re.test(text));
const contentWords = (text) => new Set((unaccent(text.toLowerCase()).match(/[\p{L}]{4,}/gu) || []).filter((w) => !STOPWORDS.has(w)).map((w) => w.slice(0, 6)));

// Value tokens a text carries (numbers, clock times, codes), each as the list
// of its readings.
function valueTokens(text, language) {
  const out = [];
  for (const n of numbersIn(text, { keepRefs: true, language })) out.push([`n:${n.value}`, ...(n.alt === undefined ? [] : [`n:${n.alt}`])]);
  for (const t of clockTimes(text)) out.push([`t:${t.minutes}`]);
  for (const m of text.matchAll(/(?<![\p{L}\p{N}])(?=[\p{L}\p{N}-]*\d)(?=[\p{L}\p{N}-]*\p{L})[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*(?![\p{L}\p{N}])/gu)) out.push([`c:${m[0].toLowerCase()}`]);
  return out;
}

// --------------------------------------------------------------- grade ----

function evidenceTexts(question) {
  const e = question.evidence || {};
  return [e.fact, e.visual, ...(Array.isArray(e.also) ? e.also.flatMap((a) => [a.fact, a.visual]) : [])].filter((t) => typeof t === 'string');
}

// One listed value of an exact, one-of or all-of expectation, typed.
function kindOf(literal) {
  const v = literal.trim();
  if (/^\d{1,2}:\d{2}(?:\s*[ap]\.?m\.?)?$/i.test(v) || /^\d{1,2}(?:[:.]\d{2})?\s*[ap]\.?m\.?$/i.test(v)) return { literal, kind: 'time', time: clockTimes(v)[0] };
  if (/^\d+(?:[.,]\d+)?$/.test(v)) return /^0\d/.test(v) ? { literal, kind: 'digits', digits: v } : { literal, kind: 'number', number: Number(v.replace(',', '.')) };
  const date = datesIn(v);
  if (date.length === 1 && date[0].index === 0 && date[0].end === v.length) return { literal, kind: 'date', date: date[0] };
  const family = familyOf(v);
  if (family) return { literal, kind: 'family', ...family };
  if (/^\p{Lu}$/u.test(v)) return { literal, kind: 'letter', letter: v };
  return { literal, kind: 'phrase' };
}

// The value as written, standing as whole words.
function findPhrase(text, literal) {
  const m = new RegExp(`(?<![\\p{L}\\p{N}'])${phrasePattern(literal)}(?![\\p{L}\\p{N}])`, 'iu').exec(text);
  return m ? { index: m.index, end: m.index + m[0].length } : null;
}

const ALTERNATIVE_AFTER = /^\s*,?\s*(?:or|oppure|o|ovvero)\s+(?:the\s+|il\s+|la\s+|lo\s+|l')?([^.,;!?\n]{1,40})/iu;
const ALTERNATIVE_BEFORE = /(?<![\p{L}])(?:or|oppure|either|o)\s+(?:the\s+|il\s+|la\s+|lo\s+|l')?$/iu;
const near = (a, b) => Math.abs(a - b) < 1e-9;
const clock = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const readings = (n) => n.alt === undefined ? [n.value] : [n.value, n.alt];

// Letters, digits and case of a free-text value: `Marenka Dolvich` -> `Aa Aa`, `BR-6093` -> `A-9`.
const shapeOf = (text) => text.trim().replace(/\p{Lu}+/gu, 'A').replace(/\p{Ll}+/gu, 'a').replace(/\p{N}+/gu, '9').replace(/\s+/g, ' ');
const LIST_SEPARATOR = /\s*(?:,|\/|(?<![\p{L}])(?:or|oppure|o|and|e|either|ovvero)(?![\p{L}']))\s*/iu;
const LIST_EDGE = /^(?:the|a|an|il|lo|la|i|gli|le|un|una|uno|l')\s+|[\s.!?:;()"']+$/giu;
const same = (a, b) => unaccent(a.trim().toLowerCase()) === unaccent(b.trim().toLowerCase());

// Other entries of the list that holds a free-text value, with the value's shape.
function sameShapeEntries(text, span, literal, literals, contextWords) {
  const lineStart = text.lastIndexOf('\n', span.index) + 1, lineEnd = text.indexOf('\n', span.end);
  const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
  const sentence = line.split(/(?<=[.!?])\s+(?=\p{Lu})/u).find((part, i, all) => {
    const start = lineStart + all.slice(0, i).reduce((n, p) => n + p.length + 1, 0);
    return span.index >= start && span.index < start + part.length + 1;
  }) || line;
  const shape = shapeOf(literal), out = [];
  for (const raw of sentence.split(LIST_SEPARATOR)) {
    const entry = raw.replace(LIST_EDGE, '').replace(LIST_EDGE, '');
    if (!entry || shapeOf(entry) !== shape || literals.some((v) => same(entry, v))) continue;
    const words = unaccent(entry.toLowerCase()).match(/[\p{L}\p{N}-]+/gu) || [];
    if (words.length && words.every((w) => contextWords.has(w))) continue;
    out.push(entry);
  }
  return out;
}

function gradeValues(question, text, literals, mode, language) {
  const prompt = cleanAnswer(question.prompt || '');
  const tags = question.tags || [];
  const sources = evidenceTexts(question).map(cleanAnswer);
  const kinds = literals.map(kindOf);
  const has = (kind) => kinds.some((k) => k.kind === kind);
  const tolerance = Number(question.expected.tolerance) || 0;

  const isNumber = (n, k) => k.kind === 'digits' ? n.raw === k.digits : k.kind === 'number' && readings(n).some((v) => Math.abs(v - k.number) <= tolerance + 1e-9);
  const wantsNumber = (n) => kinds.some((k) => isNumber(n, k));
  const numeric = has('number') || has('digits');
  const refsMatter = tags.includes('physical-page') || tags.includes('printed-label') || tags.includes('image-order');
  const answerNumbers = numeric ? numbersIn(text, { language, keepRefs: refsMatter, keepValue: (v) => wantsNumber({ value: v, raw: String(v) }) }) : [];
  // "the third physical page" in the question makes "page 3" context too.
  const stated = (s) => [...numbersIn(s, { language, keepRefs: true }), ...familyMentions(s, 'ordinal').map((m) => ({ value: Number(m.id.slice(1)), raw: m.form }))];
  const promptNumbers = numeric ? stated(prompt) : [];
  const contextNumbers = [...(promptNumbers.some(wantsNumber) ? [] : promptNumbers), ...sources.flatMap(stated)].flatMap(readings);
  const competingNumbers = [...new Set(answerNumbers.filter((n) => !wantsNumber(n) && !contextNumbers.some((v) => readings(n).some((r) => near(v, r)))).map((n) => n.value))];

  const wantsTime = (t) => kinds.some((k) => k.kind === 'time' && t.minutes === k.time.minutes);
  const answerTimes = has('time') ? clockTimes(text, { dotted: true }) : [];
  const contextTimes = has('time') ? [prompt, ...sources].flatMap((s) => clockTimes(s, { dotted: true })).map((t) => t.minutes) : [];
  const competingTimes = [...new Set(answerTimes.filter((t) => !wantsTime(t) && !contextTimes.includes(t.minutes)).map((t) => t.minutes))];

  const wantsDate = (d) => kinds.some((k) => k.kind === 'date' && k.date.day === d.day && k.date.month === d.month);
  const answerDates = has('date') ? datesIn(text) : [];
  const contextDates = has('date') ? [prompt, ...sources].flatMap(datesIn) : [];
  const competingDates = [...new Set(answerDates.filter((d) => !wantsDate(d) && !contextDates.some((o) => o.day === d.day && o.month === d.month)).map((d) => `${d.day}/${d.month}`))];

  const competingFamily = new Set(), familyHits = new Map();
  for (const family of new Set(kinds.filter((k) => k.kind === 'family').map((k) => k.family))) {
    const wanted = new Set(kinds.filter((k) => k.kind === 'family' && k.family === family).map((k) => k.id));
    const inPrompt = familyMentions(prompt, family).map((m) => m.id);
    const context = new Set([...(inPrompt.some((id) => wanted.has(id)) ? [] : inPrompt), ...sources.flatMap((s) => familyMentions(s, family).map((m) => m.id))]);
    const mentions = familyMentions(text, family);
    familyHits.set(family, mentions);
    for (const m of mentions) if (!wanted.has(m.id) && !context.has(m.id)) competingFamily.add(unaccent(m.form.toLowerCase()));
  }

  // Labels: capital letters standing alone. A, I, E and O are also words.
  const letters = kinds.filter((k) => k.kind === 'letter').map((k) => k.letter);
  const standsAlone = (letter) => new RegExp(`(?<![\\p{L}\\p{N}'.-])${letter}(?![\\p{L}\\p{N}'-])`, 'u');
  const competingLetters = letters.length ? [...new Set([...text.matchAll(/(?<![\p{L}\p{N}'.-])(\p{Lu})(?![\p{L}\p{N}'-])/gu)].map((m) => m[1])
    .filter((l) => !letters.includes(l) && !'AIEO'.includes(l) && !standsAlone(l).test(prompt)))] : [];

  const contextWords = new Set([prompt, ...sources].flatMap((t) => unaccent(t.toLowerCase()).match(/[\p{L}\p{N}-]+/gu) || []));
  const competingPhrases = new Set();
  const found = [], missing = [];
  let hedged = false;
  for (const k of kinds) {
    let span = null, hit = false;
    if (k.kind === 'digits' || k.kind === 'number') hit = answerNumbers.some((n) => isNumber(n, k));
    else if (k.kind === 'time') hit = answerTimes.some((t) => t.minutes === k.time.minutes);
    else if (k.kind === 'date') hit = answerDates.some((d) => d.day === k.date.day && d.month === k.date.month);
    else if (k.kind === 'family') {
      const mention = familyHits.get(k.family).find((m) => m.id === k.id);
      span = mention ? { index: mention.index, end: mention.index + mention.form.length } : null;
    } else if (k.kind === 'letter') {
      const m = standsAlone(k.letter).exec(text);
      span = m ? { index: m.index, end: m.index + 1 } : null;
    } else {
      span = findPhrase(text, k.literal);
      if (span) for (const entry of sameShapeEntries(text, span, k.literal, literals, contextWords)) competingPhrases.add(entry);
    }
    hit ||= Boolean(span);
    if (span) {
      const after = text.slice(span.end).match(ALTERNATIVE_AFTER);
      // "third or 3rd": another listed value is a synonym, not an alternative.
      if ((after && !literals.some((v) => v !== k.literal && findPhrase(after[1], v))) || ALTERNATIVE_BEFORE.test(text.slice(0, span.index))) hedged = true;
    }
    (hit ? found : missing).push(k.literal);
  }
  const competing = [...competingNumbers, ...competingTimes.map(clock), ...competingDates, ...competingFamily, ...competingLetters, ...competingPhrases];
  const detail = { stated: found, missing, competing };
  const enough = mode === 'all' ? missing.length === 0 : found.length > 0;
  if (!enough) {
    if (mode === 'all' && found.length) return { passed: false, class: 'partial', detail };
    if (competing.length) return { passed: false, class: 'wrong_value', detail };
    if (refuses(text)) return { passed: false, class: 'refused', detail };
    const offered = competing.length > 0 || answerNumbers.length > 0 || answerTimes.length > 0 || answerDates.length > 0
      || [...familyHits.values()].some((list) => list.length > 0) || has('phrase') || has('letter');
    return { passed: false, class: offered ? 'wrong_value' : 'no_value', detail };
  }
  // An explicit "X or Y" is `hedged` even when Y also has the value's shape.
  if (competing.length > competingPhrases.size) return { passed: false, class: 'value_among_others', detail };
  if (hedged) return { passed: false, class: 'hedged', detail };
  if (competingPhrases.size) return { passed: false, class: 'value_among_others', detail };
  return { passed: true, class: 'correct', detail };
}

function gradeUnanswerable(question, text, context) {
  const parts = sentences(text);
  if (!parts.some(refuses)) return { passed: false, class: 'no_refusal', detail: {} };
  const guess = parts.find((s) => SPECULATION.some((re) => re.test(s)));
  if (guess) return { passed: false, class: 'refused_then_guessed', detail: { sentence: guess } };
  // A sentence that affirms a value for the asked thing, where the value is
  // in neither the question nor anything known to be in the input.
  const known = new Set(valueTokens([question.prompt, question.evidence?.missing, ...(question.evidence?.absentTerms || []), context.knownText]
    .filter(Boolean).map(cleanAnswer).join('\n'), context.language).flat());
  const asked = contentWords(question.prompt || '');
  // "I cannot see it, but the total is 49,10": the second clause is an answer.
  const clauses = parts.flatMap((s) => s.split(/\s*[,;:]?\s*(?<![\p{L}])(?:but|however|although|though|yet|ma|però|tuttavia|anche se|sebbene|comunque)(?![\p{L}])\s*,?\s*/iu)).filter(Boolean);
  for (const s of clauses) {
    if (NEGATION.test(s) || refuses(s)) continue;
    const words = contentWords(s);
    if (![...asked].some((w) => words.has(w))) continue;
    const novel = valueTokens(s, context.language).filter((token) => !token.some((reading) => known.has(reading))).map((token) => token[0]);
    if (novel.length) return { passed: false, class: 'refused_but_value_asserted', detail: { sentence: s, values: novel } };
  }
  return { passed: true, class: 'honest_refusal', detail: {} };
}

// question: a manifest question. answer: the final answer text.
// context.language: the item's language ("en" or "it"), for the reading of
// `9.604` and `2.500`. context.knownText: text known to be in the input (the
// item's recorded facts, the text actually sent to the model); used only by
// the unanswerable rule. Returns { passed, class, type, detail, grader }.
export function gradeAnswer(question, answer, context = {}) {
  const expected = question?.expected || {};
  const base = { type: expected.type, grader: GRADER_VERSION };
  if (typeof answer !== 'string') return { passed: false, class: 'empty', detail: { reason: 'no answer text' }, ...base };
  if (Buffer.byteLength(answer) > 262144) return { passed: false, class: 'too_long', detail: { reason: 'answer exceeds 256 KiB' }, ...base };
  const text = cleanAnswer(answer);
  if (!/[\p{L}\p{N}]/u.test(text)) return { passed: false, class: 'empty', detail: {}, ...base };
  let result;
  if (expected.type === 'unanswerable') result = gradeUnanswerable(question, text, context);
  else if (expected.type === 'number') result = gradeValues(question, text, [String(expected.value)], 'any', context.language);
  else if (expected.type === 'exact') result = gradeValues(question, text, [expected.value], 'any', context.language);
  else if (expected.type === 'one-of') result = gradeValues(question, text, expected.value, 'any', context.language);
  else if (expected.type === 'all-of') result = gradeValues(question, text, expected.value, 'all', context.language);
  else throw new Error(`unknown expected.type ${JSON.stringify(expected.type)}`);
  return { ...result, ...base };
}

// The unanswerable rule applied to an answerable question: used where a model
// that receives no pixels is asked for a fact that exists only in pixels. The
// honest reply is a limitation; stating a value is a failure.
export function gradeHonestLimitation(question, answer, context = {}) {
  const limited = { prompt: question.prompt, expected: { type: 'unanswerable' }, evidence: {} };
  return { ...gradeAnswer(limited, answer, context), type: 'honest-limitation' };
}

// An authored correct answer built from `expected`, in the item's language.
// Used by the grader's self-check and by simulated runner tests; it is not a
// model answer and is never shown to one.
export function oracleAnswer(question, language = 'en') {
  const e = question.expected, it = language === 'it';
  const number = (value) => {
    const [whole, frac] = String(value).split('.');
    const grouped = whole.length > 4 ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, it ? '.' : ',') : whole;
    return frac ? `${grouped}${it ? ',' : '.'}${frac}` : grouped;
  };
  if (e.type === 'unanswerable') return it ? 'Il documento non riporta questa informazione.' : 'The input does not state this.';
  const lead = it ? 'La risposta è' : 'The answer is';
  if (e.type === 'number') return `${lead} ${number(e.value)}.`;
  if (e.type === 'exact') return `${lead} ${e.value}.`;
  if (e.type === 'one-of') return `${lead} ${e.value[0]}.`;
  return `${lead} ${e.value.join(it ? ' e ' : ' and ')}.`;
}
