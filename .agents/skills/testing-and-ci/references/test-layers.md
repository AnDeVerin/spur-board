# Test layers, fakes, clocks and quarantine

## Layers

Pick the lowest layer that can fail for the bug you guard against. Projects are in
`vitest.config.ts`; the file name or path picks the project.

- `'unit'` - `packages/*/test/**/*.test.ts` and `scripts/**/*.test.ts`, in process, with fakes.
- `integration` - `*.integration.test.ts`. In-process wiring of several packages:
  `packages/daemon/test/restart-mid-ask.integration.test.ts` builds the daemon with
  `createE2eHarness` (`packages/daemon/test/e2e-harness.ts`) on a fake gateway, no child process.
- `process` - tests that spawn a real process (`scripts/hooks.test.ts`,
  `packages/daemon/test/main.test.ts`, `packages/daemon/test/single-instance.test.ts`); a 30 s
  timeout. Add a file here only when the behaviour lives in the OS process: signals, locks, exit.
- `startup` - `packages/cli/test/startup.test.ts` only; timing-sensitive, kept apart.
- HTTP level - adapters take an injected `fetch` (`packages/adapters/test/spur/spur.test.ts`);
  Slack code runs against the local HTTP and WebSocket fake in
  `packages/gateway-slack/test/fake-api.ts`.
- Contract - a gateway passes `runGatewayConformance` from `@spur-board/gateway-testkit`
  (`packages/gateway-slack/test/conformance.test.ts`).
- End to end - `scripts/package-smoke.ts` installs and exercises the packed tarball;
  `scripts/upgrade-smoke.ts` migrates from the previous published version;
  `scripts/smoke-live.ts` talks to real Slack and runs by hand only.

## Fakes, not module mocks

- `vi.mock` and `vi.doMock` fail lint (`viMockBan` in `eslint.config.js`). Pass the dependency in
  and give the test a fake or a local server.
- Adapters and the runner: `createFakeCore`, `createFakeAdapter` from
  `@spur-board/adapters/testing` (`packages/adapters/src/testing.ts`).
- Gateways: `createFakeGateway` from `@spur-board/gateway-testkit`
  (`packages/gateway-testkit/src/fake.ts`); shared inbound and outbound cases from
  `@spur-board/gateway-testkit/cases` (`packages/gateway-testkit/src/cases.ts`).
- Builders: there is no shared test-data builder yet. Inline the data while one test needs it;
  when a second test needs the same shape, move a builder into that package's `test/`.

## Clock and ids

Production code never reads `Date.now()` where a test needs to control time; it takes a seam.

- Core app and API functions take `clock: { now(): number }`, usually as `deps.clock` or an
  options field: `createApply` requires it; `createInbound` takes an optional `clock` and falls
  back to `Date.now`. Domain helpers such as `packages/core/src/domain/health.ts` take a plain
  `now` number. Tests pass a fixed clock and move it by hand.
- Adapters, the sender and skills install take a `now` option: `StartAdaptersOptions` and
  `RunnerOptions` (`() => number`), `SenderOptions` and `InstallSkillsOptions` (`() => Date`).
- Daemon modules read `ctx.clock`; see `running-the-daemon`.
- Test controls: `vi.useFakeTimers` for timers, `FakeGateway.advance()` for the fake gateway's
  clock.
- Ids: there is no id seam. Commands take an idempotency `key` and generate a random one only
  when it is missing (`createApply`); a test that asserts on an id passes its own `key`.

## Waits

- Waiting for something to happen uses `vi.useFakeTimers`, an injected clock, `vi.waitFor` or an
  awaited event or promise. Never a fixed sleep followed by a positive assertion.
- A short, bounded real wait is allowed only to assert that nothing happened within a window,
  e.g. no second exit after shutdown in `packages/daemon/test/lifecycle.test.ts`
  (`describe('runDaemon',`) and the timer checks in `packages/daemon/test/systemd.test.ts`.
- The rule covers waits before an assertion. A delay inside a fake that only keeps calls
  overlapping or imitates a slow server is outside it, e.g. the timeout delays in
  `packages/gateway-slack/test/fake-api.ts` and the overlap delay in
  `packages/cli/test/skills.test.ts`.
- One existing wait is known debt, not a pattern: `packages/daemon/test/main.test.ts`
  (`describe('daemon process',`) sleeps 100 ms after SIGTERM and then asserts a positive state
  (the 503 `starting` reply). Do not copy it; a new test waits on an event or a log line.

## Harness guarantees

Every test runs through the root config, so all of these hold:

- `pool: 'forks'` - each worker is a child process that inherits the scrubbed environment; with
  threads, the OS environment would still hold the parent's secrets.
- `packages/testkit/src/global-setup.ts` runs once before workers fork: it scrubs credential
  variables and points `HOME`, `TMPDIR` and the XDG directories at a fresh temporary root, so no
  test reads or writes the real home.
- `packages/testkit/src/setup.ts` installs the network guard in each worker: a connection to a
  non-local host throws, so a test cannot reach a real service by accident. A spawned child is not
  guarded; give it its own isolation (`BOARD_HOME`, a local server).
- Pinned by `packages/testkit/test/env.test.ts` and
  `packages/testkit/test/network.integration.test.ts`.

## What runs where

- `pnpm check` (changed mode): format and lint on changed files; types and the `unit`,
  `integration` and `process` projects for changed packages plus their dependents
  (`withDependents`, `buildSteps` in `scripts/check.ts`). `startup` and package smoke run only when
  `packages/cli` is affected.
- A change to a file in `GLOBAL_FILES` or `GLOBAL_DIRS` (`scripts/check-plan.ts`), or to a
  `tsconfig*.json`, switches to full mode.
- `pnpm run check --pre-push` (the pre-push hook): changed-file format and lint, types and `unit`
  only.
- `pnpm check:full --only test`: all four projects plus `scripts/package-smoke.ts`.
- CI `test` job: `check:full --only test` on Node 24 and 26 (`.github/workflows/ci.yml`).
- CI `package-smoke` job: `pnpm package:smoke`, then `pnpm upgrade:smoke`. On a PR it runs only
  when `classifyChanges` in `scripts/ci.ts` marks a package change.
- `.github/workflows/nightly.yml`: runs the published package's `--version`; on failure
  `scripts/nightly.ts` opens or updates one `ci-nightly` issue.
- `pnpm smoke:live`: by hand only, from an interactive terminal (`AGENTS.md`).

## Flaky tests

- Quarantine: `.skip` the test with `// flaky: #<issue>` on the same line or the line above; the
  `local/skip-needs-flaky-issue` lint rejects a skip without it (`eslint/skip-needs-flaky-issue.ts`,
  `packages/testkit/test/lint-rules.test.ts`, `describe('test-file lint rules',`).
- The linked issue is open and labelled `flaky`. Fix it within one week, as the label says, or
  delete the test.
- No retries: the config sets no `retry`, and a retry hides the race instead of fixing it.
- `pnpm guardrails` reports every added `.skip`, so the PR names it under Changed checks.
