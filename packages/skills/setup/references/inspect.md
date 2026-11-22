# Inspect

- Check Linux, systemd user services, npm, `flock`, and Node 24.12+ (24.x) or 26.x. Read the PATH and Node executable from a live Spur session and check its version; the interactive shell may use another Node. Stop with a specific fix for any missing prerequisite.
- Check Spur through its HTTP API, or run its CLI from the home folder. The running Spur daemon must be Spur 1.53.0 or newer; `board doctor` reports it as `spur.version`. `spur --version` shows the installed CLI, not the daemon, so restart the Spur daemon after upgrading Spur. Running it inside a folder with `spur.yaml` can attach that folder to the daemon.
- Locate `config.yaml` and `secrets.env` under `$XDG_CONFIG_HOME/spur-board/` (default `$HOME/.config/spur-board/`), or under `$BOARD_HOME` when set. Inspect configured fields, required secret _names_ and file modes, package and skill versions, service status, operator access, and product-skill visibility. Never print private file contents.
