// MCP surface: tool list, input schemas, annotations, validation. No browser involved: validation
// errors are raised by the SDK before any handler (and thus any connection) runs.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, freePort, textOf } from './helpers/mcp.js';

const EXPECTED = [
  'browser_tabs', 'browser_open', 'browser_search', 'browser_read', 'browser_find', 'browser_click',
  'browser_type', 'browser_key', 'browser_scroll', 'browser_screenshot', 'browser_wait', 'browser_eval',
  'browser_close',
];
const READ_ONLY = ['browser_tabs', 'browser_read', 'browser_find', 'browser_screenshot', 'browser_wait'];

let client;
let tools;
const tool = (n) => tools.find((t) => t.name === n);

before(async () => {
  client = await startServer({ FOXPILOT_PORT: String(await freePort()) });
  tools = (await client.listTools()).tools;
});
after(() => client.close());

describe('tool list', () => {
  test('exactly the 13 browser_* tools', () => {
    assert.equal(tools.length, 13);
    assert.deepEqual(tools.map((t) => t.name).sort(), [...EXPECTED].sort());
  });

  test('every tool has a description and an object input schema', () => {
    for (const t of tools) {
      assert.ok(t.description && t.description.length > 10, t.name);
      assert.equal(t.inputSchema.type, 'object', t.name);
    }
  });

  test('server identifies itself', () => {
    assert.equal(client.getServerVersion().name, 'foxpilot');
  });
});

describe('input schemas', () => {
  const required = (n) => [...(tool(n).inputSchema.required ?? [])].sort();
  const props = (n) => tool(n).inputSchema.properties;

  test('required fields', () => {
    assert.deepEqual(required('browser_tabs'), []);
    assert.deepEqual(required('browser_open'), ['url']);
    assert.deepEqual(required('browser_search'), ['query']);
    assert.deepEqual(required('browser_read'), []);
    assert.deepEqual(required('browser_find'), ['query']);
    assert.deepEqual(required('browser_click'), []);
    assert.deepEqual(required('browser_type'), ['value']);
    assert.deepEqual(required('browser_key'), ['key']);
    assert.deepEqual(required('browser_scroll'), ['direction']);
    assert.deepEqual(required('browser_screenshot'), []);
    assert.deepEqual(required('browser_wait'), []);
    assert.deepEqual(required('browser_eval'), ['js']);
    assert.deepEqual(required('browser_close'), ['tabId']);
  });

  test('enums', () => {
    assert.deepEqual(props('browser_search').engine.enum, ['google', 'duckduckgo', 'bing']);
    assert.deepEqual(props('browser_read').mode.enum, ['text', 'interactive']);
    assert.deepEqual(props('browser_scroll').direction.enum, ['down', 'up', 'top', 'bottom']);
  });

  test('field types and bounds', () => {
    assert.equal(props('browser_read').offset.type, 'integer');
    assert.equal(props('browser_read').offset.minimum, 0);
    assert.equal(props('browser_click').ref.type, 'integer');
    assert.equal(props('browser_type').append.type, 'boolean');
    assert.equal(props('browser_type').submit.type, 'boolean');
    assert.equal(props('browser_screenshot').fullPage.type, 'boolean');
    assert.equal(props('browser_wait').timeoutMs.type, 'integer');
    assert.equal(props('browser_open').tabId.type, 'string');
  });

  test('tabId is accepted by every tool that targets a tab', () => {
    for (const n of EXPECTED.filter((n) => !['browser_tabs', 'browser_search'].includes(n))) {
      assert.ok('tabId' in props(n), n);
    }
  });
});

describe('annotations', () => {
  test('read tools are readOnly, mutating tools are not', () => {
    for (const t of tools) {
      assert.equal(t.annotations?.readOnlyHint, READ_ONLY.includes(t.name), t.name);
    }
  });

  test('all tools are marked openWorld', () => {
    for (const t of tools) assert.equal(t.annotations?.openWorldHint, true, t.name);
  });
});

describe('argument validation', () => {
  // The SDK reports invalid arguments either as an isError result or by rejecting; accept both,
  // but require that the message names the problem and that no browser connection was attempted.
  async function invalid(name, args) {
    let r;
    try {
      r = await client.callTool({ name, arguments: args });
    } catch (e) {
      return String(e.message); // rejected by the SDK: that is a rejection too
    }
    // Outside the try, so a call that was wrongly accepted fails the test instead of being caught.
    assert.equal(r.isError, true, `expected ${name} ${JSON.stringify(args)} to be rejected, got: ${textOf(r)}`);
    return textOf(r);
  }

  test('missing required field', async () => {
    const msg = await invalid('browser_open', {});
    assert.match(msg, /url|invalid|required/i);
    assert.doesNotMatch(msg, /Cannot reach a browser/);
  });

  test('wrong enum value', async () => {
    const msg = await invalid('browser_scroll', { direction: 'sideways' });
    assert.match(msg, /direction|invalid/i);
    assert.doesNotMatch(msg, /Cannot reach a browser/);
  });

  test('wrong type (ref must be an integer)', async () => {
    const msg = await invalid('browser_click', { ref: 1.5 });
    assert.match(msg, /ref|integer|invalid/i);
    assert.doesNotMatch(msg, /Cannot reach a browser/);
  });

  test('negative offset violates min(0)', async () => {
    const msg = await invalid('browser_read', { offset: -1 });
    assert.match(msg, /offset|invalid|>=/i);
    assert.doesNotMatch(msg, /Cannot reach a browser/);
  });

  test('browser_wait timeoutMs must be 1..60000 (0 would mean "wait forever" in puppeteer)', async () => {
    for (const timeoutMs of [0, -5, 60001]) {
      const msg = await invalid('browser_wait', { timeoutMs });
      assert.match(msg, /timeoutMs|invalid/i, String(timeoutMs));
      assert.doesNotMatch(msg, /Cannot reach a browser/);
    }
  });

  test('refs start at 1 and empty strings are rejected', async () => {
    for (const [name, args] of [['browser_click', { ref: 0 }], ['browser_find', { query: '' }], ['browser_key', { key: '' }]]) {
      const msg = await invalid(name, args);
      assert.doesNotMatch(msg, /Cannot reach a browser/, name);
      assert.match(msg, />=\s*1|too small|at least|invalid/i, name);
    }
  });

  test('tabId must be a string', async () => {
    const msg = await invalid('browser_close', { tabId: 3 });
    assert.match(msg, /tabId|string|invalid/i);
    assert.doesNotMatch(msg, /Cannot reach a browser/);
  });

  test('valid args pass validation and reach the handler (then fail on the unreachable browser)', async () => {
    const r = await client.callTool({ name: 'browser_tabs', arguments: {} });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /Cannot reach a browser/);
  });

  test('unknown tool is rejected', async () => {
    const msg = await invalid('browser_nope', {});
    assert.match(msg, /not found|unknown|nope/i);
  });
});
