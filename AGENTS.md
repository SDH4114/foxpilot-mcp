# AGENTS.md — foxpilot-mcp

## Purpose
Let Claude Code, Claude Desktop and other MCP clients drive the user's real (default) browser instead of a Chrome-only integration. Firefox first (Haos uses Zen daily), Chromium browsers too (Haos also has Helium). macOS, Windows, Linux. Built because official AI browser integrations are Chrome-only and Firefox ports of Claude in Chrome are unofficial (closed Anthropic code, OAuth token injection).

## What it does
Local stdio MCP server `foxpilot` with tools `browser_*` (tabs, open, search, read text / interactive refs, find, click, type, key, scroll, wait, screenshot, eval, close). Connects to a running browser on `127.0.0.1:9222`: Firefox/forks over WebDriver BiDi, Chromium over CDP, detected automatically.

## Status
Active, v0.2.0 (unreleased; GitHub main still has 0.1.0). 134 unit tests pass (`npm test`); smoke test passes on Zen 1.24.3b (BiDi) and Helium 0.22.4.1 (CDP) on throwaway profiles, and on a Helium AI profile started by auto-start. Two bug hunts + a security audit (2026-11-26) were fixed in this version. Helium opens the debug port on its default profile (checked); Chrome 136+ does not (Google's change). Stock Firefox, Brave, Edge not tested. Public repo github.com/SDH4114/foxpilot-mcp, MIT.
Windows and Linux code paths (default browser, launch, shortcut) are written and unit-tested by parsers only — never run on a real Windows/Linux machine.
On Haos's machine: registered as `foxpilot` in Claude Code (user scope) and Claude Desktop config; skill `~/aiwork/claude-config/claude/skills/foxpilot` (symlinked into `~/.claude/skills`); launcher `~/Applications/Browser (AI).app` (default browser = Zen).

## Stack
Node 22.12+ (ESM), `puppeteer-core` 25 (protocols `webDriverBiDi` and `cdp`), `@modelcontextprotocol/sdk` 1.x, `zod` 4. npm. Launcher: AppleScript via `osacompile`.

## Structure
- `src/server.js` — entry point; MCP tool definitions, untrusted wrapping of output, ref signatures per tab, shutdown handler
- `src/browser.js` — `detectEngine()`, connection lifecycle (`withBrowser` = serialized calls, `release`), tab id mapping + `remapAfterReconnect`, `getPage` URL guard, `toFront`, `settle()`
- `src/page.js` — functions evaluated in the page: text, interactive elements (`data-foxpilot-ref` + signatures), find, `resolveTarget` → element handle, `clearField`, `focusEnd`
- `src/policy.js` — pure: `readConfig` (env validation), `normalizeUrl`/`isControllableUrl` (http(s) only), `parseKeyCombo`, `wrapUntrusted`/`quoteUntrusted`/`cleanText`, `validateDebuggerUrl`
- `test/` — unit tests (`node --test`, happy-dom fake page in `test/helpers/fake-page.js`, fake debug port + MCP client in `test/helpers/mcp.js`)
- `scripts/smoke.mjs` — end-to-end test through a real MCP client, against a local HTTP test site
- `src/system.js` — per OS: default browser (macOS LaunchServices plist + mdfind, Windows registry UserChoice, Linux xdg-settings + .desktop), `detectEngine` (files, then name), `planLaunch` (flags, Chromium AI profile), `portOwner`, `isRunning`, `quitBrowser`, `ensureBrowser` (errors: running / port-taken / failed)
- `src/launch.js` — CLI + "Browser (AI)" launcher: `--interactive` (dialogs: osascript / PowerShell MessageBox / zenity-kdialog / terminal), `--install` (macOS .app via osacompile, Windows Start Menu .lnk via PowerShell, Linux .desktop); `launcherSpec` is pure

## Architecture
Client ⇄ stdio ⇄ `server.js` → every tool runs inside `withBrowser()` → `detectEngine()` (GET `/json/version`: JSON with `webSocketDebuggerUrl` = CDP, else BiDi at `ws://127.0.0.1:PORT/session`; nothing listening → `system.ensureBrowser()` starts the default browser unless FOXPILOT_AUTOSTART=0) → `puppeteer.connect` → browser.
The launcher and auto-start share `system.js`; the only thing the MCP server never does is restart a browser the user has open — that is the launcher's job (asks first).
The connection is closed after `FOXPILOT_IDLE_MS` idle and on SIGINT/SIGTERM/SIGHUP/stdin close.
Tab ids are short numbers mapped to `page.mainFrame()._id`. CDP target ids survive reconnects; **BiDi context ids do not** (new per session), so after a reconnect stale ids are re-attached by URL + tab position (`matchStaleIds`). Ref signatures are keyed by short tab id for the same reason.
Output: trusted status line `tab N: title "…", url "…"` + page content inside `<untrusted … id=RANDOM>` markers.

## Commands
- `npm install`
- `npm start` — run the server (normally started by the MCP client)
- `npm test` — unit tests (no browser)
- `npm run smoke` — e2e test; set `FOXPILOT_PORT` to a throwaway headless instance (see README)
- `npm run launcher [-- --main-profile]` — install the "Browser (AI)" shortcut for this OS
- `npm run start-browser [-- --dry-run]` — start the default browser in AI mode from a terminal

## Conventions
- Tool names `browser_<verb>`; everything page-derived goes through `wrapUntrusted`/`quoteUntrusted`; tool descriptions of read tools carry the UNTRUSTED note.
- Pure logic goes in `src/policy.js` (unit-testable); code passed to `page.evaluate` must be self-contained (no closures, no `new Function` — page CSP).
- Errors are returned as `isError` text, never thrown to the client.
- Docs lead with Firefox; other browsers are listed with what is and isn't tested.

## Decisions
- Remote-debugging protocols, not an extension: no add-on signing, no closed code, no OAuth tokens; Firefox's Remote Agent checks Host/Origin, so web pages cannot connect.
- Auto-detect the engine on the port instead of asking for a browser path: the MCP config never changes when switching browsers; `FOXPILOT_PROTOCOL` overrides.
- MCP server, not a skill + CLI script: persistent connection, no Bash permission prompts, works in Claude Desktop too.
- Connect-on-demand with idle release: Firefox allows one BiDi session at a time, so several clients must take turns.
- URL policy http(s)-only and Chromium AI profile by default: from the 2026-11-26 security audit (prompt injection → file:// read; CDP exposes plaintext cookies of the profile to any local process).
- Refs verified by server-side signature (tag|role|type|label) instead of a nonce attribute: page scripts can read any attribute, but can't make another element look identical without it actually being "the same" button.
- Smoke test uses a local HTTP site: DuckDuckGo shows a bot challenge to headless Chromium, which made the old test fail for reasons outside this project.
- One launcher for the default browser instead of one per browser (Haos, 2026-11-26): fewer things to explain; FOXPILOT_BROWSER overrides. Browser logic lives in Node (`system.js`) so it is shared by launcher + auto-start and works on all three OSes.
- Name `foxpilot-mcp`, server `foxpilot` — chosen by Haos. Tools renamed `firefox_*` → `browser_*` in 0.2.0 when Chromium support landed.

## Gotchas
- **One BiDi session per Firefox.** A client that dies without `session.end` (e.g. `kill -9`) leaves the session open → new clients get "Maximum number of active sessions" until the browser restarts. Hence the shutdown handler; don't remove it.
- After a reconnect, BiDi gives tabs new ids; old ids are re-attached by URL. If a URL is shared by more old ids than open tabs, those ids are dropped (a wrong tab is worse than "No tab with id"). Tab order from `pages()` is not stable across BiDi sessions, so same-URL tabs may swap ids.
- A just-started browser (seen with Chromium) aborts the first navigation / loses clicks for ~1-3 s after the port opens: `ensureBrowser` waits 3 s after starting, `goto` retries once on ERR_ABORTED, smoke waits `FOXPILOT_SMOKE_GRACE_MS`.
- Every tool call is capped at 90 s (`CALL_TIMEOUT_MS`) and each protocol command at 45 s, so a frozen page can't block the queue forever.
- Ref signatures ignore digits and the content of fields (counters, typing); keep `sigOf` in `readInteractive` and the copy in `resolveTarget` identical.
- `browser_type` refuses targets that are not text fields (and checks focus), otherwise keys would land in the previously focused field.
- Linux: the browser in PATH is often a wrapper script / snap shim; `browserMatcher` matches the real binary's folder and the program name. Windows `netstat` output is localized: listening sockets are found by foreign address `:0`, not the word LISTENING.
- Firefox answers `/json/version` with 404 — that is what tells it apart from Chromium. A plain "port responds" check is not enough.
- Chrome 136+ ignores `--remote-debugging-port` on the default profile; other Chromium forks may or may not (Helium allows it).
- Firefox flag is `--remote-debugging-port 9222`, Chromium needs `--remote-debugging-port=9222`.
- Launching Firefox (or Chromium on its main profile) while it already runs just hands off to the running instance and ignores the flag — hence `needsExclusive` + the restart prompt. On macOS `open -a … --args` is ignored the same way.
- The launcher embeds absolute paths to node and `src/launch.js`: rebuild it after moving the repo or switching Node versions.
- Unit tests must keep `FOXPILOT_AUTOSTART=0` (set in `test/helpers/mcp.js`), or they would open the real default browser.
- `page.mainFrame()._id` is a puppeteer private field; check it after upgrading puppeteer-core.
- Headless Chromium: input to a background tab can hang and timers there are throttled — hence `toFront()` before click/type/key/screenshot.
- Puppeteer `timeout: 0` means "forever": keep the `browser_wait` bounds.
- Interactive refs are re-numbered on every `browser_read mode=interactive`.
- Don't run `npm run smoke` against Haos's main browser without asking — it opens/closes tabs there.
