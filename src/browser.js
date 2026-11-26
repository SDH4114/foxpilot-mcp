// Connection to a running browser plus tab bookkeeping.
// Firefox and forks (Zen, LibreWolf, ...) are driven over WebDriver BiDi; Chromium browsers
// (Chrome, Helium, Brave, Edge, ...) over CDP. The engine is detected on the port, see detectEngine().
//
// Firefox allows only ONE BiDi session at a time, and a session is not released if the client
// dies without session.end. So we connect only while working, end the session after a short idle
// period (letting Claude Code and Claude Desktop take turns), and always end it on shutdown.
import puppeteer from 'puppeteer-core';
import { readConfig, isControllableUrl, validateDebuggerUrl } from './policy.js';
import { ensureBrowser } from './system.js';

export const config = readConfig();
const { port: PORT, idleMs: IDLE_MS, protocol: PROTOCOL } = config;
const BUSY_WAIT_MS = 20000;
// Upper bound for one tool call: a hung page (busy JS loop, open dialog) must not block every later call.
const CALL_TIMEOUT_MS = 90000;
// Upper bound for a single protocol command (puppeteer's default is 180 s).
const PROTOCOL_TIMEOUT_MS = 45000;

export class BrowserNotReachable extends Error {}

let browser = null;
let connecting = null; // promise of an in-flight connect
let releasing = null; // promise of an in-flight disconnect
let idleTimer = null;
let queue = Promise.resolve(); // serializes tool calls: they share the current tab and in-page state
let shuttingDown = false;

// Tab ids are short numbers mapped to browsing-context (BiDi) / target (CDP) ids.
// CDP target ids survive a reconnect; Firefox gives every tab a NEW context id in each BiDi
// session. So after a reconnect, ids whose context vanished are re-attached to tabs by URL and
// position (remapAfterReconnect), keeping "tab 3" the same tab for the agent.
const shortByContext = new Map();
const contextByShort = new Map();
const lastSeen = new Map(); // short id -> { url, index }
let nextId = 1;
let currentContext = null; // tab the agent last worked with
let currentId = null; // same tab as currentContext, by short id (survives remapping)
let needRemap = false;

export const contextOf = (page) => page.mainFrame()._id;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, sleep(ms).then(() => fallback)]);
}

/** Like withTimeout, but rejects: for calls whose result we need (page title, in-page reads). */
export function timed(promise, ms, what) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => (t = setTimeout(() => rej(new Error(`${what} did not respond within ${ms} ms`)), ms))),
  ]);
}

/**
 * Chromium answers GET /json/version with JSON containing webSocketDebuggerUrl.
 * The Firefox Remote Agent answers that path with 404, so anything else means BiDi.
 */
/**
 * Nothing listens on the port: start the default browser in AI mode (src/system.js).
 * Rejects with an explanation if it can't (e.g. the browser is open without remote debugging and
 * the user has to restart it via the "Browser (AI)" launcher).
 */
async function startBrowser() {
  try {
    await ensureBrowser({ port: PORT, mainProfile: config.mainProfile });
  } catch (err) {
    throw new BrowserNotReachable(
      err.code === 'running'
        ? `${err.message} Ask the user to do that; don't try to restart the browser yourself.`
        : `Could not start the browser automatically: ${err.message}`
    );
  }
}

async function detectEngine({ allowStart = config.autostart } = {}) {
  const bidi = { protocol: 'bidi', endpoint: `ws://127.0.0.1:${PORT}/session` };
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(3000) });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    if (timedOut) throw notReachable('the port did not answer within 3 s');
    if (!allowStart || shuttingDown) throw notReachable('nothing is listening');
    await startBrowser();
    return detectEngine({ allowStart: false });
  }
  if (PROTOCOL === 'bidi') {
    await res.body?.cancel().catch(() => {});
    return bidi;
  }
  const info = res.ok ? await res.json().catch(() => null) : (await res.body?.cancel().catch(() => {}), null);
  if (info?.webSocketDebuggerUrl) {
    // Whatever listens on the port tells us where to connect; only accept our own loopback port,
    // so a process squatting on it can't send us (and what the agent types) somewhere else.
    if (!validateDebuggerUrl(info.webSocketDebuggerUrl, PORT)) {
      throw new Error(`Refusing debugger URL ${info.webSocketDebuggerUrl}: it is not ws://127.0.0.1:${PORT}.`);
    }
    return { protocol: 'cdp', endpoint: info.webSocketDebuggerUrl };
  }
  if (PROTOCOL === 'cdp') throw new Error(`FOXPILOT_PROTOCOL=cdp, but port ${PORT} does not speak CDP.`);
  return bidi;
}

function notReachable(detail) {
  return new BrowserNotReachable(
    `Cannot reach a browser on 127.0.0.1:${PORT} (${detail}). ` +
      `Start it with remote debugging: open "Browser (AI)" from ~/Applications (made by npm run launcher), or run: ` +
      `open -a <App> --args --remote-debugging-port ${PORT}  (Firefox and forks) / ` +
      `--remote-debugging-port=${PORT}  (Chromium browsers).`
  );
}

async function connectOnce() {
  const engine = await detectEngine();
  try {
    return await puppeteer.connect({
      browserWSEndpoint: engine.endpoint,
      protocol: engine.protocol === 'bidi' ? 'webDriverBiDi' : 'cdp',
      defaultViewport: null,
      protocolTimeout: PROTOCOL_TIMEOUT_MS,
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
  if (shuttingDown) throw new Error('Shutting down.');
  if (browser?.connected) return browser;
  if (connecting) return connecting;
  connecting = (async () => {
    if (releasing) await releasing; // let a previous BiDi session finish ending first
    const deadline = Date.now() + BUSY_WAIT_MS;
    for (;;) {
      try {
        const b = await connectOnce();
        if (shuttingDown) {
          await withTimeout(b.disconnect().catch(() => {}), 3000);
          throw new Error('Shutting down.');
        }
        b.on('disconnected', () => {
          if (browser === b) browser = null;
        });
        browser = b;
        needRemap = true;
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

/**
 * Run fn with a live connection. Calls run one at a time (they share the current tab and refs);
 * the session is ended after IDLE_MS without calls.
 */
export function withBrowser(fn) {
  const run = queue.then(async () => {
    clearTimeout(idleTimer);
    let t;
    try {
      // The handler may keep running after the deadline (puppeteer calls can't be cancelled), but
      // the queue moves on and each of its protocol calls still ends after PROTOCOL_TIMEOUT_MS.
      return await Promise.race([
        fn(),
        new Promise((_, reject) => {
          t = setTimeout(() => reject(new Error(`no result after ${CALL_TIMEOUT_MS / 1000} s (the page may be frozen or showing a dialog)`)), CALL_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(t);
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => release().catch(() => {}), IDLE_MS);
    }
  });
  queue = run.catch(() => {});
  return run;
}

/** End the session. Also waits for a connect that is still in flight, so it can't leak. */
export async function release({ final = false } = {}) {
  clearTimeout(idleTimer);
  if (final) shuttingDown = true;
  // Don't let shutdown hang on a slow connect / auto-start; the in-flight connect sees
  // shuttingDown and disconnects by itself.
  if (connecting) await withTimeout(connecting.catch(() => {}), final ? 5000 : BUSY_WAIT_MS + 5000);
  const b = browser;
  browser = null;
  if (!b?.connected) return;
  releasing = withTimeout(b.disconnect().catch(() => {}), 3000);
  try {
    await releasing;
  } finally {
    releasing = null;
  }
}

function bind(ctx, id) {
  shortByContext.set(ctx, id);
  contextByShort.set(id, ctx);
}

export function idOf(page) {
  const ctx = contextOf(page);
  let id = shortByContext.get(ctx);
  if (!id) {
    id = String(nextId++);
    bind(ctx, id);
  }
  const seen = lastSeen.get(id);
  lastSeen.set(id, { url: page.url(), index: seen?.index ?? Infinity });
  return id;
}

/**
 * Pure matching used after a reconnect: give old ids (whose context is gone) to new pages with the
 * same URL. Returns [[pageIndex, id], ...] in the order of `stale`.
 * Per URL: more old ids than pages means a tab with that URL was closed and we can't tell which,
 * so none of them is re-attached (they fail with "No tab with id" instead of pointing at the wrong
 * tab). Equal counts: matched in tab order. Fewer old ids: each takes the closest free position.
 */
export function matchStaleIds(stale, pages) {
  const byUrl = new Map();
  stale.forEach(([id, seen], order) => {
    if (!byUrl.has(seen.url)) byUrl.set(seen.url, []);
    byUrl.get(seen.url).push({ id, index: seen.index, order });
  });
  const result = [];
  for (const [url, olds] of byUrl) {
    const slots = [];
    pages.forEach((p, i) => p.url === url && slots.push(i));
    if (!url || olds.length > slots.length) continue;
    const sorted = [...olds].sort((a, b) => a.index - b.index || a.order - b.order);
    if (olds.length === slots.length) {
      sorted.forEach((o, k) => result.push([slots[k], o.id, o.order]));
      continue;
    }
    const pairs = [];
    for (const o of olds) for (const i of slots) pairs.push({ o, i, d: Math.abs(i - o.index) });
    pairs.sort((a, b) => a.d - b.d || a.o.order - b.o.order || a.i - b.i);
    const usedIds = new Set();
    const usedSlots = new Set();
    for (const { o, i } of pairs) {
      if (usedIds.has(o.id) || usedSlots.has(i)) continue;
      usedIds.add(o.id);
      usedSlots.add(i);
      result.push([i, o.id, o.order]);
    }
  }
  return result.sort((a, b) => a[2] - b[2]).map(([i, id]) => [i, id]);
}

function remapAfterReconnect(pages) {
  const live = new Set(pages.map(contextOf));
  const stale = [];
  for (const [id, ctx] of contextByShort) {
    if (!live.has(ctx)) stale.push([id, lastSeen.get(id) ?? { url: '', index: Infinity }]);
  }
  if (!stale.length) return;
  const fresh = pages.map((p) => ({ url: p.url(), known: shortByContext.has(contextOf(p)) }));
  const candidates = fresh.map((f) => (f.known ? { url: null } : f));
  for (const [id] of stale) {
    shortByContext.delete(contextByShort.get(id));
    contextByShort.delete(id);
  }
  const matched = matchStaleIds(stale, candidates);
  for (const [i, id] of matched) bind(contextOf(pages[i]), id);
  const kept = new Set(matched.map(([, id]) => id));
  for (const [id] of stale) if (!kept.has(id)) lastSeen.delete(id);
  if (currentId && contextByShort.has(currentId)) currentContext = contextByShort.get(currentId);
}

export async function listPages() {
  const pages = await (await getBrowser()).pages();
  if (needRemap) {
    needRemap = false;
    remapAfterReconnect(pages);
  }
  pages.forEach((p, i) => {
    const id = shortByContext.get(contextOf(p));
    if (id) lastSeen.set(id, { url: p.url(), index: i });
  });
  return pages;
}

export async function listTabs() {
  const pages = await listPages();
  // Forget ids of tabs that no longer exist, so stale ids fail clearly instead of piling up.
  const live = new Set(pages.map(contextOf));
  for (const [ctx, id] of shortByContext) {
    if (!live.has(ctx)) {
      shortByContext.delete(ctx);
      contextByShort.delete(id);
      lastSeen.delete(id);
    }
  }
  return Promise.all(
    pages.map(async (p) => {
      const visible = await withTimeout(
        p.evaluate(() => document.visibilityState === 'visible' && document.hasFocus()).catch(() => false),
        800,
        false
      );
      const title = await withTimeout(p.title().catch(() => ''), 800, '');
      return { id: idOf(p), page: p, url: p.url(), title, visible, current: contextOf(p) === currentContext };
    })
  );
}

function assertControllable(page) {
  const url = page.url();
  if (!isControllableUrl(url, config)) {
    throw new Error(`Tab shows ${url}: only http(s) pages can be read or controlled.`);
  }
}

/**
 * Resolve the tab to act on: explicit id, else last used, else the focused one, else the first.
 * Refuses tabs on file:, chrome:, about: (except about:blank) pages unless anyScheme is set.
 */
export async function getPage(tabId, { anyScheme = false } = {}) {
  const pages = await listPages();
  const byContext = (ctx) => pages.find((p) => contextOf(p) === ctx);
  let page;
  if (tabId != null) {
    page = byContext(contextByShort.get(String(tabId)));
    if (!page) throw new Error(`No tab with id ${tabId}. Call browser_tabs to see current tabs.`);
  } else {
    page = currentContext && byContext(currentContext);
    if (!page) {
      const tabs = await listTabs();
      const ok = (t) => isControllableUrl(t.url, config);
      page = (tabs.find((t) => t.visible && ok(t)) || tabs.find(ok) || tabs[0])?.page;
      if (!page) page = await (await getBrowser()).newPage();
    }
  }
  if (!anyScheme) assertControllable(page);
  setCurrent(page);
  return page;
}

export async function newTab() {
  const page = await (await getBrowser()).newPage();
  setCurrent(page);
  return page;
}

/** Short ids that currently point at a tab (for pruning per-tab state elsewhere). */
export function knownIds() {
  return new Set(contextByShort.keys());
}

export function setCurrent(page) {
  currentContext = contextOf(page);
  currentId = idOf(page);
}

/**
 * Show the tab before acting on it: Chromium throttles background tabs and synthetic input to a
 * background tab can hang; the user also sees what the agent does.
 */
export async function toFront(page) {
  await withTimeout(page.bringToFront().catch(() => {}), 2000);
}

/**
 * After an action that may navigate: wait briefly for a navigation to start (URL change or
 * document no longer complete), then wait for load. Bounded, so a click that does nothing is cheap;
 * a server slower than ~1.5 s to start responding is reported as "no navigation".
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
