# Failures, backoff, budget and tests

## Failures, backoff and budget

- Map a failed HTTP response with `classifyHttpFailure` in `packages/adapters/src/runner/http.ts`:
  429, or 403 with a rate-limit sign, is `throttled`, with `retryAt` when the headers give a
  usable time; other 401 and 403 are `auth`; the rest is `transient`. `GithubClient.query` makes
  an error body cut off after the headers `transient`. Board doctor reuses it and the GraphQL
  rules.
- `nextDelay` in `packages/adapters/src/runner/policy.ts` waits `authRetryMs` after `auth` or
  `config`, until `retryAt` after a `throttled` failure that carries one, and backs off
  exponentially otherwise, a `throttled` failure without `retryAt` included.
- `pollPr` retries a `transient` step-`poll` failure `DEMAND_RETRY_WAITS_MS` apart within
  `timeoutMs` (`packages/adapters/src/runner/runner.ts`).
- Report remaining budget in `Batch.budget` and reported consumption in optional `Batch.usage`
  (GitHub: `references/github-responses.md`). `budgetPause`
  pauses each bucket below `github.reserveRemaining`.
- GitHub, GitHub Issues and Jira requests run under `withTimeout` in
  `packages/adapters/src/runner/http.ts` (30 s unless the caller passes `timeoutMs`; the approval
  watch passes 4 s): a timeout is `transient`, a caller abort passes through unchanged. Spur keeps its own 5 s timer.
- `schedule` (`packages/adapters/src/runner/runner.ts`) caps a poll wait at 2147483647 ms, the
  setTimeout limit; a longer one fires after 1 ms.
- A source whose failure reaches the operator by code throws `AdapterError` with `code` from
  `MIRROR_FAILURE_CODES` (`packages/contracts/src/adapters.ts`); `kind` still drives backoff.
- Give such a source's runner entry `defaultFailureCode` (`startAdapters` in
  `packages/adapters/src/index.ts`): an uncoded error or invalid batch then reports that code.
  An entry without it reports a failure only for a coded error.
- The runner puts the code and message in `SourceState.failure` and clears it after a delivered
  batch; core stores it in `source_state`. Never infer the code from the message.
- Runner coverage: `describe('batch validation')`, `describe('failures')`, `describe('retry')`,
  `describe('http failure classification')`, `describe('budget')`,
  `describe('auth and config errors')` and `describe('failure log')` in
  `packages/adapters/test/runner/runner.test.ts`.

## Tests

- Inject `vi.fn<typeof fetch>()` returning inline wire JSON, as `wire()` does in
  `packages/adapters/test/github/prBatch.test.ts` (`describe('GitHub PR batch')`).
- Runner fakes: `createFakeCore` and `createFakeAdapter` from `@spur-board/adapters/testing`.
- Per adapter, cover a happy batch, malformed wire, each failure kind, abort and budget.
- Response fixtures in `test/github/fixtures/<topic>/` come in three kinds, and the test file's
  header names each file's origin (`packages/adapters/test/github/projectMirror.test.ts`):
  - live-recorded: `live-*.json`, one read-only call, scrubbed of logins and tokens, kept as
    recorded;
  - derived: a live recording with one named edit, for states the live data lacks;
  - hand-authored: only for shapes no read-only call can produce (missing scope, rate limit),
    following the vendor's documented error shape.
