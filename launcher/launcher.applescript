-- foxpilot launcher: start Firefox (or a fork such as Zen) with WebDriver BiDi on 127.0.0.1:9222,
-- so the foxpilot MCP server can drive it. If the browser already runs without it, offer a restart
-- (tabs come back via session restore). APP_NAME is filled in by scripts/make-launcher.sh.
property appName : "APP_NAME"

on portOpen()
	try
		do shell script "/usr/sbin/lsof -nP -iTCP:9222 -sTCP:LISTEN >/dev/null 2>&1"
		return true
	on error
		return false
	end try
end portOpen

if application appName is running then
	if portOpen() then
		tell application appName to activate
		return
	end if
	set answer to button returned of (display dialog appName & " is running without AI control. Restart it so Claude can use it? Your tabs will be restored." buttons {"Cancel", "Restart"} default button "Restart" with title appName & " (AI)")
	if answer is not "Restart" then return
	tell application appName to quit
	repeat 60 times
		if application appName is not running then exit repeat
		delay 0.5
	end repeat
end if
do shell script "open -a " & quoted form of appName & " --args --remote-debugging-port 9222"
