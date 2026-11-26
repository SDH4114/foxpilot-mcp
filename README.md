# foxpilot-mcp

An MCP server that lets Claude (Claude Code, Claude Desktop) and other MCP clients control **your real Firefox** — your open tabs, your logins — over WebDriver BiDi. Works with Firefox forks such as **Zen**. No browser extension, no API keys, no tokens copied anywhere.

Official browser integrations for AI assistants are Chrome-only. Firefox already ships a standard remote-control protocol (WebDriver BiDi); foxpilot exposes it to the agent as a small set of tools.

## Tools

| Tool | What it does |
|---|---|
| `firefox_tabs` | List open tabs (id, title, URL, which one is visible) |
| `firefox_open` | Open a URL in a new tab, or navigate a given tab |
| `firefox_search` | Web search (Google, DuckDuckGo, Bing) in a new tab, returns result text |
| `firefox_read` | Page as text, or a numbered list of links/buttons/fields (`mode=interactive`) |
| `firefox_find` | Find text on the page with surrounding lines |
| `firefox_click` | Click by ref, CSS selector or visible text |
| `firefox_type` | Type into a field (replace or append), optionally press Enter |
| `firefox_key` | Press a key or combo (`Enter`, `Escape`, `Meta+a`, …) |
| `firefox_scroll` | Scroll up/down/top/bottom |
| `firefox_wait` | Wait for a selector or text |
| `firefox_screenshot` | PNG of the tab |
| `firefox_eval` | Run JavaScript in the page (fallback) |
| `firefox_close` | Close a tab |

## Requirements
- macOS (the launcher is macOS-only; the server itself is plain Node)
- Firefox or a Firefox-based browser with WebDriver BiDi. Tested on **Zen 1.24.3b**; stock Firefox uses the same remote agent but was not tested yet.
- Node.js 22.12+

## Install
```bash
git clone https://github.com/SDH4114/foxpilot-mcp.git
cd foxpilot-mcp
npm install
```

## 1. Start the browser with remote debugging
The browser must be started with `--remote-debugging-port 9222`. It listens on `127.0.0.1` only, and Firefox rejects connections from web pages (Host/Origin checks).

```bash
open -a Firefox --args --remote-debugging-port 9222   # or: open -a Zen ...
```

`open -a … --args` is ignored if the browser is already running. Easier: build a launcher app and use it instead of the normal icon. If the browser is running without the flag, it offers to restart it (tabs are restored):
```bash
npm run launcher            # creates ~/Applications/Firefox (AI).app
npm run launcher -- Zen     # creates ~/Applications/Zen (AI).app
```

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
| `FOXPILOT_IDLE_MS` | `8000` | End the browser session after this much idle time |

## Things to know
- **One controller at a time.** Firefox allows a single WebDriver BiDi session. foxpilot connects only while it works and lets go after `FOXPILOT_IDLE_MS`, so Claude Code and Claude Desktop can take turns. If a client is killed hard (`kill -9`), Firefox keeps the stale session until the browser restarts.
- While the port is open, any program on your Mac can control the browser. Web pages cannot.
- The agent acts with your logins. Keep an eye on what it does on sensitive sites.

## Tests
End-to-end smoke test through a real MCP client (opens and closes a few tabs). Run it against a throwaway headless instance, not your main browser:
```bash
/Applications/Firefox.app/Contents/MacOS/firefox --profile /tmp/foxpilot-test --no-remote --headless --remote-debugging-port 9333 &
FOXPILOT_PORT=9333 npm run smoke
```
(For Zen: `/Applications/Zen.app/Contents/MacOS/zen` with the same flags.)

## Project structure
```
src/server.js            MCP server and tool definitions
src/firefox.js           BiDi connection lifecycle, tab ids
src/page.js              code that runs inside the page (text, interactive refs, find)
scripts/smoke.mjs        end-to-end test
scripts/make-launcher.sh builds the "<Browser> (AI)" app
launcher/                AppleScript source of the launcher
```

## License
MIT
