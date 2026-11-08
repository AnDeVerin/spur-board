---
name: building-messenger-connectors
description: Messenger gateway rules - obligations, conformance, inbound ack and dedupe, recover and gap, outbound results. Use when changing or reviewing packages/gateway-*/ or packages/contracts/src/gateway/. Don't use for outbox or sender (working-with-storage) or contract mechanics (working-with-contracts).
---

# Building messenger connectors

A gateway adapts one chat platform to the `Gateway` port.

## Checklist and conformance

- G1-G15 on `interface Gateway` in `packages/contracts/src/gateway/gateway.ts` are the
  checklist; a member's TSDoc cites the ids it implements.
- Register `runGatewayConformance` with `caseIds: fakeCaseIds` against a fake of the platform
  API, as `packages/gateway-slack/test/conformance.test.ts` does with
  `packages/gateway-slack/test/fake-api.ts`.
- Set `maxTextLength` to the platform limit, less any marker or repeat mark rendered in the
  text. Slack keeps its marker out of the text, so its target uses the limit itself
  (`MAX_PART_TEXT` in `packages/gateway-slack/src/render.ts`).
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

- Declare `capabilities` truthfully (G12); the port contract file above has the other rules.
- A platform difference core must act on becomes an event or result shape, or an obligation,
  never a capability core reads.

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
  `packages/gateway-slack/src/recover.ts`). Copy its `gap` cases, not the rate-limit sleep in
  `readThread`: that loop breaks G1 and is a known deviation.
- Core turns a `gap` into a "repeat your answer" item (`applyGap` in
  `packages/core/src/app/inbound.ts`).

## Outbound

- Read `references/outbound.md` before changing `deliver`: one attempt per call (G1), failure
  mapping (G2), steps and results (G4, G6), and the health items core raises.

## Platform differences

- No history, marker search or private responses: `references/platform-differences.md`.

## Changing the rules

- A PR that changes a rule here, or the contract behind it, updates this skill in the same PR.
