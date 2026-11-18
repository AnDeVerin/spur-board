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
- `packages/testkit/src/setup.ts` installs the network guard in each worker: a connection to a
  non-local host throws.
- Pinned by `packages/testkit/test/env.test.ts` and
  `packages/testkit/test/network.integration.test.ts`.
