# Port contract

Reference: `packages/contracts/src/gateway/`.

- An interface with numbered obligations in its TSDoc; members cite the ids they implement.
- Ids are append-only and never renumbered (the "obligation ids" test in
  `packages/contracts/test/gateway/source.test.ts`). A withdrawn obligation keeps its id; its text
  says it is withdrawn and why.
- Capabilities are a data object, fixed for the port's lifetime. They never make an operation
  optional or change a result's shape (G12).
- Core never branches on capabilities or the port's `kind`, never uses platform terms (the "no
  Slack fields" test in `packages/contracts/test/gateway/source.test.ts`) and never compares a
  project id literal (`local/no-project-literal-compare` in `eslint.config.js`).
- Outputs are `strictObject`, with a valid and an invalid fixture per variant keyed by a
  `Record` (pattern: `packages/contracts/test/gateway/schemas.test.ts`).
- A type test shows a minimal implementation (pattern:
  `packages/contracts/test/gateway/gateway-types.test.ts`). Opaque refs are branded.
