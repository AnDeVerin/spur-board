# Update run

Use this when the installed package is older than the intended release. Keep completed configuration and operator access intact.

1. Check the package version, live Spur session Node and PATH, installed skill stamps and content, service version, and current doctor results. Ask no question already answered in config.
2. Install the newer package with the Node and user prefix visible to live Spur sessions. Verify `board --version` there. Do not reinstall a matching package.
3. If skills are older, ask before writing agent skill folders, run `board skills install`, and verify both installed copies. Record the install time so older live sessions can be identified.
   For a local same-version trial, compare packed and installed bytes too; a matching stamp can hide old content.
4. Compare the unit's absolute Node and daemon paths with the newly selected Node and installed package. If either path changed, run the new package's `board service install`; it rewrites the unit, reloads systemd, and restarts an active service. If paths are unchanged but the daemon version changed, run `board service restart`. Do not restart twice or restart an unchanged service.
5. Run `board doctor --json` until no blocking check remains. Report live sessions that still use the older skill and ask the operator to restart those sessions. Do not assume an existing agent or MCP process reloaded updated files.
6. Never rewrite settled config, reissue an operator token, uninstall the service, or revoke a token as part of an update.
