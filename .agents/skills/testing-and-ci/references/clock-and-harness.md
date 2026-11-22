# Clock, ids and harness guarantees

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

## Harness guarantees

Every test runs through the root config, so all of these hold:

- `pool: 'forks'` - each worker is a child process that inherits the scrubbed environment; with
  threads, the OS environment would still hold the parent's secrets.
- `packages/testkit/src/global-setup.ts` runs once before workers fork: it scrubs credential
  variables, points `HOME`, `TMPDIR` and the XDG directories at a fresh temporary root, and
  removes `DBUS_SESSION_BUS_ADDRESS` and `NOTIFY_SOCKET` so `systemctl --user` cannot reach the
  real user manager; a test that needs a user bus sets one explicitly.
  It builds fresh production assets before workers in provided `webAssetsRoot`; tests inject
  that path. Failure/teardown removes it. `packages/testkit/test/web-assets.test.ts` pins this.
- Global setup writes an owner record into its root (pid, start ticks, boot id, pid
  namespace) and, before it creates the root, removes the `spur-board-test-*` roots of dead
  runs from `tmpdir()` and the system temp directory (`packages/testkit/src/sweep.ts`): owner
  gone, pid reused or earlier boot. A root without an owner record goes after 3 h of age, a root in another pid namespace or
  with a record missing a field after 24 h; age is the newer mtime of the root and its tmp directory.
  It never follows symlinks, skips other users' entries and never removes a live run's root.
- `packages/testkit/src/setup.ts` re-pins `HOME`, `TMPDIR` and the XDG directories in each
  worker to the run root from `inject('harnessRoot')`, prints a `testkit: re-pinned` line on
  stderr when a runner handed the worker other values, and throws when global setup did not
  run. Then it installs the network guard: a connection to a non-local host throws.
- Temp-dir helpers remove what they make: `openTempStore` (`packages/core/test/support/store.ts`)
  and `makeHome` (`packages/daemon/test/home.ts`) remove their directory after the test's
  afterEach hooks, or in the suite's afterAll when called outside a test. A new helper that
  makes a temp dir does the same.
- Vitest's own transformed-module copies (`join(tmpdir(), <random>)`, made by the main process
  before global setup) stay outside the run root; Vitest removes them on close, a killed run
  leaks them.
- Pinned by `packages/testkit/test/env.test.ts`, `packages/testkit/test/sweep.test.ts`,
  `packages/testkit/test/env.integration.test.ts` and
  `packages/testkit/test/network.integration.test.ts`.
