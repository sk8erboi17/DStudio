import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  artifactDir,
  csrfHeaders,
  jsonFetch,
  mkdirp,
  pollAgent,
  startDStudio,
  startMode,
  waitForAgentText,
  waitForModel,
  writeArtifact,
} from './real_harness.mjs';

const artifacts = artifactDir('remote-real');
const host = await startDStudio({ binaryArg: process.argv[2], label: 'dstudio-remote-host' });
const client = await startDStudio({ binaryArg: process.argv[2], label: 'dstudio-remote-client', ignoreExternal: true });

async function sendPrompt(baseUrl, prompt) {
  const res = await jsonFetch(baseUrl, '/api/agent/send', {
    method: 'POST',
    headers: csrfHeaders,
    body: JSON.stringify({ prompt }),
    timeoutMs: 30_000,
  });
  if (!res.ok) throw new Error(`agent send failed: ${JSON.stringify(res)}`);
  return res;
}

async function assertRemoteWorkspaceWrite({ mode, workspace, file, content, prompt }) {
  mkdirp(workspace);
  const st = await startMode(client.baseUrl, {
    mode,
    model: 'uncensored',
    variant: 'flash',
    ctx: 4096,
    power: 100,
    think: 'off',
    workdir: workspace,
    jsonl: true,
    build: 'off',
    modelBackend: 'remote',
    remoteBaseUrl: host.baseUrl,
    remoteModel: 'ds4',
  }, 300_000);
  writeArtifact(artifacts, `${mode}-start.json`, st);

  const before = await pollAgent(client.baseUrl, 0).catch(() => ({ len: 0 }));
  await sendPrompt(client.baseUrl, prompt);
  const target = path.join(workspace, file);
  const run = await waitForAgentText(client.baseUrl, before.len || 0, () => fs.existsSync(target), 900_000);
  writeArtifact(artifacts, `${mode}-transcript.txt`, run.text);

  assert.equal(fs.existsSync(target), true, `${mode} should write ${file} in the client workspace`);
  assert.equal(fs.readFileSync(target, 'utf8').includes(content), true, `${mode} output should contain exact marker`);
}

try {
  await waitForModel(host.baseUrl);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dstudio-remote-workspaces-'));
  const agentWorkspace = path.join(root, 'agent-client');
  const designWorkspace = path.join(root, 'design-client');

  await assertRemoteWorkspaceWrite({
    mode: 'agent',
    workspace: agentWorkspace,
    file: 'remote-agent-client.txt',
    content: 'REMOTE_AGENT_CLIENT_OK',
    prompt: [
      'This is an automated DStudio remote-model workspace test.',
      'Call the write tool exactly once to create `remote-agent-client.txt`.',
      'The file content must be exactly: REMOTE_AGENT_CLIENT_OK',
      'After the tool result, answer only: done',
    ].join('\n'),
  });

  await assertRemoteWorkspaceWrite({
    mode: 'design',
    workspace: designWorkspace,
    file: 'remote-design-client.html',
    content: 'REMOTE_DESIGN_CLIENT_OK',
    prompt: [
      'This is an automated DStudio remote-model design workspace test.',
      'Call the write tool to create `remote-design-client.html`.',
      'The HTML must include this exact marker in the body: REMOTE_DESIGN_CLIENT_OK',
      'After the tool result, answer only: done',
    ].join('\n'),
  });

  assert.equal(fs.existsSync(path.join(agentWorkspace, 'remote-design-client.html')), false);
  assert.equal(fs.existsSync(path.join(designWorkspace, 'remote-agent-client.txt')), false);

  console.log('real_remote_test: ok');
} finally {
  await client.stop();
  await host.stop();
}
