'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '_site');
const prefix = '/plateloader/';
const port = Number(process.env.PORT) || 4173;
const mime = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.woff2', 'font/woff2'],
]);

const server = http.createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }

  const url = new URL(request.url, 'http://127.0.0.1');
  if (!url.pathname.startsWith(prefix)) {
    response.writeHead(302, { Location: prefix }).end();
    return;
  }

  let relative;
  try { relative = decodeURIComponent(url.pathname.slice(prefix.length)); }
  catch (_) { response.writeHead(400).end(); return; }
  if (!relative || relative.endsWith('/')) relative += 'index.html';

  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) {
    response.writeHead(403).end();
    return;
  }

  fs.readFile(target, (error, bytes) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': mime.get(path.extname(target)) || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Plate Loader test server listening on http://127.0.0.1:${port}${prefix}\n`);
});
