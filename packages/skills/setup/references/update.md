# Update run

Use this when the installed package is older than the intended release. Keep completed configuration and operator access intact.

1. Check the package version, live Spur session Node and PATH, installed skill stamps and content, service version, and current doctor results. Ask no question already answered in config.
2. Install the newer package with the Node and user prefix visible to live Spur sessions. Verify `board --version` there. Do not reinstall a matching package.
3. If skills are older, ask before writing agent skill folders, run `board skills install`, and verify both installed copies. Record the install time so older live sessions can be identified.
   For a local same-version trial, compare packed and installed bytes too; a matching stamp can hide old content.
4. Before installing, note whether `board service status` reports `active` as `active`. Then run the new package's `board service install`: it rewrites the unit only when it differs, reloads systemd, starts a stopped service, and restarts an active service only when the unit changed. Run `board service restart` only when the service was active before install, install reported `changed` as `false`, and the daemon version changed. Do not restart twice or restart an unchanged service.
5. Run `board doctor --json` until no blocking check remains. Report live sessions that still use the older skill and ask the operator to restart those sessions. Do not assume an existing agent or MCP process reloaded updated files.
6. Never rewrite settled config, reissue an operator token, uninstall the service, or revoke a token as part of an update.
