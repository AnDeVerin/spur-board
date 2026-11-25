# Inbound and recover

## Inbound

- Live and recovered input go through one normalizer (G8,
  `packages/gateway-slack/src/normalize.ts`).
- Read Slack payloads through `packages/gateway-slack/src/wire.ts` or zod; `wireWalkerBans` in
  `eslint.config.js` covers gateway `src/` except `testing.ts`.
- Ack only after `sink` resolves; a rejected sink is not acked (G11, `function handle` in
  `packages/gateway-slack/src/socket.ts`, conformance case `ack-after-sink`).
- Build `dedupeKey` from stable platform ids; an edit and a deletion get keys of their own (G9);
  `connection` and `gap` keys are unique per occurrence (G14).
- Since #36 (PR #115) `message`, `message_edited`, `message_deleted`, `mention` and `action`
  require `rootMessage` and `sourceUrl`; `command` requires only `sourceUrl`, the space link.
- `action` requires `sourceSpace`: the configured space, or `null` when it came from outside;
  `command` may carry it.
- Never guess a space: core denies an action whose `sourceSpace` is `null`
  (`packages/core/src/app/inbound.ts`).

## Reconnect, recover and gap

- Emit `connection` `up` after every connect, the first included, and `down` only on a real
  loss (G13). Core runs `recover` on `up`.
- The Slack gateway owns its reconnect loop (`createSocket` in
  `packages/gateway-slack/src/socket.ts`): SDK autoReconnect is off, every `down` schedules an
  attempt on a fresh client until `stop()`, and SDK debug lines never reach the log
  (`packages/gateway-slack/test/socket.test.ts`, `describe('Socket Mode reconnect')`).
- A refresh `disconnect` (`refresh_requested`, `warning`) is a handover, not a drop:
  `RefreshingClient` keeps the old socket serving, the replacement opens at once, and the old one
  closes after the replacement's hello and its envelopes in flight, with no `connection` event.
  Two clients live during a handover, briefly a third when the replacement gets its own refresh
  while the retired client still drains. A retired client emits no `connection` event, no
  `slack socket ...` line and no SDK line, but still handles its envelopes, so a rejected one
  still reaches `onError` (`slack envelope failed`); it closes once they settle
  (`packages/gateway-slack/test/socket-handover.test.ts`).
- `recover` works from its request alone (G10).
- Yield `gap` whenever completeness cannot be proven (`recoverThreads` in
  `packages/gateway-slack/src/recover.ts`). Copy its `gap` cases, not the rate-limit wait in
  `readThread`: that retry breaks G1 and is a known deviation. Its waits share a per-thread
  budget; a wait past the budget becomes a `gap`.
- Stop reading when `RecoverRequest.signal` aborts and yield no `gap` for it (G10); race a read
  that cannot be cancelled against the abort, as `readThread` does.
- Core turns a `gap` into a "repeat your answer" item (`applyGap` in
  `packages/core/src/app/inbound.ts`).
