import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readText, readInteractive, findText, resolveTarget } from '../src/page.js';
import { makePage } from './helpers/fake-page.js';

describe('readText', () => {
  test('returns the whole text when it fits, no tail', async () => {
    assert.equal(await readText(makePage('<p>hello</p>')), 'hello');
  });

  test('empty body gives empty string', async () => {
    assert.equal(await readText(makePage('')), '');
  });

  test('windowing: slice of max chars plus a continuation hint with the next offset', async () => {
    const page = makePage('<p>' + 'a'.repeat(100) + '</p>');
    const out = await readText(page, { max: 40 });
    assert.equal(out, 'a'.repeat(40) + '\n\n[...60 more chars, call again with offset=40]');
  });

  test('following the offset hint walks the whole text; last page has no hint', async () => {
    const page = makePage('<p>' + '0123456789'.repeat(10) + '</p>');
    const first = await readText(page, { max: 40 });
    assert.match(first, /offset=40\]$/);
    const second = await readText(page, { offset: 40, max: 40 });
    assert.match(second, /offset=80\]$/);
    assert.equal(await readText(page, { offset: 80, max: 40 }), '0123456789'.repeat(2));
  });

  test('exact fit leaves no hint (boundary)', async () => {
    const page = makePage('<p>' + 'b'.repeat(40) + '</p>');
    assert.equal(await readText(page, { max: 40 }), 'b'.repeat(40));
  });

  test('offset past the end yields empty string, not a bogus hint', async () => {
    assert.equal(await readText(makePage('<p>short</p>'), { offset: 999 }), '');
  });

  test('runs of 3+ newlines are collapsed to a blank line and text is trimmed', async () => {
    const page = makePage('');
    Object.defineProperty(page.document.body, 'innerText', { value: '\n\nA\n\n\n\n\nB\n\n' });
    assert.equal(await readText(page), 'A\n\nB');
  });
});

describe('readInteractive', () => {
  test('empty page', async () => {
    assert.equal(await readInteractive(makePage('<p>nothing</p>')), '(no interactive elements found)');
  });

  test('formats links, buttons, inputs, selects with refs and tags elements', async () => {
    const page = makePage(`
      <a href="/docs">Docs</a>
      <button>Save</button>
      <input type="text" placeholder="Name" value="Bob">
      <input type="checkbox" name="agree" checked>
      <input type="checkbox" name="other">
      <textarea name="msg">hi</textarea>
      <select name="color"><option>Red</option><option selected>Green</option></select>
      <div role="tab">Tab1</div>`);
    const out = (await readInteractive(page)).split('\n');
    assert.deepEqual(out, [
      '[1] link "Docs" -> /docs',
      '[2] button "Save"',
      '[3] input text "Name" value="Bob"',
      '[4] input checkbox [x] "agree" value="on"',
      '[5] input checkbox [ ] "other" value="on"',
      '[6] input textarea "msg" value="hi"',
      '[7] select "color" = "Green" options: Red | Green',
      '[8] tab "Tab1"',
    ]);
    assert.equal(page.document.querySelectorAll('[data-foxpilot-ref]').length, 8);
    assert.equal(page.document.querySelector('[data-foxpilot-ref="2"]').tagName, 'BUTTON');
  });

  test('password values are masked, never leaked', async () => {
    const page = makePage('<input type="password" name="pw" value="hunter2"><input type="password" name="empty">');
    const out = await readInteractive(page);
    assert.ok(!out.includes('hunter2'));
    assert.match(out, /\[1\] input password "pw" value="\*\*\*"/);
    assert.match(out, /\[2\] input password "empty"$/m);
  });

  test('hidden inputs, disabled, display:none, visibility:hidden and zero-size elements are skipped', async () => {
    const page = makePage(`
      <input type="hidden" value="x">
      <button disabled>Disabled</button>
      <button style="display:none">None</button>
      <button style="visibility:hidden">Invisible</button>
      <button data-test-rect="0,0,0,0">ZeroSize</button>
      <button>Visible</button>`);
    assert.equal(await readInteractive(page), '[1] button "Visible"');
  });

  test('refs are renumbered on every call (stale tags removed)', async () => {
    const page = makePage('<button id="a">A</button><button id="b">B</button>');
    await readInteractive(page);
    page.document.getElementById('a').style.display = 'none';
    assert.equal(await readInteractive(page), '[1] button "B"');
    assert.equal(page.document.getElementById('a').hasAttribute('data-foxpilot-ref'), false);
    assert.equal(page.document.getElementById('b').getAttribute('data-foxpilot-ref'), '1');
  });

  test('max cap: stops after max items and appends an omitted notice', async () => {
    const page = makePage('<button>1</button><button>2</button><button>3</button><button>4</button>');
    const out = (await readInteractive(page, { max: 2 })).split('\n');
    assert.deepEqual(out, ['[1] button "1"', '[2] button "2"', '[...more elements omitted, max=2]']);
    assert.equal(page.document.querySelectorAll('[data-foxpilot-ref]').length, 2);
  });

  test('exactly max elements: no "omitted" notice when nothing was omitted', { todo: 'bug: readInteractive appends "[...more elements omitted]" whenever n reaches max, even if there are no further elements' }, async () => {
    const page = makePage('<button>1</button><button>2</button>');
    assert.equal(await readInteractive(page, { max: 2 }), '[1] button "1"\n[2] button "2"');
  });

  test('offscreen marker uses viewport height', async () => {
    const page = makePage(
      '<button data-test-rect="50,20,900,920">Below</button><button data-test-rect="50,20,-60,-40">Above</button><button>In</button>',
      { innerHeight: 800 }
    );
    const out = await readInteractive(page);
    assert.match(out, /\[1\] button "Below" \(offscreen\)/);
    assert.match(out, /\[2\] button "Above" \(offscreen\)/);
    assert.match(out, /\[3\] button "In"$/);
  });

  test('long names are clipped with an ellipsis; aria-label wins over text', async () => {
    const page = makePage(`<button>${'x'.repeat(100)}</button><button aria-label="Close">X</button>`);
    const out = await readInteractive(page);
    assert.ok(out.includes(`[1] button "${'x'.repeat(80)}…"`));
    assert.match(out, /\[2\] button "Close"/);
  });
});

describe('findText', () => {
  const page = () => makePage('<p>alpha</p><p>Needle here</p><p>omega</p><p>zeta</p>');

  test('case-insensitive match with previous and next line as context', async () => {
    assert.equal(await findText(page(), 'needle'), '1 match(es):\n- alpha\n   >> Needle here\n   omega');
  });

  test('no matches message quotes the query', async () => {
    assert.equal(await findText(page(), 'nope'), 'No matches for "nope".');
  });

  test('first line has no previous-line context', async () => {
    assert.equal(await findText(page(), 'alpha'), '1 match(es):\n- >> alpha\n   Needle here');
  });

  test('max limits the number of hits', async () => {
    const out = await findText(makePage('<p>x1</p><p>x2</p><p>x3</p>'), 'x', { max: 2 });
    assert.match(out, /^2 match\(es\):/);
  });

  test('long context is truncated to 400 chars plus ellipsis', async () => {
    const out = await findText(makePage(`<p>${'y'.repeat(500)}</p>`), 'y');
    assert.ok(out.endsWith('…'));
    assert.equal(out.split('- ')[1].length, 401);
  });
});

describe('resolveTarget', () => {
  const idOfTarget = (p, sel) => p.document.querySelector(sel).id;

  test('ref: returns the attribute selector when tagged', async () => {
    const p = makePage('<button>Go</button>');
    await readInteractive(p);
    assert.equal(await resolveTarget(p, { ref: 1 }), '[data-foxpilot-ref="1"]');
  });

  test('ref 0 is treated as a ref (not missing)', async () => {
    await assert.rejects(resolveTarget(makePage(''), { ref: 0 }), /Ref 0 not found/);
  });

  test('unknown ref -> error telling to re-read', async () => {
    await assert.rejects(resolveTarget(makePage('<p></p>'), { ref: 9999 }), /Ref 9999 not found.*browser_read mode=interactive/);
  });

  test('selector: returned as is when present, error when absent', async () => {
    const p = makePage('<div id="x"></div>');
    assert.equal(await resolveTarget(p, { selector: '#x' }), '#x');
    await assert.rejects(resolveTarget(p, { selector: '#y' }), /Selector not found: #y/);
  });

  test('ref takes precedence over selector and text', async () => {
    const p = makePage('<button>Go</button>');
    await readInteractive(p);
    assert.equal(await resolveTarget(p, { ref: 1, selector: 'nope', text: 'nope' }), '[data-foxpilot-ref="1"]');
  });

  test('no arguments -> usage error', async () => {
    await assert.rejects(resolveTarget(makePage(''), {}), /Give one of: ref, selector, text/);
  });

  test('text: exact match wins over a shorter partial match', async () => {
    const p = makePage('<button id="partial">Say OK now</button><button id="exact">OK</button><button id="short">OK!</button>');
    assert.equal(idOfTarget(p, await resolveTarget(p, { text: 'ok' })), 'exact');
  });

  test('text: exact match wins even when a shorter-label partial match exists', async () => {
    // "Save" label is shorter than... query is "save draft": only "Save draft" and the long one match.
    const p = makePage('<button id="long">Save draft and exit</button><button id="exact">Save draft</button>');
    assert.equal(idOfTarget(p, await resolveTarget(p, { text: 'save draft' })), 'exact');
  });

  test('text: among non-exact matches the shortest label wins', async () => {
    const p = makePage('<button id="long">Delete everything now</button><button id="short">Delete all</button>');
    assert.equal(idOfTarget(p, await resolveTarget(p, { text: 'delet' })), 'short');
  });

  test('text: case-insensitive, query trimmed, matches input value', async () => {
    const p = makePage('<input type="submit" id="s" value="Send it">');
    assert.equal(idOfTarget(p, await resolveTarget(p, { text: '  SEND ' })), 's');
  });

  test('text: invisible candidates are ignored', async () => {
    const p = makePage('<button style="visibility:hidden">Buy</button><button data-test-rect="0,0,0,0">Buy</button>');
    await assert.rejects(resolveTarget(p, { text: 'buy' }), /No visible clickable element with text "buy"/);
  });

  test('text: only one element keeps the target tag', async () => {
    const p = makePage('<button id="a">One</button><button id="b">Two</button>');
    await resolveTarget(p, { text: 'one' });
    await resolveTarget(p, { text: 'two' });
    const tagged = p.document.querySelectorAll('[data-foxpilot-target]');
    assert.equal(tagged.length, 1);
    assert.equal(tagged[0].id, 'b');
  });
});
