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
| `browser_type` | Type into a text field (replace or append), optionally press Enter; refuses non-fields |
| `browser_key` | Press a key or combo (`Enter`, `Escape`, `Meta+a`, …; key names are case-insensitive) |
| `browser_scroll` | Scroll up/down/top/bottom |
| `browser_wait` | Wait for a selector or text |
| `browser_screenshot` | PNG of the tab |
| `browser_eval` | Run JavaScript in the page (fallback) |
| `browser_close` | Close a tab |

## Supported browsers

foxpilot uses your **default browser** (or `FOXPILOT_BROWSER`).

| Browser | Protocol | Profile the agent uses | Tested |
|---|---|---|---|
| Zen | WebDriver BiDi | your main profile | yes, macOS (1.24.3b) |
| Firefox, LibreWolf, Floorp, Waterfox | WebDriver BiDi | your main profile | no (same remote agent as Zen) |
| Helium | CDP | separate AI profile; main with `--main-profile` | yes, macOS (0.22.4.1) |
| Brave, Edge, Vivaldi, Arc, Opera | CDP | separate AI profile; main may be refused like Chrome | no |
| Google Chrome | CDP | separate AI profile only: since Chrome 136 remote debugging is ignored on the default profile ([details](https://developer.chrome.com/blog/remote-debugging-port)) | no |
| Safari | — | not supported (no way to attach to a running session) | — |

| OS | Status |
|---|---|
| macOS | tested |
| Windows | written, **not tested yet** (default browser from the registry, Start Menu shortcut) |
| Linux | written, **not tested yet** (default browser via `xdg-settings`, `.desktop` shortcut). Flatpak/Snap-confined browsers are not supported yet |

## Requirements
- macOS, Windows or Linux
- Node.js 22.12+

## Install
```bash
git clone https://github.com/SDH4114/foxpilot-mcp.git
cd foxpilot-mcp
npm install
```

## 1. The browser

The browser must run with remote debugging on port 9222 (only reachable from `127.0.0.1`). You usually don't have to think about it:

- **If the browser is closed**, foxpilot starts your default browser in the right mode by itself the first time the agent needs it.
- **If it is already open the normal way**, it has to be restarted once in "AI mode". Create the **Browser (AI)** shortcut and use it instead of the normal browser icon:
  ```bash
  npm run launcher                    # macOS: ~/Applications/Browser (AI).app
                                      # Windows: Start Menu → Browser (AI)
                                      # Linux: "Browser (AI)" in the app menu
  ```
  It opens the default browser in AI mode, offers to restart it if it is open without it (tabs come back if the browser restores the previous session), and tells you if another program holds the port. Rebuild it if you move this folder or change Node.

**Profiles.** Firefox-based browsers use your main profile. Chromium browsers get a separate "AI profile" (macOS `~/Library/Application Support/foxpilot/profiles/<name>`, Windows `%LOCALAPPDATA%\foxpilot\profiles\<name>`, Linux `~/.local/share/foxpilot/profiles/<name>`), started next to your normal browser; sign in there once. `npm run launcher -- --main-profile` and `FOXPILOT_MAIN_PROFILE=1` use your everyday profile instead — see Security for why that is opt-in.

Without the shortcut: `npm run start-browser` does the same from a terminal (exit code 3 = open without AI mode, 4 = port taken). By hand: `firefox --remote-debugging-port 9222` / `chromium --remote-debugging-port=9222` (macOS: `open -a <App> --args …`, ignored if the app already runs).

## 2. Connect to Claude
Windows: use `node` from PATH and the full path to `src\server.js`; the Claude Desktop config is `%APPDATA%\Claude\claude_desktop_config.json`.

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
| `FOXPILOT_BROWSER` | system default | App name (macOS, e.g. `Helium`) or executable (Windows/Linux) to use instead |
| `FOXPILOT_AUTOSTART` | on | `0` = never start the browser automatically |
| `FOXPILOT_MAIN_PROFILE` | unset | `1` = Chromium browsers use the everyday profile |
| `FOXPILOT_PROTOCOL` | `auto` | `auto`, `bidi` or `cdp`. Auto: Chromium answers `/json/version` on the port, anything else is treated as BiDi |
| `FOXPILOT_IDLE_MS` | `8000` | Let go of the browser after this much idle time |
| `FOXPILOT_ALLOW_FILE` | unset | `1` lets the agent open and read `file://` URLs |

Bad values (e.g. a non-numeric port) stop the server with a clear message.

## Security
- **Page content is untrusted.** Everything read from a page (text, element labels, titles, URLs, eval results) comes back inside `<untrusted … id=…>` markers with a random id, and the tool descriptions tell the agent it is data, not instructions. Zero-width and bidi control characters are removed. This lowers prompt-injection risk; it doesn't remove it. Keep an eye on what the agent does on sensitive sites — it acts with your logins.
- **Only http(s) pages.** `browser_open` refuses `file:`, `chrome:`, `about:` (except `about:blank`), `javascript:` and `data:` URLs, and no tool reads or controls a tab showing such a page. `FOXPILOT_ALLOW_FILE=1` allows local files.
- **Refs can't be hijacked by the page.** foxpilot remembers what each ref from `browser_read mode=interactive` was; if a page script moves or duplicates the ref to another element, the click fails instead of hitting the wrong thing.
- **Sensitive field values are masked** in `browser_read mode=interactive`: passwords (also when shown as text), one-time codes, card data. `browser_eval` and screenshots can still see them.
- **The debug port.** Both browsers listen on `127.0.0.1` only and reject requests from web pages (Host/Origin checks). But any program running as you can connect, and on Chromium that includes reading every cookie of the profile in plain text over CDP — the reason Chrome 136 turned this off for the default profile, and why Chromium browsers get a separate AI profile unless you opt in with `--main-profile`. On Firefox the cookie database is already a plain file in your profile, so the port adds little.
- foxpilot only follows a CDP debugger URL that points back to `127.0.0.1:<port>`, so a program squatting on the port can't redirect it elsewhere.

## Things to know
- **Firefox allows one controller at a time.** foxpilot connects only while it works and lets go after `FOXPILOT_IDLE_MS`, so Claude Code and Claude Desktop can take turns. If a client is killed hard (`kill -9`), Firefox keeps the stale session until the browser restarts. Chromium has no such limit.
- Firefox gives tabs new internal ids on every reconnect; foxpilot re-attaches its short tab ids by URL and position, so `tab 3` stays `tab 3` unless the tab navigated in the meantime.
- Tool calls run one at a time. Before clicking, typing, pressing keys or taking a screenshot, the tab is brought to the front.
- Elements inside iframes and shadow DOM are not listed or targeted yet.

## Tests
Unit tests (no browser, no network beyond localhost):
```bash
npm test
```

End-to-end smoke test through a real MCP client against local test pages (only `browser_search` goes online). It closes the tabs it opens, but run it against a throwaway headless instance, not your main browser:
```bash
# Firefox / Zen
/Applications/Firefox.app/Contents/MacOS/firefox --profile /tmp/fp-ff --no-remote --headless --remote-debugging-port 9333 &
FOXPILOT_PORT=9333 npm run smoke

# Chromium (Helium shown)
/Applications/Helium.app/Contents/MacOS/Helium --user-data-dir=/tmp/fp-cr --headless=new --no-first-run --remote-debugging-port=9444 &
FOXPILOT_PORT=9444 npm run smoke
```
The commands above are for macOS/Linux shells. The smoke test never starts a browser itself (it sets `FOXPILOT_AUTOSTART=0`) and waits 3 s after the port opens (`FOXPILOT_SMOKE_GRACE_MS`), because a freshly started browser may abort the first navigation.

## Project structure
```
src/server.js            MCP server and tool definitions
src/browser.js           engine detection (BiDi/CDP), connection lifecycle, tab ids
src/page.js              code that runs inside the page (text, interactive refs, find)
src/policy.js            config, URL policy, key parsing, untrusted-content wrapping (pure)
src/system.js            default browser, engine, starting it in AI mode (macOS/Windows/Linux)
src/launch.js            "Browser (AI)" launcher and its installer
scripts/smoke.mjs        end-to-end test with a local test site
test/                    unit tests (node --test, happy-dom)
```

## License
MIT
