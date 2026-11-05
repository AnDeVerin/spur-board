---
name: writing-adapters
description: Rules for packages/adapters/ - port, untrusted responses, failure kinds, rate limits, budget, fakes and tests. Use when you add or change an adapter or the runner, or review such a diff. Don't use for the port's shape (use working-with-contracts) or daemon wiring (use running-the-daemon).
---

# Writing adapters

These rules apply to every adapter under `packages/adapters/src/`; GitHub is the cited example.
A PR that changes a practice named here updates this skill.

## When to use

- Adapter code, the runner in `packages/adapters/src/runner/`, and their tests.
- The port's shape and facts: `working-with-contracts`. Daemon wiring and call logging:
  `running-the-daemon`. The Vitest harness and CI: `testing-and-ci`.

## Port and boundary

- Implement `Adapter` and keep A1-A8 in its TSDoc in `packages/contracts/src/adapters.ts`;
  `describe('no wire formats')` in `packages/contracts/test/adapters.test.ts` checks A1.
- Imports: `adapterBoundaryPatterns` and `siblingPattern` in `eslint.config.js`.
- Honour `PollContext.signal` (A7): rethrow the abort and return no batch.
- Network calls go only through the injected fetch, never the global `fetch`. Take
  `options.fetch` (`StartAdaptersOptions.fetch` in `packages/adapters/src/index.ts`) and pass it
  to the client, as `githubSources` passes `GithubOptions.fetch` to `GithubClient` in
  `packages/adapters/src/github/index.ts`.
- A client's global default applies only when no fetch is passed; the daemon always passes one,
  wrapped for logging (`running-the-daemon`).
- A vendor SDK lives only inside its adapter folder, after a design decision and a lint rule that
  confines it.

## Untrusted responses

- Check every response before use. Current practice: the `record`, `list` and `string` guards in
  `packages/adapters/src/github/client.ts` throw a transient `Malformed GitHub ...` error.
- Parse normalized output with the contracts schema: `prFactsSchema.safeParse` in `normalizePr`
  (`packages/adapters/src/github/prBatch.ts`). The runner re-validates each batch with
  `batchSchema` (`describe('batch validation')` in `packages/adapters/test/runner/runner.test.ts`).
- Unknown shape: fail the whole poll as `transient` with the cause. Never default a field, guess
  a fact, or mark a batch complete with a part missing.
- A requested entity that is missing or denied gets the `not_found` or `no_access` status; any
  other partial error clears `complete` (`pollRepository` in
  `packages/adapters/src/github/index.ts`).

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
  the reserve that `githubSources` takes from the config key `github.reserveRemaining`.
- Runner coverage: `describe('failures')`, `describe('http failure classification')`,
  `describe('budget')` and `describe('auth and config errors')` in
  `packages/adapters/test/runner/runner.test.ts`.

## Tests

- Inject `vi.fn<typeof fetch>()` returning inline wire JSON, as `wire()` does in
  `packages/adapters/test/github/prBatch.test.ts` (`describe('GitHub PR batch')`).
- Runner fakes: `createFakeCore` and `createFakeAdapter` from `@spur-board/adapters/testing`
  (`packages/adapters/src/testing.ts`).
- Module mocks are banned repo-wide (`viMockBan` in `eslint.config.js`).
- Per adapter, cover a happy batch, malformed wire, each failure kind, abort and budget.

## Gaps

- No shared contract suite runs every adapter against the port; a PR that adds one updates this
  skill.
- The fakes live in `packages/adapters/src/testing.ts`, not next to the port in contracts.
- No recorded responses: tests feed inline wire into the injected fetch. A PR that adds
  recordings updates this skill with their refresh command.

## Checks

- `pnpm check`.
