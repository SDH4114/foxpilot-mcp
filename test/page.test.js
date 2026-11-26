import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readText, readInteractive, findText, resolveTarget, focusEditable } from '../src/page.js';
import { makePage } from './helpers/fake-page.js';

const list = async (page, opts) => (await readInteractive(page, opts)).text;

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

  test('offset past the end says so instead of returning an empty string', async () => {
    assert.equal(await readText(makePage('<p>short</p>'), { offset: 999 }), '[offset 999 is past the end; the text has 5 chars]');
    assert.equal(await readText(makePage('<p>short</p>'), { offset: 5 }), '[offset 5 is past the end; the text has 5 chars]');
  });

  test('runs of 3+ newlines are collapsed to a blank line and text is trimmed', async () => {
    const page = makePage('');
    Object.defineProperty(page.document.body, 'innerText', { value: '\n\nA\n\n\n\n\nB\n\n' });
    assert.equal(await readText(page), 'A\n\nB');
  });
});

describe('readInteractive', () => {
  test('empty page', async () => {
    assert.deepEqual(await readInteractive(makePage('<p>nothing</p>')), { text: '(no interactive elements found)', sigs: [] });
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
    const out = (await list(page)).split('\n');
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

  test('returns one signature per ref (tag|role|type|label), without the value', async () => {
    const { sigs } = await readInteractive(makePage('<button>Save</button><input type="text" placeholder="Name" value="Bob">'));
    assert.deepEqual(sigs, ['button|||Save', 'input||text|Name']);
  });

  test('password values are masked, never leaked', async () => {
    const page = makePage('<input type="password" name="pw" value="hunter2"><input type="password" name="empty">');
    const out = await list(page);
    assert.ok(!out.includes('hunter2'));
    assert.match(out, /\[1\] input password "pw" value="\*\*\*"/);
    assert.match(out, /\[2\] input password "empty"$/m);
  });

  test('other sensitive fields are masked too: shown passwords, one-time codes, card data', async () => {
    const page = makePage(`
      <input type="text" autocomplete="current-password" value="shown-pass">
      <input type="text" autocomplete="one-time-code" value="123456">
      <input type="text" autocomplete="cc-number" value="4111111111111111">
      <input type="text" name="otp_code" value="999999">
      <input type="text" name="city" value="Baku">`);
    const out = await list(page);
    for (const secret of ['shown-pass', '123456', '4111111111111111', '999999']) assert.ok(!out.includes(secret), secret);
    assert.match(out, /value="Baku"/);
  });

  test('hidden inputs, disabled, display:none, visibility:hidden and zero-size elements are skipped', async () => {
    const page = makePage(`
      <input type="hidden" value="x">
      <button disabled>Disabled</button>
      <button style="display:none">None</button>
      <button style="visibility:hidden">Invisible</button>
      <button data-test-rect="0,0,0,0">ZeroSize</button>
      <button>Visible</button>`);
    assert.equal(await list(page), '[1] button "Visible"');
  });

  test('refs are renumbered on every call (stale tags removed)', async () => {
    const page = makePage('<button id="a">A</button><button id="b">B</button>');
    await readInteractive(page);
    page.document.getElementById('a').style.display = 'none';
    assert.equal(await list(page), '[1] button "B"');
    assert.equal(page.document.getElementById('a').hasAttribute('data-foxpilot-ref'), false);
    assert.equal(page.document.getElementById('b').getAttribute('data-foxpilot-ref'), '1');
  });

  test('max cap: stops after max items and says how many were omitted', async () => {
    const page = makePage('<button>1</button><button>2</button><button>3</button><button>4</button>');
    const out = (await list(page, { max: 2 })).split('\n');
    assert.deepEqual(out, ['[1] button "1"', '[2] button "2"', '[...2 more elements omitted, max=2]']);
    assert.equal(page.document.querySelectorAll('[data-foxpilot-ref]').length, 2);
  });

  test('exactly max elements: no "omitted" notice when nothing was omitted', async () => {
    const page = makePage('<button>1</button><button>2</button>');
    assert.equal(await list(page, { max: 2 }), '[1] button "1"\n[2] button "2"');
  });

  test('offscreen marker uses viewport height', async () => {
    const page = makePage(
      '<button data-test-rect="50,20,900,920">Below</button><button data-test-rect="50,20,-60,-40">Above</button><button>In</button>',
      { innerHeight: 800 }
    );
    const out = await list(page);
    assert.match(out, /\[1\] button "Below" \(offscreen\)/);
    assert.match(out, /\[2\] button "Above" \(offscreen\)/);
    assert.match(out, /\[3\] button "In"$/);
  });

  test('long names are clipped with an ellipsis', async () => {
    const out = await list(makePage(`<button>${'x'.repeat(100)}</button>`));
    assert.ok(out.includes(`[1] button "${'x'.repeat(80)}…"`));
  });

  test('aria-label alone is used; when it differs from the visible text both are shown', async () => {
    const out = await list(makePage('<button aria-label="Close"></button><button aria-label="Cancel">Delete account</button>'));
    assert.match(out, /\[1\] button "Close"$/m);
    assert.match(out, /\[2\] button "Delete account" \(aria-label "Cancel"\)/);
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

  test('empty or whitespace query is rejected', async () => {
    await assert.rejects(findText(page(), '   '), /Query is empty/);
  });
});

describe('resolveTarget', () => {
  const read = async (p) => (await readInteractive(p)).sigs;

  test('ref: returns the tagged element when its signature still matches', async () => {
    const p = makePage('<button id="go">Go</button>');
    const sigs = await read(p);
    const { handle, note } = await resolveTarget(p, { ref: 1 }, { sigs });
    assert.equal(handle.id, 'go');
    assert.equal(note, '');
  });

  test('ref without a previous interactive read is rejected', async () => {
    await assert.rejects(resolveTarget(makePage('<button>Go</button>'), { ref: 1 }), /Unknown ref 1: call browser_read mode=interactive first/);
  });

  test('unknown ref -> error telling to re-read', async () => {
    const p = makePage('<p></p>');
    await assert.rejects(resolveTarget(p, { ref: 9999 }, { sigs: await read(p) }), /Ref 9999 not found.*browser_read mode=interactive/);
  });

  test('a page that moves the ref attribute to another element is caught (signature mismatch)', async () => {
    const p = makePage('<button id="del">Delete everything</button><button id="save">Save draft</button>');
    const sigs = await read(p);
    const save = p.document.getElementById('save');
    const ref = save.getAttribute('data-foxpilot-ref');
    save.removeAttribute('data-foxpilot-ref');
    p.document.getElementById('del').setAttribute('data-foxpilot-ref', ref);
    await assert.rejects(resolveTarget(p, { ref: Number(ref) }, { sigs }), /points to a different element/);
  });

  test('a page that duplicates the ref attribute is caught', async () => {
    const p = makePage('<button id="a">A</button><button id="b">B</button>');
    const sigs = await read(p);
    p.document.getElementById('b').setAttribute('data-foxpilot-ref', '1');
    await assert.rejects(resolveTarget(p, { ref: 1 }, { sigs }), /matches 2 elements/);
  });

  test('selector: first match, with a note when several match; error when absent', async () => {
    const p = makePage('<div id="x" class="c"></div><div id="y" class="c"></div>');
    assert.equal((await resolveTarget(p, { selector: '#x' })).handle.id, 'x');
    const multi = await resolveTarget(p, { selector: '.c' });
    assert.equal(multi.handle.id, 'x');
    assert.match(multi.note, /matched 2 elements/);
    await assert.rejects(resolveTarget(p, { selector: '#nope' }), /Selector not found: #nope/);
  });

  test('ref takes precedence over selector and text', async () => {
    const p = makePage('<button id="go">Go</button>');
    const sigs = await read(p);
    assert.equal((await resolveTarget(p, { ref: 1, selector: 'nope', text: 'nope' }, { sigs })).handle.id, 'go');
  });

  test('ref still works after a counter in the button text changes (digits are ignored)', async () => {
    const p = makePage('<button id="c">Count: 0</button>');
    const sigs = await read(p);
    p.document.getElementById('c').textContent = 'Count: 17';
    assert.equal((await resolveTarget(p, { ref: 1 }, { sigs })).handle.id, 'c');
  });

  test('ref to a contenteditable field still works after typing into it', async () => {
    const p = makePage('<div id="ed" contenteditable="true" aria-label="Message">x</div>');
    const sigs = await read(p);
    p.document.getElementById('ed').textContent = 'hello there';
    assert.equal((await resolveTarget(p, { ref: 1 }, { sigs })).handle.id, 'ed');
  });

  test('no arguments -> usage error', async () => {
    await assert.rejects(resolveTarget(makePage(''), {}), /Give one of: ref, selector, text/);
  });

  test('text: empty or whitespace is rejected instead of matching everything', async () => {
    await assert.rejects(resolveTarget(makePage('<button>A</button>'), { text: '   ' }), /Text to click is empty/);
  });

  test('text: exact match wins over a shorter partial match', async () => {
    const p = makePage('<button id="partial">Say OK now</button><button id="exact">OK</button><button id="short">OK!</button>');
    const { handle, note } = await resolveTarget(p, { text: 'ok' });
    assert.equal(handle.id, 'exact');
    assert.match(note, /3 elements matched/);
  });

  test('text: among non-exact matches the shortest label wins', async () => {
    const p = makePage('<button id="long">Delete everything now</button><button id="short">Delete all</button>');
    assert.equal((await resolveTarget(p, { text: 'delet' })).handle.id, 'short');
  });

  test('text: case-insensitive, query trimmed, matches input value; single match has no note', async () => {
    const p = makePage('<input type="submit" id="s" value="Send it">');
    const { handle, note } = await resolveTarget(p, { text: '  SEND ' });
    assert.equal(handle.id, 's');
    assert.equal(note, '');
  });

  test('text: invisible candidates are ignored', async () => {
    const p = makePage('<button style="visibility:hidden">Buy</button><button data-test-rect="0,0,0,0">Buy</button>');
    await assert.rejects(resolveTarget(p, { text: 'buy' }), /No visible clickable element with text "buy"/);
  });
});

describe('focusEditable (browser_type target check)', () => {
  // A handle whose evaluate() runs the function on the element with the page globals installed.
  const handleOf = (p, el) => ({ evaluate: (fn) => p.evaluate(() => fn(el)) });

  test('text inputs, textareas and contenteditable take focus', async () => {
    const p = makePage('<input id="i"><textarea id="t"></textarea><div id="e" contenteditable="true">x</div>');
    for (const id of ['i', 't', 'e']) {
      const el = p.document.getElementById(id);
      await focusEditable(handleOf(p, el));
      assert.equal(p.document.activeElement, el, id);
    }
  });

  test('a div, a checkbox or a button is refused instead of typing into the previously focused field', async () => {
    const p = makePage('<input id="prev"><div id="plain">text</div><input id="cb" type="checkbox"><button id="b">Go</button>');
    p.document.getElementById('prev').focus();
    await assert.rejects(focusEditable(handleOf(p, p.document.getElementById('plain'))), /not a text field/);
    await assert.rejects(focusEditable(handleOf(p, p.document.getElementById('cb'))), /type=checkbox/);
    await assert.rejects(focusEditable(handleOf(p, p.document.getElementById('b'))), /<button>/);
  });

  test('disabled and read-only fields are refused', async () => {
    const p = makePage('<input id="d" disabled><input id="r" readonly>');
    await assert.rejects(focusEditable(handleOf(p, p.document.getElementById('d'))), /disabled or read-only/);
    await assert.rejects(focusEditable(handleOf(p, p.document.getElementById('r'))), /disabled or read-only/);
  });
});
