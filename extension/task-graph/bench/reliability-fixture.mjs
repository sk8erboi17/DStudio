import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const RELIABILITY_FIXTURE_ID = 'diverse-local-agent-v2';
export const RELIABILITY_SUITE_SIZE = 50;

export const RELIABILITY_VARIANTS = Object.freeze({
  'native-agent': { slug: 'direct', marker: 'DIRECT' },
  'task-graph': { slug: 'graph', marker: 'GRAPH' },
  pi: { slug: 'pi', marker: 'PI' },
  opencode: { slug: 'opencode', marker: 'OPENCODE' },
});

export const RELIABILITY_TASK_TYPES = Object.freeze([
  { id: 'read-fact', label: 'Extract a fact', dimension: 'read' },
  { id: 'search-repository', label: 'Search nested files', dimension: 'read' },
  { id: 'cross-file-reasoning', label: 'Combine file evidence', dimension: 'reason' },
  { id: 'write-exact-file', label: 'Create exact output', dimension: 'write' },
  { id: 'edit-json', label: 'Edit structured data', dimension: 'write' },
  { id: 'surgical-edit', label: 'Preserve unrelated text', dimension: 'write' },
  { id: 'repair-code', label: 'Repair failing code', dimension: 'code' },
  { id: 'implement-function', label: 'Implement missing code', dimension: 'code' },
  { id: 'multi-file-refactor', label: 'Refactor across files', dimension: 'code' },
  { id: 'diagnose-test', label: 'Diagnose a test failure', dimension: 'diagnose' },
]);

export const RELIABILITY_COVERAGE = Object.freeze({
  casesPerFamily: 5,
  dimensions: ['read', 'reason', 'write', 'code', 'diagnose'],
  included: [
    'single-file extraction', 'nested repository search', 'cross-file calculation',
    'exact file creation', 'JSON-preserving edit', 'surgical text edit',
    'bug repair with tests', 'missing-function implementation',
    'multi-file symbol refactor', 'failure diagnosis without source mutation',
  ],
  excluded: [
    'network and browser work', 'multimodal UI judgment', 'very long autonomous tasks',
    'parallel agents', 'human approval latency', 'in-flight token recovery',
  ],
});

const VALUES = Object.freeze({
  releaseCodes: ['COBALT-417', 'LANTERN-852', 'ORBIT-263', 'HARBOR-691', 'SUMMIT-538'],
  owners: ['Nadia Rios', 'Evan Brooks', 'Mina Okafor', 'Leo Marin', 'Aya Chen'],
  prices: [17, 23, 14, 31, 19],
  quantities: [6, 4, 9, 3, 7],
  versions: ['2.4.1', '3.1.7', '4.0.3', '5.2.9', '6.3.5'],
  timeouts: [25, 40, 55, 70, 85],
  retries: [2, 3, 4, 5, 6],
});

function posixJoin(...parts) {
  return parts.join('/').replaceAll('//', '/');
}

function writeFiles(root, files) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function read(root, relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function fileEquals(root, relative, expected) {
  try {
    return read(root, relative) === expected;
  } catch {
    return false;
  }
}

function runPythonTest(root, file) {
  const run = spawnSync('python3', [file], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return {
    ok: run.status === 0,
    exitCode: run.status,
    output: `${run.stdout || ''}${run.stderr || ''}`.trim(),
  };
}

function markerFor(config, taskId, variation) {
  return `${config.marker}_${taskId.replaceAll('-', '_').toUpperCase()}_${variation + 1}_DONE`;
}

function readonlyScore(root, files) {
  return () => ({
    ok: Object.entries(files).every(([relative, content]) => read(root, relative) === content),
  });
}

function repairFixture(variation) {
  const fixtures = [
    {
      app: 'def total(a, b):\n    return a - b\n',
      test: "from app import total\nassert total(7, 5) == 12, total(7, 5)\nprint('TEST_OK')\n",
    },
    {
      app: 'def clamp(value, low, high):\n    return max(high, min(low, value))\n',
      test: "from app import clamp\nassert clamp(12, 0, 10) == 10\nassert clamp(-2, 0, 10) == 0\nassert clamp(4, 0, 10) == 4\nprint('TEST_OK')\n",
    },
    {
      app: 'def normalize_email(value):\n    return value.upper()\n',
      test: "from app import normalize_email\nassert normalize_email('  Ada@Example.COM ') == 'ada@example.com'\nprint('TEST_OK')\n",
    },
    {
      app: 'def is_palindrome(value):\n    cleaned = value.replace(" ", "").lower()\n    return cleaned == value\n',
      test: "from app import is_palindrome\nassert is_palindrome('Never odd or even') is True\nassert is_palindrome('agent') is False\nprint('TEST_OK')\n",
    },
    {
      app: "def count_vowels(value):\n    return sum(ch.lower() not in 'aeiou' for ch in value if ch.isalpha())\n",
      test: "from app import count_vowels\nassert count_vowels('DStudio Agent') == 5\nassert count_vowels('rhythm') == 0\nprint('TEST_OK')\n",
    },
  ];
  return fixtures[variation];
}

function implementationFixture(variation) {
  const fixtures = [
    {
      app: 'def dedupe(items):\n    raise NotImplementedError\n',
      test: "from app import dedupe\nassert dedupe([3, 1, 3, 2, 1]) == [3, 1, 2]\nprint('TEST_OK')\n",
    },
    {
      app: 'def chunks(items, size):\n    raise NotImplementedError\n',
      test: "from app import chunks\nassert chunks([1, 2, 3, 4, 5], 2) == [[1, 2], [3, 4], [5]]\nprint('TEST_OK')\n",
    },
    {
      app: 'def parse_bool(value):\n    raise NotImplementedError\n',
      test: "from app import parse_bool\nassert parse_bool(' YES ') is True\nassert parse_bool('no') is False\ntry:\n    parse_bool('maybe')\nexcept ValueError:\n    pass\nelse:\n    raise AssertionError('invalid values must raise ValueError')\nprint('TEST_OK')\n",
    },
    {
      app: 'def median(values):\n    raise NotImplementedError\n',
      test: "from app import median\nassert median([9, 1, 5]) == 5\nassert median([1, 7, 3, 5]) == 4\nprint('TEST_OK')\n",
    },
    {
      app: 'def flatten(groups):\n    raise NotImplementedError\n',
      test: "from app import flatten\nassert flatten([[1, 2], [], [3], [4, 5]]) == [1, 2, 3, 4, 5]\nprint('TEST_OK')\n",
    },
  ];
  return fixtures[variation];
}

function refactorFixture(variation) {
  const fixtures = [
    { oldName: 'compute_total', newName: 'sum_values', body: 'return sum(values)', parameter: 'values', argument: '[2, 4, 6]', expected: '12' },
    { oldName: 'format_user', newName: 'render_user', body: 'return name.strip().title()', parameter: 'name', argument: "' ada lovelace '", expected: 'Ada Lovelace' },
    { oldName: 'is_valid', newName: 'validate_token', body: 'return len(token) >= 4', parameter: 'token', argument: "'abcd'", expected: 'True' },
    { oldName: 'build_slug', newName: 'slugify_title', body: "return title.strip().lower().replace(' ', '-')", parameter: 'title', argument: "'Hello Agent'", expected: 'hello-agent' },
    { oldName: 'load_items', newName: 'collect_items', body: 'return list(values)', parameter: 'values', argument: '(x for x in [1, 2, 3])', expected: '[1, 2, 3]' },
  ];
  return fixtures[variation];
}

function diagnosisFixture(variation) {
  const fixtures = [
    { source: 'TAX_RATE = 0.18\n', test: "from app import TAX_RATE\nassert TAX_RATE == 0.20, 'ROOT_CAUSE=TAX_RATE_CONSTANT'\n", cause: 'ROOT_CAUSE=TAX_RATE_CONSTANT' },
    { source: "LABEL_PREFIX = 'dev-'\n", test: "from app import LABEL_PREFIX\nassert LABEL_PREFIX == 'prod-', 'ROOT_CAUSE=LABEL_PREFIX'\n", cause: 'ROOT_CAUSE=LABEL_PREFIX' },
    { source: 'PAGE_OFFSET = 0\n', test: "from app import PAGE_OFFSET\nassert PAGE_OFFSET == 1, 'ROOT_CAUSE=PAGE_OFFSET'\n", cause: 'ROOT_CAUSE=PAGE_OFFSET' },
    { source: 'DEFAULT_RETRIES = 1\n', test: "from app import DEFAULT_RETRIES\nassert DEFAULT_RETRIES == 3, 'ROOT_CAUSE=DEFAULT_RETRIES'\n", cause: 'ROOT_CAUSE=DEFAULT_RETRIES' },
    { source: "CSV_DELIMITER = ';'\n", test: "from app import CSV_DELIMITER\nassert CSV_DELIMITER == ',', 'ROOT_CAUSE=CSV_DELIMITER'\n", cause: 'ROOT_CAUSE=CSV_DELIMITER' },
  ];
  return fixtures[variation];
}

function createVariantTask(workspace, template, variation, variant, scenarioId) {
  const config = RELIABILITY_VARIANTS[variant];
  if (!config) throw new Error(`unknown reliability variant: ${variant}`);
  const relativeRoot = posixJoin('cases', scenarioId, config.slug);
  const root = path.join(workspace, ...relativeRoot.split('/'));
  const marker = markerFor(config, template.id, variation);
  const finish = `All paths are relative to the active workspace: do not cd to / or search outside the workspace. In the final answer include the requested result and then ${marker}.`;
  let files;
  let prompt;
  let allowed = [];
  let answerMustContain = [];
  let score;

  if (template.id === 'read-fact') {
    const value = VALUES.releaseCodes[variation];
    files = { 'project.txt': `Project: Atlas ${variation + 1}\nRelease code: ${value}\nOwner: Team ${variation + 1}\n` };
    prompt = `Use a tool to read ${relativeRoot}/project.txt. Report the release code as "Release code: <value>". Do not modify files. ${finish}`;
    answerMustContain = [`Release code: ${value}`];
    score = readonlyScore(root, files);
  } else if (template.id === 'search-repository') {
    const owner = VALUES.owners[variation];
    const targetFiles = ['src/feature.txt', 'docs/ownership.md', 'config/flags.ini', 'src/nested/module.txt', 'docs/releases/current.txt'];
    files = {
      'src/decoy.txt': 'FEATURE_STATUS=planned\n',
      'docs/index.md': '# Repository notes\nNo owner is declared here.\n',
      'config/defaults.ini': 'FEATURE_OWNER_FALLBACK=Unassigned\n',
      [targetFiles[variation]]: `FEATURE_OWNER=${owner}\nFEATURE_ID=F-${variation + 11}\n`,
    };
    prompt = `Search under ${relativeRoot} with tools for the exact line beginning FEATURE_OWNER=. Report only "Feature owner: <value>"; ignore similarly named fallback keys. Do not modify files. ${finish}`;
    answerMustContain = [`Feature owner: ${owner}`];
    score = readonlyScore(root, files);
  } else if (template.id === 'cross-file-reasoning') {
    const price = VALUES.prices[variation];
    const quantity = VALUES.quantities[variation];
    const total = price * quantity;
    files = {
      'pricing.txt': `Unit price: ${price}\nCurrency: EUR\n`,
      'orders.txt': `Quantity: ${quantity}\nStatus: confirmed\n`,
    };
    prompt = `Read ${relativeRoot}/pricing.txt and ${relativeRoot}/orders.txt with tools. Multiply unit price by quantity and report "Total: <number> EUR". Do not modify files. ${finish}`;
    answerMustContain = [`Total: ${total} EUR`];
    score = readonlyScore(root, files);
  } else if (template.id === 'write-exact-file') {
    const payload = `status=ready\nbatch=${variation + 41}\n`;
    files = { 'instructions.txt': `Expected batch: ${variation + 41}\n` };
    prompt = `Create ${relativeRoot}/output.env with exactly these two lines and a final newline:\nstatus=ready\nbatch=${variation + 41}\nDo not change anything else. ${finish}`;
    allowed = ['output.env'];
    score = () => ({ ok: fileEquals(root, 'output.env', payload) });
  } else if (template.id === 'edit-json') {
    const timeout = VALUES.timeouts[variation];
    const retries = VALUES.retries[variation];
    files = { 'config.json': `${JSON.stringify({ service: `worker-${variation + 1}`, enabled: true, timeout: 10, tags: ['local', 'agent'] }, null, 2)}\n` };
    prompt = `Edit ${relativeRoot}/config.json: set timeout to ${timeout}, add retries=${retries}, and preserve every other value. Keep it valid JSON. ${finish}`;
    allowed = ['config.json'];
    score = () => {
      try {
        const actual = JSON.parse(read(root, 'config.json'));
        const expected = { service: `worker-${variation + 1}`, enabled: true, timeout, tags: ['local', 'agent'], retries };
        return {
          ok: actual && typeof actual === 'object' && !Array.isArray(actual) &&
            Object.keys(actual).length === Object.keys(expected).length &&
            Object.entries(expected).every(([key, value]) =>
              JSON.stringify(actual[key]) === JSON.stringify(value)),
        };
      } catch (error) {
        return { ok: false, output: error.message };
      }
    };
  } else if (template.id === 'surgical-edit') {
    const nextVersion = VALUES.versions[variation];
    const checksum = `sha256:${crypto.createHash('sha256').update(`case-${variation}`).digest('hex').slice(0, 12)}`;
    files = { 'release.md': `# Release manifest\nVersion: 1.0.0\nChannel: stable\nChecksum: ${checksum}\n` };
    const expected = `# Release manifest\nVersion: ${nextVersion}\nChannel: stable\nChecksum: ${checksum}\n`;
    prompt = `In ${relativeRoot}/release.md change only the Version value to ${nextVersion}. Preserve the heading, channel, checksum and final newline byte-for-byte. ${finish}`;
    allowed = ['release.md'];
    score = () => ({ ok: fileEquals(root, 'release.md', expected) });
  } else if (template.id === 'repair-code') {
    const fixture = repairFixture(variation);
    files = { 'app.py': fixture.app, 'test_app.py': fixture.test };
    prompt = `Fix the bug in ${relativeRoot}/app.py so ${relativeRoot}/test_app.py passes. Run python3 ${relativeRoot}/test_app.py exactly once after the repair; rerun only if it fails. ${finish}`;
    allowed = ['app.py', '__pycache__/app.cpython-*'];
    score = () => runPythonTest(root, 'test_app.py');
  } else if (template.id === 'implement-function') {
    const fixture = implementationFixture(variation);
    files = { 'app.py': fixture.app, 'test_app.py': fixture.test };
    prompt = `Implement the missing function in ${relativeRoot}/app.py without changing its public signature. Run python3 ${relativeRoot}/test_app.py exactly once after implementation; rerun only if it fails. ${finish}`;
    allowed = ['app.py', '__pycache__/app.cpython-*'];
    score = () => runPythonTest(root, 'test_app.py');
  } else if (template.id === 'multi-file-refactor') {
    const fixture = refactorFixture(variation);
    files = {
      'package.py': `def ${fixture.oldName}(${fixture.parameter}):\n    ${fixture.body}\n`,
      'consumer.py': `from package import ${fixture.oldName}\n\ndef run():\n    return ${fixture.oldName}(${fixture.argument})\n`,
      'verify.py': `from package import ${fixture.newName}\nfrom consumer import run\nassert str(run()) == ${JSON.stringify(fixture.expected)}\nassert callable(${fixture.newName})\nprint('TEST_OK')\n`,
    };
    prompt = `Rename the public function ${fixture.oldName} to ${fixture.newName} across ${relativeRoot}/package.py and ${relativeRoot}/consumer.py. Do not edit verify.py. Run python3 ${relativeRoot}/verify.py exactly once after the refactor; rerun only if it fails. ${finish}`;
    allowed = ['package.py', 'consumer.py', '__pycache__/package.cpython-*', '__pycache__/consumer.cpython-*'];
    score = () => {
      const test = runPythonTest(root, 'verify.py');
      return {
        ...test,
        ok: test.ok && !read(root, 'package.py').includes(fixture.oldName) &&
          !read(root, 'consumer.py').includes(fixture.oldName),
      };
    };
  } else if (template.id === 'diagnose-test') {
    const fixture = diagnosisFixture(variation);
    files = { 'app.py': fixture.source, 'test_app.py': fixture.test };
    prompt = `Run python3 ${relativeRoot}/test_app.py to diagnose the failure. Do not fix or edit app.py or test_app.py. Create ${relativeRoot}/diagnosis.txt containing only the complete ROOT_CAUSE=... identifier from the failure and a final newline. ${finish}`;
    allowed = ['diagnosis.txt', '__pycache__/app.cpython-*'];
    score = () => ({ ok: fileEquals(root, 'diagnosis.txt', `${fixture.cause}\n`) });
  } else {
    throw new Error(`unknown reliability task: ${template.id}`);
  }

  return {
    expected: marker,
    answerMustContain,
    prompt,
    allowedChanges: allowed.map((relative) => posixJoin(relativeRoot, relative)),
    score,
    reset: () => writeFiles(root, files),
  };
}

export function createReliabilityFixture({ workspace, caseCount, variants }) {
  if (!Number.isInteger(caseCount) || caseCount < 1 || caseCount > RELIABILITY_SUITE_SIZE)
    throw new Error(`caseCount must be between 1 and ${RELIABILITY_SUITE_SIZE}`);
  fs.mkdirSync(workspace, { recursive: true });

  const scenarios = Array.from({ length: caseCount }, (_unused, index) => {
    const template = RELIABILITY_TASK_TYPES[index % RELIABILITY_TASK_TYPES.length];
    const variation = Math.floor(index / RELIABILITY_TASK_TYPES.length);
    const id = `${template.id}-${String(variation + 1).padStart(2, '0')}`;
    return {
      id,
      templateId: template.id,
      variation: variation + 1,
      variants: Object.fromEntries(variants.map((variant) => [
        variant,
        createVariantTask(workspace, template, variation, variant, id),
      ])),
    };
  });

  for (const scenario of scenarios)
    for (const variant of variants) scenario.variants[variant].reset();

  function resetScenario(scenario, variant) {
    const task = scenario.variants[variant];
    if (!task) throw new Error(`scenario ${scenario.id} has no ${variant} variant`);
    task.reset();
  }

  return {
    metadata: {
      id: RELIABILITY_FIXTURE_ID,
      suiteSize: RELIABILITY_SUITE_SIZE,
      taskTypes: RELIABILITY_TASK_TYPES,
      coverage: RELIABILITY_COVERAGE,
    },
    templates: RELIABILITY_TASK_TYPES,
    scenarios,
    resetScenario,
  };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function workspaceSnapshot(workspace) {
  const result = {};
  function visit(relative) {
    const absolute = path.join(workspace, relative);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const child = relative ? path.posix.join(relative, entry.name) : entry.name;
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
