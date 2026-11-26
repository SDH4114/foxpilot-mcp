#!/usr/bin/env bash
# Build "~/Applications/<Browser> (AI).app" that starts the browser with remote debugging.
# Usage: scripts/make-launcher.sh [Firefox|Zen|<any Firefox-based app name>]   (default: Firefox)
set -euo pipefail
app="${1:-Firefox}"
src="/Applications/$app.app"
[[ -d "$src" ]] || { echo "Not found: $src" >&2; exit 1; }
out="$HOME/Applications/$app (AI).app"
here="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -t foxpilot-launcher).applescript"
trap 'rm -f "$tmp"' EXIT
sed "s/APP_NAME/$app/" "$here/launcher/launcher.applescript" > "$tmp"
mkdir -p "$HOME/Applications"
rm -rf "$out"
osacompile -o "$out" "$tmp"
icon="$(ls "$src"/Contents/Resources/firefox.icns 2>/dev/null || true)"
[[ -n "$icon" ]] && cp "$icon" "$out/Contents/Resources/applet.icns"
codesign --force --deep -s - "$out" 2>/dev/null || true
echo "Created: $out"
