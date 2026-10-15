# Persistent calendar service

Port 4321 is the user's persistent content calendar, managed by the macOS LaunchAgent `local.reels-calendar`. Keep it running during development and process cleanup. Use a different free port for tests and temporary servers; never kill a process to reclaim 4321.

For service configuration, logs, or a user-requested update, read [SERVICE.md](SERVICE.md). Restart this service only when the user authorizes an interruption.
