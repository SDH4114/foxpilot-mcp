import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  detectEngine, profileDir, planLaunch, parseRegValue, exeFromCommand, parseDesktopExec, parseNetstatPid,
  browserMatcher, pickApp,
} from '../src/system.js';
import { launcherSpec } from '../src/launch.js';

function tmp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'foxpilot-sys-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('detectEngine', () => {
  test('macOS bundles: omni.ja → gecko, *Framework.framework → chromium', () => {
    const t = tmp();
    try {
      const fox = path.join(t.dir, 'Fox.app');
      mkdirSync(path.join(fox, 'Contents/Resources'), { recursive: true });
      writeFileSync(path.join(fox, 'Contents/Resources/omni.ja'), '');
      const chr = path.join(t.dir, 'Chr.app');
      mkdirSync(path.join(chr, 'Contents/Frameworks/Chr Framework.framework'), { recursive: true });
      assert.equal(detectEngine(fox), 'gecko');
      assert.equal(detectEngine(chr), 'chromium');
    } finally {
      t.cleanup();
    }
  });

  test('Windows/Linux install folders: omni.ja / application.ini → gecko, .pak files → chromium', () => {
    const t = tmp();
    try {
      const fox = path.join(t.dir, 'ff');
      const chr = path.join(t.dir, 'cr');
      mkdirSync(fox);
      mkdirSync(chr);
      writeFileSync(path.join(fox, 'application.ini'), '');
      writeFileSync(path.join(chr, 'resources.pak'), '');
      assert.equal(detectEngine(fox, { name: 'whatever' }), 'gecko');
      assert.equal(detectEngine(chr, { name: 'whatever' }), 'chromium');
    } finally {
      t.cleanup();
    }
  });

  test('falls back to the name when files say nothing; unknown → null', () => {
    const t = tmp();
    try {
      assert.equal(detectEngine(t.dir, { name: 'librewolf' }), 'gecko');
      assert.equal(detectEngine(t.dir, { name: 'brave-browser' }), 'chromium');
      assert.equal(detectEngine(t.dir, { name: 'msedge' }), 'chromium');
      assert.equal(detectEngine(t.dir, { name: 'Safari' }), null);
      assert.equal(detectEngine(t.dir, { name: 'Search Browser Marc' }), null, '"arc" only as a whole word');
      assert.equal(detectEngine(t.dir, { name: 'Arc' }), 'chromium');
    } finally {
      t.cleanup();
    }
  });
});

describe('profileDir (separate Chromium AI profile)', () => {
  test('per OS location', () => {
    assert.equal(profileDir('Helium', { platform: 'darwin', home: '/Users/a' }), '/Users/a/Library/Application Support/foxpilot/profiles/Helium');
    assert.equal(profileDir('brave', { platform: 'linux', home: '/home/a', env: {} }), '/home/a/.local/share/foxpilot/profiles/brave');
    assert.equal(profileDir('brave', { platform: 'linux', home: '/home/a', env: { XDG_DATA_HOME: '/x' } }), '/x/foxpilot/profiles/brave');
    assert.equal(profileDir('chrome', { platform: 'win32', home: 'C:\\Users\\a', env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' } }), 'C:\\Users\\a\\AppData\\Local\\foxpilot\\profiles\\chrome');
  });

  test('odd characters in the name are replaced', () => {
    assert.equal(profileDir('a/b:c', { platform: 'linux', home: '/h', env: {} }), '/h/.local/share/foxpilot/profiles/a_b_c');
  });
});

describe('planLaunch', () => {
  const zen = { name: 'Zen', location: '/Applications/Zen.app', exe: null, engine: 'gecko' };
  const helium = { name: 'Helium', location: '/Applications/Helium.app', exe: null, engine: 'chromium' };

  test('macOS Firefox fork: main profile, needs to be the only instance', () => {
    assert.deepEqual(planLaunch(zen, { port: 9222, platform: 'darwin', home: '/Users/a' }), {
      command: 'open',
      args: ['-a', '/Applications/Zen.app', '--args', '--remote-debugging-port', '9222'],
      profile: null,
      needsExclusive: true,
    });
  });

  test('macOS Chromium: new instance with the AI profile, can run next to the everyday one', () => {
    const p = planLaunch(helium, { port: 9222, platform: 'darwin', home: '/Users/a' });
    assert.equal(p.command, 'open');
    assert.deepEqual(p.args.slice(0, 4), ['-n', '-a', '/Applications/Helium.app', '--args']);
    assert.ok(p.args.includes('--remote-debugging-port=9222'));
    assert.ok(p.args.includes('--user-data-dir=/Users/a/Library/Application Support/foxpilot/profiles/Helium'));
    assert.equal(p.needsExclusive, false);
  });

  test('Chromium with mainProfile: no profile flag, exclusive', () => {
    const p = planLaunch(helium, { port: 9222, platform: 'darwin', mainProfile: true, home: '/Users/a' });
    assert.deepEqual(p.args, ['-a', '/Applications/Helium.app', '--args', '--remote-debugging-port=9222']);
    assert.equal(p.needsExclusive, true);
  });

  test('Windows / Linux run the executable directly', () => {
    const ff = { name: 'firefox', location: 'C:\\Program Files\\Mozilla Firefox', exe: 'C:\\Program Files\\Mozilla Firefox\\firefox.exe', engine: 'gecko' };
    assert.deepEqual(planLaunch(ff, { port: 9333, platform: 'win32' }), {
      command: 'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
      args: ['--remote-debugging-port', '9333'],
      profile: null,
      needsExclusive: true,
    });
    const brave = { name: 'brave-browser', location: '/opt/brave.com/brave', exe: '/opt/brave.com/brave/brave', engine: 'chromium' };
    const p = planLaunch(brave, { port: 9222, platform: 'linux', home: '/home/a', env: {} });
    assert.equal(p.command, '/opt/brave.com/brave/brave');
    assert.deepEqual(p.args, ['--remote-debugging-port=9222', '--user-data-dir=/home/a/.local/share/foxpilot/profiles/brave-browser', '--no-first-run']);
  });
});

describe('Windows registry and netstat parsing', () => {
  test('parseRegValue', () => {
    const out = '\r\nHKEY_CURRENT_USER\\...\\UserChoice\r\n    ProgId    REG_SZ    FirefoxURL-308046B0AF4A39CB\r\n\r\n';
    assert.equal(parseRegValue(out), 'FirefoxURL-308046B0AF4A39CB');
    assert.equal(parseRegValue('    (Default)    REG_EXPAND_SZ    "C:\\x\\a.exe" -url "%1"'), '"C:\\x\\a.exe" -url "%1"');
    assert.equal(parseRegValue('ERROR: The system was unable to find the specified registry key or value.'), null);
  });

  test('exeFromCommand handles quoted and bare paths', () => {
    assert.equal(exeFromCommand('"C:\\Program Files\\Mozilla Firefox\\firefox.exe" -osint -url "%1"'), 'C:\\Program Files\\Mozilla Firefox\\firefox.exe');
    assert.equal(exeFromCommand('C:\\Apps\\brave.exe --single-argument %1'), 'C:\\Apps\\brave.exe');
    assert.equal(exeFromCommand(''), null);
    assert.equal(exeFromCommand(null), null);
  });

  test('exeFromCommand expands %VARS% (REG_EXPAND_SZ) case-insensitively', () => {
    const env = { ProgramFiles: 'C:\\Program Files' };
    assert.equal(exeFromCommand('"%PROGRAMFILES%\\Zen\\zen.exe" -osint -url "%1"', { env }), 'C:\\Program Files\\Zen\\zen.exe');
  });

  test('exeFromCommand: unquoted path with spaces is resolved via the files that exist', () => {
    const exists = (p) => p === 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
    assert.equal(exeFromCommand('C:\\Program Files\\Mozilla Firefox\\firefox.exe -osint -url %1', { env: {}, exists }), 'C:\\Program Files\\Mozilla Firefox\\firefox.exe');
  });

  test('parseNetstatPid finds the LISTENING socket on the port only', () => {
    const out = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    127.0.0.1:9222         127.0.0.1:50000        ESTABLISHED     1111',
      '  TCP    127.0.0.1:92220        0.0.0.0:0              LISTENING       2222',
      '  TCP    127.0.0.1:9222         0.0.0.0:0              LISTENING       4321',
    ].join('\r\n');
    assert.equal(parseNetstatPid(out, 9222), 4321);
    assert.equal(parseNetstatPid(out, 9333), null);
  });

  test('parseNetstatPid works on non-English Windows and for IPv6', () => {
    const ru = '  TCP    127.0.0.1:9222         0.0.0.0:0              ПРОСЛУШИВАНИЕ   5555';
    const de = '  TCP    127.0.0.1:9222         0.0.0.0:0              ABHÖREN         6666';
    const v6 = '  TCP    [::1]:9222             [::]:0                 LISTENING       7777';
    assert.equal(parseNetstatPid(ru, 9222), 5555);
    assert.equal(parseNetstatPid(de, 9222), 6666);
    assert.equal(parseNetstatPid(v6, 9222), 7777);
    assert.equal(parseNetstatPid('  UDP    127.0.0.1:9222         *:*                                    8888', 9222), null);
  });
});

describe('browserMatcher (is this process our browser?)', () => {
  test('macOS: only processes inside the .app, with a path boundary', () => {
    const m = browserMatcher({ location: '/Applications/Zen.app' }, { platform: 'darwin' });
    assert.equal(m('/Applications/Zen.app/Contents/MacOS/zen --remote-debugging-port 9222'), true);
    assert.equal(m('/Applications/Zen.app2/Contents/MacOS/x'), false);
    assert.equal(m('/usr/bin/python3 -m http.server 9222'), false);
  });

  test('Linux: wrapper script in /usr/bin, real binary elsewhere', () => {
    // /usr/bin/firefox -> /usr/lib/firefox/firefox.sh (script); the process is /usr/lib/firefox/firefox.
    const m = browserMatcher({ exe: '/usr/bin/firefox', exeReal: '/usr/lib/firefox/firefox.sh' }, { platform: 'linux' });
    assert.equal(m('/usr/lib/firefox/firefox --remote-debugging-port 9222'), true);
    assert.equal(m('/usr/bin/firefox'), true);
    assert.equal(m('/usr/bin/python3 -m http.server 9222'), false, 'a generic /usr/bin is not a match by itself');
  });

  test('Linux: snap shim', () => {
    const m = browserMatcher({ exe: '/snap/bin/firefox', exeReal: '/usr/bin/snap' }, { platform: 'linux' });
    assert.equal(m('/snap/firefox/4793/usr/lib/firefox/firefox'), true);
    assert.equal(m('/usr/bin/snap run something'), false);
  });

  test('Linux: Chrome wrapper next to the binary', () => {
    const m = browserMatcher({ exe: '/usr/bin/google-chrome', exeReal: '/opt/google/chrome/google-chrome' }, { platform: 'linux' });
    assert.equal(m('/opt/google/chrome/chrome --remote-debugging-port=9222'), true);
    assert.equal(m('/opt/other/chrome'), false);
  });

  test('Windows: full path or bare image name, case-insensitive', () => {
    const m = browserMatcher({ exe: 'C:\\Program Files\\Mozilla Firefox\\firefox.exe' }, { platform: 'win32' });
    assert.equal(m('c:\\program files\\mozilla firefox\\FIREFOX.EXE'), true);
    assert.equal(m('firefox.exe'), true);
    assert.equal(m('C:\\Python\\python.exe'), false);
  });
});

describe('pickApp (macOS default browser lookup)', () => {
  test('prefers /Applications, then ~/Applications; skips DMGs and the Trash', () => {
    const home = '/Users/a';
    assert.equal(pickApp(['/Volumes/Zen/Zen.app', '/Users/a/.Trash/Zen.app', '/Users/a/Applications/Zen.app', '/Applications/Zen.app'], { home }), '/Applications/Zen.app');
    assert.equal(pickApp(['/Volumes/Zen/Zen.app', '/Users/a/Applications/Zen.app'], { home }), '/Users/a/Applications/Zen.app');
    assert.equal(pickApp(['/Volumes/Zen/Zen.app', ''], { home }), null);
  });
});

describe('parseDesktopExec (Linux .desktop files)', () => {
  test('first program of Exec in [Desktop Entry], ignoring field codes and env', () => {
    assert.equal(parseDesktopExec('[Desktop Entry]\nName=Firefox\nExec=firefox %u\n'), 'firefox');
    assert.equal(parseDesktopExec('[Desktop Entry]\nExec="/opt/my browser/zen" --name x %U\n'), '/opt/my browser/zen');
    assert.equal(parseDesktopExec('[Desktop Entry]\nExec=env MOZ_ENABLE_WAYLAND=1 GDK_BACKEND=wayland firefox %u\n'), 'firefox');
  });

  test('Exec lines of other sections (actions) are ignored', () => {
    const text = '[Desktop Action new-window]\nExec=other --new-window\n[Desktop Entry]\nExec=/usr/bin/brave-browser-stable %U\n';
    assert.equal(parseDesktopExec(text), '/usr/bin/brave-browser-stable');
    assert.equal(parseDesktopExec('[Desktop Entry]\nName=x\n'), null);
  });
});

describe('launcherSpec ("Browser (AI)" shortcut per OS)', () => {
  test('macOS: AppleScript app in ~/Applications running launch.js --interactive with quoted paths', () => {
    const s = launcherSpec({ platform: 'darwin', node: '/n/node', script: '/p/my dir/launch.js', home: '/Users/a' });
    assert.equal(s.file, '/Users/a/Applications/Browser (AI).app');
    assert.equal(s.kind, 'applescript');
    assert.match(s.content, /do shell script quoted form of "\/n\/node" & " " & quoted form of "\/p\/my dir\/launch.js" & " " & quoted form of "--interactive"/);
  });

  test('macOS with --main-profile passes it on', () => {
    assert.match(launcherSpec({ platform: 'darwin', node: '/n', script: '/s', home: '/h', extra: ['--main-profile'] }).content, /"--main-profile"/);
  });

  test('Windows: Start Menu .lnk created via PowerShell, node as target, paths quoted', () => {
    const s = launcherSpec({ platform: 'win32', node: 'C:\\node\\node.exe', script: 'C:\\My Code\\launch.js', home: 'C:\\Users\\a', env: { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' } });
    assert.equal(s.file, 'C:\\Users\\a\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Browser (AI).lnk');
    assert.equal(s.kind, 'lnk');
    assert.match(s.content, /\$s\.TargetPath = 'C:\\node\\node\.exe'/);
    assert.match(s.content, /\$s\.Arguments = '"C:\\My Code\\launch\.js" --interactive'/);
  });

  test("Windows: a single quote in a path can't break out of the PowerShell string", () => {
    const s = launcherSpec({ platform: 'win32', node: 'C:\\n.exe', script: "C:\\O'Brien\\launch.js", home: 'C:\\Users\\a', env: {} });
    assert.match(s.content, /C:\\O''Brien\\launch\.js/);
  });

  test('Linux: .desktop entry in ~/.local/share/applications, Exec escaped per the spec', () => {
    const s = launcherSpec({ platform: 'linux', node: '/usr/bin/node', script: '/home/a/my $code 100%/launch.js', home: '/home/a', env: {} });
    assert.equal(s.file, '/home/a/.local/share/applications/foxpilot-browser-ai.desktop');
    assert.match(s.content, /^\[Desktop Entry\]$/m);
    // $ -> \$ inside quotes, then the backslash doubled for the string value; % -> %%.
    const exec = s.content.split('\n').find((l) => l.startsWith('Exec='));
    assert.equal(exec, 'Exec="/usr/bin/node" "/home/a/my \\\\$code 100%%/launch.js" "--interactive"');
    assert.match(s.content, /^Terminal=false$/m);
    assert.doesNotMatch(s.content, /WebBrowser/, 'must not be offered as a default browser');
  });
});
