// End-to-end check: starts the MCP server over stdio and calls every tool against a running browser.
// Needs Firefox/Zen listening on FOXPILOT_PORT (default 9222). Run: npm run smoke
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: process.execPath, args: ['src/server.js'], env: { ...process.env } });
const client = new Client({ name: 'smoke', version: '0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));

let failed = 0;
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const out = r.content.map((c) => (c.type === 'text' ? c.text : `<${c.type} ${c.data.length}b>`)).join(' | ');
  console.log(`\n## ${name} ${JSON.stringify(args)}${r.isError ? '  [ERROR]' : ''}\n${out.slice(0, 600)}`);
  if (r.isError) failed++;
  return out;
}

await call('firefox_open', { url: 'https://example.com' });
await call('firefox_read');
await call('firefox_find', { query: 'domain' });
await call('firefox_read', { mode: 'interactive' });
await call('firefox_click', { text: 'Learn more' });
await call('firefox_open', { url: 'https://html.duckduckgo.com/html/' });
const inter = await call('firefox_read', { mode: 'interactive' });
const ref = Number(/\[(\d+)\] input (text|search)/.exec(inter)?.[1]);
await call('firefox_type', { ref, value: 'webdriver bidi', submit: true });
await call('firefox_wait', { text: 'BiDi', timeoutMs: 15000 });
await call('firefox_scroll', { direction: 'down' });
await call('firefox_key', { key: 'Escape' });
await call('firefox_eval', { js: 'document.title' });
await call('firefox_screenshot');
await call('firefox_search', { query: 'firefox webdriver bidi', engine: 'duckduckgo' });
const tabs = await call('firefox_tabs');
const last = /\[(\d+)\][^\n]*$/.exec(tabs)?.[1];
await call('firefox_close', { tabId: last });
await call('firefox_tabs');
await call('firefox_click', { ref: 9999 }); // expected error
failed--; // the line above is supposed to fail
await client.close();
console.log(failed ? `\nFAILED: ${failed}` : '\nSMOKE OK');
process.exit(failed ? 1 : 0);
