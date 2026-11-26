// Connection to a running browser plus tab bookkeeping.
// Firefox and forks (Zen, LibreWolf, ...) are driven over WebDriver BiDi; Chromium browsers
// (Chrome, Helium, Brave, Edge, ...) over CDP. The engine is detected on the port, see detectEngine().
//
// Firefox allows only ONE BiDi session at a time, and a session is not released if the client
// dies without session.end. So we connect only while working, end the session after a short idle
// period (letting Claude Code and Claude Desktop take turns), and always end it on shutdown.
import puppeteer from 'puppeteer-core';

export const PORT = Number(process.env.FOXPILOT_PORT || 9222);
const PROTOCOL = (process.env.FOXPILOT_PROTOCOL || 'auto').toLowerCase(); // auto | bidi | cdp
const IDLE_MS = Number(process.env.FOXPILOT_IDLE_MS || 8000);
const BUSY_WAIT_MS = 20000;

export class BrowserNotReachable extends Error {}

let browser = null;
let connecting = null;
let idleTimer = null;
let busy = 0;

// Tab ids are short numbers mapped to browsing-context / target ids, which stay stable across
// reconnects, so "tab 3" means the same tab for the whole MCP server lifetime.
const shortByContext = new Map();
const contextByShort = new Map();
let nextId = 1;
let currentContext = null; // tab the agent last worked with

const contextOf = (page) => page.mainFrame()._id;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, sleep(ms).then(() => fallback)]);
}

/**
 * Chromium answers GET /json/version with JSON containing webSocketDebuggerUrl.
 * The Firefox Remote Agent answers that path with 404, so anything else means BiDi.
 * Returns { protocol: 'cdp', endpoint } | { protocol: 'bidi', endpoint } | null (nothing listening).
 */
async function detectEngine() {
  const bidi = { protocol: 'bidi', endpoint: `ws://127.0.0.1:${PORT}/session` };
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(2000) });
  } catch {
    return null;
  }
  if (PROTOCOL === 'bidi') return bidi;
  const info = res.ok ? await res.json().catch(() => null) : null;
  if (info?.webSocketDebuggerUrl) return { protocol: 'cdp', endpoint: info.webSocketDebuggerUrl, name: info.Browser };
  if (PROTOCOL === 'cdp') throw new Error(`FOXPILOT_PROTOCOL=cdp, but port ${PORT} does not speak CDP.`);
  return bidi;
}

function notReachable(detail) {
  return new BrowserNotReachable(
    `Cannot reach a browser on 127.0.0.1:${PORT} (${detail}). ` +
      `Start it with remote debugging: quit it and open the foxpilot launcher ` +
      `("<Browser> (AI)" in ~/Applications, made by npm run launcher -- <App name>), or run: ` +
      `open -a <App> --args --remote-debugging-port ${PORT}  (Firefox and forks) / ` +
      `--remote-debugging-port=${PORT}  (Chromium browsers).`
  );
}

async function connectOnce() {
  const engine = await detectEngine();
  if (!engine) throw notReachable('nothing is listening');
  try {
    return await puppeteer.connect({
      browserWSEndpoint: engine.endpoint,
      protocol: engine.protocol === 'bidi' ? 'webDriverBiDi' : 'cdp',
      defaultViewport: null,
    });
  } catch (err) {
    if (/Maximum number of active sessions/i.test(err.message)) {
      err.busy = true;
      throw err;
    }
    throw notReachable(err.message.split('\n')[0]);
  }
}

async function getBrowser() {
  if (browser?.connected) return browser;
  if (connecting) return connecting;
  connecting = (async () => {
    const deadline = Date.now() + BUSY_WAIT_MS;
    for (;;) {
      try {
        const b = await connectOnce();
        b.on('disconnected', () => {
          if (browser === b) browser = null;
        });
        browser = b;
        return b;
      } catch (err) {
        if (!err.busy) throw err;
        if (Date.now() > deadline) {
          throw new Error(
            'The browser is being controlled by another client (another Claude Code / Claude Desktop session). ' +
              'Try again in a few seconds. If it stays stuck, a previous client crashed: restart the browser.'
          );
        }
        await sleep(1000);
      }
    }
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

/** Run fn with a live connection; the session is ended after IDLE_MS without calls. */
export async function withBrowser(fn) {
  clearTimeout(idleTimer);
  busy++;
  try {
    return await fn();
  } finally {
    busy--;
    if (busy === 0) idleTimer = setTimeout(release, IDLE_MS);
  }
}

export async function release() {
  clearTimeout(idleTimer);
  const b = browser;
  browser = null;
  if (b?.connected) await withTimeout(b.disconnect().catch(() => {}), 3000);
}

export function idOf(page) {
  const ctx = contextOf(page);
  let id = shortByContext.get(ctx);
  if (!id) {
    id = String(nextId++);
    shortByContext.set(ctx, id);
    contextByShort.set(id, ctx);
  }
  return id;
}

export async function listTabs() {
  const pages = await (await getBrowser()).pages();
  return Promise.all(
    pages.map(async (p) => {
      const visible = await withTimeout(
        p.evaluate(() => document.visibilityState === 'visible').catch(() => false),
        800,
        false
      );
      const title = await withTimeout(p.title().catch(() => ''), 800, '');
      return { id: idOf(p), page: p, url: p.url(), title, visible, current: contextOf(p) === currentContext };
    })
  );
}

/** Resolve the tab to act on: explicit id, else last used, else the visible one, else first. */
export async function getPage(tabId) {
  const b = await getBrowser();
  const pages = await b.pages();
  const byContext = (ctx) => pages.find((p) => contextOf(p) === ctx);
  let page;
  if (tabId != null) {
    page = byContext(contextByShort.get(String(tabId)));
    if (!page) throw new Error(`No tab with id ${tabId}. Call browser_tabs to see current tabs.`);
  } else {
    page = currentContext && byContext(currentContext);
    if (!page) {
      const tabs = await listTabs();
      page = (tabs.find((t) => t.visible) || tabs[0])?.page || (await b.newPage());
    }
  }
  currentContext = contextOf(page);
  idOf(page);
  return page;
}

export async function newTab() {
  const page = await (await getBrowser()).newPage();
  currentContext = contextOf(page);
  idOf(page);
  return page;
}

/**
 * After an action that may navigate: wait briefly for a navigation to start (URL change or
 * document no longer complete), then wait for load. Bounded, so a click that does nothing is cheap.
 */
export async function settle(page, beforeUrl, ms = 8000) {
  const state = () =>
    withTimeout(page.evaluate(() => document.readyState).catch(() => 'loading'), 1000, 'loading');
  const startBy = Date.now() + 1500;
  while (Date.now() < startBy) {
    if (page.url() !== beforeUrl || (await state()) !== 'complete') break;
    await sleep(100);
  }
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await state()) === 'complete') return;
    await sleep(200);
  }
}
