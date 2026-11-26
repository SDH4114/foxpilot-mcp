// Functions that run inside the page (serialized by puppeteer), plus thin wrappers.
// Functions passed to page.evaluate run in the page, so they can't use closures from this module;
// the little "signature" helper is therefore repeated in readInteractive and resolveTarget.
// Limitation: elements inside iframes and shadow roots are not listed or targeted.

/** Visible text of the page, collapsed, with a window [offset, offset+max). */
export async function readText(page, { offset = 0, max = 15000 } = {}) {
  const text = await page.evaluate(() => (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim());
  if (offset > 0 && offset >= text.length) return `[offset ${offset} is past the end; the text has ${text.length} chars]`;
  const slice = text.slice(offset, offset + max);
  const rest = text.length - (offset + slice.length);
  const tail = rest > 0 ? `\n\n[...${rest} more chars, call again with offset=${offset + slice.length}]` : '';
  return slice + tail;
}

/**
 * List interactive elements and tag each with data-foxpilot-ref so later calls can target it.
 * Returns { text, sigs }: sigs[n-1] is a signature (tag, role, label) of ref n. The server keeps it
 * and resolveTarget checks it, so a page script that moves the ref attribute to another element
 * makes the click fail instead of hitting the wrong thing. Refs are renumbered on every call.
 */
export async function readInteractive(page, { max = 250 } = {}) {
  return page.evaluate((max) => {
    const sel = [
      'a[href]', 'button', 'input:not([type=hidden])', 'textarea', 'select', 'summary',
      '[role=button]', '[role=link]', '[role=tab]', '[role=menuitem]', '[role=checkbox]',
      '[role=textbox]', '[role=combobox]', '[contenteditable=""]', '[contenteditable=true]',
    ].join(',');
    const clip = (s, k = 80) => {
      s = (s || '').replace(/\s+/g, ' ').trim();
      return s.length > k ? s.slice(0, k) + '…' : s;
    };
    // Fields are identified without their content (it changes as the agent types), and digits are
    // ignored (counters, timers), so the signature stays stable while the element is the same.
    const sigOf = (el) => {
      const label = el.matches('input,textarea,select,[role=textbox],[role=combobox]') || el.isContentEditable
        ? el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || el.title || ''
        : el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.name || el.title || el.alt || '';
      return [el.tagName.toLowerCase(), el.getAttribute('role') || '', el.getAttribute('type') || '', label.replace(/\s+/g, ' ').trim().replace(/\d+/g, '#').slice(0, 80)].join('|');
    };
    const sensitive = (el, type) =>
      type === 'password' ||
      /^(current-password|new-password|one-time-code)$|^cc-/.test(el.getAttribute('autocomplete') || '') ||
      /pass|otp|one.?time|cvc|cvv|card.?num|secret|token/i.test(`${el.name || ''} ${el.id || ''}`);

    document.querySelectorAll('[data-foxpilot-ref]').forEach((el) => el.removeAttribute('data-foxpilot-ref'));
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return r.width >= 1 && r.height >= 1 && style.visibility !== 'hidden' && style.display !== 'none' && !el.disabled;
    };
    const all = [...document.querySelectorAll(sel)].filter(visible);
    const out = [];
    const sigs = [];
    const vh = window.innerHeight;
    all.slice(0, max).forEach((el, i) => {
      const n = i + 1;
      el.setAttribute('data-foxpilot-ref', String(n));
      sigs.push(sigOf(el));
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role');
      const shown = clip(el.innerText || el.value || el.title || el.alt);
      const aria = clip(el.getAttribute('aria-label'));
      // Show both when they differ: a button reading "Delete account" with aria-label "Cancel"
      // must not be presented to the agent as "Cancel".
      const name = aria && shown && aria !== shown ? `${shown}" (aria-label "${aria}")` : `${aria || shown}"`;
      let desc;
      if (tag === 'a') desc = `link "${name} -> ${clip(el.getAttribute('href'), 100)}`;
      else if (tag === 'input' || tag === 'textarea') {
        const type = el.getAttribute('type') || (tag === 'textarea' ? 'textarea' : 'text');
        const ph = clip(el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.name, 50);
        const val = sensitive(el, type) ? (el.value ? '***' : '') : clip(el.value, 50);
        const checked = ['checkbox', 'radio'].includes(type) ? (el.checked ? ' [x]' : ' [ ]') : '';
        desc = `input ${type}${checked}${ph ? ` "${ph}"` : ''}${val ? ` value="${val}"` : ''}`;
      } else if (tag === 'select') {
        const opts = [...el.options].slice(0, 15).map((o) => clip(o.text, 30));
        desc = `select "${clip(el.name || el.getAttribute('aria-label'), 40)}" = "${clip(el.selectedOptions[0]?.text, 30)}" options: ${opts.join(' | ')}`;
      } else desc = `${role || tag} "${name}`;
      const r = el.getBoundingClientRect();
      const offscreen = r.bottom < 0 || r.top > vh ? ' (offscreen)' : '';
      out.push(`[${n}] ${desc}${offscreen}`);
    });
    if (all.length > max) out.push(`[...${all.length - max} more elements omitted, max=${max}]`);
    return { text: out.join('\n') || '(no interactive elements found)', sigs };
  }, max);
}

/** Lines of page text containing the query (case-insensitive), with a little context. */
export async function findText(page, query, { max = 30 } = {}) {
  if (!String(query ?? '').trim()) throw new Error('Query is empty.');
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
 * Resolve {ref | selector | text} to an element handle. Returns { handle, note }.
 * - ref: must match exactly one element and still have the signature recorded at read time (sigs).
 * - selector: first match; note says how many matched.
 * - text: smallest visible clickable element whose label contains the text; note on ambiguity.
 */
export async function resolveTarget(page, { ref, selector, text }, { sigs } = {}) {
  let handle;
  let note = '';
  if (ref != null) {
    if (!sigs) throw new Error(`Unknown ref ${ref}: call browser_read mode=interactive first.`);
    handle = await page.evaluateHandle(
      (ref, expected) => {
        const els = document.querySelectorAll(`[data-foxpilot-ref="${ref}"]`);
        if (els.length === 0) return `Ref ${ref} not found (page changed?). Call browser_read mode=interactive again.`;
        if (els.length > 1) return `Ref ${ref} matches ${els.length} elements; the page may be tampering. Re-read the page.`;
        const el = els[0];
        // Same as sigOf in readInteractive.
        const label = el.matches('input,textarea,select,[role=textbox],[role=combobox]') || el.isContentEditable
          ? el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || el.title || ''
          : el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.name || el.title || el.alt || '';
        const sig = [el.tagName.toLowerCase(), el.getAttribute('role') || '', el.getAttribute('type') || '', label.replace(/\s+/g, ' ').trim().replace(/\d+/g, '#').slice(0, 80)].join('|');
        if (expected == null || sig !== expected) return `Ref ${ref} now points to a different element (page changed?). Call browser_read mode=interactive again.`;
        return el;
      },
      ref,
      sigs[ref - 1] ?? null
    );
  } else if (selector) {
    const all = await page.$$(selector);
    if (!all.length) throw new Error(`Selector not found: ${selector}`);
    [handle] = all;
    for (const h of all.slice(1)) await h.dispose?.();
    if (all.length > 1) note = ` (selector matched ${all.length} elements, used the first)`;
  } else if (text != null) {
    const q = String(text).toLowerCase().trim();
    if (!q) throw new Error('Text to click is empty.');
    handle = await page.evaluateHandle((q) => {
      const cand = [...document.querySelectorAll(
        'a,button,input[type=submit],input[type=button],summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[onclick]'
      )];
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      };
      const label = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const matches = cand.filter((el) => visible(el) && label(el).includes(q));
      if (!matches.length) return `No visible clickable element with text "${q}".`;
      matches.sort((a, b) => (label(a) === q ? -1 : 0) - (label(b) === q ? -1 : 0) || label(a).length - label(b).length);
      window.__foxpilotMatches = matches.length;
      return matches[0];
    }, q);
    const count = await page.evaluate(() => window.__foxpilotMatches).catch(() => 1);
    if (count > 1) note = ` (${count} elements matched the text, used the closest)`;
  } else {
    throw new Error('Give one of: ref, selector, text.');
  }
  const el = handle.asElement?.();
  if (!el) {
    const msg = await handle.jsonValue();
    await handle.dispose?.();
    throw new Error(String(msg));
  }
  return { handle: el, note };
}

/**
 * Focus a text field, or fail. Without this check, typing into something that can't take focus
 * (a div, a label, a checkbox) would send the keys to whatever field had focus before.
 */
export async function focusEditable(handle) {
  const err = await handle.evaluate((el) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const textInput = tag === 'input' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color', 'hidden'].includes(type);
    if (!(textInput || tag === 'textarea' || tag === 'select' || el.isContentEditable)) {
      return `the target is a <${tag}${type ? ` type=${type}` : ''}>, not a text field; use browser_click for buttons, checkboxes and links`;
    }
    if (el.disabled || el.readOnly) return 'the field is disabled or read-only';
    el.focus();
    const a = document.activeElement;
    if (a !== el && !el.contains(a)) return 'the field did not take focus (covered or hidden?)';
    return null;
  });
  if (err) throw new Error(`Can't type: ${err}.`);
}

/**
 * Empty a field with real key presses (select all + Backspace), so frameworks that track input
 * events (React, Vue) see the change; setting .value directly would leave their state stale.
 */
export async function clearField(page, handle) {
  await focusEditable(handle);
  await handle.evaluate((el) => {
    if (typeof el.select === 'function') el.select();
    else if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  });
  await page.keyboard.press('Backspace');
}

/** Put the caret at the end of a field without clicking (a click would place it mid-text). */
export async function focusEnd(handle) {
  await focusEditable(handle);
  await handle.evaluate((el) => {
    if (typeof el.setSelectionRange === 'function' && typeof el.value === 'string') {
      try {
        el.setSelectionRange(el.value.length, el.value.length);
      } catch {
        /* type=email/number don't support selection ranges; focus is enough */
      }
    } else if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  });
}
