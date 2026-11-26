#!/usr/bin/env bash
# Build "~/Applications/<App> (AI).app" that starts a browser with remote debugging on port 9222.
# Usage: scripts/make-launcher.sh "<App name in /Applications>"   e.g. Firefox, Zen, Helium, "Brave Browser"
# The engine is detected from the app bundle: Gecko (Firefox and forks) or Chromium.
set -euo pipefail
app="${1:-Firefox}"
src="/Applications/$app.app"
[[ -d "$src" ]] || { echo "Not found: $src" >&2; exit 1; }

# Gecko browsers ship omni.ja and application.ini; Chromium ones ship a "<Name> Framework.framework".
if [[ -f "$src/Contents/Resources/omni.ja" || -f "$src/Contents/Resources/application.ini" ]]; then
  engine=gecko; flag="--remote-debugging-port 9222"
elif compgen -G "$src/Contents/Frameworks/*Framework.framework" >/dev/null; then
  engine=chromium; flag="--remote-debugging-port=9222"
else
  echo "Can't tell whether $app is Firefox- or Chromium-based. Safari and WebKit browsers are not supported." >&2
  exit 1
fi

out="$HOME/Applications/$app (AI).app"
here="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -t foxpilot-launcher).applescript"
trap 'rm -f "$tmp"' EXIT
sed -e "s/APP_NAME/$app/" -e "s/DEBUG_FLAG/$flag/" "$here/launcher/launcher.applescript" > "$tmp"
mkdir -p "$HOME/Applications"
rm -rf "$out"
osacompile -o "$out" "$tmp"
icon_name="$(/usr/libexec/PlistBuddy -c 'Print CFBundleIconFile' "$src/Contents/Info.plist" 2>/dev/null || true)"
[[ -n "$icon_name" && "$icon_name" != *.icns ]] && icon_name="$icon_name.icns"
[[ -n "$icon_name" && -f "$src/Contents/Resources/$icon_name" ]] && cp "$src/Contents/Resources/$icon_name" "$out/Contents/Resources/applet.icns"
codesign --force --deep -s - "$out" 2>/dev/null || true
echo "Created: $out ($engine)"
[[ "$app" == "Google Chrome" ]] && echo "Note: Chrome 136+ ignores remote debugging on the default profile; see README." >&2
exit 0
