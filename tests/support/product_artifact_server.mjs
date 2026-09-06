import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

// Serve unchanged artifacts for the independent browser audit. Resolve the
// product once: mutating route segments inside find() skipped the second row.
export function createProductArtifactServer(candidates) {
  return http.createServer((req, res) => {
    try {
      const [product, ...parts] = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
        .split('/').filter(Boolean);
      const row = candidates.find(candidate => candidate.product === product);
      if (!row?.workspace || parts.some(part => part === '..')) { res.writeHead(404).end(); return; }
      const root = fs.realpathSync(row.workspace), target = fs.realpathSync(path.join(root, ...parts));
      if (!target.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
      const type = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml' }[path.extname(target)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type }); res.end(fs.readFileSync(target));
    } catch { res.writeHead(404).end(); }
  });
}
