// End-to-end check: starts the MCP server over stdio and calls every tool against a running browser.
// Needs a browser (Firefox/Zen or Chromium) listening on FOXPILOT_PORT (default 9222). Run: npm run smoke
// Pages come from a local HTTP server, so results don't depend on outside sites; only browser_search
// goes online, and its content is not checked (search engines may show bot challenges).
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const pages = {
  '/': `<title>Home</title><h1>Smoke home</h1><p>This domain is a local test page.</p>
        <a href="/next">Learn more</a>
        <form action="/result"><input name="q" placeholder="Search"><button>Go</button></form>
        <div style="height:3000px"></div>`,
  '/next': '<title>Next page</title><p>You followed the link.</p>',
};
const site = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const body = url.pathname === '/result'
    ? `<title>Result</title><p>You searched: ${(url.searchParams.get('q') ?? '').replace(/[<>&]/g, '')}</p>`
    : pages[url.pathname];
  res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body ?? 'not found');
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}`;

const transport = new StdioClientTransport({ command: process.execPath, args: ['src/server.js'], env: { ...process.env } });
const client = new Client({ name: 'smoke', version: '0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));

let failed = 0;
async function call(name, args = {}, { expect, expectError = false } = {}) {
  const r = await client.callTool({ name, arguments: args });
  const out = r.content.map((c) => (c.type === 'text' ? c.text : `<${c.type} ${c.data.length}b>`)).join(' | ');
  const bad = expectError ? !r.isError : r.isError || (expect && !out.includes(expect));
  console.log(`\n## ${name} ${JSON.stringify(args)}${bad ? '  [FAIL]' : ''}\n${out.slice(0, 400)}`);
  if (bad) failed++;
  return out;
}

await call('browser_open', { url: `${base}/` }, { expect: 'Home' });
await call('browser_read', {}, { expect: 'Smoke home' });
await call('browser_find', { query: 'local test' }, { expect: '1 match' });
await call('browser_read', { mode: 'interactive' }, { expect: 'Learn more' });
await call('browser_click', { text: 'Learn more' }, { expect: '/next' });
await call('browser_open', { url: `${base}/` }, { expect: 'Home' });
const inter = await call('browser_read', { mode: 'interactive' });
const ref = Number(/\[(\d+)\] input text/.exec(inter)?.[1] ?? NaN);
await call('browser_type', { ref, value: 'hello fox', submit: true }, { expect: '/result' });
await call('browser_wait', { text: 'You searched: hello fox', timeoutMs: 10000 }, { expect: 'Ready' });
await call('browser_open', { url: `${base}/` });
await call('browser_scroll', { direction: 'down' }, { expect: 'Scrolled down' });
await call('browser_key', { key: 'Escape' }, { expect: 'Pressed Escape' });
await call('browser_eval', { js: 'document.title' }, { expect: '"Home"' });
await call('browser_screenshot', {}, { expect: '<image' });
await call('browser_search', { query: 'model context protocol', engine: 'bing' }, { expect: 'tab ' });
const tabs = await call('browser_tabs', {}, { expect: 'Home' });
const last = /\[(\d+)\][^\n]*$/.exec(tabs)?.[1];
await call('browser_close', { tabId: last }, { expect: 'Closed' });
await call('browser_click', { ref: 9999 }, { expectError: true });

await client.close();
site.close();
console.log(failed ? `\nFAILED: ${failed}` : '\nSMOKE OK');
process.exit(failed ? 1 : 0);
