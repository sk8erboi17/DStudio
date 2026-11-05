import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { extractFunction } from '../support/real_harness.mjs';

const source = fs.readFileSync('web/loading.html', 'utf8');
const start = extractFunction(source, 'startWithSavedSettings');
async function scenario({ running = false, occupied = false, launchTaskId = 0, adjusted = false, quota = false } = {}) {
  const calls = [], redirects = [], stages = [];
  const context = vm.createContext({
    JSON, Math, Number, parseInt, visualPct: 5,
    localStorage: { getItem: () => '{}', setItem() { if (quota) throw Error('Browser quota'); } },
    syncBootFacts() {},
    showProgress: (...args) => stages.push(args),
    showStartupError: (message,title='Could not start the engine') => stages.push([5, title, message]),
    crypto: { randomUUID: () => 'loading-fixture-attempt' },
    sleep: async () => {},
    location: { replace: value => redirects.push(value) },
    fetchJson: async (url, options = {}) => {
      calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
      if (url === '/api/status') return { running, launchTaskId, ds4dirOk: true, models: { standard: true } };
      assert.equal(url, '/api/start', 'no implicit stop or unrelated control operation');
      if (occupied) {
        const error = Error('A server owned by another process is using the port');
        error.data = { code: 'external_server' };
        throw error;
      }
      return { ok: true, adjusted, ctx:65536 };
    },
  });
  const result = await vm.runInContext(`(${start})()`, context);
  return { calls, redirects, stages, result };
}
const normal = await scenario();
assert.equal(normal.result, true);
assert.equal(normal.calls.length, 2);
assert.equal(normal.calls[1].body.force, false, 'a saved preference is not authorization to kill an external engine');
assert.equal(normal.calls[1].body.ctx, 65536, 'preserve the configured default context');
const occupied = await scenario({ occupied: true });
assert.equal(occupied.result, false);
assert.equal(occupied.calls.length, 2, 'no forced automatic retry');
assert.equal(occupied.calls[1].body.force, false);
assert.equal(occupied.stages.at(-1)[2], 'A server owned by another process is using the port',
  'the loading screen must show the actual launcher failure');
assert.deepEqual(occupied.redirects, [], 'leave the failure readable until explicit recovery');
const active = await scenario({ running: true });
assert.equal(active.calls.length, 1, 'an active runtime is not stopped or restarted by loading');
assert.equal(active.result, true);
const preparing = await scenario({ launchTaskId: 37 });
assert.equal(preparing.calls.length, 1, 'an admitted preparation is not launched again by loading');
assert.equal(preparing.result, true);
const storage = await scenario({adjusted:true,quota:true});
assert.equal(storage.result,false);
assert.equal(storage.calls.length,2,'A settings write failure must never restart an already started engine');
assert.equal(storage.stages.at(-1)[1],'Engine started; settings need attention');
assert.match(storage.stages.at(-1)[2],/browser storage/);
console.log('loading_launch_test: PASS (production startup function; simulated status and port conflict, no model)');
