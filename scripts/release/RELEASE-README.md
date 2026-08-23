# Nudge edge build

This archive contains a pinned Node runtime, compiled server code, the built
web console, production dependencies, and Nudge's bundled skills.

Keep runtime state outside this directory. By default Nudge uses
`$XDG_CONFIG_HOME/nudge`, or `~/.config/nudge` when that variable is unset.
Put `.env` there and run every command from that directory:

```bash
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/nudge"
cd "${XDG_CONFIG_HOME:-$HOME/.config}/nudge"
cp /path/to/extracted-nudge/.env.example .env
$EDITOR .env
/path/to/extracted-nudge/bin/nudge console
```

Open `http://localhost:3100`, finish setup, then run the agent server in a
separate terminal or service:

```bash
cd "${XDG_CONFIG_HOME:-$HOME/.config}/nudge"
/path/to/extracted-nudge/bin/nudge run
```

Use `bin/nudge help` for commands. `BUILD.json` records the exact source commit
and Node version. The `edge` release changes after every push to `main`, so keep
that file when reporting a problem.

To update, extract the new archive elsewhere and point your service at its
`bin/nudge`. Do not move or replace the configuration directory. It contains
credentials, configuration, and conversation history.
