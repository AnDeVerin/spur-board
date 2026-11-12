---
name: writing-adapters
description: Rules for packages/adapters/ - port, untrusted responses, failure kinds, rate limits, budget, fakes and tests. Use when you add or change an adapter or the runner, or review such a diff. Don't use for the port's shape (use working-with-contracts) or daemon wiring (use running-the-daemon).
---

# Writing adapters

Rules for every adapter under `packages/adapters/src/`; GitHub is the cited example unless a
rule names another. A PR that changes a practice named here updates this skill.

## When to use

- Adapter code, the runner in `packages/adapters/src/runner/`, and their tests.
- The port's shape and facts: `working-with-contracts`. Daemon wiring and call logging:
  `running-the-daemon`. The Vitest harness and CI: `testing-and-ci`.

## Port and boundary

- Implement `Adapter` and keep A1-A9 in its TSDoc in `packages/contracts/src/adapters.ts`;
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
- Parse a GraphQL root only after `GithubClient.query` classifies `errors` and its scoped errors
  are handled; denied fields arrive null, so make them nullable.
- Lint: `wireWalkerBans` in `eslint.config.js`.
- Parse normalized output with the contracts schema: `prFactsSchema.safeParse` in `normalizePr`.
  The runner re-validates each batch with `batchSchema` (`describe('batch validation')` in
  `packages/adapters/test/runner/runner.test.ts`).
- A missing or denied requested entity gets `not_found` or `no_access`; any other partial error
  clears `complete` (`pollRepository` in `packages/adapters/src/github/index.ts`).
- Unknown shape in one PR: leave it out, clear `complete`, report it `no_access` if requested;
  rethrow its error if nothing else answered. Other unknown shapes fail the poll. Never
  default a field, guess a fact, or mark a batch complete with a part missing.
- Except a denied `closingIssuesReferences` (`deniedReference`) or a `null` `requestedReviewer`:
  drop it, keep `complete`.

## Failures, backoff and budget

- One attempt per request (A6): no retry, no sleep. Reject the poll with an `AdapterError` of the
  matching kind.
- Map a failed HTTP response with `classifyHttpFailure` in `packages/adapters/src/runner/http.ts`:
  429, or 403 with a rate-limit sign, is `throttled` with `retryAt`; other 401 and 403 are `auth`;
  the rest is `transient`.
- `nextDelay` in `packages/adapters/src/runner/policy.ts` waits `authRetryMs` after `auth` or
  `config`, until `retryAt` after `throttled`, and backs off exponentially otherwise.
- GraphQL errors in a 200 response: `GithubClient.query` maps rate limiting to a synthetic 429
  and `INSUFFICIENT_SCOPES` to `auth`.
- Report the source budget in `Batch.budget`. Every GitHub query selects
  `rateLimit { remaining resetAt }`; a missing budget fails the poll. `budgetPause` pauses below
  the config key `github.reserveRemaining`.
- The runner hands each failed step and rejected report to `onFailure`; no bare `catch`.
- Runner coverage: `describe('failures')`, `describe('http failure classification')`,
  `describe('budget')`, `describe('auth and config errors')` and `describe('failure log')` in
  `packages/adapters/test/runner/runner.test.ts`.

## Tests

- Inject `vi.fn<typeof fetch>()` returning inline wire JSON, as `wire()` does in
  `packages/adapters/test/github/prBatch.test.ts` (`describe('GitHub PR batch')`).
- Runner fakes: `createFakeCore` and `createFakeAdapter` from `@spur-board/adapters/testing`.
- Module mocks are banned (`viMockBan` in `eslint.config.js`).
- Per adapter, cover a happy batch, malformed wire, each failure kind, abort and budget.

## Gaps

- No shared contract suite runs every adapter against the port.
- The fakes live in `packages/adapters/src/testing.ts`, not next to the port in contracts.
- No recorded responses; a PR adding them names their refresh command here.

## Checks

- `pnpm check`.
