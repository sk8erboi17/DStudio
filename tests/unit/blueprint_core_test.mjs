// Executes the production Blueprint core (createBlueprintCore in
// web/index.html): streaming parse, validation, reach/route, citation
// verification, layout and SVG. Pure functions; no browser or model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { extractFunction, artifactRunDir, writeArtifact } from '../support/real_harness.mjs';

const source = fs.readFileSync('web/index.html', 'utf8');
const context = vm.createContext({});
vm.runInContext(`${extractFunction(source, 'createBlueprintCore')}\nthis.core = createBlueprintCore();`, context);
const core = context.core;
const run = artifactRunDir('blueprint-core');
const report = { scope: 'Production Blueprint core functions; synthetic specs and files', cases: [] };
async function check(name, fn) {
  const row = { name };
  report.cases.push(row);
  try { await fn(row); row.status = 'PASS'; }
  catch (error) { row.status = 'FAIL'; row.error = String(error.stack); process.exitCode = 1; }
  writeArtifact(run, 'results.json', report);
  console.log(`${row.status}: ${name}${row.error ? `\n${row.error}` : ''}`);
}
// vm objects come from another realm: compare through JSON.
const tag = (x) => Object.prototype.toString.call(x);
const plain = (v) => JSON.parse(JSON.stringify(v, (k, x) => (tag(x) === '[object Set]' ? [...x].sort() : tag(x) === '[object Map]' ? [...x] : x)));

const SPEC = {
  schema: 'dstudio.blueprint/1', kind: 'architecture', title: 'Shop', summary: 'Orders and storage.',
  groups: [{ id: 'edge', label: 'Edge' }, { id: 'core', label: 'Core' }],
  nodes: [
    { id: 'api', label: 'API', type: 'service', group: 'edge', description: 'HTTP routes', sources: [{ path: 'src/api.js', lines: [3, 4], quote: 'function route(req) {' }] },
    { id: 'orders', label: 'Orders', type: 'module', group: 'core', sources: [{ path: 'src/orders.js', lines: [1, 1], quote: 'exports.create = create;' }] },
    { id: 'db', label: 'DB', type: 'store', group: 'core' },
    { id: 'mail', label: 'Mailer', type: 'external' },
  ],
  edges: [
    { from: 'api', to: 'orders', label: 'create', type: 'call' },
    { from: 'orders', to: 'db', label: 'insert', type: 'data' },
    { from: 'db', to: 'orders', label: 'rows', type: 'data' },
    { from: 'orders', to: 'mail', label: 'notify', type: 'event' },
  ],
  open_questions: ['Retries?'],
};

await check('every streamed prefix parses without throwing and nodes only accumulate', (row) => {
  const text = JSON.stringify(SPEC, null, 1);
  let last = 0, lastEdges = 0, parsedPrefixes = 0;
  for (let i = 0; i <= text.length; i++) {
    const raw = core.parsePartial(text.slice(0, i));
    if (!raw) continue;
    parsedPrefixes++;
    const { spec } = core.normalize(raw, { partial: true, kind: 'architecture' });
    const n = spec.nodes.length, e = spec.edges.length;
    assert.ok(n >= last, `node count went back at ${i}: ${last} -> ${n}`);
    if (n === last) assert.ok(e >= lastEdges, `edge count went back at ${i}`);
    last = n; lastEdges = e;
  }
  row.parsedPrefixes = parsedPrefixes;
  assert.deepEqual(plain(core.parsePartial(text)), SPEC, 'the complete text parses exactly');
  assert.equal(core.parsePartial('no json here'), null);
  const braces = core.parsePartial('{"title": "a {b} [c]", "nodes": [{"id": "x", "label": "q\\"uo');
  assert.equal(braces.title, 'a {b} [c]', 'brackets inside strings are text');
  assert.deepEqual(plain(braces.nodes), [{ id: 'x' }], 'an unfinished string is left out, not guessed');
});

await check('validation keeps what can be drawn truthfully and reports every drop', () => {
  const bad = structuredClone(SPEC);
  bad.nodes.push({ id: 'API', label: 'dup' });
  bad.nodes.push({ label: 'no id' });
  bad.nodes.push({ id: 'cfg', label: 'Config', type: 'spaceship', group: 'nowhere', sources: [{ path: '../etc/passwd' }, { path: '/abs/x.js' }, { path: 'ok.js', lines: [9, 3] }, { path: './rel/y.js', lines: '12-14' }] });
  bad.edges.push({ from: 'api', to: 'ghost' });
  bad.edges.push({ from: 'api', to: 'orders', label: 'create', type: 'call' });
  const { spec, issues } = core.normalize(bad);
  assert.deepEqual(plain(spec.nodes.map((n) => n.id)), ['api', 'orders', 'db', 'mail', 'cfg']);
  const cfg = spec.nodes.find((n) => n.id === 'cfg');
  assert.equal(cfg.type, 'module', 'unknown type drawn as the kind fallback');
  assert.equal(cfg.group, '');
  assert.deepEqual(plain(cfg.sources), [{ path: 'ok.js', lines: null, quote: '' }, { path: 'rel/y.js', lines: [12, 14], quote: '' }]);
  assert.equal(spec.edges.length, 4, 'unknown endpoint and duplicate dropped');
  const messages = issues.map((i) => i.message).join('\n');
  for (const m of [/duplicate node id "api"/, /without an id/, /not a architecture type/, /unknown group "nowhere"/, /valid workspace-relative path/, /ghost.*does not exist/, /duplicate relationship/]) assert.match(messages, m);
  assert.ok(!issues.some((i) => i.level === 'error'));
  assert.equal(core.normalize({ schema: 'other/9', kind: 'architecture', nodes: [{ id: 'a' }] }).issues[0].level, 'error');
  assert.equal(core.normalize({ kind: 'galaxy' }).spec, null);
  assert.equal(core.normalize([]).spec, null);
  const many = { kind: 'workflow', nodes: Array.from({ length: 45 }, (_, i) => ({ id: `n${i}`, label: `Step ${i}` })) };
  const capped = core.normalize(many);
  assert.equal(capped.spec.nodes.length, core.LIMITS.nodes);
  assert.ok(capped.issues.some((i) => /only the first 40 nodes/.test(i.message)));
});

await check('sequence participants named only by steps are added, and steps keep their order', () => {
  const { spec, issues } = core.normalize({ kind: 'sequence', nodes: [{ id: 'web', label: 'Web' }],
    steps: [{ from: 'web', to: 'api', label: 'GET' }, { from: 'api', to: 'api', label: 'validate' }, { from: 'api', to: 'web', label: '200', type: 'return' }] });
  assert.deepEqual(plain(spec.nodes.map((n) => n.id)), ['web', 'api']);
  assert.deepEqual(plain(spec.steps.map((s) => `${s.id}:${s.from}>${s.to}:${s.type}`)), ['s0:web>api:call', 's1:api>api:call', 's2:api>web:return']);
  assert.ok(issues.some((i) => /participant "api" was not declared/.test(i.message)));
});

await check('reach and routes follow stated relationships only, cycles included', () => {
  const { spec } = core.normalize(SPEC);
  assert.deepEqual(plain(core.reach(spec, 'orders', 'down')), { nodes: ['db', 'mail', 'orders'], edges: ['e1', 'e2', 'e3'] });
  // db is upstream of orders and orders of db: the cycle's edges are included.
  assert.deepEqual(plain(core.reach(spec, 'orders', 'up')), { nodes: ['api', 'db', 'orders'], edges: ['e0', 'e1', 'e2'] });
  assert.deepEqual(plain(core.reach(spec, 'mail', 'down')), { nodes: ['mail'], edges: [] });
  assert.deepEqual(plain(core.route(spec, 'api', 'mail')), { nodes: ['api', 'orders', 'mail'], edges: ['e0', 'e3'] });
  assert.equal(core.route(spec, 'mail', 'api'), null);
  assert.equal(core.route(spec, 'api', 'api'), null);
});

await check('a citation is verified only by the bytes of the cited file', () => {
  const file = 'line one\n  function route(req) {\n    return req;\n  }\nexports.create = create;\n';
  assert.deepEqual(plain(core.verifySource(file, { quote: 'function   route(req) {', lines: [1, 3] })), { status: 'verified', line: 2 });
  assert.deepEqual(plain(core.verifySource(file, { quote: 'return req; }', lines: [3, 3] })), { status: 'verified', line: 3 }, 'a quote may span lines');
  assert.deepEqual(plain(core.verifySource(file, { quote: 'exports.create = create;', lines: [40, 41] })), { status: 'moved', line: 5 });
  assert.equal(core.verifySource(file, { quote: 'function routes(req)', lines: [2, 2] }).status, 'unverified');
  assert.equal(core.verifySource(null, { quote: 'x' }).status, 'missing');
  assert.deepEqual(plain(core.verifySource(file, { quote: '', lines: [2, 2] })), { status: 'unquoted', line: 2 });
  assert.equal(core.verifySource(file, { quote: '', lines: [90, 91] }).status, 'unverified');
});

await check('verifySpec reads each cited file once and summarises claims', async (row) => {
  const files = { 'src/api.js': 'x\ny\nfunction route(req) {\n}\n', 'src/orders.js': 'const a = 1;\n' };
  const reads = [];
  const { spec } = core.normalize(SPEC);
  spec.edges[0].sources = [{ path: 'src/api.js', lines: [3, 3], quote: 'function route(req) {' }, { path: 'src/missing.js', lines: [1, 1], quote: 'x' }];
  const r = await core.verifySpec(spec, async (p) => { reads.push(p); return files[p] ?? null; });
  assert.deepEqual(reads.sort(), ['src/api.js', 'src/missing.js', 'src/orders.js']);
  assert.equal(r.items.get('node:api'), 'verified');
  assert.equal(r.items.get('node:orders'), 'unverified');
  assert.equal(r.items.get('node:db'), 'unsourced');
  assert.equal(r.items.get('rel:e0'), 'partial');
  assert.equal(r.claims, 8);
  assert.equal(r.supported, 2);
  assert.deepEqual(plain(r.counts), { verified: 2, moved: 0, unverified: 1, missing: 1, unquoted: 0, skipped: 0 });
  const capped = await core.verifySpec(spec, async (p) => files[p] ?? null, 1);
  assert.ok(capped.counts.skipped > 0, 'files beyond the bound are reported as not checked');
  row.citations = r.citations.length;
});

await check('layout is deterministic, keeps nodes apart and inside their lanes', (row) => {
  const { spec } = core.normalize(SPEC);
  const a = core.layout(spec), b = core.layout(structuredClone(spec));
  assert.deepEqual(plain([...a.nodes]), plain([...b.nodes]));
  assert.deepEqual(plain(a.edges), plain(b.edges));
  const boxes = [...a.nodes.entries()];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const [p, q] = [boxes[i][1], boxes[j][1]];
    assert.ok(p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y, `${boxes[i][0]} overlaps ${boxes[j][0]}`);
  }
  for (const [id, p] of boxes) {
    assert.ok(p.x >= 0 && p.y >= 0 && p.x + p.w <= a.width && p.y + p.h <= a.height, `${id} outside the canvas`);
    const group = spec.nodes.find((n) => n.id === id).group;
    const lane = a.lanes.find((l) => l.id === group);
    assert.ok(lane && p.y >= lane.y && p.y + p.h <= lane.y + lane.h, `${id} outside its lane`);
  }
  assert.equal(a.edges.find((e) => e.id === 'e2').back, true, 'the cycle edge is drawn as a back edge');
  assert.equal(a.dir, 'LR');
  const wf = core.layout(core.normalize({ kind: 'workflow', nodes: [{ id: 's', type: 'start' }, { id: 'd', type: 'decision' }, { id: 'e', type: 'end' }], edges: [{ from: 's', to: 'd' }, { from: 'd', to: 'e' }] }).spec);
  assert.equal(wf.dir, 'TB');
  assert.ok(wf.nodes.get('s').y < wf.nodes.get('d').y && wf.nodes.get('d').y < wf.nodes.get('e').y, 'workflow flows downwards');
  row.size = `${a.width}x${a.height}`;
});

await check('the SVG escapes every author string', () => {
  const evil = core.normalize({ kind: 'architecture', title: '<script>alert(1)</script>', nodes: [{ id: 'x', label: '<img src=x onerror=alert(1)>', description: '"><svg onload=1>' }, { id: 'y', label: 'Y' }],
    edges: [{ from: 'x', to: 'y', label: '</text><script>bad()</script>' }] }).spec;
  const svg = core.renderSvg(evil, core.layout(evil));
  // Escaped text cannot contain a raw "<" or ">", so every <...> token is a
  // tag the renderer wrote: only SVG drawing tags, never an event handler.
  const tags = svg.match(/<[^>]*>/g);
  const names = new Set(tags.map((t) => t.match(/^<\/?([a-zA-Z]+)/)?.[1]));
  assert.deepEqual([...names].sort(), ['circle', 'defs', 'g', 'marker', 'path', 'rect', 'svg', 'text'].filter((n) => names.has(n)).sort());
  assert.ok(![...names].some((n) => /script|img|foreignObject|iframe/i.test(n)), `unexpected tag: ${[...names]}`);
  // Attribute values are escaped (no raw quote), so names can be read exactly.
  const attrNames = tags.flatMap((t) => [...t.matchAll(/\s([a-zA-Z_:][-\w:.]*)\s*=\s*"[^"]*"/g)].map((m) => m[1].toLowerCase()));
  assert.ok(attrNames.length > 20 && !attrNames.some((n) => n.startsWith('on')), 'no event-handler attribute');
  assert.match(svg, /&lt;img src=x onerror=/, 'the label is shown as text');
  assert.equal((svg.match(/<svg/g) || []).length, 1);
});

await check('the prompt names the file, the schema and the evidence contract', () => {
  const p = core.buildPrompt({ kind: 'sequence', focus: 'a cache miss', path: '.dstudio/blueprints/s.json' });
  assert.match(p, /one sequence diagram .* focused on: a cache miss/);
  assert.match(p, /ONE write tool call to \.dstudio\/blueprints\/s\.json/);
  assert.match(p, /"schema": "dstudio\.blueprint\/1", "kind": "sequence"/);
  assert.match(p, /"steps": \[/);
  assert.match(p, /DStudio checks every quote against the file/);
  assert.doesNotMatch(core.buildPrompt({ kind: 'architecture', path: 'x.json' }), /"steps"/);
});

await check('the Design hand-off carries every part and relationship, bounded', (row) => {
  const spec = core.normalize({ ...SPEC, nodes: [...SPEC.nodes, { id: 'web', label: 'Web shop', type: 'client', group: 'edge' }],
    edges: [...SPEC.edges, { from: 'web', to: 'api', label: 'POST /orders' }] }).spec;
  const brief = core.designBrief(spec, { path: '.dstudio/blueprints/shop.json' });
  for (const n of spec.nodes) assert.ok(brief.includes(`- ${n.label} [${n.type}`), `part ${n.label}`);
  assert.match(brief, /Parts \(5\), by group:\nEdge:\n  - API \[service\]: HTTP routes\n  - Web shop \[client\]\nCore:\n  - Orders \[module\]\n  - DB \[store\]\nOther parts:\n  - Mailer \[external\]/);
  assert.match(brief, /- Web shop → API: POST \/orders/);
  assert.match(brief, /- Orders → DB: insert/);
  assert.match(brief, /map of existing code/);
  assert.match(brief, /the parts people use \(Web shop\)/, 'client parts are named as screens');
  assert.match(brief, /say how many there are/);
  // The largest blueprint the schema keeps stays a bounded prompt.
  const long = 'x'.repeat(2000);
  const big = core.normalize({ kind: 'architecture', title: long, summary: long,
    groups: Array.from({ length: 30 }, (_, i) => ({ id: `g${i}`, label: long, description: long })),
    nodes: Array.from({ length: 60 }, (_, i) => ({ id: `n${i}`, label: long, type: 'client', group: `g${i % 12}`, description: long })),
    edges: Array.from({ length: 200 }, (_, i) => ({ from: `n${i % 40}`, to: `n${(i * 7 + 1) % 40}`, label: `${i}${long}` })),
    open_questions: Array.from({ length: 20 }, () => long) }).spec;
  row.maxChars = core.designBrief(big).length;
  assert.ok(row.maxChars < 26000, `bounded: ${row.maxChars}`);
  // A plan says so, and a sequence keeps its order.
  const seq = core.normalize({ kind: 'sequence', basis: 'description', nodes: [{ id: 'u', label: 'User', type: 'actor' }, { id: 's', label: 'Shop' }],
    steps: [{ from: 'u', to: 's', label: 'open' }, { from: 's', to: 'u', label: 'page' }] }).spec;
  const sb = core.designBrief(seq);
  assert.match(sb, /plan written from a description/);
  assert.match(sb, /Steps in order \(2\):\n1\. User → Shop: open\n2\. Shop → User: page/);
});

await check('the implement prompt follows the blueprint basis', () => {
  const code = core.normalize(SPEC).spec;
  const p = core.buildImplementPrompt({ path: '.dstudio/blueprints/shop.json', spec: code });
  assert.match(p, /^Implement the DStudio Blueprint "Shop" \(\.dstudio\/blueprints\/shop\.json\)/);
  assert.match(p, /with 4 parts and 4 relationships/);
  assert.match(p, /1\. Read \.dstudio\/blueprints\/shop\.json first/);
  assert.match(p, /keep that code/);
  assert.doesNotMatch(p, /choose the simplest common stack/);
  assert.match(p, /Do not edit \.dstudio\/blueprints\/shop\.json\./);
  assert.doesNotMatch(p, /holds screens designed/);
  const plan = core.normalize({ ...SPEC, basis: 'description', open_questions: ['Which database?'] }).spec;
  const pp = core.buildImplementPrompt({ path: 'b.json', spec: plan, designDir: 'design' });
  assert.match(pp, /Nothing of it is implemented yet/);
  assert.match(pp, /"Which database\?"/);
  assert.match(pp, /design\/ holds screens designed from this blueprint/);
  // Steps are numbered without gaps whatever is included.
  const nums = [...pp.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
  assert.deepEqual(nums, nums.map((_, i) => i + 1));
});

const failed = report.cases.filter((c) => c.status !== 'PASS').length;
console.log(`blueprint_core_test: ${report.cases.length - failed}/${report.cases.length} passed`);
