// Fake puppeteer `page` backed by a happy-dom document, for testing src/page.js.
//
// page.js passes plain functions to page.evaluate(); they reference the globals `document`,
// `window` and `getComputedStyle`. We install those globals from a happy-dom Window for the duration
// of each evaluate() call.
//
// Layout caveat: happy-dom has no layout engine, so getBoundingClientRect() is all zeros.
// We stub it: every element gets a default 100x20 box unless it has data-test-rect="w,h,top,bottom"
// (e.g. "0,0,0,0" makes it zero-sized, i.e. invisible to page.js). innerText works in happy-dom;
// visibility/display come from inline styles, which happy-dom's getComputedStyle honours.
import { Window } from 'happy-dom';

export function makePage(html, { innerHeight = 800 } = {}) {
  const win = new Window({ innerHeight });
  // Minimal JSHandle/ElementHandle stand-ins: asElement() gives the DOM element (or null for a
  // non-element result), jsonValue() the plain value.
  const wrap = (v) => ({
    asElement: () => (v instanceof win.Element ? v : null),
    jsonValue: async () => v,
    dispose: async () => {},
  });
  win.document.body.innerHTML = html;
  win.HTMLElement.prototype.getBoundingClientRect = function () {
    const spec = this.getAttribute('data-test-rect');
    const [width, height, top, bottom] = spec ? spec.split(',').map(Number) : [100, 20, 0, 20];
    return { width, height, top, bottom, left: 0, right: width, x: 0, y: top };
  };
  const names = ['document', 'window', 'getComputedStyle'];
  const impl = { document: win.document, window: win, getComputedStyle: (el) => win.getComputedStyle(el) };
  return {
    document: win.document,
    async evaluate(fn, ...args) {
      const saved = names.map((n) => Object.getOwnPropertyDescriptor(globalThis, n));
      names.forEach((n) => Object.defineProperty(globalThis, n, { value: impl[n], configurable: true, writable: true }));
      try {
        return fn(...args);
      } finally {
        names.forEach((n, i) => (saved[i] ? Object.defineProperty(globalThis, n, saved[i]) : delete globalThis[n]));
      }
    },
    async $(sel) {
      return win.document.querySelector(sel);
    },
    async evaluateHandle(fn, ...args) {
      return wrap(await this.evaluate(fn, ...args));
    },
    async $$(sel) {
      return [...win.document.querySelectorAll(sel)].map(wrap);
    },
  };
}
