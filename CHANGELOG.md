# Changelog

Notable changes in each spur-board release, newest first. A breaking change lists what changed and how to migrate the config under **BREAKING CHANGES**; the versioning policy is in [CONTRIBUTING.md](CONTRIBUTING.md#versions-and-the-changelog). Releases before this file, and any release not listed here, are on the [GitHub releases page](https://github.com/AnDeVerin/spur-board/releases).

## Upgrade notes from earlier releases

### 0.58.0

Change a dedicated worker column executor to `role: orchestrator`. For operator execution use the literal `orchestrator: operator`, rather than the name of an operator project. Curator executors remain supported.
