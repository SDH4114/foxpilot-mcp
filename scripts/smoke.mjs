// End-to-end check: starts the MCP server over stdio and calls every tool against a running browser.
// Needs a browser (Firefox/Zen or Chromium) listening on FOXPILOT_PORT (default 9222). Run: npm run smoke
// Pages come from a local HTTP server, so results don't depend on outside sites; only browser_search
// goes online, and its content is not checked (search engines may show bot challenges).
// Every tab the test opens is closed at the end. Still: run it against a throwaway browser profile.
import http from 'node:http';
import net from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const IDLE_MS = 400; // short idle so the test also covers release + reconnect
const PORT = Number(process.env.FOXPILOT_PORT || 9222);

// A browser started right before this script needs a moment to open its port: wait for it
// instead of failing the first calls.
async function waitForPort(port, ms = 20000) {
  const deadline = Date.now() + ms;
  // FOXPILOT_SMOKE_GRACE_MS: extra wait for a browser started right before this script.
  const grace = Number(process.env.FOXPILOT_SMOKE_GRACE_MS ?? 3000);
  while (Date.now() < deadline) {
    const open = await new Promise((r) => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => (s.destroy(), r(true)));
      s.once('error', () => r(false));
    });
    if (open) {
      if (grace > 0) await new Promise((r) => setTimeout(r, grace));
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error(`No browser on 127.0.0.1:${port} after ${ms / 1000} s. Start one with --remote-debugging-port ${port}.`);
  process.exit(2);
}
await waitForPort(PORT);

const pages = {
  '/': `<title>Home</title><h1>Smoke home</h1><p>This domain is a local test page.</p>
        <a href="/next">Learn more</a> <a href="/next" target="_blank">Open in new tab</a>
        <form action="/result"><input name="q" placeholder="Search" value="old text"><button>Go</button></form>
        <input id="note" placeholder="Note" value="hello world">
        <p id="keys"></p>
        <button id="cnt" onclick="this.textContent = 'Count: ' + (Number(this.textContent.split(': ')[1]) + 1)">Count: 0</button>
        <script>addEventListener('keydown', (e) => { if (e.key === 'a' && (e.ctrlKey || e.metaKey)) document.getElementById('keys').textContent = 'combo ok'; });</script>
        <div style="height:3000px"></div>`,
  '/next': '<title>Next page</title><p>You followed the link.</p>',
  // After 300 ms a script moves ref "2" from "Save draft" to "Delete everything".
  '/tamper': `<title>Tamper</title><button id="del" onclick="document.title='DELETED'">Delete everything</button>
        <button id="save" onclick="document.title='SAVED'">Save draft</button>
        <script>setTimeout(() => { const s = document.getElementById('save'); const r = s.getAttribute('data-foxpilot-ref');
          if (r) { s.removeAttribute('data-foxpilot-ref'); document.getElementById('del').setAttribute('data-foxpilot-ref', r); } }, 300);</script>`,
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

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/server.js'],
  // AUTOSTART=0: if the test browser dies mid-run, fail instead of opening the user's real browser.
  env: { ...process.env, FOXPILOT_IDLE_MS: String(IDLE_MS), FOXPILOT_AUTOSTART: '0' },
});
const client = new Client({ name: 'smoke', version: '0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));

let failed = 0;
const mine = new Set(); // tab ids this test opened
const tabOf = (out) => /tab (\d+):/.exec(out)?.[1];
async function call(name, args = {}, { expect, expectError = false } = {}) {
  const r = await client.callTool({ name, arguments: args });
  const out = r.content.map((c) => (c.type === 'text' ? c.text : `<${c.type} ${c.data.length}b>`)).join(' | ');
  const bad = expectError ? !r.isError || (expect && !out.includes(expect)) : r.isError || (expect && !out.includes(expect));
  console.log(`\n## ${name} ${JSON.stringify(args)}${bad ? '  [FAIL]' : ''}\n${out.slice(0, 400)}`);
  if (bad) failed++;
  if (!r.isError && ['browser_open', 'browser_search'].includes(name) && !args.tabId) mine.add(tabOf(out));
  if (!r.isError && /opened a new tab/.test(out)) mine.add(tabOf(out));
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const refOf = (list, re) => Number(re.exec(list)?.[1] ?? NaN);

// Reading
const home = tabOf(await call('browser_open', { url: `${base}/` }, { expect: 'Home' }));
if (!home) {
  // Everything below works on this tab; going on would only produce follow-up failures.
  console.log('\nFAILED: could not open the test page, stopping.');
  await client.close();
  site.close();
  process.exit(1);
}
await call('browser_read', {}, { expect: 'Smoke home' });
await call('browser_read', { offset: 99999 }, { expect: 'past the end' });
await call('browser_find', { query: 'local test' }, { expect: '1 match' });
const inter = await call('browser_read', { mode: 'interactive' }, { expect: 'Learn more' });

// Idle release + reconnect: the same tab id must still work.
await sleep(IDLE_MS * 3);
await call('browser_read', { tabId: home }, { expect: 'Smoke home' });

// Clicking
await call('browser_click', { text: 'Learn more' }, { expect: '/next' });
await call('browser_open', { url: `${base}/`, tabId: home }, { expect: 'Home' });
await call('browser_click', { text: 'Open in new tab' }, { expect: 'opened a new tab' });
await call('browser_read', {}, { expect: 'You followed the link' });

// Typing: replace, append, submit
await call('browser_open', { url: `${base}/`, tabId: home }, { expect: 'Home' });
let list = await call('browser_read', { mode: 'interactive' });
await call('browser_type', { ref: refOf(list, /\[(\d+)\] input text "Note"/), value: '!', append: true });
await call('browser_eval', { js: "document.getElementById('note').value" }, { expect: '"hello world!"' });
list = await call('browser_read', { mode: 'interactive' });
await call('browser_type', { ref: refOf(list, /\[(\d+)\] input text "Search"/), value: 'hello fox', submit: true }, { expect: '/result' });
await call('browser_wait', { text: 'You searched: hello fox', timeoutMs: 10000 }, { expect: 'Ready' });

// A button whose text changes keeps its ref; typing into something that is not a field is refused
await call('browser_open', { url: `${base}/`, tabId: home }, { expect: 'Home' });
list = await call('browser_read', { mode: 'interactive' });
const cnt = refOf(list, /\[(\d+)\] button "Count: 0"/);
await call('browser_click', { ref: cnt });
await call('browser_click', { ref: cnt });
await call('browser_eval', { js: "document.getElementById('cnt').textContent" }, { expect: '"Count: 2"' });
await call('browser_type', { selector: 'h1', value: 'x' }, { expectError: true, expect: 'not a text field' });
await call('browser_eval', { js: "document.getElementById('note').value" }, { expect: '"hello world"' });

// Keys and scrolling
await call('browser_open', { url: `${base}/`, tabId: home });
await call('browser_key', { key: process.platform === 'darwin' ? 'Meta+a' : 'Ctrl+a' }, { expect: 'Pressed' });
await call('browser_eval', { js: "document.getElementById('keys').textContent" }, { expect: 'combo ok' });
await call('browser_key', { key: 'Foo+a' }, { expectError: true, expect: 'Unknown modifier' });
await call('browser_scroll', { direction: 'down' }, { expect: 'Scrolled down' });
await call('browser_eval', { js: 'document.title' }, { expect: '"Home"' });
await call('browser_screenshot', {}, { expect: '<image' });

// Safety
await call('browser_open', { url: 'file:///etc/hosts' }, { expectError: true, expect: 'Blocked URL scheme' });
await call('browser_open', { url: `${base}/tamper`, tabId: home }, { expect: 'Tamper' });
list = await call('browser_read', { mode: 'interactive' });
await sleep(600);
await call('browser_click', { ref: refOf(list, /\[(\d+)\] button "Save draft"/) }, { expectError: true, expect: 'different element' });
await call('browser_eval', { js: 'document.title' }, { expect: '"Tamper"' });
await call('browser_click', { ref: 9999 }, { expectError: true });

// Search (online; content not checked) and tabs
await call('browser_search', { query: 'model context protocol', engine: 'bing' }, { expect: 'tab ' });
await call('browser_tabs', {}, { expect: '<untrusted tab list' });
void inter;

for (const id of mine) if (id) await call('browser_close', { tabId: id }, { expect: 'Closed' });

await client.close();
site.close();
console.log(failed ? `\nFAILED: ${failed}` : '\nSMOKE OK');
process.exit(failed ? 1 : 0);
