// Find the system's default browser and start it with remote debugging: macOS, Windows, Linux.
// Used by the MCP server (auto-start when nothing listens) and by the launcher (src/launch.js).
//
// Pure helpers (parsers, planLaunch, profileDir) are exported for unit tests; everything that
// touches the OS goes through run() so the platform-specific parts stay small.
import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export class StartError extends Error {
  /** code: 'running' (open without debugging, needs restart) | 'port-taken' | 'failed' */
  constructor(code, message, browserName = null) {
    super(message);
    this.code = code;
    this.browserName = browserName;
  }
}

function run(cmd, args, { timeout = 10000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Pure helpers

const GECKO_NAMES = /firefox|zen|librewolf|floorp|waterfox|icecat|mullvad|tor ?browser/i;
const CHROMIUM_NAMES = /chrom|brave|edge|msedge|vivaldi|opera|helium|thorium|yandex|\barc\b/i;

/** Engine from files next to the browser (or inside the .app), falling back to the name. */
export function detectEngine(location, { name = path.basename(location) } = {}) {
  const has = (...p) => existsSync(path.join(location, ...p));
  if (location.endsWith('.app')) {
    if (has('Contents', 'Resources', 'omni.ja') || has('Contents', 'Resources', 'application.ini')) return 'gecko';
    const fw = path.join(location, 'Contents', 'Frameworks');
    if (existsSync(fw) && readdirSync(fw).some((f) => f.endsWith('Framework.framework'))) return 'chromium';
  } else {
    if (has('omni.ja') || has('application.ini')) return 'gecko';
    if (has('resources.pak') || has('chrome_100_percent.pak') || has('v8_context_snapshot.bin') || has('icudtl.dat')) return 'chromium';
  }
  if (GECKO_NAMES.test(name)) return 'gecko';
  if (CHROMIUM_NAMES.test(name)) return 'chromium';
  return null;
}

/** Where the separate Chromium "AI profile" lives on each OS. */
export function profileDir(name, { platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const safe = name.replace(/[^A-Za-z0-9 ._-]/g, '_');
  if (platform === 'darwin') return path.posix.join(home, 'Library/Application Support/foxpilot/profiles', safe);
  if (platform === 'win32') return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'foxpilot', 'profiles', safe);
  return path.posix.join(env.XDG_DATA_HOME || path.posix.join(home, '.local/share'), 'foxpilot/profiles', safe);
}

/**
 * The command that starts the browser in AI mode. browser = { name, location, exe, engine }.
 * Firefox takes "--remote-debugging-port N"; Chromium takes "--remote-debugging-port=N".
 * Chromium gets a separate profile (and may run next to the everyday instance) unless mainProfile.
 */
export function planLaunch(browser, { port, mainProfile = false, platform = process.platform, env, home } = {}) {
  const profile = browser.engine === 'chromium' && !mainProfile ? profileDir(browser.name, { platform, env, home }) : null;
  const flags = browser.engine === 'gecko'
    ? ['--remote-debugging-port', String(port)]
    : [`--remote-debugging-port=${port}`, ...(profile ? [`--user-data-dir=${profile}`, '--no-first-run'] : [])];
  // Firefox can't open a second instance on the same profile, nor can Chromium on its main one.
  const needsExclusive = !profile;
  if (platform === 'darwin') {
    return { command: 'open', args: [...(profile ? ['-n'] : []), '-a', browser.location, '--args', ...flags], profile, needsExclusive };
  }
  return { command: browser.exe, args: flags, profile, needsExclusive };
}

/** First value of a `reg query` output line like "    ProgId    REG_SZ    FirefoxURL-308046B0AF4A39CB". */
export function parseRegValue(out) {
  const m = /REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(out);
  return m ? m[1] : null;
}

/**
 * Executable from a Windows open-command like "\"C:\\Program Files\\Mozilla Firefox\\firefox.exe\" -osint -url \"%1\"".
 * Expands %VARS% (REG_EXPAND_SZ values come back unexpanded). An unquoted path with spaces is
 * resolved by trying ever longer prefixes that exist and end in .exe.
 */
export function exeFromCommand(command, { env = process.env, exists = existsSync } = {}) {
  const s = String(command ?? '').trim().replace(/%([^%]+)%/g, (m, v) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === v.toLowerCase());
    return key ? env[key] : m;
  });
  if (!s) return null;
  if (s.startsWith('"')) return /^"([^"]+)"/.exec(s)?.[1] ?? null;
  const words = s.split(' ');
  for (let i = words.length; i > 1; i--) {
    const cand = words.slice(0, i).join(' ');
    if (/\.exe$/i.test(cand) && exists(cand)) return cand;
  }
  return words[0];
}

/** Program from the Exec= line of a .desktop file ([Desktop Entry] section only). */
export function parseDesktopExec(text) {
  let inEntry = false;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) inEntry = line === '[Desktop Entry]';
    else if (inEntry && line.startsWith('Exec=')) {
      const tokens = line.slice(5).match(/"[^"]*"|\S+/g) ?? [];
      let i = 0;
      if (tokens[i] === 'env') for (i = 1; i < tokens.length && tokens[i].includes('='); i++);
      const prog = tokens[i]?.replace(/^"|"$/g, '');
      return prog || null;
    }
  }
  return null;
}

/**
 * PID listening on the port in `netstat -ano` output (Windows). The state column is translated on
 * non-English Windows ("ПРОСЛУШИВАНИЕ", "ABHÖREN"), so a listening socket is recognized by its
 * foreign address "0.0.0.0:0" / "[::]:0" instead. IPv4 and IPv6.
 */
export function parseNetstatPid(out, port) {
  for (const line of String(out).split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== 'TCP' || cols.length < 5) continue;
    if (!(cols[1] ?? '').endsWith(`:${port}`) || !/:0$/.test(cols[2] ?? '')) continue;
    const pid = Number(cols[cols.length - 1]);
    if (pid > 0) return pid;
  }
  return null;
}

const GENERIC_BIN = new Set(['/usr/bin', '/bin', '/usr/local/bin', '/usr/sbin', '/snap/bin', '/usr/games']);

/**
 * Predicate: does this process (command line on macOS/Linux, executable path or "name.exe" on
 * Windows) belong to the browser? On Linux the launcher in PATH is often a wrapper script or a
 * snap shim, while the process runs from elsewhere (/usr/lib/firefox/firefox,
 * /snap/firefox/123/usr/lib/firefox/firefox, /opt/google/chrome/chrome), so it also matches the
 * real file's folder and the program name.
 */
export function browserMatcher(browser, { platform = process.platform } = {}) {
  if (platform === 'darwin') {
    const dir = `${browser.location}/`;
    return (cmd) => String(cmd).startsWith(dir);
  }
  if (platform === 'win32') {
    const exe = browser.exe.toLowerCase();
    const base = path.win32.basename(exe);
    return (p) => {
      const s = String(p).toLowerCase().replace(/^"|"$/g, '');
      return s === exe || s.startsWith(`${exe} `) || s === base;
    };
  }
  const snap = browser.exeReal === '/usr/bin/snap'; // the snap launcher runs every snap app
  const files = [...new Set([browser.exe, snap ? null : browser.exeReal].filter(Boolean))];
  const dirs = [];
  if (browser.exeReal && !GENERIC_BIN.has(path.posix.dirname(browser.exeReal))) dirs.push(`${path.posix.dirname(browser.exeReal)}/`);
  const names = new Set(files.map((f) => path.posix.basename(f).replace(/\.sh$/, '')).filter((n) => n !== 'snap'));
  if (snap) dirs.push(`/snap/${path.posix.basename(browser.exe)}/`);
  return (cmd) => {
    const s = String(cmd);
    const first = s.split(' ')[0];
    return files.some((f) => s === f || s.startsWith(`${f} `)) || dirs.some((d) => s.startsWith(d)) || names.has(path.posix.basename(first));
  };
}

// ---------------------------------------------------------------------------------------------
// Default browser per OS

async function defaultBrowserMac() {
  const plist = path.join(os.homedir(), 'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist');
  let bundleId = null;
  if (existsSync(plist)) {
    const r = await run('plutil', ['-convert', 'json', '-o', '-', plist]);
    try {
      const h = JSON.parse(r.stdout).LSHandlers?.find((x) => x.LSHandlerURLScheme === 'https' && x.LSHandlerRoleAll);
      bundleId = h?.LSHandlerRoleAll ?? null;
    } catch {
      /* unreadable plist: treated as "no default set" */
    }
  }
  if (!bundleId) return null; // nothing chosen means Safari
  const app = await findAppByBundleId(bundleId);
  if (!app) throw new StartError('failed', `Can't find the app for the default browser (${bundleId}).`);
  return { name: path.basename(app, '.app'), location: app, exe: null, bundleId };
}

const macAppDirs = () => ['/Applications', path.join(os.homedir(), 'Applications')];

/** Prefer installed copies (/Applications, ~/Applications) over mounted DMGs and the Trash. */
export function pickApp(paths, { home = os.homedir() } = {}) {
  const apps = paths.filter((p) => p.endsWith('.app') && !p.startsWith('/Volumes/') && !p.includes('/.Trash/'));
  const rank = (p) => (p.startsWith('/Applications/') ? 0 : p.startsWith(`${home}/Applications/`) ? 1 : 2);
  return apps.sort((a, b) => rank(a) - rank(b) || a.length - b.length)[0] ?? null;
}

async function findAppByBundleId(bundleId) {
  const r = await run('mdfind', [`kMDItemCFBundleIdentifier == '${bundleId.replace(/'/g, '')}'`]);
  const found = pickApp(r.stdout.split('\n'));
  if (found) return found;
  // Spotlight off or not indexed yet: look in the usual folders.
  for (const dir of macAppDirs()) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.app'))) {
      const app = path.join(dir, name);
      const id = await run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(app, 'Contents/Info.plist')]);
      if (id.stdout.trim() === bundleId) return app;
    }
  }
  return null;
}

async function defaultBrowserWindows() {
  const choice = await run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId']);
  const progId = parseRegValue(choice.stdout);
  if (!progId) return null;
  const cmd = await run('reg', ['query', `HKCR\\${progId}\\shell\\open\\command`, '/ve']);
  const exe = exeFromCommand(parseRegValue(cmd.stdout));
  if (!exe || !existsSync(exe)) throw new StartError('failed', `Can't find the program for the default browser (${progId}).`);
  return winBrowser(exe);
}

function winBrowser(exe) {
  const base = path.win32.basename(exe, path.win32.extname(exe));
  // Opera registers "launcher.exe": its folder name says more.
  const name = /^launcher$/i.test(base) ? path.win32.basename(path.win32.dirname(exe)) : base;
  return { name, location: path.win32.dirname(exe), exe };
}

function whichSync(prog, env = process.env) {
  if (path.isAbsolute(prog) || prog.includes('/') || prog.includes('\\')) return existsSync(prog) ? prog : null;
  const exts = process.platform === 'win32' ? ['', ...(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)] : [''];
  const pathVar = env.PATH ?? env.Path ?? '';
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, prog + ext);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

async function defaultBrowserLinux() {
  const r = await run('xdg-settings', ['get', 'default-web-browser']);
  const desktopId = r.stdout.trim();
  if (!desktopId) return null;
  const home = os.homedir();
  const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local/share');
  const dirs = [dataHome, ...(process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':'), '/var/lib/snapd/desktop']
    .map((d) => path.join(d, 'applications'));
  const file = dirs.map((d) => path.join(d, desktopId)).find(existsSync);
  if (!file) throw new StartError('failed', `Can't find ${desktopId} for the default browser.`);
  const prog = parseDesktopExec(readFileSync(file, 'utf8'));
  if (!prog || /flatpak$/.test(prog)) throw new StartError('failed', `The default browser (${desktopId}) is a Flatpak or has no Exec line; Flatpak browsers are not supported yet. Set FOXPILOT_BROWSER to the browser's executable.`);
  const exe = whichSync(prog);
  if (!exe) throw new StartError('failed', `Can't find ${prog} (from ${desktopId}) in PATH.`);
  const real = realpathSync(exe);
  return { name: path.basename(desktopId, '.desktop'), location: path.dirname(real), exe, exeReal: real };
}

/** The browser to use: FOXPILOT_BROWSER (name or path) if set, else the system default. */
export async function findBrowser({ env = process.env } = {}) {
  let b;
  const override = env.FOXPILOT_BROWSER;
  if (override) {
    if (process.platform === 'darwin') {
      const app = override.endsWith('.app')
        ? override
        : macAppDirs().map((d) => path.join(d, `${override}.app`)).find(existsSync) ?? `/Applications/${override}.app`;
      if (!existsSync(app)) throw new StartError('failed', `Not found: ${app}`);
      b = { name: path.basename(app, '.app'), location: app, exe: null };
    } else {
      const exe = whichSync(override, env);
      if (!exe) throw new StartError('failed', `Not found: ${override}`);
      const real = realpathSync(exe);
      b = process.platform === 'win32'
        ? winBrowser(real)
        : { name: path.basename(override), location: path.dirname(real), exe, exeReal: real };
    }
  } else if (process.platform === 'darwin') b = await defaultBrowserMac();
  else if (process.platform === 'win32') b = await defaultBrowserWindows();
  else b = await defaultBrowserLinux();
  if (!b) throw new StartError('failed', 'No default browser is set (Safari / system default is not supported). Make Firefox, Zen or a Chromium browser the default, or set FOXPILOT_BROWSER.');
  b.engine = detectEngine(b.location, { name: b.name });
  if (!b.engine) throw new StartError('failed', `${b.name} is neither Firefox- nor Chromium-based; it can't be controlled.`);
  return b;
}

// ---------------------------------------------------------------------------------------------
// Processes and ports

/** Command line / path of the process listening on the port, or null. */
export async function portOwner(port) {
  let pid = null;
  if (process.platform === 'win32') {
    pid = parseNetstatPid((await run('netstat', ['-ano'])).stdout, port);
    if (!pid) return null;
    // Path is empty for processes of other users / elevated ones: fall back to the image name.
    const r = await run('powershell', ['-NoProfile', '-Command', `$p = Get-Process -Id ${pid}; if ($p.Path) { $p.Path } else { $p.ProcessName + '.exe' }`]);
    return r.stdout.trim() || `pid ${pid}`;
  }
  const r = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  pid = Number(r.stdout.split('\n')[0]) || null;
  if (!pid && process.platform === 'linux') {
    const ss = await run('ss', ['-ltnpH', `sport = :${port}`]);
    pid = Number(/pid=(\d+)/.exec(ss.stdout)?.[1]) || null;
  }
  if (!pid) return null;
  return (await run('ps', ['-o', 'command=', '-p', String(pid)])).stdout.trim() || `pid ${pid}`;
}

/** Processes of the browser (macOS/Linux): [{ pid, args }]. */
async function browserProcesses(browser) {
  const matches = browserMatcher(browser);
  const r = await run('ps', ['-axo', 'pid=,args=']);
  return r.stdout
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), args: m[2] }))
    .filter((p) => p.pid !== process.pid && matches(p.args));
}

/** Whether the browser itself runs (any instance). */
export async function isRunning(browser) {
  if (process.platform === 'win32') {
    const r = await run('tasklist', ['/FI', `IMAGENAME eq ${path.win32.basename(browser.exe)}`, '/NH']);
    return r.stdout.toLowerCase().includes(path.win32.basename(browser.exe).toLowerCase());
  }
  return (await browserProcesses(browser)).length > 0;
}

const STARTUP_GRACE_MS = 3000;

export async function waitForPort(port, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const open = await new Promise((r) => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => (s.destroy(), r(true)));
      s.once('error', () => r(false));
    });
    if (open) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Ask the browser to quit like the user would, and wait until it is gone. */
export async function quitBrowser(browser, ms = 30000) {
  if (process.platform === 'darwin') {
    const target = browser.bundleId ? `application id ${JSON.stringify(browser.bundleId)}` : `application ${JSON.stringify(browser.name)}`;
    await run('osascript', ['-e', `tell ${target} to quit`]);
  }
  else if (process.platform === 'win32') await run('taskkill', ['/IM', path.win32.basename(browser.exe)]);
  else {
    // Main processes only (Chromium helpers carry --type=); they take their children down.
    for (const p of await browserProcesses(browser)) {
      if (/\s--type=/.test(p.args)) continue;
      try {
        process.kill(p.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await isRunning(browser))) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Make sure the browser listens on the port. Throws StartError:
 *  'port-taken' — another program holds the port;
 *  'running'    — the browser is open without remote debugging and restart is false;
 *  'failed'     — anything else.
 * Returns { message, browser, started }.
 */
export async function ensureBrowser({ port, mainProfile = false, restart = false, dryRun = false, env = process.env } = {}) {
  const browser = await findBrowser({ env });
  const owner = await portOwner(port);
  if (owner) {
    if (browserMatcher(browser)(owner)) return { message: `${browser.name} is already running with remote debugging on port ${port}.`, browser, started: false };
    throw new StartError('port-taken', `Port ${port} is already used by: ${owner}`);
  }
  const plan = planLaunch(browser, { port, mainProfile });
  if (plan.needsExclusive && (await isRunning(browser))) {
    if (!restart) {
      throw new StartError('running', `${browser.name} is open without remote debugging. It has to be restarted in AI mode: open "Browser (AI)" (tabs come back if the browser restores the previous session).`, browser.name);
    }
    if (dryRun) return { message: `would quit ${browser.name}, then run: ${plan.command} ${plan.args.join(' ')}`, browser, started: false };
    if (!(await quitBrowser(browser))) throw new StartError('failed', `${browser.name} did not quit (maybe it is asking for confirmation). Quit it yourself and try again.`);
  }
  if (dryRun) return { message: `would run: ${plan.command} ${plan.args.join(' ')}`, browser, started: false };
  if (plan.profile) mkdirSync(plan.profile, { recursive: true });
  const child = spawn(plan.command, plan.args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {});
  child.unref();
  if (!(await waitForPort(port))) throw new StartError('failed', `${browser.name} did not open port ${port} within 20 s.`);
  // The port opens before the first window has finished loading; acting right away can get the
  // first navigation aborted (seen with Chromium: net::ERR_ABORTED) or a click lost.
  await new Promise((r) => setTimeout(r, STARTUP_GRACE_MS));
  return { message: `${browser.name} started in AI mode${plan.profile ? ` (AI profile: ${plan.profile})` : ''}.`, browser, started: true };
}
