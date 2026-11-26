// Pure helpers: configuration, URL policy, key parsing, and handling of untrusted page content.
// No browser access here, so everything is unit-testable.
import { randomBytes } from 'node:crypto';

/** Read and validate FOXPILOT_* settings. Throws with a clear message on bad values. */
export function readConfig(env = process.env) {
  const int = (name, def, min, max) => {
    const raw = env[name];
    if (raw == null || raw === '') return def;
    const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer ${min}..${max}, got "${raw}"`);
    return n;
  };
  // "0"/"1" only: FOXPILOT_AUTOSTART=false must not silently mean "on".
  const flag = (name, def) => {
    const raw = env[name];
    if (raw == null || raw === '') return def;
    if (raw === '0' || raw === '1') return raw === '1';
    throw new Error(`${name} must be 0 or 1, got "${raw}"`);
  };
  const protocol = (env.FOXPILOT_PROTOCOL || 'auto').toLowerCase();
  if (!['auto', 'bidi', 'cdp'].includes(protocol)) {
    throw new Error(`FOXPILOT_PROTOCOL must be auto, bidi or cdp, got "${env.FOXPILOT_PROTOCOL}"`);
  }
  return {
    port: int('FOXPILOT_PORT', 9222, 1, 65535),
    idleMs: int('FOXPILOT_IDLE_MS', 8000, 10, 3_600_000),
    protocol,
    allowFile: flag('FOXPILOT_ALLOW_FILE', false),
    autostart: flag('FOXPILOT_AUTOSTART', true),
    mainProfile: flag('FOXPILOT_MAIN_PROFILE', false),
  };
}

/** "x:..." is a scheme unless it is host:port, a dotted host ("a.com:8080"), or user:pass@host. */
function hasScheme(raw) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return true;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) return false;
  const head = raw.split(/[/?#]/)[0];
  const scheme = head.split(':')[0].toLowerCase();
  if (/^(mailto|javascript|data|file|about|blob|view-source|chrome|edge|brave|moz-extension|chrome-extension|resource|tel|sms|ws|wss|ftp)$/.test(scheme)) return true;
  return !/^[^:]+:\d+$/.test(head) && !scheme.includes('.') && !head.includes('@');
}

/**
 * Normalize a URL the agent wants to open. Adds https:// to bare hosts ("example.com/x").
 * Only http(s) and about:blank are allowed (file: with allowFile): a prompt-injected agent must not
 * be able to read local files or privileged browser pages (chrome://, about:config) through us.
 */
export function normalizeUrl(input, { allowFile = false } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('URL is empty.');
  if (raw === 'about:blank') return raw;
  let url;
  try {
    url = new URL(hasScheme(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  if (url.protocol === 'file:' && allowFile) return url.href;
  throw new Error(
    `Blocked URL scheme "${url.protocol}". Only http(s) pages can be opened` +
      (url.protocol === 'file:' ? ' (set FOXPILOT_ALLOW_FILE=1 to allow local files).' : '.')
  );
}

/** Whether the agent may read or act on a tab showing this URL. */
export function isControllableUrl(url, { allowFile = false } = {}) {
  if (url === 'about:blank') return true;
  try {
    const p = new URL(url).protocol;
    return p === 'http:' || p === 'https:' || (allowFile && p === 'file:');
  } catch {
    return false;
  }
}

const MODIFIERS = {
  ctrl: 'Control', control: 'Control',
  cmd: 'Meta', command: 'Meta', meta: 'Meta', super: 'Meta', win: 'Meta',
  alt: 'Alt', option: 'Alt', opt: 'Alt',
  shift: 'Shift',
};

/**
 * Parse "Ctrl+Shift+a", "Meta+a", "+", "Control++", "Enter" into { modifiers, key }.
 * A trailing "+" (or a lone "+") is the plus key itself.
 */
export function parseKeyCombo(combo) {
  const s = String(combo ?? '');
  if (!s) throw new Error('Key is empty.');
  if (s === '+') return { modifiers: [], key: '+' };
  const parts = s.endsWith('++') ? [...s.slice(0, -2).split('+'), '+'] : s.split('+');
  if (parts.some((p) => p === '')) throw new Error(`Bad key combo "${s}". Use e.g. "Enter", "Control+a", "Meta+Shift+t".`);
  const key = parts.pop();
  const modifiers = parts.map((m) => {
    const name = MODIFIERS[m.toLowerCase()];
    if (!name) throw new Error(`Unknown modifier "${m}" in "${s}". Use Control/Ctrl, Meta/Cmd, Alt/Option, Shift.`);
    return name;
  });
  const lower = key.toLowerCase();
  if (key.length > 1 && MODIFIERS[lower]) return { modifiers, key: MODIFIERS[lower] };
  // Puppeteer key names are case-sensitive ("Enter", not "enter").
  return { modifiers, key: key.length > 1 ? (KEY_NAMES[lower] ?? key) : key };
}

const KEY_NAMES = Object.fromEntries(
  [
    'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'CapsLock',
    ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  ].map((k) => [k.toLowerCase(), k]).concat([
    ['esc', 'Escape'], ['del', 'Delete'], ['return', 'Enter'], ['up', 'ArrowUp'], ['down', 'ArrowDown'],
    ['left', 'ArrowLeft'], ['right', 'ArrowRight'], ['plus', '+'],
  ])
);

// Invisible characters can hide or reorder text shown to the agent: zero-width and bidi controls,
// word joiner and invisible operators, soft hyphen, Arabic letter mark, Mongolian vowel separator,
// deprecated format controls, BOM, and Unicode "tag" characters (U+E0000–E007F, used to smuggle
// invisible instructions).
const CONTROL_CHARS = /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\u{E0000}-\u{E007F}]/gu;

export function cleanText(s) {
  return String(s ?? '').replace(CONTROL_CHARS, '');
}

/**
 * Wrap page-derived content in markers with a random id the page cannot predict, so it can't fake
 * the end of the block or the tool's own output. The agent is told (tool descriptions) that what is
 * inside is untrusted data, never instructions.
 */
export function wrapUntrusted(content, label = 'page content') {
  const id = randomBytes(6).toString('hex');
  const body = cleanText(content);
  return `<untrusted ${label} id=${id}>\n${body}\n</untrusted id=${id}>`;
}

/** A short, single-line, quoted rendering of a page-controlled string (title, URL). */
export function quoteUntrusted(s, max = 120) {
  let t = cleanText(s).replace(/\s+/g, ' ').trim();
  const chars = [...t]; // code points, so an emoji is never cut in half
  if (chars.length > max) t = chars.slice(0, max).join('') + '…';
  return JSON.stringify(t);
}

/** Accept a CDP debugger URL only if it points back at the loopback port we probed. */
export function validateDebuggerUrl(wsUrl, port) {
  let u;
  try {
    u = new URL(wsUrl);
  } catch {
    return false;
  }
  return u.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && Number(u.port) === port;
}
