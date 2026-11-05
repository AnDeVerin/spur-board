# Security policy

## Supported versions

Only the latest release of `spur-board` gets security fixes. Check that the problem still exists
in it before you report.

## Report a vulnerability

Report it privately through GitHub:
[Report a vulnerability](https://github.com/AnDeVerin/spur-board/security/advisories/new) on the
repository's Security tab. Do not open a public issue or pull request for it. Include the
version, the steps to reproduce and the impact you see.

## Secrets

Never commit tokens, keys or other secrets. Keep them in private local files as
[SETUP.md](SETUP.md) describes. gitleaks scans staged changes in the pre-commit hook, each pull
request's diff in CI, and the full history in a weekly CI scan. If a secret reaches a commit,
revoke it first; removing it from the history does not make it safe again.

For the contribution flow, see [CONTRIBUTING.md](CONTRIBUTING.md).
