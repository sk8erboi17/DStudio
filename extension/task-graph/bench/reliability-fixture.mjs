import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const RELIABILITY_VARIANTS = Object.freeze({
  'native-agent': { slug: 'direct', marker: 'DIRECT' },
  'task-graph': { slug: 'graph', marker: 'GRAPH' },
  pi: { slug: 'pi', marker: 'PI' },
  opencode: { slug: 'opencode', marker: 'OPENCODE' },
});

export const RELIABILITY_TASK_TYPES = Object.freeze([
  { id: 'read-fact', label: 'Read a fact' },
  { id: 'write-file', label: 'Create a file' },
  { id: 'repair-code', label: 'Repair code' },
]);

function runPythonTest(workspace, file) {
  const run = spawnSync('python3', [file], {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return {
    ok: run.status === 0,
    exitCode: run.status,
    output: `${run.stdout || ''}${run.stderr || ''}`.trim(),
  };
}

function createVariantTask(workspace, taskId, variant) {
  const config = RELIABILITY_VARIANTS[variant];
  if (!config) throw new Error(`unknown reliability variant: ${variant}`);
  const { slug, marker } = config;
  if (taskId === 'read-fact') {
    return {
      expected: `${marker}_READ_ALPHA_729`,
      prompt: `Use the read tool to inspect facts.txt. Do not modify any file. Then reply with exactly: ${marker}_READ_ALPHA_729`,
      allowedChanges: [],
      score: () => ({
        ok: fs.readFileSync(path.join(workspace, 'facts.txt'), 'utf8').includes('ALPHA-729'),
      }),
    };
  }
  if (taskId === 'write-file') {
    return {
      expected: `${marker}_WRITE_DONE`,
      prompt: `Use the write tool to create ${slug}-output.txt with exactly this text and a final newline: RELIABLE_OUTPUT. Then reply with exactly: ${marker}_WRITE_DONE`,
      allowedChanges: [`${slug}-output.txt`],
      score: () => ({
        ok: fs.existsSync(path.join(workspace, `${slug}-output.txt`)) &&
          fs.readFileSync(path.join(workspace, `${slug}-output.txt`), 'utf8') === 'RELIABLE_OUTPUT\n',
      }),
    };
  }
  if (taskId === 'repair-code') {
    return {
      expected: `${marker}_REPAIR_DONE`,
      prompt: `Fix the bug in ${slug}_app.py so ${slug}_test.py passes. Run python3 ${slug}_test.py to verify it. Then reply with exactly: ${marker}_REPAIR_DONE`,
      allowedChanges: [`__pycache__/${slug}_app.cpython-*`, `${slug}_app.py`],
      score: () => runPythonTest(workspace, `${slug}_test.py`),
    };
  }
  throw new Error(`unknown reliability task: ${taskId}`);
}

export function createReliabilityFixture({ workspace, caseCount, variants }) {
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'facts.txt'), [
    'Project: Aurora',
    'Release code: ALPHA-729',
    'Owner: Sofia',
  ].join('\n'));

  for (const variant of variants) {
    const config = RELIABILITY_VARIANTS[variant];
    if (!config) throw new Error(`unknown reliability variant: ${variant}`);
    const { slug, marker } = config;
    fs.writeFileSync(path.join(workspace, `${slug}_app.py`), 'def total(a, b):\n    return a - b\n');
    fs.writeFileSync(path.join(workspace, `${slug}_test.py`), [
      `from ${slug}_app import total`,
      'assert total(7, 5) == 12, total(7, 5)',
      `print('${marker}_TEST_OK')`,
    ].join('\n'));
  }

  const templates = RELIABILITY_TASK_TYPES.map(({ id }) => ({ id }));
  const scenarios = Array.from({ length: caseCount }, (_unused, index) => {
    const template = templates[index % templates.length];
    return {
      id: `${template.id}-${String(index + 1).padStart(2, '0')}`,
      templateId: template.id,
      variants: Object.fromEntries(variants.map((variant) => [
        variant,
        createVariantTask(workspace, template.id, variant),
      ])),
    };
  });

  function resetScenario(scenario, variant) {
    const { slug } = RELIABILITY_VARIANTS[variant];
    if (scenario.templateId === 'write-file') {
      try { fs.unlinkSync(path.join(workspace, `${slug}-output.txt`)); } catch {}
    }
    if (scenario.templateId === 'repair-code') {
      fs.writeFileSync(path.join(workspace, `${slug}_app.py`), 'def total(a, b):\n    return a - b\n');
      fs.rmSync(path.join(workspace, '__pycache__'), { recursive: true, force: true });
    }
  }

  return { templates, scenarios, resetScenario };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function workspaceSnapshot(workspace) {
  const result = {};
  function visit(relative) {
    const absolute = path.join(workspace, relative);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const child = relative ? path.join(relative, entry.name) : entry.name;
      if (child === '.dstudio' || child.startsWith(`.dstudio${path.sep}`) ||
          child === '.git' || child.startsWith(`.git${path.sep}`)) continue;
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) result[child] = sha256(path.join(workspace, child));
    }
  }
  visit('');
  return result;
}

export function changedFiles(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((file) => before[file] !== after[file]).sort();
}

export function changeAllowed(file, patterns) {
  return patterns.some((pattern) => pattern.endsWith('*')
    ? file.startsWith(pattern.slice(0, -1))
    : file === pattern);
}
