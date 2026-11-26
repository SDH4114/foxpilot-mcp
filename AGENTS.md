# AGENTS.md — foxpilot-mcp

## Purpose
Let Claude Code, Claude Desktop and other MCP clients drive the user's real browser instead of a Chrome-only integration. Firefox first (Haos uses Zen daily), Chromium browsers too (Haos also has Helium). Built because official AI browser integrations are Chrome-only and Firefox ports of Claude in Chrome are unofficial (closed Anthropic code, OAuth token injection).

## What it does
Local stdio MCP server `foxpilot` with tools `browser_*` (tabs, open, search, read text / interactive refs, find, click, type, key, scroll, wait, screenshot, eval, close). Connects to a running browser on `127.0.0.1:9222`: Firefox/forks over WebDriver BiDi, Chromium over CDP, detected automatically.

## Status
Active, v0.2.0. Smoke test passes on Zen 1.24.3b (BiDi) and Helium 0.22.4.1 (CDP), both on throwaway profiles. Helium opens the debug port on its default profile (checked); Chrome 136+ does not (Google's change). Stock Firefox, Brave, Edge not tested. Public repo github.com/SDH4114/foxpilot-mcp, MIT.
On Haos's machine: registered as `foxpilot` in Claude Code (user scope) and Claude Desktop config; skill `~/aiwork/claude-config/claude/skills/foxpilot` (symlinked into `~/.claude/skills`); launchers `~/Applications/Zen (AI).app`, `~/Applications/Helium (AI).app`.

## Stack
Node 22.12+ (ESM), `puppeteer-core` 25 (protocols `webDriverBiDi` and `cdp`), `@modelcontextprotocol/sdk` 1.x, `zod` 4. npm. Launcher: AppleScript via `osacompile`.

## Structure
- `src/server.js` — entry point; MCP tool definitions, error wrapping, shutdown handler
- `src/browser.js` — `detectEngine()`, connection lifecycle (`withBrowser`, `release`), tab id mapping, `settle()` after navigation
- `src/page.js` — functions evaluated in the page: text, interactive elements (`data-foxpilot-ref`), find, target resolution
- `scripts/smoke.mjs` — end-to-end test through a real MCP client, against a local HTTP test site
- `scripts/make-launcher.sh` + `launcher/launcher.applescript` — builds `~/Applications/<App> (AI).app` (APP_NAME / DEBUG_FLAG placeholders); detects Gecko (`omni.ja`/`application.ini`) vs Chromium (`*Framework.framework`)

## Architecture
Client ⇄ stdio ⇄ `server.js` → every tool runs inside `withBrowser()` → `detectEngine()` (GET `/json/version`: JSON with `webSocketDebuggerUrl` = CDP, else BiDi at `ws://127.0.0.1:PORT/session`) → `puppeteer.connect` → browser.
The connection is closed after `FOXPILOT_IDLE_MS` idle and on SIGINT/SIGTERM/SIGHUP/stdin close.
Tab ids are short numbers mapped to `page.mainFrame()._id` (BiDi browsing-context id / CDP target id), stable across reconnects.

## Commands
- `npm install`
- `npm start` — run the server (normally started by the MCP client)
- `npm run smoke` — e2e test; set `FOXPILOT_PORT` to a throwaway headless instance (see README)
- `npm run launcher -- "<App name>"` — build a launcher app

## Conventions
- Tool names `browser_<verb>`; output is compact plain text ending with `tab <id>: <title> — <url>` after actions.
- Errors are returned as `isError` text, never thrown to the client.
- Docs lead with Firefox; other browsers are listed with what is and isn't tested.

## Decisions
- Remote-debugging protocols, not an extension: no add-on signing, no closed code, no OAuth tokens; Firefox's Remote Agent checks Host/Origin, so web pages cannot connect.
- Auto-detect the engine on the port instead of asking for a browser path: the MCP config never changes when switching browsers; `FOXPILOT_PROTOCOL` overrides.
- MCP server, not a skill + CLI script: persistent connection, no Bash permission prompts, works in Claude Desktop too.
- Connect-on-demand with idle release: Firefox allows one BiDi session at a time, so several clients must take turns.
- Smoke test uses a local HTTP site: DuckDuckGo shows a bot challenge to headless Chromium, which made the old test fail for reasons outside this project.
- Name `foxpilot-mcp`, server `foxpilot` — chosen by Haos. Tools renamed `firefox_*` → `browser_*` in 0.2.0 when Chromium support landed.

## Gotchas
- **One BiDi session per Firefox.** A client that dies without `session.end` (e.g. `kill -9`) leaves the session open → new clients get "Maximum number of active sessions" until the browser restarts. Hence the shutdown handler; don't remove it.
- Firefox answers `/json/version` with 404 — that is what tells it apart from Chromium. A plain "port responds" check is not enough.
- Chrome 136+ ignores `--remote-debugging-port` on the default profile; other Chromium forks may or may not (Helium allows it).
- Firefox flag is `--remote-debugging-port 9222`, Chromium needs `--remote-debugging-port=9222`.
- `open -a <App> --args …` is ignored if the app is already running (the launcher handles that).
- `page.mainFrame()._id` is a puppeteer private field; check it after upgrading puppeteer-core.
- Interactive refs are re-numbered on every `browser_read mode=interactive`.
- Don't run `npm run smoke` against Haos's main browser without asking — it opens/closes tabs there.
