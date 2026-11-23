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
  namespace, machine id) and, before it creates the root, removes the `spur-board-test-*` roots
  of dead runs from `tmpdir()` and the system temp directory (`packages/testkit/src/sweep.ts`).
  On the same machine id and pid namespace it removes a root at once when the owner pid is gone,
  reused or from an earlier boot, and keeps it while the owner pid exists, even when its start
  time cannot be read. A root without an owner record goes after 3 h of age; one with no
  liveness signal (another or unknown host, another pid namespace, a record or sweeper
  missing a field, an owner of unknown state) after 24 h. Age is the newer mtime of the root
  and its tmp directory.
  It skips other users' entries and does not follow a symlinked candidate root (lstat); the
  owner record and tmp directory inside a root are read through symlinks.
- `packages/testkit/src/setup.ts` re-pins `HOME`, `TMPDIR` and the XDG directories in each
  worker to the run root from `inject('harnessRoot')`, prints a `testkit: re-pinned` line on
  stderr when a runner handed the worker other values (old `TMPDIR`, `STRYKER_MUTATOR_WORKER`,
  parent pid and executable name, never its arguments), and throws when global setup did not
  run. Then it installs the network guard: a connection to a non-local host throws.
- Temp-dir helpers remove what they make: `openTempStore` (`packages/core/test/support/store.ts`)
  and `makeHome` (`packages/daemon/test/home.ts`) remove their directory after the test's
  afterEach hooks, or in the suite's afterAll when called outside a test. A new helper that
  makes a temp dir does the same.
- Every package dir with `test/`, and `scripts/`, holds a `vitest.config.js` whose plugin
  `config()` hook throws a `testkit:` error naming the root command
  (`pnpm exec vitest run <path>`; the path picks the project). Vitest reads a config only from
  its root dir, so without it a run started there skips this harness. Not guarded: deeper dirs,
  `--config <other>`, `--config false` and IDE Vitest extensions, which load every
  `vitest.config.*` and stop on the refusals. Each copy is inlined because packages may not
  import testkit.
- Vitest's own transformed-module copies (`join(tmpdir(), <random>)`, made by the main process
  before global setup) stay outside the run root; Vitest removes them on close, a killed run
  leaks them.
- Pinned by `packages/testkit/test/env.test.ts`, `packages/testkit/test/sweep.test.ts`,
  `packages/testkit/test/env.integration.test.ts` and
  `packages/testkit/test/network.integration.test.ts`.
