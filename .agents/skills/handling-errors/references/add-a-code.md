# Add or change an error code

## Entry

- Add the entry to `ERRORS` in `packages/contracts/src/errors.ts` through `spec()`, next to codes
  of the same meaning. The order is pinned: update the code table in
  `packages/contracts/test/errors.test.ts` `describe('error catalog')`.
- `status` is the HTTP status the daemon answers with, or `null` for a code the client raises.
  Only codes with a status are in `ServerErrorCode`, so only they can be thrown as
  `CommandError` or listed on an operation.
- `exit`: `outcomeUnknown` (5) exactly when `recovery.sideEffects` is `unknown`. Codes 1 to 4
  have no side effects, except `service_start_failed` (4, `applied`: the unit stays installed),
  so pick among them by what the daemon did with the call:
  - `notApplied` (3): the daemon could not evaluate the call - identity, startup, catalog
    version or reachability (`identity_unavailable`, `starting`, `version_mismatch`,
    `daemon_unavailable`);
  - `refused` (1): the daemon evaluated the call and rejected it, even when an operator action
    would let the same call pass later (`forbidden`, `not_implemented`, `task_archived`);
  - `usage` (2): the call is malformed (`usage`, `wrong_id_kind`);
  - `config` (4): the client's configuration must be fixed (`config`).
- Build `recovery` with the helpers in `packages/contracts/src/errors.ts`: `noRetry`, `retry`,
  `unknownOutcome` or `unexpectedOutcome`. Write a literal only when none fits.
- `recoverySchema` requires `outcomeCheck` when `sideEffects` is `unknown`, and
  `describe('error catalog')` requires that `outcomeCheck` says `before retry` and `action` says
  `same idempotency key`.
- `context` keys come only from `errorContextSchema`; a new key is a schema change there.
- Write `message`, `hint` and any `mcp` variant by the "Hints" rules of this skill.

## Operations

- List the code on the operations that raise it: follow
  `.agents/skills/working-with-contracts/references/operation.md` "Grants and errors".

## Pinned text

- Editing an existing `hint` or `recovery` can break expected strings in
  `packages/contracts/test/errors.test.ts` (`describe('error catalog')`,
  `describe('error representations')`), `packages/contracts/test/fixtures/identity-unavailable.txt`,
  `packages/skills/test/skill-sync.test.ts` and `packages/cli/test/commands.test.ts`.
- Each changed expected value is a Changed checks entry (`gitflow`).

## Generated outputs

- Run `pnpm gen`: it rewrites `docs/errors.md`, `docs/cli.md`,
  `packages/contracts/ops.snapshot.json` and the product skill in `packages/skills/spur-board/`.
- Without it these fail: `describe('generated error documentation')` in
  `packages/contracts/test/errors.test.ts`, `describe('generated public references')` in
  `scripts/gen-docs.test.ts`, `describe('snapshot')` in `packages/contracts/test/ops.test.ts` and
  `describe('product skill sync')` in `packages/skills/test/skill-sync.test.ts`.
- `catalogVersion` in `packages/contracts/src/ops/snapshot.ts` hashes `ERRORS`, so any entry
  edit gives `version_mismatch` until the daemon restarts.

## Breaking changes

- Renaming or removing a code, or changing its `status` or `exit`, is a user-visible break:
  follow `.agents/skills/working-with-contracts/references/breaking-changes.md`.
