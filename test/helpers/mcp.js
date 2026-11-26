// Helpers: start src/server.js over stdio with a real MCP client, and a fake debugging-port server.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Spawn the server as a child process (PORT/PROTOCOL are read from env at module load). */
export async function startServer(env = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('FOXPILOT_')));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'src/server.js')],
    env: { ...clean, FOXPILOT_IDLE_MS: '50', FOXPILOT_AUTOSTART: '0', ...env },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'unit-test', version: '0' });
  await client.connect(transport);
  return client;
}

export const textOf = (r) => r.content.map((c) => c.text ?? '').join('\n');

/**
 * Fake "debugging port". `versionHandler(req, res)` answers GET /json/version (default: 404 HTML).
 * Any WebSocket upgrade is recorded in `upgrades` (request path) and the socket is dropped, so a
 * client that tries to connect fails fast instead of speaking a real protocol.
 */
export async function fakePort(versionHandler) {
  const upgrades = [];
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/json/version' && versionHandler) return versionHandler(req, res);
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<html><body>Not Found</body></html>');
  });
  server.on('upgrade', (req, socket) => {
    upgrades.push(req.url);
    socket.destroy();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    port,
    upgrades,
    requests,
    close: () => new Promise((r) => (server.closeAllConnections(), server.close(r))),
  };
}

/** A port number with (almost certainly) nothing listening: bind, read the port, close. */
export async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}
