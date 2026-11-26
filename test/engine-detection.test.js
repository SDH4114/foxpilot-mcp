// detectEngine() in src/browser.js is not exported, so it is tested through the MCP server
// (child process, env per test) by calling browser_tabs against a fake local debugging port.
// The fake port records WebSocket upgrade paths, which reveals the protocol chosen:
//   /session            -> WebDriver BiDi (Firefox)
//   /devtools/browser/* -> CDP (Chromium, taken from webSocketDebuggerUrl)
// The fake never completes the handshake, so every "reachable" case ends in a connection error.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, fakePort, freePort, textOf } from './helpers/mcp.js';

const chromiumVersion = (port) => (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ Browser: 'Chrome/999', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/abc-123` }));
};
const nonJson200 = (req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<html>hello</html>');
};
const jsonWithoutWs = (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"Browser":"Something/1"}');
};

/** Run browser_tabs against a server configured with env; always closes the client. */
async function tabs(env) {
  const client = await startServer(env);
  try {
    return await client.callTool({ name: 'browser_tabs', arguments: {} });
  } finally {
    await client.close();
  }
}

const NOTHING = /nothing is listening/;

describe('nothing listening', () => {
  for (const protocol of [undefined, 'auto', 'bidi', 'cdp']) {
    test(`FOXPILOT_PROTOCOL=${protocol ?? '(unset)'}: reports unreachable browser with launch hints`, async () => {
      const port = await freePort();
      const r = await tabs({ FOXPILOT_PORT: String(port), ...(protocol && { FOXPILOT_PROTOCOL: protocol }) });
      assert.equal(r.isError, true);
      const t = textOf(r);
      assert.match(t, new RegExp(`Cannot reach a browser on 127\\.0\\.0\\.1:${port}`));
      assert.match(t, NOTHING);
      assert.match(t, /--remote-debugging-port/);
      assert.doesNotMatch(t, /browser_tabs failed/); // BrowserNotReachable is returned verbatim, no wrapper
    });
  }
});

describe('Firefox-like port (GET /json/version -> 404 HTML)', () => {
  test('auto: falls back to BiDi on /session; error is a connection error, not "nothing listening"', async () => {
    const fake = await fakePort();
    try {
      const r = await tabs({ FOXPILOT_PORT: String(fake.port), FOXPILOT_PROTOCOL: 'auto' });
      assert.equal(r.isError, true);
      assert.match(textOf(r), /Cannot reach a browser/);
      assert.doesNotMatch(textOf(r), NOTHING);
      assert.ok(fake.requests.includes('/json/version'));
      assert.deepEqual(fake.upgrades, ['/session']);
    } finally {
      await fake.close();
    }
  });

  test('default (unset) behaves as auto', async () => {
    const fake = await fakePort();
    try {
      await tabs({ FOXPILOT_PORT: String(fake.port) });
      assert.deepEqual(fake.upgrades, ['/session']);
    } finally {
      await fake.close();
    }
  });

  test('bidi: connects to /session', async () => {
    const fake = await fakePort();
    try {
      const r = await tabs({ FOXPILOT_PORT: String(fake.port), FOXPILOT_PROTOCOL: 'bidi' });
      assert.doesNotMatch(textOf(r), NOTHING);
      assert.deepEqual(fake.upgrades, ['/session']);
    } finally {
      await fake.close();
    }
  });

  test('cdp: fails with "does not speak CDP" and never opens a WebSocket', async () => {
    const fake = await fakePort();
    try {
      const r = await tabs({ FOXPILOT_PORT: String(fake.port), FOXPILOT_PROTOCOL: 'cdp' });
      assert.equal(r.isError, true);
      assert.equal(textOf(r), `browser_tabs failed: FOXPILOT_PROTOCOL=cdp, but port ${fake.port} does not speak CDP.`);
      assert.deepEqual(fake.upgrades, []);
    } finally {
      await fake.close();
    }
  });

  test('protocol value is case-insensitive (CDP)', async () => {
    const fake = await fakePort();
    try {
      const r = await tabs({ FOXPILOT_PORT: String(fake.port), FOXPILOT_PROTOCOL: 'CDP' });
      assert.match(textOf(r), /does not speak CDP/);
    } finally {
      await fake.close();
    }
  });
});

describe('Chromium-like port (GET /json/version -> JSON with webSocketDebuggerUrl)', () => {
  test('auto: connects to the advertised CDP websocket path', async () => {
    const fake = await fakePort((req, res) => chromiumVersion(fake.port)(req, res));
    try {
      const r = await tabs({ FOXPILOT_PORT: String(fake.port), FOXPILOT_PROTOCOL: 'auto' });
      assert.equal(r.isError, true);
      assert.match(textOf(r), /Cannot reach a browser/);
      assert.doesNotMatch(textOf(r), NOTHING);
      assert.deepEqual(fake.upgrades, ['/devtools/browser/abc-123']);
    } finally {
      await fake.close();
    }
  });

  test('cdp: same CDP path', async () => {
    const fake = await fakePort((req, res) => chromiumVersion(fake.port)(req, res));
    try {
      await tabs({ FOXPILOT_PORT: String(fake.port), FOXPILOT_PROTOCOL: 'cdp' });
      assert.deepEqual(fake.upgrades, ['/devtools/browser/abc-123']);
    } finally {
      await fake.close();
    }
  });

  test('bidi forced: ignores the CDP advertisement and uses /session', async () => {
    const fake = await fakePort((req, res) => chromiumVersion(fake.port)(req, res));
    try {
      await tabs({ FOXPILOT_PORT: String(fake.port), FOXPILOT_PROTOCOL: 'bidi' });
      assert.deepEqual(fake.upgrades, ['/session']);
    } finally {
      await fake.close();
    }
  });
});

describe('ambiguous responses', () => {
  test('non-JSON 200, auto: treated as BiDi', async () => {
    const fake = await fakePort(nonJson200);
    try {
      const r = await tabs({ FOXPILOT_PORT: String(fake.port), FOXPILOT_PROTOCOL: 'auto' });
      assert.doesNotMatch(textOf(r), NOTHING);
      assert.deepEqual(fake.upgrades, ['/session']);
    } finally {
      await fake.close();
    }
  });

  test('non-JSON 200, cdp: "does not speak CDP"', async () => {
    const fake = await fakePort(nonJson200);
    try {
      const r = await tabs({ FOXPILOT_PORT: String(fake.port), FOXPILOT_PROTOCOL: 'cdp' });
      assert.match(textOf(r), /does not speak CDP/);
    } finally {
      await fake.close();
    }
  });

  test('JSON without webSocketDebuggerUrl: auto -> BiDi, cdp -> error', async () => {
    const fake = await fakePort(jsonWithoutWs);
    try {
      await tabs({ FOXPILOT_PORT: String(fake.port), FOXPILOT_PROTOCOL: 'auto' });
      assert.deepEqual(fake.upgrades, ['/session']);
      const r = await tabs({ FOXPILOT_PORT: String(fake.port), FOXPILOT_PROTOCOL: 'cdp' });
      assert.match(textOf(r), /does not speak CDP/);
    } finally {
      await fake.close();
    }
  });

  test('JSON with a webSocketDebuggerUrl but HTTP 404 is not trusted (auto -> BiDi)', async () => {
    const fake = await fakePort((req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${fake.port}/devtools/browser/x` }));
    });
    try {
      await tabs({ FOXPILOT_PORT: String(fake.port), FOXPILOT_PROTOCOL: 'auto' });
      assert.deepEqual(fake.upgrades, ['/session']);
    } finally {
      await fake.close();
    }
  });

  test('JSON "null" body does not crash detection (auto -> BiDi)', async () => {
    const fake = await fakePort((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('null');
    });
    try {
      const r = await tabs({ FOXPILOT_PORT: String(fake.port), FOXPILOT_PROTOCOL: 'auto' });
      assert.doesNotMatch(textOf(r), /TypeError|Cannot read/);
      assert.deepEqual(fake.upgrades, ['/session']);
    } finally {
      await fake.close();
    }
  });
});
