# Docs index

Start with the user guides in order; contributors read the second list.

## For users

1. [Overview](overview.md): what the Board does and how tasks move through its columns.
2. [Quickstart](quickstart.md): from zero to a first task in Done with the minimal example.
3. [Setup](../SETUP.md): install the package, write the config and secrets, then install the
   service and skills.
4. [Configuration reference](configuration.md): every `config.yaml` field and secret.
5. [Troubleshooting](../TROUBLESHOOTING.md): doctor checks and their fixes; the
   [runbook](runbook.md) covers production incidents.
6. [Errors](errors.md): each error code with its recovery guidance.

### Reference

- [CLI reference](cli.md): every command and flag.
- [How the Board works](how-board-works.md) and the [web UI](web-ui.md).
- [Minimal example](../examples/minimal/): a complete Slack-free config for one repository.
- [Changelog](../CHANGELOG.md) and the [security policy](../SECURITY.md).

## For contributors

- [Contributing](../CONTRIBUTING.md): workflow, checks, versions and the changelog.
- [AGENTS.md](../AGENTS.md): the repo map, commands and rules for agents.
- [QA stand](contributing/qa-stand.md): a disposable Board for agents and tests.
- [Demo board](contributing/demo.md): the `showcase` stand scenario with every column filled.
- [Design system decisions](contributing/design-system-decisions.md): who is right when a
  prototype and the build differ, and the reason codes.
- [Design prototypes](../design/README.md): screen prototypes and their layout.
- [Live Slack conformance](../packages/gateway-testkit/README.md#live-slack-conformance): the
  maintainer check against a real Slack workspace.
