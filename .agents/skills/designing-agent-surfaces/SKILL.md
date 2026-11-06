---
name: designing-agent-surfaces
description: Rules for what agents see from the board - MCP tool names, descriptions, schemas and annotations, and CLI output, stdout and help. Use when you change packages/cli/ or how an operation reads to an agent. Don't use for adding an operation (use adding-an-operation) or errors (use handling-errors).
---

# Designing agent surfaces

The CLI (`packages/cli/src/cli.ts`) and the MCP server (`packages/cli/src/mcp.ts`) are generated
from the catalog in `packages/contracts/src/ops/catalog.ts` and call `/v1/ops/:id` in
`packages/core/src/api/server.ts`. Fix a surface in the catalog entry or the generator, never
per operation. Errors, `usage`, hints and exit codes on every surface: `handling-errors`. A PR
that changes these rules updates this skill in the same PR.

## MCP tools

- Tool names and annotations: "Entry" and "Bindings" in
  `.agents/skills/working-with-contracts/references/operation.md`.
- `toolDescription` in `packages/cli/src/mcp.ts` joins the description, `whenToUse`,
  `whenNotToUse` and the first example. Keep the description one short sentence; lead
  `whenToUse` with the situation, and make `whenNotToUse` name the neighbour tool an agent
  should pick instead (the guidance test under `describe('catalog')` checks the form).
- `outputSchema` is the operation's `output`; the handler returns the result as
  `structuredContent`. Change the catalog output, not the tool.
- No operation has a limit, cursor, pagination or concise and detailed modes. A new list
  operation that can grow without bound states its bound or its paging shape in its issue
  before implementation.
- Tests: `describe('board mcp')` in `packages/cli/test/mcp.test.ts` and its snapshot.

## CLI

- `--json`, or stdout that is not a TTY, prints JSON; a TTY gets the human format.
- Stdout carries only the result. The idempotency key, hints and errors go to stderr.
- The CLI never prompts. A future prompt checks `isTTY` and has a flag that skips it.
- Help shows every catalog example, checked under `describe('catalog commands')` in
  `packages/cli/test/commands.test.ts`. Write examples an agent can copy.
- Human output passes daemon text through `escapeTerminalControls`
  (`packages/cli/src/terminal.ts`).

## Stdio

- `board mcp` stdout is JSON-RPC only; diagnostics go to stderr (`startMcp` in
  `packages/cli/src/mcp.ts`).
- Checks: the `no-console` rule for `packages/cli/src/` in `eslint.config.js`, the stdout test at
  the end of `packages/cli/test/mcp.test.ts`, and `handshake` in `scripts/package-smoke-mcp.ts`.
