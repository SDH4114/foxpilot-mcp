# foxpilot-mcp

An MCP server that lets Claude (Claude Code, Claude Desktop) and other MCP clients control **your real browser** — your open tabs, your logins. Firefox comes first; Firefox forks (Zen, LibreWolf, …) and Chromium browsers (Helium, Brave, Edge, Chrome, …) work too. No browser extension, no API keys, no tokens copied anywhere.

Official browser integrations for AI assistants are Chrome-only. Browsers already ship standard remote-control protocols — WebDriver BiDi in Firefox, CDP in Chromium. foxpilot detects which one is on the port and exposes it to the agent as a small set of tools.

## Tools

| Tool | What it does |
|---|---|
| `browser_tabs` | List open tabs (id, title, URL, which one is visible) |
| `browser_open` | Open a URL in a new tab, or navigate a given tab |
| `browser_search` | Web search (Google, DuckDuckGo, Bing) in a new tab, returns result text |
| `browser_read` | Page as text, or a numbered list of links/buttons/fields (`mode=interactive`) |
| `browser_find` | Find text on the page with surrounding lines |
| `browser_click` | Click by ref, CSS selector or visible text |
| `browser_type` | Type into a field (replace or append), optionally press Enter |
| `browser_key` | Press a key or combo (`Enter`, `Escape`, `Meta+a`, …) |
| `browser_scroll` | Scroll up/down/top/bottom |
| `browser_wait` | Wait for a selector or text |
| `browser_screenshot` | PNG of the tab |
| `browser_eval` | Run JavaScript in the page (fallback) |
| `browser_close` | Close a tab |

## Supported browsers

| Browser | Protocol | Your main profile | Tested |
|---|---|---|---|
| Zen | WebDriver BiDi | yes | yes (1.24.3b) |
| Firefox, LibreWolf, Floorp, Waterfox | WebDriver BiDi | yes | no (same remote agent as Zen) |
| Helium | CDP | yes | yes (0.22.4.1) |
| Brave, Edge, Vivaldi, Arc, Opera | CDP | not checked — may behave like Chrome | no |
| Google Chrome | CDP | **no**: since Chrome 136 remote debugging is ignored on the default profile ([details](https://developer.chrome.com/blog/remote-debugging-port)); use a separate `--user-data-dir` | no |
| Safari | — | not supported (no way to attach to a running session) | — |

## Requirements
- macOS for the launcher; the server itself is plain Node
- Node.js 22.12+

## Install
```bash
git clone https://github.com/SDH4114/foxpilot-mcp.git
cd foxpilot-mcp
npm install
```

## 1. Start the browser with remote debugging
The browser must run with remote debugging on port 9222. It listens on `127.0.0.1` only.

The easy way is a launcher app. Give it the app name from `/Applications`; it detects the engine and uses the right flag. Use it instead of the normal icon: if the browser is already running without debugging, it offers to restart it (tabs are restored).
```bash
npm run launcher -- Firefox          # ~/Applications/Firefox (AI).app
npm run launcher -- Zen
npm run launcher -- Helium
npm run launcher -- "Brave Browser"
```

By hand:
```bash
open -a Firefox --args --remote-debugging-port 9222    # Firefox and forks
open -a Helium --args --remote-debugging-port=9222     # Chromium browsers
```
`open -a … --args` is ignored if the app is already running.

Only one browser can sit on a port. To drive two browsers, start the second on another port and run a second foxpilot with `FOXPILOT_PORT`.

## 2. Connect to Claude
**Claude Code** (all projects):
```bash
claude mcp add -s user foxpilot -- "$(which node)" "$PWD/src/server.js"
```

**Claude Desktop**: add to `~/Library/Application Support/Claude/claude_desktop_config.json`, use absolute paths, then restart Desktop:
```json
{
  "mcpServers": {
    "foxpilot": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/foxpilot-mcp/src/server.js"]
    }
  }
}
```

Any other MCP client: run `node src/server.js` over stdio.

Then ask, for example: *"Open GitHub in my browser and list my repositories."*

## Configuration
| Env var | Default | Meaning |
|---|---|---|
| `FOXPILOT_PORT` | `9222` | Remote debugging port |
| `FOXPILOT_PROTOCOL` | `auto` | `auto`, `bidi` or `cdp`. Auto: Chromium answers `/json/version` on the port, anything else is treated as BiDi |
| `FOXPILOT_IDLE_MS` | `8000` | Let go of the browser after this much idle time |

## Things to know
- **Firefox allows one controller at a time.** foxpilot connects only while it works and lets go after `FOXPILOT_IDLE_MS`, so Claude Code and Claude Desktop can take turns. If a client is killed hard (`kill -9`), Firefox keeps the stale session until the browser restarts. Chromium has no such limit.
- While the port is open, any program on your Mac can control the browser. Web pages cannot.
- The agent acts with your logins. Keep an eye on what it does on sensitive sites.

## Tests
End-to-end smoke test through a real MCP client against local test pages (only `browser_search` goes online). Run it against a throwaway headless instance, not your main browser:
```bash
# Firefox / Zen
/Applications/Firefox.app/Contents/MacOS/firefox --profile /tmp/fp-ff --no-remote --headless --remote-debugging-port 9333 &
FOXPILOT_PORT=9333 npm run smoke

# Chromium (Helium shown)
/Applications/Helium.app/Contents/MacOS/Helium --user-data-dir=/tmp/fp-cr --headless=new --no-first-run --remote-debugging-port=9444 &
FOXPILOT_PORT=9444 npm run smoke
```

## Project structure
```
src/server.js            MCP server and tool definitions
src/browser.js           engine detection (BiDi/CDP), connection lifecycle, tab ids
src/page.js              code that runs inside the page (text, interactive refs, find)
scripts/smoke.mjs        end-to-end test with a local test site
scripts/make-launcher.sh builds the "<App> (AI)" launcher
launcher/                AppleScript source of the launcher
```

## License
MIT
