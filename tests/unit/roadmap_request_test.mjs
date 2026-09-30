// Actual harness HTTP requests to a simulated engine. No inference or quality
// score: the generation setting must override the engine launch default.
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {completeText, completeTextStream} from '../support/real_harness.mjs';
import {roadmapGenerationSettings} from '../support/roadmap_generation_settings.mjs';

const bodies = [];
const server = http.createServer(async (req, res) => {
  const bytes = []; for await (const chunk of req) bytes.push(chunk);
  const body = JSON.parse(Buffer.concat(bytes).toString()); bodies.push(body);
  res.setHeader('Content-Type', body.stream ? 'text/event-stream' : 'application/json');
  if (body.stream) res.end('data: ' + JSON.stringify({choices: [{delta: {content: 'fixture'}, finish_reason: 'stop'}]}) + '\n\ndata: [DONE]\n\n');
  else res.end(JSON.stringify({choices: [{message: {content: 'fixture'}}]}));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
try {
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(roadmapGenerationSettings({}), {thinkLevel: 'max'});
  assert.throws(() => roadmapGenerationSettings({DSTUDIO_REAL_ROADMAP_THINK_LEVEL: 'disabled'}));
  for (const level of ['off', 'high', 'max']) {
    const opts = {...roadmapGenerationSettings({DSTUDIO_REAL_ROADMAP_THINK_LEVEL: level}), maxTokens: 32, timeoutMs: 5000};
    await completeText(base, [{role: 'user', content: 'fixture'}], opts);
    await completeTextStream(base, [{role: 'user', content: 'fixture'}], opts);
    for (const body of bodies.slice(-2)) {
      assert.equal(body.think, level !== 'off');
      assert.equal(body.reasoning_effort, level === 'off' ? undefined : level);
      assert.equal(body.max_tokens, 32);
    }
  }
  console.log('PASS: Learn generation off/high/max reach real HTTP requests (simulated engine)');
} finally {server.close(); await once(server, 'close');}
