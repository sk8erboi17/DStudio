// Execute the production inline functions. Extraction is harness plumbing;
// assertions cover migration, failed requests, concurrency and preserved state.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const html = fs.readFileSync('web/index.html', 'utf8');
const source = html.slice(html.indexOf('      function loadDs()'), html.indexOf('      function clearGearPopoverPlacement()'));
function fixture(settings, getCatalog) {
  const writes = [], notices = [];
  const context = vm.createContext({
    Store: { getSettings: () => settings, setSettingsNow: patch => { writes.push(patch); Object.assign(settings, patch); } },
    Engine: { designSystems: getCatalog },
    toast: text => notices.push(text), rebuildGearIfOpen() {},
  });
  vm.runInContext('let dsCache = null, dsCatalogIds = null, dsFlight = null, dsError = "";\n' + source, context);
  return { context, settings, writes, notices, prepare: () => context.prepareDesignSystem(), load: () => context.loadDs() };
}
const catalog = { ok: true, catalogIds: ['folio', 'signal'], designSystems: [{ id: 'folio', available: true }, { id: 'signal', available: true }] };

let release, calls = 0;
const delayed = fixture({ designSystem: 'retired-import', workdirs: { design: 'keep-project' }, other: 'keep' }, async () => {
  calls++;
  return await new Promise(resolve => { release = resolve; });
});
let done = false;
const first = delayed.prepare().then(value => { done = true; return value; });
const second = delayed.load();
assert.equal(calls, 1, 'gallery and launch must share the in-flight request');
assert.equal(done, false);
assert.equal(delayed.settings.designSystem, 'retired-import', 'no migration on an unresolved catalog');
release(catalog);
assert.equal(await first, ''); await second;
assert.equal(delayed.writes.length, 1);
assert.equal(delayed.notices.length, 1);
assert.equal(delayed.settings.workdirs.design, 'keep-project');
assert.equal(delayed.settings.other, 'keep');

for (const id of ['', 'folio', 'signal']) {
  const f = fixture({ designSystem: id }, async () => catalog);
  assert.equal(await f.prepare(), id);
  assert.equal(f.writes.length, 0);
}
const empty = fixture({ designSystem: '' }, async () => ({ ok: true, catalogIds: [], designSystems: [] }));
assert.equal(await empty.prepare(), '', 'a successful empty catalog allows the default style');
const missing = fixture({ designSystem: 'folio' }, async () => ({ ...catalog, designSystems: [] }));
await assert.rejects(missing.prepare(), /missing files/);
assert.equal(missing.settings.designSystem, 'folio', 'missing assets are not a retired preference');
const incomplete = fixture({ designSystem: 'folio' }, async () => ({ ...catalog, designSystems: [{ id: 'folio', available: false }] }));
await assert.rejects(incomplete.prepare(), /missing files/);

let failing = true;
const offline = fixture({ designSystem: 'retired-import' }, async () => {
  if (failing) throw Error('offline');
  return catalog;
});
await assert.rejects(offline.prepare(), /offline/);
assert.equal(offline.writes.length, 0, 'failed catalog cannot erase a preference');
failing = false;
assert.equal(await offline.prepare(), '', 'the next user retry can recover');
for (const response of [{ ok: false, designSystems: [] }, {}, { designSystems: [null] }]) {
  const f = fixture({ designSystem: 'folio' }, async () => response);
  await assert.rejects(f.prepare(), /could not be read/);
  assert.equal(f.writes.length, 0);
}
let update;
const changed = fixture({ designSystem: 'retired-import' }, async () => await new Promise(resolve => { update = resolve; }));
const pending = changed.prepare();
changed.settings.designSystem = 'signal';
update(catalog);
assert.equal(await pending, 'signal', 'catalog completion must preserve the newer user selection');
assert.equal(changed.writes.length, 0);
changed.settings.designSystem = 'retired-import';
assert.equal(await changed.prepare(), '', 'restored old settings are validated even with a warm catalog');
console.log('design_catalog_test: PASS (production JS, delayed/deduplicated requests, migration, empty/offline/invalid catalog, missing pack, retry and changed selection; no model)');
