---
name: writing-adapters
description: Rules for packages/adapters/ - port, untrusted responses, failure kinds, rate limits, budget, fakes and tests. Use when you add or change an adapter or the runner, or review such a diff. Don't use for the port's shape (use working-with-contracts) or daemon wiring (use running-the-daemon).
---

# Writing adapters

Rules for every adapter under `packages/adapters/src/`; GitHub is the cited example unless a
rule names another. A PR changing a practice named here updates this skill.

## When to use

- Adapter code, the runner in `packages/adapters/src/runner/`, and their tests.
- The port's shape and facts: `working-with-contracts`. Daemon wiring and call logging:
  `running-the-daemon`. The Vitest harness and CI: `testing-and-ci`.

## Port and boundary

- Implement `Adapter` and keep A1-A10 in its TSDoc in `packages/contracts/src/adapters.ts`;
  `describe('no wire formats')` in `packages/contracts/test/adapters.test.ts` checks A1.
- Imports: `adapterBoundaryPatterns` and `siblingPattern` in `eslint.config.js`.
- Honour `PollContext.signal` (A7): rethrow the abort and return no batch.
- Network calls go only through the injected fetch, never the global `fetch`. Pass
  `options.fetch` (`StartAdaptersOptions.fetch` in `packages/adapters/src/index.ts`) to the
  client, as `githubSources` does in `packages/adapters/src/github/index.ts`.
- A client's global default applies only when no fetch is passed; the daemon passes a logging
  one (`running-the-daemon`).
- A vendor SDK lives only inside its adapter folder, after a design decision and a lint rule that
  confines it.

## Untrusted responses

- Parse every external response with a zod wire schema that reads only the fields the adapter
  needs, through `parseWire` (`packages/adapters/src/runner/wire.ts`): a failure is `transient`
  and names the path without the value. References: `prWire`
  (`packages/adapters/src/github/prBatch.ts`), `issueWire` (`packages/adapters/src/jira/jira.ts`).
- `z.object` strips unknown keys; use `z.looseObject` only for keys read later or chosen at
  runtime (GraphQL `data`, Jira `fields`). Vendor enums are `z.string()`, mapped in code.
- GitHub GraphQL errors, partial PR batches and comment history: read
  `references/github-responses.md`.
- Lint: `wireWalkerBans` in `eslint.config.js`.
- Parse normalized output with the contracts schema: `prFactsSchema.safeParse` in `normalizePr`.
  The runner re-validates each batch with `batchSchema`.
- A missing or denied requested entity gets `not_found` or `no_access`; any other partial error
  clears `complete` (`pollRepository` in `packages/adapters/src/github/index.ts`).
- Never default a field, guess a fact, or mark a batch complete with a part missing.

## Failures, backoff and budget

- One attempt per request (A6): no retry, no sleep. Reject the poll with an `AdapterError` of the
  matching kind. The one exception, PR chunk halving: `references/github-responses.md`.
- The runner hands each failed step and rejected report to `onFailure`; no bare `catch`.
- Failure kinds, backoff, retries, budget, timeouts and runner tests:
  `references/failures-and-tests.md`.

## Tests

- Fetch fakes, runner fakes and the cases each adapter covers: `references/failures-and-tests.md`.

## Gaps

- No shared suite runs every adapter against the port.
- Fakes: `packages/adapters/src/testing.ts`.
- Recordings: `packages/stand/recordings/`; after a request change, follow `testing-and-ci`.

## Checks

- `pnpm check`.
