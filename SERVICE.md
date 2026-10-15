# Content calendar service

Open http://localhost:4321. The production server runs from this project and reads the existing `~/Movies/reels` library and this project's `plans/` folder.

macOS launchd starts the service at login and restarts it if it exits, with a 10-second restart throttle. It runs independently of terminals and T3. Access requires this Mac to be awake and the user to be logged in. Port 4321 stays fixed; do not reclaim it for another project.

- LaunchAgent: `~/Library/LaunchAgents/local.reels-calendar.plist`
- Service label: `local.reels-calendar`
- Logs: `~/Library/Logs/reels-calendar/stdout.log` and `stderr.log`
- Runtime: `/opt/homebrew/bin/node`

Check the service:

```sh
launchctl print "gui/$(id -u)/local.reels-calendar"
curl --fail http://localhost:4321/api/state
```

The service serves the built `dist/` files. When the user requests a code update, run `pnpm build` here. Server changes require a restart and a brief interruption; perform that only with the user's authorization:

```sh
launchctl kickstart -k "gui/$(id -u)/local.reels-calendar"
```

Use a different free port and isolated plan fixtures for development or tests. Keep this service and the user's real plans running undisturbed.
