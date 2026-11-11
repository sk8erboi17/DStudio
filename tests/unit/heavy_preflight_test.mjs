// Executes the preflight decision with controlled process tables, then takes
// one real snapshot of this machine. No model is started and no process is signalled.
import assert from 'node:assert/strict';
import { classifyEngines, contamination, isEngineProcess, parseFootprint, parsePs, preflight, HEAVY_FOOTPRINT_BYTES }
  from '../support/heavy_preflight.mjs';

const GiB = 1024 ** 3;
const table = parsePs([
  '    1     0    100 /sbin/launchd',
  '  500     1   2048 node tests/live/host_common_quality.mjs --model x',
  '  501   500   4096 /repo/tests/.build/dstudio-server-test 50000 /repo/ds4',
  '  502   501 900000 /repo/llama.cpp/bin/llama-server --model /repo/ds4/gguf/a.gguf',
  '  645     1    848 /opt/homebrew/bin/llama-server --models-dir /models --no-models-autoload',
  '  700     1 300000 /Applications/Other.app/Contents/MacOS/ds4-server --metal -m big.gguf',
  '  710     1  90000 /opt/python/bin/python3 -m mlx_lm server --model /repo/ds4/mlx/q',
  '  720     1  50000 /usr/bin/python3 /tmp/unrelated_server.py',
  '  730     1  20000 /Applications/Ollama.app/Contents/MacOS/ollama serve',
  'garbage line',
].join('\n'));
assert.equal(table.length, 9, 'malformed rows are ignored');
assert.equal(table[4].rssBytes, 848 * 1024);
assert.ok(isEngineProcess(table[4]) && isEngineProcess(table[6]), 'llama-server and the MLX server are engines');
assert.ok(!isEngineProcess(table[7]) && !isEngineProcess(table[8]), 'an unrelated Python server and another product are not');

assert.equal(parseFootprint('llama-server [645]: 64-bit    Footprint: 21 MB (16384 bytes per page)'), 21 * 1024 ** 2);
assert.equal(parseFootprint('x [1]: 64-bit Footprint: 86.5 GB (16384 bytes per page)'), Math.round(86.5 * GiB));
assert.equal(parseFootprint('no such process'), null);

const footprints = new Map([[645, 21 * 1024 ** 2], [700, 87 * GiB], [710, 37 * GiB], [502, 30 * GiB], [501, 40 * 1024 ** 2]]);
const footprintOf = (pid) => footprints.has(pid) ? footprints.get(pid) : null;

// The run's own host and its engine never block; the idle router is recorded
// and allowed; two foreign processes holding models block.
let result = classifyEngines(table, { ownerPid: 500, footprintOf });
assert.deepEqual(result.foreign.map((row) => [row.pid, row.state]), [[645, 'idle'], [700, 'heavy'], [710, 'heavy']]);
assert.deepEqual(result.blocking.map((row) => row.pid), [700, 710]);
assert.match(result.reasons[0], /pid 700 holds 87\.0 GiB/);

// Only the idle router present: nothing blocks.
const quiet = table.filter((row) => ![700, 710].includes(row.pid));
result = classifyEngines(quiet, { ownerPid: 500, footprintOf });
assert.deepEqual(result.blocking, []);
assert.deepEqual(result.foreign.map((row) => row.pid), [645]);

// The boundary is inclusive, and an unknown footprint fails closed.
footprints.set(645, HEAVY_FOOTPRINT_BYTES);
assert.equal(classifyEngines(quiet, { ownerPid: 500, footprintOf }).blocking.length, 1);
footprints.set(645, HEAVY_FOOTPRINT_BYTES - 1);
assert.equal(classifyEngines(quiet, { ownerPid: 500, footprintOf }).blocking.length, 0);
footprints.delete(645);
result = classifyEngines(quiet, { ownerPid: 500, footprintOf });
assert.equal(result.blocking[0].state, 'unmeasured');
assert.match(result.reasons[0], /could not be measured/);

// A runner driving an already started host owns that host's engine too.
result = classifyEngines(table, { ownerPid: [720, 501], footprintOf });
assert.ok(!result.foreign.some((row) => [501, 502].includes(row.pid)), 'the driven host and its engine are owned');
assert.ok([700, 710].every((pid) => result.blocking.some((row) => row.pid === pid)), 'foreign models still block');

// Another harness's engine is foreign to this owner.
result = classifyEngines(table, { ownerPid: 720, footprintOf });
assert.ok(result.blocking.some((row) => row.pid === 502), 'an engine owned by a different run blocks');

// Contamination: an idle router that loads a model, or a new heavy engine.
const idleRow = { pid: 645, command: 'llama-server', state: 'idle' };
assert.deepEqual(contamination({ foreignEngines: [idleRow] }, { foreignEngines: [idleRow] }), []);
assert.match(contamination({ foreignEngines: [idleRow] }, { foreignEngines: [{ ...idleRow, state: 'heavy' }] })[0], /pid 645 grew/);
assert.match(contamination({ foreignEngines: [] }, { foreignEngines: [{ pid: 9, command: 'ds4-server', state: 'heavy' }] })[0], /pid 9 appeared/);
assert.deepEqual(contamination({ foreignEngines: [idleRow] }, { foreignEngines: [] }), [], 'a foreign engine that exits is not contamination');

// One real snapshot: structure only, since the machine's load is not this test's to decide.
const real = preflight({ dir: process.cwd() });
assert.equal(typeof real.ok, 'boolean');
assert.ok(real.diskFreeBytes > 0 && real.memory.totalBytes > 0);
assert.ok(Array.isArray(real.foreignEngines) && real.foreignEngines.every((row) => ['idle', 'heavy', 'unmeasured'].includes(row.state)));
const full = preflight({ dir: process.cwd(), minDiskFreeBytes: Number.MAX_SAFE_INTEGER });
assert.equal(full.ok, false);
assert.ok(full.reasons.some((reason) => /GiB free/.test(reason)), 'an insufficient disk budget blocks');

console.log(`PASS: heavy-run preflight classifies owned, idle, heavy and unmeasured engines; contamination and disk budget (controlled tables + one real snapshot: ${real.foreignEngines.length} foreign engine process(es), ok=${real.ok})`);
