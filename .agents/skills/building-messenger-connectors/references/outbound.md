# Outbound

`deliver` on `interface Gateway` in `packages/contracts/src/gateway/gateway.ts` sends one
outbox row per call.

- One attempt per call, SDK retries off (G1, `createApi` in `packages/gateway-slack/src/api.ts`);
  map every failure through one function (G2, `apiFailure`).
- `scope: 'transport'` only when the cause blocks the whole gateway or a space destination; a
  rejection of this message alone is `scope: 'message'`; an unknown outcome is `uncertain: true`.
- A failure after a confirmed step, permanent ones included, returns `retry {uncertain: true}`,
  keeping `afterMs`: part of the post is out, so the retry must carry `maybeSent` (G2, G4;
  `deliver` in `packages/gateway-slack/src/deliver.ts`).
- Never sleep, throttle or retry inside `deliver`: the sender owns the limiter, retries and
  health (`working-with-storage`).
- Return `delivered` with `message` and `permalink` only after every step (G6); core stores them
  (`deliveredRefSchema` in `packages/core/src/app/outbox.ts`) and hands them back as targets.
- A `transport` failure, or a connection down for over 5 min, raises one health item per gateway
  (`syncTransportItem` in `packages/core/src/app/sender.ts`; "transport outage" in
  `packages/daemon/test/transport-health.integration.test.ts`).
