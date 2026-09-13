// Execute the production command queue with simulated status/transport. This is
// UI behavior, not proof of native checkpoint correctness or model quality.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {extractFunction} from '../support/real_harness.mjs';

const source = fs.readFileSync('web/index.html', 'utf8');
const functions = ['sessionStatusMatches', 'drainSessionEvents', 'sessionRequestValid', 'runSessionAction']
  .map(name => extractFunction(source, name)).join('\n');
async function scenario(mode, action, supported, statusMode = mode, invalidateAfterPoll = false, failure = '') {
  const calls = [], metadata = [], bindingsDuringReset = [];
  const context = vm.createContext({
    Date, Promise, setTimeout, activeView: true, epoch: 1, viewMode: mode,
    liveConvId: 'current-conversation', since: 8, activeSessionCommand: null,
    sessionEventCarry: '', toast: () => {}, pullSessionList: () => {},
    Engine: {
      status: async () => ({mode: statusMode, running: true, ready: true, agentWorking: false,
        ...(supported === undefined ? {} : {agentDiskCheckpointsSupported: supported})}),
      designSession: async (...args) => {
        calls.push(args);
        if (action === 'new') bindingsDuringReset.push(context.liveConvId);
        return failure === 'http' ? {ok: false, error: 'reset rejected'} : {ok: true};
      },
    },
    Store: {getChat: id => ({id}), setChatMeta: (...args) => metadata.push(args)},
    poll: async () => {
      if (invalidateAfterPoll) context.epoch++;
      if (action === 'new' && context.activeSessionCommand) {
        bindingsDuringReset.push(context.liveConvId);
        const message = failure ? 'new session failed: interrupted; previous session retained' : 'new session started';
        const frame = '\x1e' + JSON.stringify({type: 'session_status', level: failure ? 'error' : 'info', message}) + '\n';
        // Real production event consumer, split across two transport chunks.
        context.chunk = frame.slice(0, 17); vm.runInContext('drainSessionEvents(chunk)', context);
        context.chunk = frame.slice(17); vm.runInContext('drainSessionEvents(chunk)', context);
        context.since += frame.length;
      }
    },
  });
  vm.runInContext(functions, context);
  context.request = {mode, epoch: 1, action, sha: '1234abcd', timeoutMs: 1000, targetConvId: 'reopened-conversation'};
  const result = await vm.runInContext('runSessionAction(request)', context);
  return {result, calls, metadata, bindingsDuringReset, liveConvId: context.liveConvId};
}
let count = 0;
for (const mode of ['agent', 'cowork']) {
  for (const action of ['save', 'list', 'switch', 'del']) {
    const r = await scenario(mode, action, false);
    assert.equal(r.result.ok, false);
    assert.equal(r.result.code, 'unsupported_session_checkpoint');
    assert.equal(r.calls.length, 0, 'Do not send unsupported commands');
    assert.equal(r.metadata.length, 0, 'Do not rebind a conversation on a rejected restore');
    assert.equal(r.liveConvId, 'current-conversation'); count++;
  }
  for (const [action, supported] of [['new', false], ['save', true], ['switch', undefined]]) {
    const r = await scenario(mode, action, supported);
    assert.equal(r.result.ok, true);
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0][0], action);
    if (action === 'new') assert(r.bindingsDuringReset.every(id => id === 'current-conversation'));
    assert.equal(r.liveConvId, 'reopened-conversation'); count++;
  }
  for (const failure of ['http', 'native']) {
    const r = await scenario(mode, 'new', false, mode, false, failure);
    assert.equal(r.result.ok, false, 'A rejected/failed native reset is not a successful new session');
    assert.match(r.result.error, failure === 'http' ? /rejected/ : /previous session retained/);
    assert.equal(r.metadata.length, 0, 'Do not change the target chat after a failed reset');
    assert.equal(r.liveConvId, 'current-conversation');
    assert(r.bindingsDuringReset.every(id => id === 'current-conversation')); count++;
  }
  const changed = await scenario(mode, 'new', false, 'design');
  assert.equal(changed.result.canceled, true);
  assert.equal(changed.calls.length, 0); count++;
  for (const action of ['new', 'save', 'switch']) {
    const stale = await scenario(mode, action, true, mode, true);
    assert.equal(stale.result.canceled, true, 'Revalidate after awaiting the previous transcript');
    assert.equal(stale.calls.length, 0, 'A stale view must not send a session command');
    assert.equal(stale.metadata.length, 0, 'A stale view must not rebind conversation metadata');
    assert.equal(stale.liveConvId, 'current-conversation'); count++;
  }
}
const menus = ['selectedAgentDiskCheckpointsExpected', 'slashCommands']
  .map(name => extractFunction(source, name)).join('\n');
const selectors = source.slice(source.indexOf('    const localQwen35Selected ='), source.indexOf('    function thinkingProfile('));
for (const mode of ['agent', 'cowork']) for (const [model, remote, lan, expected] of [
  ['qwen3.6-35b-a3b', false, false, false], ['deepseek-v4-flash', false, false, true],
  ['qwen3.6-35b-a3b', true, false, true], ['qwen3.6-35b-a3b', false, true, true],
  ['qwen3.8-27b', false, false, false], ['qwen3.8-27b', true, false, true], ['qwen3.8-27b', false, true, true],
]) {
  const settings = {model, chatBackend: remote ? 'deepseek' : 'local', deepseekApiKey: remote ? 'fixture' : ''};
  const context = vm.createContext({Store: {getSettings: () => settings}, Switcher: {mode: () => mode},
    isLanClientMode: () => lan});
  const commands = vm.runInContext(selectors + menus + '\nslashCommands()', context).map(c => c.cmd.trim());
  for (const command of ['/save', '/list', '/switch', '/del']) assert.equal(commands.includes(command), expected);
  for (const command of ['/new', '/compact', '/help']) assert(commands.includes(command));
  count++;
}
console.log(`agent_session_capability_test: ${count}/${count} PASS; production UI queue, simulated runtime`);
