// Functions that run inside the page (serialized by puppeteer), plus thin wrappers.

/** Visible text of the page, collapsed, with a window [offset, offset+max). */
export async function readText(page, { offset = 0, max = 15000 } = {}) {
  const text = await page.evaluate(() => {
    const t = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    return t;
  });
  const slice = text.slice(offset, offset + max);
  const rest = text.length - (offset + slice.length);
  const tail = rest > 0 ? `\n\n[...${rest} more chars, call again with offset=${offset + slice.length}]` : '';
  return slice + tail;
}

/**
 * List interactive elements and tag each with data-foxpilot-ref so later calls can target it.
 * Refs are renumbered on every call, so always use refs from the latest firefox_read.
 */
export async function readInteractive(page, { max = 250 } = {}) {
  return page.evaluate((max) => {
    const sel = [
      'a[href]', 'button', 'input:not([type=hidden])', 'textarea', 'select', 'summary',
      '[role=button]', '[role=link]', '[role=tab]', '[role=menuitem]', '[role=checkbox]',
      '[role=textbox]', '[role=combobox]', '[contenteditable=""]', '[contenteditable=true]',
    ].join(',');
    document.querySelectorAll('[data-foxpilot-ref]').forEach((el) => el.removeAttribute('data-foxpilot-ref'));
    const out = [];
    let n = 0;
    const clip = (s, k = 80) => {
      s = (s || '').replace(/\s+/g, ' ').trim();
      return s.length > k ? s.slice(0, k) + '…' : s;
    };
    const vh = window.innerHeight;
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (r.width < 1 || r.height < 1 || style.visibility === 'hidden' || style.display === 'none') continue;
      if (el.disabled) continue;
      n += 1;
      el.setAttribute('data-foxpilot-ref', String(n));
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role');
      const name = clip(el.getAttribute('aria-label') || el.innerText || el.value || el.title || el.alt);
      let desc;
      if (tag === 'a') desc = `link "${name}" -> ${clip(el.getAttribute('href'), 100)}`;
      else if (tag === 'input' || tag === 'textarea') {
        const type = el.getAttribute('type') || (tag === 'textarea' ? 'textarea' : 'text');
        const ph = clip(el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.name, 50);
        const val = type === 'password' ? (el.value ? '***' : '') : clip(el.value, 50);
        const checked = ['checkbox', 'radio'].includes(type) ? (el.checked ? ' [x]' : ' [ ]') : '';
        desc = `input ${type}${checked}${ph ? ` "${ph}"` : ''}${val ? ` value="${val}"` : ''}`;
      } else if (tag === 'select') {
        const opts = [...el.options].slice(0, 15).map((o) => clip(o.text, 30));
        desc = `select "${clip(el.name || el.getAttribute('aria-label'), 40)}" = "${clip(el.selectedOptions[0]?.text, 30)}" options: ${opts.join(' | ')}`;
      } else desc = `${role || tag} "${name}"`;
      const offscreen = r.bottom < 0 || r.top > vh ? ' (offscreen)' : '';
      out.push(`[${n}] ${desc}${offscreen}`);
      if (n >= max) {
        out.push(`[...more elements omitted, max=${max}]`);
        break;
      }
    }
    return out.join('\n') || '(no interactive elements found)';
  }, max);
}

/** Lines of page text containing the query (case-insensitive), with a little context. */
export async function findText(page, query, { max = 30 } = {}) {
  return page.evaluate(
    (query, max) => {
      const lines = (document.body?.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean);
      const q = query.toLowerCase();
      const hits = [];
      lines.forEach((l, i) => {
        if (hits.length < max && l.toLowerCase().includes(q)) {
          const ctx = [lines[i - 1], `>> ${l}`, lines[i + 1]].filter(Boolean).join('\n   ');
          hits.push(ctx.length > 400 ? ctx.slice(0, 400) + '…' : ctx);
        }
      });
      return hits.length ? `${hits.length} match(es):\n- ${hits.join('\n- ')}` : `No matches for "${query}".`;
    },
    query,
    max
  );
}

/**
 * Turn {ref | selector | text} into a CSS selector that matches exactly one element.
 * For text, finds the smallest visible clickable-ish element whose text contains it and tags it.
 */
export async function resolveTarget(page, { ref, selector, text }) {
  if (ref != null) {
    const s = `[data-foxpilot-ref="${ref}"]`;
    if (!(await page.$(s))) throw new Error(`Ref ${ref} not found (page changed?). Call firefox_read mode=interactive again.`);
    return s;
  }
  if (selector) {
    if (!(await page.$(selector))) throw new Error(`Selector not found: ${selector}`);
    return selector;
  }
  if (text) {
    const ok = await page.evaluate((text) => {
      const q = text.toLowerCase().trim();
      const cand = [...document.querySelectorAll(
        'a,button,input[type=submit],input[type=button],summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[onclick]'
      )];
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      };
      const label = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase();
      const matches = cand.filter((el) => visible(el) && label(el).includes(q));
      matches.sort((a, b) => (label(a) === q ? -1 : 0) - (label(b) === q ? -1 : 0) || label(a).length - label(b).length);
      const el = matches[0];
      if (!el) return false;
      document.querySelectorAll('[data-foxpilot-target]').forEach((e) => e.removeAttribute('data-foxpilot-target'));
      el.setAttribute('data-foxpilot-target', '1');
      return true;
    }, text);
    if (!ok) throw new Error(`No visible clickable element with text "${text}".`);
    return '[data-foxpilot-target="1"]';
  }
  throw new Error('Give one of: ref, selector, text.');
}
