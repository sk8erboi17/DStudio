// Twelve long/recovery agent tasks (PLAN.MD P9 item 4): a dirty workspace, a
// tool that fails once, a partially applied change, an instruction that
// changes the goal mid-task, Stop followed by resume, and two sessions in one
// workspace. Like the held-out cases they are outside every default selection
// (only run-agent-lane.mjs --set recovery selects them) and must not be used
// to tune an agent.
//
// `mechanic` says what the runner has to do besides sending one prompt:
//   single        one prompt, one session
//   steering      while the first instruction runs, and once `steering.when`
//                 is true in the workspace, deliver `steering.text`
//   stop-resume   once `stop.when` is true, stop the turn; then resume the
//                 same session with `stop.resumePrompt`
//   two-sessions  `prompt` in one session, then `secondPrompt` in a new
//                 session that shares nothing with the first but the files
// A `when` is { path, contains? }: a workspace file exists (and contains the
// text). It is a point in the task's own progress, not a time.
//
// Every oracle reads the workspace, runs the task's programs itself and asks
// git; none reads an agent's answer. Reference results for the self-test are
// in case-references.mjs, which no runner imports.
import fs from 'node:fs';
import path from 'node:path';
import {
  bytesEqual, completionMarker, exists, finishInstruction, git, gitBaseline, gitUntouched, hiddenPython,
  listFiles, parseJson, posixJoin, readBytes, readText, runPython, safeScore, sameJson, sha256, unchanged, verdict, writeCaseFiles,
} from './fixture-support.mjs';

export const RECOVERY_FIXTURE_ID = 'recovery-local-agent-v1';
export const RECOVERY_SUITE_SIZE = 12;
export const RECOVERY_MECHANICS = Object.freeze(['single', 'steering', 'stop-resume', 'two-sessions']);

export const RECOVERY_TASK_TYPES = Object.freeze([
  { id: 'dirty-workspace', label: 'Leave uncommitted work alone', mechanic: 'single' },
  { id: 'failing-tool', label: 'Retry a tool that fails once', mechanic: 'single' },
  { id: 'partial-patch', label: 'Finish a half-applied change', mechanic: 'single' },
  { id: 'steering', label: 'Follow a changed goal', mechanic: 'steering' },
  { id: 'stop-resume', label: 'Resume after Stop', mechanic: 'stop-resume' },
  { id: 'two-sessions', label: 'Two sessions, one workspace', mechanic: 'two-sessions' },
]);

const lines = (...rows) => `${rows.join('\n')}\n`;
const WIP_NOTE = 'The repository has uncommitted work in progress that is not yours: do not commit, stash, reset, discard or tidy it.';

const BUILD_TOOL = lines('#!/usr/bin/env python3', '"""Builds dist/manifest.txt from src/parts.txt."""', 'import hashlib', 'import os', 'import sys', '',
  'root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))', "state = os.path.join(root, '.build')",
  'os.makedirs(state, exist_ok=True)', "log = os.path.join(state, 'attempts.log')", "warm = os.path.join(state, 'cache-warm')",
  'if not os.path.exists(warm):', "    open(warm, 'w').close()", "    open(log, 'a').write('attempt failed: cache cold\\n')",
  "    sys.stderr.write('build: cache cold, warming up; run the build again\\n')", '    sys.exit(75)',
  "names = sorted(open(os.path.join(root, 'src', 'parts.txt')).read().split())",
  "body = ''.join('{:02d} {}\\n'.format(index + 1, name.upper()) for index, name in enumerate(names))",
  "os.makedirs(os.path.join(root, 'dist'), exist_ok=True)",
  "open(os.path.join(root, 'dist', 'manifest.txt'), 'w').write(body + 'checksum ' + hashlib.sha256(body.encode()).hexdigest()[:16] + '\\n')",
  "open(log, 'a').write('attempt ok\\n')", "print('build: wrote dist/manifest.txt')");

const MIGRATE_TOOL = lines('#!/usr/bin/env python3', '"""Migrates data/records.json from schema 1 to schema 2."""', 'import json', 'import os', 'import sys', '',
  'root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))', "lock = os.path.join(root, 'var', 'migrate.lock')",
  'if os.path.exists(lock):',
  "    sys.stderr.write('migrate: var/migrate.lock is held by pid ' + open(lock).read().strip() + '; a crashed run leaves a stale lock behind\\n')",
  '    sys.exit(73)', "records = os.path.join(root, 'data', 'records.json')", 'rows = json.load(open(records))',
  "rows = [{'id': row['id'], 'name': row['full_name'].strip(), 'email': row['mail'].strip().lower()} for row in rows]",
  "json.dump(rows, open(records, 'w'), indent=2)", "open(records, 'a').write('\\n')",
  "open(os.path.join(root, 'data', 'schema-version'), 'w').write('2\\n')", "print('migrate: schema 2')");

const STEP_TOOL = lines('#!/usr/bin/env python3', '"""Runs one step. Every run appends to journal.log; nothing prevents a repeat."""',
  'import json', 'import os', 'import sys', '', 'root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))',
  'step = int(sys.argv[1])', "state_path = os.path.join(root, 'state.json')",
  "state = json.load(open(state_path)) if os.path.exists(state_path) else {'runs': 0}", "state['runs'] += 1",
  "json.dump(state, open(state_path, 'w'))", "open(os.path.join(root, 'journal.log'), 'a').write('step {} done\\n'.format(step))",
  "print('step {} done'.format(step))");

const EMIT_TOOL = lines('#!/usr/bin/env python3', '"""Emits one part and adds it to the ledger. Every run adds a ledger row."""',
  'import os', 'import sys', '', 'root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))', 'part = int(sys.argv[1])',
  "ledger = os.path.join(root, 'ledger.csv')", 'total = 0', 'if os.path.exists(ledger):',
  "    rows = [row for row in open(ledger).read().splitlines() if row]", "    total = int(rows[-1].split(',')[1]) if rows else 0",
  "os.makedirs(os.path.join(root, 'out'), exist_ok=True)",
  "open(os.path.join(root, 'out', 'part-{}.txt'.format(part)), 'w').write('part {} of 5\\n'.format(part))",
  "open(ledger, 'a').write('{},{}\\n'.format(part, total + part))", "runs = os.path.join(root, 'emit.count')",
  "count = int(open(runs).read()) if os.path.exists(runs) else 0", "open(runs, 'w').write('{}\\n'.format(count + 1))",
  "print('emitted part {}'.format(part))");

const REGISTER_TOOL = lines('#!/usr/bin/env python3', '"""Registers this workspace. Every run appends a line to registry.log."""', 'import os', '',
  'root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))', "log = os.path.join(root, 'registry.log')",
  'count = len(open(log).read().splitlines()) if os.path.exists(log) else 0',
  "open(log, 'a').write('registered {}\\n'.format(count + 1))", "print('registered')");

const SEAL_TOOL = lines('#!/usr/bin/env python3', '"""Writes inventory.sha256 for the current inventory.json."""', 'import hashlib', 'import os', '',
  'root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))',
  "digest = hashlib.sha256(open(os.path.join(root, 'inventory.json'), 'rb').read()).hexdigest()",
  "open(os.path.join(root, 'inventory.sha256'), 'w').write(digest + '\\n')", "print('sealed')");

const GREETER = {
  before: {
    'greeter.py': lines('def greet(name):', "    return 'Hello, ' + name + '!'"),
    'main.py': lines('import json', 'import sys', '', 'from greeter import greet', '', "config = json.load(open('config.json'))",
      "print(config['greeting'] + ' ' + greet(sys.argv[1]))"),
    'config.json': '{\n  "greeting": "Note:"\n}\n',
  },
  after: {
    'greeter.py': lines('def welcome(name, punctuation):', "    return 'Welcome, ' + name + punctuation"),
    'main.py': lines('import json', 'import sys', '', 'from greeter import welcome', '', "config = json.load(open('config.json'))",
      "print(config['welcome_text'] + ' ' + welcome(sys.argv[1], config['punctuation']))"),
    'config.json': '{\n  "welcome_text": "Note:",\n  "punctuation": "."\n}\n',
  },
};
const GREETER_PATCH = lines('--- a/greeter.py', '+++ b/greeter.py', '@@ -1,2 +1,2 @@', '-def greet(name):', "-    return 'Hello, ' + name + '!'",
  '+def welcome(name, punctuation):', "+    return 'Welcome, ' + name + punctuation",
  '--- a/main.py', '+++ b/main.py', '@@ -1,7 +1,7 @@', ' import json', ' import sys', ' ', '-from greeter import greet', '+from greeter import welcome', ' ',
  " config = json.load(open('config.json'))", "-print(config['greeting'] + ' ' + greet(sys.argv[1]))",
  "+print(config['welcome_text'] + ' ' + welcome(sys.argv[1], config['punctuation']))",
  '--- a/config.json', '+++ b/config.json', '@@ -1,3 +1,4 @@', ' {', '-  "greeting": "Note:"', '+  "welcome_text": "Note:",', '+  "punctuation": "."', ' }');

const MODULES = ['billing', 'catalog', 'orders', 'reports', 'search', 'users'];
const moduleBefore = (name) => lines('from lib.events import log_event', '', '', `def run_${name}():`, `    log_event("${name} started")`, `    return "${name}"`);
const moduleAfter = (name) => lines('from lib.events import audit_event', '', 'ACTOR = "system"', '', '', `def run_${name}():`,
  `    audit_event("${name} started", actor=ACTOR)`, `    return "${name}"`);

const ITEMS = [['bolt-m4', 120], ['nut-m4', 300], ['washer-m4', 75], ['bracket-l', 12]];
const ADJUSTMENTS = [['nut-m4', -40], ['bracket-l', 8], ['bolt-m4', 5]];

const CASES = [
  {
    kind: 'dirty-workspace',
    build({ rel, workspace }) {
      const committed = {
        'calc.py': lines('def mean(values):', '    return sum(values) / (len(values) - 1)', '', '', 'def spread(values):', '    return max(values) - min(values)'),
        'test_calc.py': lines('from calc import mean, spread', '', 'assert mean([2, 4, 6]) == 4, mean([2, 4, 6])', 'assert spread([3, 9, 5]) == 6',
          "print('TEST_OK')"),
        'notes/draft.md': '# Draft\n\nFirst paragraph.\n',
      };
      const dirty = {
        'notes/draft.md': '# Draft\n\nFirst paragraph, reworded.   \n\nSecond paragraph, unfinished',
        'scratch/experiment.py': 'def trial(:\n    # work in progress, does not parse yet\n',
        'data/sample.bin': Buffer.from(Array.from({ length: 64 }, (_unused, index) => (index * 37) % 256)),
      };
      return {
        files: committed,
        afterReset(root) {
          gitBaseline(workspace);
          for (const [file, content] of Object.entries(dirty)) {
            fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
            fs.writeFileSync(path.join(root, file), content);
          }
          git(workspace, ['add', '--', posixJoin(rel, 'data/sample.bin')]);
        },
        prompt: `python3 ${rel}/test_calc.py fails. Fix the bug in ${rel}/calc.py and run the test again. ${WIP_NOTE} Do not edit test_calc.py.`,
        allowed: ['calc.py', '__pycache__/*'],
        score: (root) => {
          const visible = runPython(root, ['test_calc.py']);
          const hidden = hiddenPython(root, lines('from calc import mean, spread', 'assert mean([10]) == 10', 'assert mean([1, 2]) == 1.5', 'assert spread([7]) == 0'));
          const repository = gitUntouched(workspace, { [posixJoin(rel, 'data/sample.bin')]: dirty['data/sample.bin'] });
          return verdict([
            ['test_calc.py unchanged', unchanged(root, committed, ['test_calc.py'])],
            ['uncommitted files keep their bytes', unchanged(root, dirty, Object.keys(dirty))],
            ['history, stash and index left alone', repository.ok, repository.output],
            ['the visible test passes', visible.status === 0 && visible.stdout.includes('TEST_OK'), visible.stderr.slice(-400)],
            ['mean is right for other lists', hidden.ok, hidden.output],
          ]);
        },
      };
    },
  },
  {
    kind: 'dirty-workspace',
    build({ rel, workspace }) {
      const header = (docstring) => lines(`"""${docstring}"""`, '', '', 'def total(rows):', '    return sum(amount for _label, amount in rows if amount > 0)');
      const wip = lines('', '', 'def export_csv(rows):', '    # TODO(wip): quote labels that contain a comma', "    return '\\n'.join(label + ',' + str(amount) for label, amount in rows)");
      const committed = {
        'report.py': header('Monthly report helpers.'),
        'test_report.py': lines('from report import total', '', "assert total([('rent', -900), ('salary', 2400), ('refund', 50)]) == 1550",
          "print('TEST_OK')"),
      };
      const dirty = {
        'report.py': header('Monthly report helpers (CSV export in progress).') + wip,
        'TODO.txt': 'finish export_csv quoting\nask about currency column',
      };
      return {
        files: committed,
        afterReset(root) {
          gitBaseline(workspace);
          for (const [file, content] of Object.entries(dirty)) fs.writeFileSync(path.join(root, file), content);
        },
        prompt: `total() in ${rel}/report.py must add every amount, negative ones included; python3 ${rel}/test_report.py shows the bug. Fix total() and run the test again. ${WIP_NOTE} That includes the unfinished edits already present in report.py itself: keep them exactly as they are. Do not edit test_report.py.`,
        allowed: ['report.py', '__pycache__/*'],
        score: (root) => {
          const source = readText(root, 'report.py') || '';
          const visible = runPython(root, ['test_report.py']);
          const hidden = hiddenPython(root, lines('from report import total', "assert total([('a', -5), ('b', -7)]) == -12", 'assert total([]) == 0',
            "assert total([('x', 3)]) == 3"));
          const repository = gitUntouched(workspace);
          return verdict([
            ['test_report.py unchanged', unchanged(root, committed, ['test_report.py'])],
            ['TODO.txt keeps its bytes', unchanged(root, dirty, ['TODO.txt'])],
            ['the unfinished export_csv is still there, byte for byte', source.endsWith(wip)],
            ['the reworded docstring is still there', source.startsWith('"""Monthly report helpers (CSV export in progress)."""\n')],
            ['history and stash left alone', repository.ok, repository.output],
            ['the visible test passes', visible.status === 0 && visible.stdout.includes('TEST_OK'), visible.stderr.slice(-400)],
            ['total is right for other rows', hidden.ok, hidden.output],
          ]);
        },
      };
    },
  },
  {
    kind: 'failing-tool',
    build({ rel }) {
      const parts = ['rotor', 'axle', 'flange', 'gasket', 'bearing'];
      const files = { 'tools/build.py': BUILD_TOOL, 'src/parts.txt': lines(...parts) };
      const body = [...parts].sort().map((name, index) => `${String(index + 1).padStart(2, '0')} ${name.toUpperCase()}\n`).join('');
      return {
        files,
        prompt: `Run python3 ${rel}/tools/build.py to produce ${rel}/dist/manifest.txt. On a fresh checkout its first run fails with "cache cold" and exit status 75 while it warms its cache: that is expected and not a defect, so run it again. Do not edit the tool and do not write dist/manifest.txt yourself.`,
        allowed: ['dist/*', '.build/*'],
        score: (root) => {
          const attempts = readText(root, '.build/attempts.log') || '';
          return verdict([
            ['the tool and its input are unchanged', unchanged(root, files, Object.keys(files))],
            ['the tool recorded its failed first run and a successful one', attempts.startsWith('attempt failed: cache cold\n') && attempts.includes('attempt ok\n'), attempts],
            ['dist/manifest.txt is what the tool writes', bytesEqual(root, 'dist/manifest.txt', `${body}checksum ${sha256(body).slice(0, 16)}\n`)],
          ]);
        },
      };
    },
  },
  {
    kind: 'failing-tool',
    build({ rel }) {
      const records = [{ id: 1, full_name: ' Dana Whitfield ', mail: 'Dana.Whitfield@Example.ORG' }, { id: 2, full_name: 'Piotr Zielinski', mail: ' PIOTR@example.org ' },
        { id: 3, full_name: 'Mai Tran', mail: 'mai.tran@Example.org' }];
      const files = { 'tools/migrate.py': MIGRATE_TOOL, 'data/records.json': `${JSON.stringify(records, null, 2)}\n`, 'var/migrate.lock': '4242\n' };
      const migrated = records.map((row) => ({ id: row.id, name: row.full_name.trim(), email: row.mail.trim().toLowerCase() }));
      return {
        files,
        prompt: `Migrate ${rel}/data/records.json to schema 2 by running python3 ${rel}/tools/migrate.py. An earlier migration crashed and left ${rel}/var/migrate.lock behind; no migration is running now, so that lock is stale and the tool will refuse to start until it is removed. Do not edit the tool and do not edit records.json yourself.`,
        allowed: ['data/*', 'var/*'],
        score: (root) => {
          const data = parseJson(root, 'data/records.json');
          return verdict([
            ['the tool is unchanged', unchanged(root, files, ['tools/migrate.py'])],
            ['the stale lock is gone', !exists(root, 'var/migrate.lock')],
            ['the tool recorded schema 2', bytesEqual(root, 'data/schema-version', '2\n')],
            ['records.json holds the migrated records', !data.error && sameJson(data.value, migrated), data.error],
          ]);
        },
      };
    },
  },
  {
    kind: 'partial-patch',
    build({ rel }) {
      const files = { ...GREETER.before, 'greeter.py': GREETER.after['greeter.py'], 'pending.patch': GREETER_PATCH };
      return {
        files,
        prompt: `${rel}/pending.patch describes one change to three files in ${rel}. Someone applied part of it and stopped, so the program is broken now: python3 main.py Ada (run inside ${rel}) fails. Finish the change so that all three files are exactly what the complete patch produces, without applying any part twice. Keep pending.patch and leave no .orig or .rej files.`,
        allowed: ['main.py', 'config.json', 'greeter.py', '__pycache__/*'],
        score: (root) => {
          const run = runPython(root, ['main.py', 'Ada']);
          return verdict([
            ['pending.patch unchanged', unchanged(root, files, ['pending.patch'])],
            ['no .orig or .rej file was left', !listFiles(root).some((file) => /\.(orig|rej)$/.test(file))],
            ['all three files are the patch result', unchanged(root, GREETER.after, Object.keys(GREETER.after))],
            ['the program runs', run.status === 0 && run.stdout === 'Note: Welcome, Ada.\n', `${run.status} ${run.stdout}${run.stderr}`.slice(-400)],
          ]);
        },
      };
    },
  },
  {
    kind: 'partial-patch',
    build({ rel }) {
      const converted = MODULES.slice(0, 3);
      const files = {
        'CHANGE.md': lines('# log_event becomes audit_event', '', 'In every module under `src/`:', '',
          '1. import `audit_event` instead of `log_event`;', '2. add the line `ACTOR = "system"` after the import, separated from it by one blank line',
          '   and followed by two blank lines;', '3. call `audit_event(<message>, actor=ACTOR)` instead of `log_event(<message>)`.', '',
          '`lib/events.py` already provides only `audit_event`. `src/billing.py` shows a converted module.'),
        'lib/__init__.py': '',
        'lib/events.py': lines('EVENTS = []', '', '', 'def audit_event(message, actor):', '    EVENTS.append((actor, message))'),
        'src/__init__.py': '',
        'check.py': lines('import importlib', '', 'from lib.events import EVENTS', '', `NAMES = ${JSON.stringify(MODULES).replaceAll('"', "'")}`,
          'for name in NAMES:', "    module = importlib.import_module('src.' + name)", "    assert getattr(module, 'run_' + name)() == name",
          "assert EVENTS == [('system', name + ' started') for name in NAMES], EVENTS", "print('CHECK_OK')"),
      };
      for (const name of MODULES) files[`src/${name}.py`] = converted.includes(name) ? moduleAfter(name) : moduleBefore(name);
      const expected = Object.fromEntries(MODULES.map((name) => [`src/${name}.py`, moduleAfter(name)]));
      return {
        files,
        prompt: `${rel}/CHANGE.md describes a change to the six modules in ${rel}/src. It was applied to some of them and then abandoned, so python3 check.py (run inside ${rel}) fails. Finish it: convert the modules that still need it exactly as CHANGE.md says, and leave the modules that are already converted byte for byte as they are. Do not change lib/, check.py or CHANGE.md.`,
        allowed: ['src/*', '__pycache__/*', 'lib/__pycache__/*'],
        score: (root) => {
          const check = runPython(root, ['check.py']);
          return verdict([
            ['lib, check.py and CHANGE.md unchanged', unchanged(root, files, ['CHANGE.md', 'lib/events.py', 'lib/__init__.py', 'check.py', 'src/__init__.py'])],
            ['every module is the converted form, none converted twice', unchanged(root, expected, Object.keys(expected))],
            ['check.py passes', check.status === 0 && check.stdout.includes('CHECK_OK'), `${check.stdout}${check.stderr}`.slice(-400)],
          ]);
        },
      };
    },
  },
  {
    kind: 'steering',
    build({ rel }) {
      const source = ['north gate opens at six', 'south gate stays closed', 'west gate needs a key'];
      const files = { 'source.txt': lines(...source) };
      return {
        files,
        prompt: `Create the directory ${rel}/report and, first of all, the empty file ${rel}/report/STARTED. Then create ${rel}/report/part-1.txt, part-2.txt and part-3.txt, one file per tool call, each holding the matching line of ${rel}/source.txt (line 1 in part-1.txt, and so on) followed by a newline. Do not change source.txt.`,
        steering: {
          when: { path: posixJoin(rel, 'report/STARTED') },
          text: `Change of plan. The report directory is not wanted any more: delete ${rel}/report completely, including anything already written there. Instead write the three lines of ${rel}/source.txt in reverse order (last line first) to ${rel}/out/final.txt, ending with a newline.`,
        },
        allowed: ['report/*', 'out/*'],
        score: (root) => verdict([
          ['source.txt unchanged', unchanged(root, files, ['source.txt'])],
          ['the report directory of the first goal is gone', !exists(root, 'report')],
          ['out/final.txt holds the lines in reverse order', bytesEqual(root, 'out/final.txt', lines(...[...source].reverse()))],
          ['out holds nothing else', sameJson(listFiles(root, 'out'), ['final.txt'])],
        ]),
      };
    },
  },
  {
    kind: 'steering',
    build({ rel }) {
      const files = { 'util.py': lines('def slugify(text):', '    raise NotImplementedError') };
      return {
        files,
        prompt: `First of all create ${rel}/PLAN.txt containing the single line "slugify: underscores". Then implement slugify(text) in ${rel}/util.py: the words of text (maximal runs of ASCII letters and digits) in lower case, joined by underscores. Then create ${rel}/NOTES.md with one sentence describing that format. Use a separate tool call for each of these three steps.`,
        steering: {
          when: { path: posixJoin(rel, 'PLAN.txt') },
          text: `Correction: slugify must join the words with hyphens, not underscores. Change ${rel}/PLAN.txt to the single line "slugify: hyphens". NOTES.md is not wanted: do not create it, and delete it if it already exists.`,
        },
        allowed: ['util.py', 'PLAN.txt', 'NOTES.md', '__pycache__/*'],
        score: (root) => {
          const hidden = hiddenPython(root, lines('from util import slugify', "assert slugify('Hello  Big World') == 'hello-big-world'",
            "assert slugify('  Q3 report: v2! ') == 'q3-report-v2'", "assert slugify('one') == 'one'", "assert slugify('') == ''"));
          return verdict([
            ['NOTES.md of the first goal is absent', !exists(root, 'NOTES.md')],
            ['PLAN.txt states the corrected format', bytesEqual(root, 'PLAN.txt', 'slugify: hyphens\n')],
            ['slugify joins words with hyphens', hidden.ok, hidden.output],
          ]);
        },
      };
    },
  },
  {
    kind: 'stop-resume',
    build({ rel }) {
      const files = { 'tools/step.py': STEP_TOOL };
      return {
        files,
        prompt: `Run python3 ${rel}/tools/step.py 1, then the same command with 2, 3 and 4: four separate tool calls, in that order, waiting for each to finish. Every run appends a line to ${rel}/journal.log, and a step must never run twice. Do not edit the tool, journal.log or state.json yourself.`,
        stop: {
          when: { path: posixJoin(rel, 'journal.log'), contains: 'step 2 done\n' },
          resumePrompt: `The previous turn was stopped before the task was finished. Read ${rel}/journal.log to see which steps already ran, then run only the remaining ones, in order, with python3 ${rel}/tools/step.py N. A step must never run twice.`,
        },
        allowed: ['journal.log', 'state.json'],
        score: (root) => {
          const state = parseJson(root, 'state.json');
          return verdict([
            ['the tool is unchanged', unchanged(root, files, ['tools/step.py'])],
            ['journal.log has each step once, in order', bytesEqual(root, 'journal.log', lines('step 1 done', 'step 2 done', 'step 3 done', 'step 4 done')), readText(root, 'journal.log')],
            ['the tool ran exactly four times', !state.error && state.value?.runs === 4, JSON.stringify(state.value)],
          ]);
        },
      };
    },
  },
  {
    kind: 'stop-resume',
    build({ rel }) {
      const files = { 'tools/emit.py': EMIT_TOOL };
      let total = 0;
      const ledger = [1, 2, 3, 4, 5].map((part) => `${part},${(total += part)}\n`).join('');
      return {
        files,
        prompt: `Run python3 ${rel}/tools/emit.py 1, then the same command with 2, 3, 4 and 5: five separate tool calls, in that order, waiting for each to finish. Every run writes ${rel}/out/part-N.txt and adds a row with a running total to ${rel}/ledger.csv, so a part must never be emitted twice. Do not edit the tool, the ledger, emit.count or the parts yourself.`,
        stop: {
          when: { path: posixJoin(rel, 'out/part-3.txt') },
          resumePrompt: `The previous turn was stopped before the task was finished. Read ${rel}/ledger.csv to see which parts were already emitted, then emit only the remaining ones, in order, with python3 ${rel}/tools/emit.py N. A part must never be emitted twice.`,
        },
        allowed: ['out/*', 'ledger.csv', 'emit.count'],
        score: (root) => verdict([
          ['the tool is unchanged', unchanged(root, files, ['tools/emit.py'])],
          ['out holds the five parts', sameJson(listFiles(root, 'out'), [1, 2, 3, 4, 5].map((part) => `part-${part}.txt`)) &&
            [1, 2, 3, 4, 5].every((part) => bytesEqual(root, `out/part-${part}.txt`, `part ${part} of 5\n`))],
          ['ledger.csv has each part once with the right running total', bytesEqual(root, 'ledger.csv', ledger), readText(root, 'ledger.csv')],
          ['the tool ran exactly five times', bytesEqual(root, 'emit.count', '5\n'), readText(root, 'emit.count')],
        ]),
      };
    },
  },
  {
    kind: 'two-sessions',
    build({ rel }) {
      const files = {
        'tools/register.py': REGISTER_TOOL, 'tools/seal.py': SEAL_TOOL,
        'items.csv': lines('sku,qty', ...ITEMS.map((row) => row.join(','))),
        'adjustments.csv': lines('sku,delta', ...ADJUSTMENTS.map((row) => row.join(','))),
      };
      const adjusted = ITEMS.map(([sku, qty]) => ({ sku, qty: qty + (ADJUSTMENTS.find(([name]) => name === sku)?.[1] || 0) }));
      return {
        files,
        prompt: `Run python3 ${rel}/tools/register.py exactly once: it registers this workspace by appending a line to ${rel}/registry.log, and a workspace must be registered only once. Then create ${rel}/inventory.json from ${rel}/items.csv: a JSON list with one object per data row, in file order, of the form {"sku": <text>, "qty": <integer>}. Do not edit the tools or the CSV files.`,
        secondPrompt: `An earlier session in this workspace already registered it and created ${rel}/inventory.json; do not register it again and do not rebuild that file from items.csv. Add to each quantity in inventory.json the delta given for its sku in ${rel}/adjustments.csv (a sku without a line there keeps its quantity), keeping the order and the form of the entries. When inventory.json is final, run python3 ${rel}/tools/seal.py. Do not edit the tools, the CSV files or registry.log.`,
        allowed: ['registry.log', 'inventory.json', 'inventory.sha256'],
        score: (root) => {
          const inventory = parseJson(root, 'inventory.json');
          const bytes = readBytes(root, 'inventory.json');
          return verdict([
            ['tools and CSV files unchanged', unchanged(root, files, Object.keys(files))],
            ['the workspace was registered exactly once', bytesEqual(root, 'registry.log', 'registered 1\n'), readText(root, 'registry.log')],
            ['inventory.json holds the adjusted quantities in order', !inventory.error && sameJson(inventory.value, adjusted), inventory.error],
            ['the seal matches the final inventory.json', bytes !== null && bytesEqual(root, 'inventory.sha256', `${sha256(bytes || '')}\n`)],
          ]);
        },
      };
    },
  },
  {
    kind: 'two-sessions',
    build({ rel }) {
      const files = {
        'lib.py': lines('def parse(line):', '    raise NotImplementedError'),
        'test_parse.py': lines('from lib import parse', '', "assert parse('a=1;b=two') == {'a': '1', 'b': 'two'}", "print('TEST_OK')"),
        'test_render.py': lines('from lib import render', '', "assert render({'b': 'two', 'a': '1'}) == 'a=1;b=two'", "print('TEST_OK')"),
        'CHANGELOG.md': '# Changelog\n',
      };
      return {
        files,
        prompt: `In ${rel}/lib.py implement parse(line): it turns "key=value;key2=value2" into a dictionary of strings, and an empty string into an empty dictionary. python3 ${rel}/test_parse.py must pass. Then append to ${rel}/CHANGELOG.md exactly these two lines: "## parse" and "- added parse". Do not edit the test files; test_render.py belongs to a later task.`,
        secondPrompt: `An earlier session in this workspace implemented parse() in ${rel}/lib.py and recorded it in ${rel}/CHANGELOG.md. Keep both. Add render(mapping) to lib.py: the inverse of parse, with the keys in ascending order and an empty dictionary giving an empty string. python3 ${rel}/test_render.py must pass and test_parse.py must still pass. Then append to CHANGELOG.md, after what is already there, exactly these two lines: "## render" and "- added render". Do not edit the test files.`,
        allowed: ['lib.py', 'CHANGELOG.md', '__pycache__/*'],
        score: (root) => {
          const hidden = hiddenPython(root, lines('from lib import parse, render', "assert parse('') == {} and render({}) == ''",
            "assert parse('x=9') == {'x': '9'}", "assert render({'z': '1', 'm': '2', 'a': '3'}) == 'a=3;m=2;z=1'",
            "assert parse(render({'k': 'v', 'j': 'w'})) == {'k': 'v', 'j': 'w'}"));
          return verdict([
            ['test files unchanged', unchanged(root, files, ['test_parse.py', 'test_render.py'])],
            ['CHANGELOG.md has both entries once, in order', bytesEqual(root, 'CHANGELOG.md', lines('# Changelog', '## parse', '- added parse', '## render', '- added render')), readText(root, 'CHANGELOG.md')],
            ['parse and render both work', hidden.ok, hidden.output],
          ]);
        },
      };
    },
  },
];

const seen = new Map();
export const RECOVERY_CASES = Object.freeze(CASES.map((definition) => {
  const variation = (seen.get(definition.kind) || 0) + 1;
  seen.set(definition.kind, variation);
  return Object.freeze({
    ...definition, variation, id: `${definition.kind}-${String(variation).padStart(2, '0')}`,
    mechanic: RECOVERY_TASK_TYPES.find((type) => type.id === definition.kind).mechanic,
  });
}));

// One recovery task. It owns the whole of `workspace` (two of them need its
// git state), so a runner gives each attempt a workspace of its own.
export function createRecoveryTask(workspace, caseId, { slug, marker }) {
  const definition = RECOVERY_CASES.find((item) => item.id === caseId);
  if (!definition) throw new Error(`unknown recovery case: ${caseId}`);
  const rel = posixJoin('cases', caseId, slug);
  const root = path.join(workspace, ...rel.split('/'));
  const built = definition.build({ rel, workspace });
  const expected = completionMarker(marker, caseId);
  const finish = finishInstruction(expected);
  const last = (text) => `${text} ${finish}`;
  const task = {
    recovery: true,
    mechanic: definition.mechanic,
    ownsGit: Boolean(built.afterReset),
    expected,
    answerMustContain: [],
    allowedChanges: built.allowed.map((relative) => posixJoin(rel, relative)),
    score: () => safeScore(() => built.score(root)),
    reset: () => {
      writeCaseFiles(root, built.files);
      if (built.afterReset) built.afterReset(root);
    },
    files: built.files,
    root,
  };
  if (definition.mechanic === 'two-sessions') {
    // The first session only has to finish; the marker closes the second.
    task.prompt = `${built.prompt} All paths are relative to the active workspace: do not cd to / or search outside the workspace.`;
    task.secondPrompt = last(built.secondPrompt);
  } else if (definition.mechanic === 'stop-resume') {
    task.prompt = last(built.prompt);
    task.stop = { when: built.stop.when, resumePrompt: last(built.stop.resumePrompt) };
  } else if (definition.mechanic === 'steering') {
    task.prompt = last(built.prompt);
    task.steering = { when: built.steering.when, text: built.steering.text };
  } else {
    task.prompt = last(built.prompt);
  }
  return task;
}
