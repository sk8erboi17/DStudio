import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'manifest.json'), 'utf8'));
const required = ['simple-direct','coding-multistage','research-code','multimodal-ui','gsa','rsa','media','crash-recovery','interrupt','workspace-collision'];
if (manifest.schemaVersion !== 1) throw new Error('Task Graph benchmark schemaVersion must be 1');
if (manifest.execution !== 'prepare-only') throw new Error('heavy Task Graph benchmarks must be prepare-only');
for (const id of required) if (!manifest.scenarios.some((s) => s.id === id)) throw new Error(`missing benchmark scenario ${id}`);
for (const scenario of manifest.scenarios) {
  if (!scenario.fixture || !Array.isArray(scenario.metrics) || !scenario.metrics.includes('wallClockMs') || !scenario.metrics.includes('taskSuccess'))
    throw new Error(`invalid benchmark scenario ${scenario.id}`);
  const fixturePath = path.join(here, scenario.fixture);
  if (!fs.existsSync(fixturePath)) throw new Error(`missing fixture file ${scenario.fixture}`);
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  if (fixture.schemaVersion !== 1 || fixture.id !== scenario.id || !Array.isArray(fixture.acceptance) || !fixture.acceptance.length)
    throw new Error(`invalid fixture ${scenario.fixture}`);
}
console.log(`task_graph_bench_validate: ${manifest.scenarios.length} prepared scenarios; heavy execution disabled`);
