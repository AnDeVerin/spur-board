# Single source of types

- Define each shape once: a zod schema (`configSchema`, `eventPayloadSchemas`,
  `inboundEventSchema`) or a named `as const` list. Never a TS `enum`.
- Derive types with `z.output`, `z.input` or `(typeof X)[number]`. No hand-written duplicate.
- Plain TS types only for what core builds and hands to a port, never parsed (header of
  `packages/contracts/src/gateway/gateway.ts`). What a port returns is a zod schema (header of
  `packages/contracts/src/gateway/schemas.ts`).
- A list lives in the module whose schema uses it (`WEEKDAYS` in
  `packages/contracts/src/config.ts`, `SPACE_IDS` in `packages/contracts/src/gateway/schemas.ts`).
  A list several modules share goes in `packages/contracts/src/enums.ts`. Schemas use
  `z.enum(<LIST>)`.
- The inline `role` list in `spurProject` is existing debt; do not copy it.
- No `.transform` or `.preprocess`: the output-mode tests in `packages/contracts/test/config.test.ts`
  and `packages/contracts/test/events.test.ts` fail.
- New exports from `packages/contracts/src/gateway/` go into the explicit list in
  `packages/contracts/src/index.ts`.
