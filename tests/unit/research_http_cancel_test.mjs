// Actual loopback HTTP transport; no model or external service.
import assert from 'node:assert/strict';
import http from 'node:http';
import { completeText, jsonFetch } from '../support/real_harness.mjs';

let received, closed;
const server = http.createServer((req, res) => {
  req.resume();
  req.once('end', () => received?.());
  res.once('close', () => closed?.());
  // Deliberately never return headers: cancellation must close this request.
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const bound = setTimeout(() => { server.closeAllConnections(); throw Error('HTTP cancellation gate timed out'); }, 5000);
try {
  let readyResolve, closedResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const closure = new Promise(resolve => { closedResolve = resolve; });
  received = readyResolve; closed = closedResolve;
  const controller = new AbortController();
  const response = completeText(base, [{ role: 'user', content: 'Cancel this test request' }], { signal: controller.signal, timeoutMs: 0 });
  const rejected = assert.rejects(response, error => /abort/i.test(error.name + error.message));
  await ready;
  controller.abort();
  await rejected;
  await closure;

  // A caller signal must not mask an explicit independent transport deadline.
  const alive = new AbortController();
  await assert.rejects(jsonFetch(base, '/stalled', { timeoutMs: 30, signal: alive.signal }), error => /timeout|aborted/i.test(error.name + error.message));
  assert.equal(alive.signal.aborted, false);
  console.log('research_http_cancel: aborted inference closes real HTTP request; independent timeout retained');
} finally {
  clearTimeout(bound);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
