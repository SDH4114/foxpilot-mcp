# AGENTS.md — foxpilot-mcp

## Purpose
Let Claude Code, Claude Desktop and other MCP clients drive the user's real Firefox (or a fork such as Zen, which Haos uses daily) instead of Chrome. Built because official AI browser integrations are Chrome-only and Firefox ports of Claude in Chrome are unofficial (closed Anthropic code, OAuth token injection).

## What it does
Local stdio MCP server `foxpilot` with tools `firefox_*` (tabs, open, search, read text / interactive refs, find, click, type, key, scroll, wait, screenshot, eval, close). Connects to a running browser over WebDriver BiDi on `ws://127.0.0.1:9222/session`.

## Status
Prototype v0.1.0, working: smoke test passes against Zen 1.24.3b. Stock Firefox not tested (not installed on Haos's Mac). Public repo github.com/SDH4114/foxpilot-mcp, MIT.
On Haos's machine: registered as `foxpilot` in Claude Code (user scope) and Claude Desktop config; skill `~/aiwork/claude-config/claude/skills/foxpilot` (symlinked into `~/.claude/skills`); launcher `~/Applications/Zen (AI).app`.

## Stack
Node 22.12+ (ESM), `puppeteer-core` 25 (protocol `webDriverBiDi`), `@modelcontextprotocol/sdk` 1.x, `zod` 4. npm. Launcher: AppleScript via `osacompile`.

## Structure
- `src/server.js` — entry point; MCP tool definitions, error wrapping, shutdown handler
- `src/firefox.js` — BiDi connection lifecycle (`withBrowser`, `release`), tab id mapping, `settle()` after navigation
- `src/page.js` — functions evaluated in the page: text, interactive elements (`data-foxpilot-ref`), find, target resolution
- `scripts/smoke.mjs` — end-to-end test through a real MCP client
- `scripts/make-launcher.sh` + `launcher/launcher.applescript` — builds `~/Applications/<App> (AI).app` (APP_NAME placeholder)

## Architecture
Client ⇄ stdio ⇄ `server.js` → every tool runs inside `withBrowser()` → lazy `puppeteer.connect` → browser.
The session is ended after `FOXPILOT_IDLE_MS` idle and on SIGINT/SIGTERM/SIGHUP/stdin close.
Tab ids are short numbers mapped to BiDi browsing-context ids (`page.mainFrame()._id`), stable across reconnects.

## Commands
- `npm install`
- `npm start` — run the server (normally started by the MCP client)
- `npm run smoke` — e2e test; set `FOXPILOT_PORT` to a throwaway headless instance (see README)
- `npm run launcher -- Zen` — build the launcher app

## Conventions
- Tool names `firefox_<verb>`; output is compact plain text ending with `tab <id>: <title> — <url>` after actions.
- Errors are returned as `isError` text, never thrown to the client.
- Code and docs say "Firefox"; Zen is mentioned only as a supported fork.

## Decisions
- WebDriver BiDi, not an extension: no add-on signing problem, no closed code, no OAuth tokens; the Firefox Remote Agent already checks Host/Origin, so web pages cannot connect.
- MCP server, not a skill + CLI script: persistent connection, no Bash permission prompts, works in Claude Desktop too.
- Connect-on-demand with idle release: Firefox allows one BiDi session at a time, so several clients must take turns.
- Name `foxpilot-mcp` (repo/package), server `foxpilot`, tools `firefox_*` — chosen by Haos.

## Gotchas
- **One BiDi session per browser.** A client that dies without `session.end` (e.g. `kill -9`) leaves the session open → new clients get "Maximum number of active sessions" until the browser restarts. Hence the shutdown handler; don't remove it.
- `open -a <App> --args …` is ignored if the app is already running (the launcher handles that).
- `page.mainFrame()._id` is a puppeteer private field; check it after upgrading puppeteer-core.
- Interactive refs are re-numbered on every `firefox_read mode=interactive`.
- Don't run `npm run smoke` against Haos's main browser without asking — it opens/closes tabs there.
