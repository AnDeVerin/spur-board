# Test layers, fakes, clocks and quarantine

## Layers

Pick the lowest layer that can fail for the bug you guard against. Projects are in
`vitest.config.ts`; the file name or path picks the project.

- `'unit'` - `packages/*/test/**/*.test.ts` and `scripts/**/*.test.ts`, in process, with fakes.
- `integration` - `*.integration.test.ts`. In-process wiring of several packages:
  `packages/daemon/test/restart-mid-ask.integration.test.ts` builds the daemon with
  `createE2eHarness` (`packages/daemon/test/e2e-harness.ts`) on a fake gateway, no child process.
  The harness and the stand (`packages/stand/test/stand.integration.test.ts`) share one build,
  `startInProcessDaemon` from `@spur-board/daemon/in-process`. Await its `teardown`, not
  `exited`, before removing a home: `exited` can settle while the store and lock are still held.
- `process` - tests that spawn a real process (`scripts/hooks.test.ts`,
  `packages/daemon/test/main.test.ts`, `packages/daemon/test/single-instance.test.ts`,
  `packages/stand/test/fake-cli.test.ts`); a 30 s timeout. Add a file here only when the behaviour lives in the OS process: signals, locks, exit.
  List it in both the `process` include and the `unit` exclude in `vitest.config.ts`, or it runs
  in both projects.
- `startup` - `packages/cli/test/startup.test.ts` only.
- `stand` - `packages/stand/test/scenarios.integration.test.ts` only; `integration` excludes it.
- HTTP level - adapters take an injected `fetch` (`packages/adapters/test/spur/spur.test.ts`);
  Slack code runs against the local HTTP and WebSocket fake in
  `packages/gateway-slack/src/testing.ts`.
- Contract - a gateway passes `runGatewayConformance` from `@spur-board/gateway-testkit`
  (`packages/gateway-slack/test/conformance.test.ts`).
- End to end - `scripts/package-smoke.ts` installs and exercises the packed tarball;
  `scripts/upgrade-smoke.ts` migrates from the previous published version;
  `scripts/update-smoke.ts` updates and rolls back a global install through a loopback registry
  and a fake `systemctl`; `scripts/smoke-live.ts` talks to real Slack and runs by hand only.

## Fakes, not module mocks

- Adapters and the runner: `createFakeCore`, `createFakeAdapter` from
  `@spur-board/adapters/testing` (`packages/adapters/src/testing.ts`).
- Gateways: `createFakeGateway` from `@spur-board/gateway-testkit`
  (`packages/gateway-testkit/src/fake.ts`); shared inbound and outbound cases from
  `@spur-board/gateway-testkit/cases` (`packages/gateway-testkit/src/cases.ts`).
- Stand: `createFakeSpur` (`packages/stand/src/fake-spur.ts`) and `createFakes`
  (`packages/stand/src/fakes/fetch.ts`) answer the real adapters; `pnpm stand violations` reads
  their one log together with the fake Slack API's unknown methods. A GitHub GraphQL query
  change must update `KNOWN_DOCUMENTS` in `packages/stand/src/fakes/github-pr.ts`, and a GitHub
  Issues REST call change the routes and query rules in `packages/stand/src/fakes/github-issues.ts`.
- Builders: there is no shared test-data builder yet. Inline the data while one test needs it;
  when a second test needs the same shape, move a builder into `packages/<x>/test/`.

## Clock and ids

- Core app and API functions take `clock: { now(): number }`, usually as `deps.clock` or an
  options field: `createApply` requires it; `createInbound` takes an optional `clock` and falls
  back to `Date.now`. Domain helpers such as `packages/core/src/domain/health.ts` take a plain
  `now` number. Tests pass a fixed clock and move it by hand.
- Adapters, the sender and skills install take a `now` option: `StartAdaptersOptions` and
  `RunnerOptions` (`() => number`), `SenderOptions` and `InstallSkillsOptions` (`() => Date`).
- The Slack gateway takes `createSlackGateway({ now })` (`() => number`, required) as the end of
  the recovery window; the fake Slack API takes `startFakeSlackApi({ now })` (`() => number`,
  optional) and stamps each message ts in that millisecond.
- Daemon modules read `ctx.clock`; see `running-the-daemon`.
- Stand: `pnpm stand clock +<n><s|m|h|d>` moves its one clock forward only, then ticks and
  pulses; timers stay real (`packages/stand/src/stand.ts`).
- `FakeGateway.advance()` moves the fake gateway's clock; timers use `vi.useFakeTimers`.
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
  `packages/gateway-slack/src/testing.ts` and the overlap delay in
  `packages/cli/test/skills.test.ts`.
- One existing wait is known debt, not a pattern: `packages/daemon/test/main.test.ts`
  (`describe('daemon process',`) sleeps 100 ms after SIGTERM and then asserts a positive state
  (the 503 `stopping` reply). Do not copy it; a new test waits on an event or a log line.

## Harness guarantees

Every test runs through the root config, so all of these hold:

- `pool: 'forks'` - each worker is a child process that inherits the scrubbed environment; with
  threads, the OS environment would still hold the parent's secrets.
- `packages/testkit/src/global-setup.ts` runs once before workers fork: it scrubs credential
  variables, points `HOME`, `TMPDIR` and the XDG directories at a fresh temporary root, and
  removes `DBUS_SESSION_BUS_ADDRESS` and `NOTIFY_SOCKET` so `systemctl --user` cannot reach the
  real user manager; a test that needs a user bus sets one explicitly.
- `packages/testkit/src/setup.ts` installs the network guard in each worker: a connection to a
  non-local host throws.
- Pinned by `packages/testkit/test/env.test.ts` and
  `packages/testkit/test/network.integration.test.ts`.

## What runs where

- `pnpm check` (changed mode): format and lint on changed files; types and the `unit`,
  `integration` and `process` projects for changed packages plus their dependents
  (`withDependents`, `buildSteps` in `scripts/check.ts`). `startup` and package smoke run only when
  `packages/cli` is affected, `stand` only when `packages/stand` is. `scripts/gen-docs.test.ts`
  and `packages/skills/test/skill-sync.test.ts` also run when contracts or cli is affected.
- A change to a file in `GLOBAL_FILES` or `GLOBAL_DIRS` (`scripts/check-plan.ts`), or to a
  root `tsconfig*.json`, switches to full mode; a package's own `tsconfig.json` does not.
- `pnpm run check --pre-push` (the pre-push hook): changed-file format and lint, types and `unit`
  only.
- `pnpm check:full --only test`: `unit`, `integration`, `process` and `startup`.
- CI `test` and `stand` jobs: `check:full --only test` and `--only stand` (`.github/workflows/ci.yml`).
- CI `package-smoke` job: `pnpm package:smoke` and `pnpm upgrade:smoke` on PRs, then
  `pnpm update:smoke`; on a PR it runs only when `classifyChanges` in `scripts/ci.ts` marks a
  package change. Pushes and dispatches smoke the candidate in `release-smoke`.
- `.github/workflows/nightly.yml`: runs the published package's `--version`; on failure
  `scripts/nightly.ts` opens or updates one `ci-nightly` issue.

## Flaky tests

- Quarantine: `.skip` the test with `// flaky: #<issue>` on the same line or the line above; the
  `skip-needs-flaky-issue` lint rule rejects a skip without it (`eslint/skip-needs-flaky-issue.ts`,
  `packages/testkit/test/lint-rules.test.ts`, `describe('test-file lint rules',`).
- The linked issue is open and labelled `flaky`. Fix it within one week, as the label says, or
  delete the test.
- No retries: the config sets no `retry`, and a retry hides the race instead of fixing it.
