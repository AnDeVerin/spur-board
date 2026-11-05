---
name: building-messenger-connectors
description: Messenger gateway rules - obligations, conformance, inbound ack and dedupe, recover and gap, outbound results. Use when changing or reviewing packages/gateway-*/ or packages/contracts/src/gateway/. Don't use for outbox or sender (working-with-storage) or contract mechanics (working-with-contracts).
---

# Building messenger connectors

A gateway adapts one chat platform to the `Gateway` port. These rules add the judgment the
obligations leave open.

## Checklist and conformance

- G1-G15 on `interface Gateway` in `packages/contracts/src/gateway/gateway.ts` are the
  checklist; a member's TSDoc cites the ids it implements.
- Register `runGatewayConformance` with `caseIds: fakeCaseIds` against a fake of the platform
  API, as `packages/gateway-slack/test/conformance.test.ts` does with
  `packages/gateway-slack/test/fake-api.ts`.
- Set `maxTextLength` to the platform limit minus the marker overhead (`MAX_PART_TEXT` in
  `packages/gateway-slack/src/render.ts`).
- A live run passes a subset of `liveCaseIds` (`packages/gateway-testkit/src/cases.ts`, checked by
  `assertSupportedLiveCaseSet`) to `runLiveConformance`
  (`packages/gateway-slack/test/live-conformance.ts`), launched by `pnpm smoke:live`.
- A live result the fake does not reproduce gets a fake regression test or an entry under
  "Known differences" in `packages/gateway-testkit/README.md`.

## Boundary

- Import the platform SDK only inside its gateway package; no lint covers it, so review it. The
  daemon imports only the factory (`createSlackGateway` in `packages/daemon/src/composition.ts`).
- Keep wire fields and markup out of `packages/contracts/src/gateway/` and `packages/core/`;
  "no Slack fields" in `packages/contracts/test/gateway/source.test.ts` scans both.
- Platform settings may live outside the gateway as config keys in
  `packages/contracts/src/config.ts` and catalog bindings in
  `packages/contracts/src/ops/catalog.ts`.
- Refs are opaque strings the gateway builds and parses (`parseRef` in
  `packages/gateway-slack/src/ref.ts`); core stores them and never parses them.
- A new obligation, capability or event field follows
  `.agents/skills/working-with-contracts/references/port-contract.md`.

## Capabilities

- Declare `capabilities` truthfully and keep them constant (G12).
- Never make core behaviour depend on them: a difference core must act on becomes an event or
  result shape, or an obligation, through the contract change above.

## Inbound

- Live and recovered input go through one normalizer (G8,
  `packages/gateway-slack/src/normalize.ts`).
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
- `recover` works from its request alone (G10).
- Yield `gap` whenever completeness cannot be proven (`recoverThreads` in
  `packages/gateway-slack/src/recover.ts`).
- Core turns a `gap` into a "repeat your answer" item (`applyGap` in
  `packages/core/src/app/inbound.ts`).

## Outbound

- One attempt per call, SDK retries off (G1, `createApi` in `packages/gateway-slack/src/api.ts`);
  map every failure through one function (G2, `apiFailure`).
- `scope: 'transport'` only when the cause blocks the whole gateway or a space destination; a
  rejection of this message alone is `scope: 'message'`; an unknown outcome is `uncertain: true`.
- Never sleep, throttle or retry inside `deliver`: the sender owns the limiter, retries and
  health (`working-with-storage`).
- Return `delivered` with `message` and `permalink` only after every step (G6); core stores them
  (`deliveredRefSchema` in `packages/core/src/app/outbox.ts`) and hands them back as targets.
- A `transport` failure, or a connection down for over 5 min, raises one health item per gateway
  (`syncTransportItem` in `packages/core/src/app/sender.ts`; "transport outage" in
  `packages/daemon/test/transport-health.integration.test.ts`).

## Platform differences

- No history, marker search or private responses: `references/platform-differences.md`.

## Changing the rules

- A PR that changes a rule here, or the contract behind it, updates this skill in the same PR.
