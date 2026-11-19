# Failures, backoff, budget and tests

## Failures, backoff and budget

- Map a failed HTTP response with `classifyHttpFailure` in `packages/adapters/src/runner/http.ts`:
  429, or 403 with a rate-limit sign, is `throttled` with `retryAt`; a 403 whose body cannot be
  read and whose headers carry no rate-limit sign is `transient`; other 401 and 403 are `auth`;
  the rest is `transient`. Board doctor reuses it and the GraphQL rules.
- `nextDelay` in `packages/adapters/src/runner/policy.ts` waits `authRetryMs` after `auth` or
  `config`, until `retryAt` after `throttled`, and backs off exponentially otherwise.
- `pollPr` retries a `transient` step-`poll` failure `DEMAND_RETRY_WAITS_MS` apart within
  `timeoutMs` (`packages/adapters/src/runner/runner.ts`).
- Report remaining budget in `Batch.budget` and reported consumption in optional `Batch.usage`
  (GitHub: `references/github-responses.md`). `budgetPause`
  pauses each bucket below `github.reserveRemaining`.
- GitHub, GitHub Issues and Jira requests run under `withTimeout` in
  `packages/adapters/src/runner/http.ts` (30 s): a timeout is `transient`, a caller abort passes
  through unchanged. Spur keeps its own 5 s timer.
- `schedule` (`packages/adapters/src/runner/runner.ts`) caps a poll wait at 2147483647 ms, the
  setTimeout limit; a longer one fires after 1 ms.
- Runner coverage: `describe('batch validation')`, `describe('failures')`, `describe('retry')`,
  `describe('http failure classification')`, `describe('budget')`,
  `describe('auth and config errors')` and `describe('failure log')` in
  `packages/adapters/test/runner/runner.test.ts`.

## Tests

- Inject `vi.fn<typeof fetch>()` returning inline wire JSON, as `wire()` does in
  `packages/adapters/test/github/prBatch.test.ts` (`describe('GitHub PR batch')`).
- Runner fakes: `createFakeCore` and `createFakeAdapter` from `@spur-board/adapters/testing`.
- Per adapter, cover a happy batch, malformed wire, each failure kind, abort and budget.
