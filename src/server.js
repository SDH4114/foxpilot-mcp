#!/usr/bin/env node
// foxpilot-mcp: MCP server (stdio) exposing tools that drive the user's running Firefox (or a Firefox fork such as Zen).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getPage, listTabs, newTab, settle, idOf, withBrowser, release, BrowserNotReachable } from './firefox.js';
import { readText, readInteractive, findText, resolveTarget } from './page.js';

const server = new McpServer({ name: 'foxpilot', version: '0.1.0' });

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

/** Wrap a handler: uniform error text, and a short "where am I" footer after actions. */
function tool(name, description, inputSchema, handler, { readOnly = false } = {}) {
  server.registerTool(
    name,
    { description, inputSchema, annotations: { readOnlyHint: readOnly, openWorldHint: true } },
    async (args) => {
      try {
        return await withBrowser(() => handler(args));
      } catch (err) {
        if (err instanceof BrowserNotReachable) return fail(err.message);
        return fail(`${name} failed: ${err.message}`);
      }
    }
  );
}

async function where(page) {
  const title = await page.title().catch(() => '');
  return `tab ${idOf(page)}: ${title} — ${page.url()}`;
}

const tabId = z.string().optional().describe('Tab id from firefox_tabs. Default: the tab last used, else the visible one.');
const target = {
  ref: z.number().int().optional().describe('Element ref from firefox_read mode=interactive'),
  selector: z.string().optional().describe('CSS selector'),
  text: z.string().optional().describe('Visible text of a link/button to click'),
};

tool('firefox_tabs', 'List open tabs in the user\'s Firefox browser (id, title, url; * = visible, > = current target).', {},
  async () => {
    const tabs = await listTabs();
    if (!tabs.length) return text('No tabs.');
    return text(tabs.map((t) => `${t.current ? '>' : ' '}${t.visible ? '*' : ' '} [${t.id}] ${t.title || '(no title)'} — ${t.url}`).join('\n'));
  }, { readOnly: true });

tool('firefox_open', 'Open a URL in the user\'s Firefox browser. Opens a new tab unless tabId is given (then navigates that tab).',
  { url: z.string().describe('Full URL, e.g. https://example.com'), tabId },
  async ({ url, tabId }) => {
    const page = tabId ? await getPage(tabId) : await newTab();
    if (!tabId) await page.bringToFront().catch(() => {});
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    } catch (err) {
      if (!/timeout/i.test(err.message)) throw err;
    }
    return text(`Opened. ${await where(page)}`);
  });

const engines = {
  google: 'https://www.google.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  bing: 'https://www.bing.com/search?q=',
};
tool('firefox_search', 'Web search in a new tab of the user\'s Firefox browser; returns the result page text.',
  { query: z.string(), engine: z.enum(['google', 'duckduckgo', 'bing']).optional().describe('Default: google') },
  async ({ query, engine = 'google' }) => {
    const page = await newTab();
    await page.bringToFront().catch(() => {});
    await page.goto(engines[engine] + encodeURIComponent(query), { waitUntil: 'load', timeout: 30000 }).catch(() => {});
    return text(`${await where(page)}\n\n${await readText(page, { max: 8000 })}`);
  });

tool('firefox_read', 'Read the page. mode=text: visible text (paged by offset). mode=interactive: numbered list of links, buttons and fields; use the numbers as ref in firefox_click/firefox_type.',
  {
    tabId,
    mode: z.enum(['text', 'interactive']).optional().describe('Default: text'),
    offset: z.number().int().min(0).optional().describe('Text offset for long pages'),
  },
  async ({ tabId, mode = 'text', offset = 0 }) => {
    const page = await getPage(tabId);
    const body = mode === 'interactive' ? await readInteractive(page) : await readText(page, { offset });
    return text(`${await where(page)}\n\n${body}`);
  }, { readOnly: true });

tool('firefox_find', 'Find text on the current page; returns matching lines with context.',
  { query: z.string(), tabId },
  async ({ query, tabId }) => {
    const page = await getPage(tabId);
    return text(await findText(page, query));
  }, { readOnly: true });

tool('firefox_click', 'Click an element by ref (from firefox_read interactive), CSS selector, or visible text.',
  { ...target, tabId },
  async ({ tabId, ...t }) => {
    const page = await getPage(tabId);
    const sel = await resolveTarget(page, t);
    const before = page.url();
    await page.click(sel);
    await settle(page, before);
    return text(`Clicked. ${await where(page)}`);
  });

tool('firefox_type', 'Type into a field (by ref or selector). Replaces existing value unless append=true. submit=true presses Enter after.',
  {
    ref: target.ref, selector: target.selector, tabId,
    value: z.string().describe('Text to type'),
    append: z.boolean().optional(),
    submit: z.boolean().optional(),
  },
  async ({ ref, selector, tabId, value, append, submit }) => {
    const page = await getPage(tabId);
    const sel = await resolveTarget(page, { ref, selector });
    if (!append) {
      await page.$eval(sel, (el) => {
        if ('value' in el) el.value = '';
        else if (el.isContentEditable) el.textContent = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    await page.click(sel);
    await page.type(sel, value);
    if (submit) {
      const before = page.url();
      await page.keyboard.press('Enter');
      await settle(page, before);
    }
    return text(`Typed${submit ? ' and submitted' : ''}. ${await where(page)}`);
  });

tool('firefox_key', 'Press a key or combo in the page, e.g. "Enter", "Escape", "Tab", "ArrowDown", "Meta+a".',
  { key: z.string(), tabId },
  async ({ key, tabId }) => {
    const page = await getPage(tabId);
    const before = page.url();
    const parts = key.split('+');
    const main = parts.pop();
    for (const m of parts) await page.keyboard.down(m);
    await page.keyboard.press(main);
    for (const m of parts.reverse()) await page.keyboard.up(m);
    await settle(page, before, 3000);
    return text(`Pressed ${key}. ${await where(page)}`);
  });

tool('firefox_scroll', 'Scroll the page.',
  { direction: z.enum(['down', 'up', 'top', 'bottom']), tabId },
  async ({ direction, tabId }) => {
    const page = await getPage(tabId);
    const pos = await page.evaluate((d) => {
      const h = window.innerHeight * 0.85;
      if (d === 'down') window.scrollBy(0, h);
      else if (d === 'up') window.scrollBy(0, -h);
      else if (d === 'top') window.scrollTo(0, 0);
      else window.scrollTo(0, document.documentElement.scrollHeight);
      return `${Math.round(window.scrollY)}/${document.documentElement.scrollHeight}`;
    }, direction);
    return text(`Scrolled ${direction}, position ${pos}.`);
  });

tool('firefox_screenshot', 'Screenshot of the tab (PNG). Use only when the visual layout matters; prefer firefox_read.',
  { tabId, fullPage: z.boolean().optional() },
  async ({ tabId, fullPage = false }) => {
    const page = await getPage(tabId);
    const data = await page.screenshot({ encoding: 'base64', fullPage });
    return { content: [{ type: 'image', data, mimeType: 'image/png' }, { type: 'text', text: await where(page) }] };
  }, { readOnly: true });

tool('firefox_wait', 'Wait until a selector or text appears on the page.',
  { selector: z.string().optional(), text: z.string().optional(), timeoutMs: z.number().int().optional().describe('Default 10000'), tabId },
  async ({ selector, text: t, timeoutMs = 10000, tabId }) => {
    const page = await getPage(tabId);
    if (selector) await page.waitForSelector(selector, { timeout: timeoutMs });
    else if (t) await page.waitForFunction((q) => document.body?.innerText.includes(q), { timeout: timeoutMs }, t);
    else await new Promise((r) => setTimeout(r, Math.min(timeoutMs, 30000)));
    return text(`Ready. ${await where(page)}`);
  }, { readOnly: true });

tool('firefox_eval', 'Run a JavaScript expression in the page and return the JSON result. Fallback when other tools are not enough.',
  { js: z.string().describe('Expression or IIFE, e.g. "document.title" or "(() => [...document.links].length)()"'), tabId },
  async ({ js, tabId }) => {
    const page = await getPage(tabId);
    const result = await page.evaluate(js);
    const out = JSON.stringify(result, null, 2) ?? 'undefined';
    return text(out.length > 20000 ? out.slice(0, 20000) + '\n[...truncated]' : out);
  });

tool('firefox_close', 'Close a tab. Only close tabs you opened, unless the user asked.',
  { tabId: z.string() },
  async ({ tabId }) => {
    const page = await getPage(tabId);
    await page.close();
    return text(`Closed tab ${tabId}.`);
  });

// End the BiDi session on any shutdown path, otherwise Firefox keeps it and refuses new clients.
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await release();
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, shutdown);
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);

await server.connect(new StdioServerTransport());
