# Platform differences

A platform may lack history, marker search or private responses. The gateway still meets every
obligation in `packages/contracts/src/gateway/gateway.ts`; only the means change.

- `history: false`: rely on the platform redelivering events to a gateway that acks late (G11),
  and yield `gap` for what `recover` cannot return (G10, G12).
- `markerSearch: false`: with `maybeSent`, repeat the message or each part with a repeat mark, or
  open a second conversation carrying the same key (G3, G4).
- `privateResponses: false`: with `private: true`, `respond` posts nothing and returns `dropped`
  (G15).
- Test core against both fake `profiles`, `slack-like` and `telegram-like`
  (`packages/gateway-testkit/src/fake.ts`; `PROFILES` in
  `packages/core/test/app/outbox.restart.test.ts`).
