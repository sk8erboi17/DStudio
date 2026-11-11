// SIMULATED engine for the vision corpus runner's dry run: no model, no weights.
//
// The model-free test host launches it through its real /api/start path, in
// place of ds4-server (tests/integration/vision_corpus_runner_test.mjs writes
// a fixture checkout whose ./ds4-server execs this file). It takes the
// arguments the host gives ds4-server (-m, --vision, --host, --port, ...),
// listens where it is told, answers /v1/models like ds4-server and forwards
// every other request to the scripted engine of the test
// (DSTUDIO_FIXTURE_ENGINE_UPSTREAM, inherited from the host's environment).
// Each forwarded request carries the arguments this process was started with
// in x-fixture-engine-* headers, so the test can tell which launch served it.
// Closing the client connection closes the upstream one (Stop reaches the
// scripted engine). It opens no file named on its command line.
import http from 'node:http';

const args = process.argv.slice(2);
const arg = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : ''; };
const port = Number(arg('--port'));
const host = arg('--host') || '127.0.0.1';
const model = arg('-m');
const vision = arg('--vision') || arg('--mmproj');
const upstream = new URL(process.env.DSTUDIO_FIXTURE_ENGINE_UPSTREAM || 'http://127.0.0.1:9');
if (!(port > 0)) { console.error('fixture engine: --port is required'); process.exit(2); }

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    // The catalog shape the host's compatibility probe expects of ds4-server.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-v4-flash', object: 'model', owned_by: 'ds4.c' }] }));
    return;
  }
  const forward = http.request({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method,
    headers: { ...req.headers, host: upstream.host, 'x-fixture-engine-model': model, 'x-fixture-engine-vision': vision, 'x-fixture-engine-pid': String(process.pid) } },
  (reply) => { res.writeHead(reply.statusCode || 502, reply.headers); reply.pipe(res); });
  forward.on('error', (error) => {
    if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: `fixture upstream: ${error.message}` } })); }
    else res.destroy();
  });
  res.on('close', () => { if (!res.writableFinished) forward.destroy(); });
  req.pipe(forward);
});
server.listen(port, host, () => {
  // The line ds4-server prints when it accepts requests.
  console.log(`fixture engine (no model): listening on http://${host}:${port}`);
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(); server.closeAllConnections(); process.exit(0); });
