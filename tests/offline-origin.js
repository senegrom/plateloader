'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

// An isolated origin serving the built site, which a test can genuinely shut
// down without taking down the shared suite server. no-store prevents the
// ordinary HTTP cache from making an offline test pass without the service
// worker.
async function startOfflineOrigin() {
  const root = path.resolve(__dirname, '../_site');
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (!pathname.startsWith('/plateloader/')) {
        response.writeHead(404).end();
        return;
      }
      const file = path.resolve(root, pathname.slice('/plateloader/'.length) || 'index.html');
      if (!file.startsWith(root + path.sep)) {
        response.writeHead(403).end();
        return;
      }
      const body = await fs.readFile(file);
      response.writeHead(200, {
        'Content-Type': types[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      response.end(body);
    } catch (_) {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/plateloader/`,
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}

module.exports = { startOfflineOrigin };
