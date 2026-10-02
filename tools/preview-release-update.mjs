import http from 'node:http';
import { readFile } from 'node:fs/promises';

const version = (await readFile(new URL('../VERSION', import.meta.url), 'utf8')).trim();
const port = Number(process.argv[2] ?? 8193);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a port between 1024 and 65535.');
const server = http.createServer((request, response) => {
  if (request.method !== 'GET' || request.url !== '/releases/latest') {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  // Simulate GitHub after publication while the actual release remains draft.
  // Asset downloads still require the signed catalog's sizes and hashes.
  response.end(JSON.stringify({
    tag_name: `v${version}`,
    html_url: `https://github.com/martig7/subway-builder-open-world/releases/tag/v${version}`,
    draft: false,
    prerelease: false,
  }));
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Update preview for v${version}: http://127.0.0.1:${port}/releases/latest`);
  console.log('Launch the manager with OPEN_WORLD_UPDATE_TEST_URL set to that URL. Stop this process when finished.');
});
