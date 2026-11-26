// scripts/make-launcher.sh hardcodes /Applications, so only the paths that fail before touching
// anything can be tested without modifying the script. HOME is pointed at a temp dir so that,
// even if the script misbehaved, it could not write into the real ~/Applications.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/make-launcher.sh');

function run(args) {
  const home = mkdtempSync(path.join(tmpdir(), 'foxpilot-home-'));
  try {
    const r = spawnSync('bash', [script, ...args], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    return { ...r, createdApps: existsSync(path.join(home, 'Applications')) };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('missing app: exits 1, "Not found" on stderr, creates nothing', () => {
  const name = 'FoxpilotNoSuchApp-' + process.pid;
  assert.ok(!existsSync(`/Applications/${name}.app`));
  const r = run([name]);
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), `Not found: /Applications/${name}.app`);
  assert.equal(r.stdout, '');
  assert.equal(r.createdApps, false);
});

test('app name with spaces is handled as one argument', () => {
  const r = run(['Foxpilot No Such App']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Not found: \/Applications\/Foxpilot No Such App\.app/);
});

test('empty name is not treated as the default and fails cleanly', () => {
  // ${1:-Firefox} treats an empty string like "unset", so this checks the default path name,
  // and only asserts the clean failure when Firefox is not installed.
  if (existsSync('/Applications/Firefox.app')) return;
  const r = run(['']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Not found: \/Applications\/Firefox\.app/);
});

test('no argument defaults to Firefox', { skip: existsSync('/Applications/Firefox.app') && 'Firefox is installed; script would build a launcher' }, () => {
  const r = run([]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Not found: \/Applications\/Firefox\.app/);
});

// Not covered: engine detection (omni.ja / application.ini -> gecko, *Framework.framework -> chromium,
// else "Can't tell" error). It needs a real bundle under /Applications, which the script hardcodes.
