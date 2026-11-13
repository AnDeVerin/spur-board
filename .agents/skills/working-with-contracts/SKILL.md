---
name: working-with-contracts
description: Rules for changing packages/contracts - zod schemas, config fields, enums, journal event kinds, port contracts, breaking changes and PR order. Use when you add or change anything under packages/contracts/ or review such a diff. Don't use for package boundaries (use working-in-the-monorepo).
---

# Working with contracts

`packages/contracts/` holds the shapes every package agrees on. Where a test or lint enforces a
rule, the rule names it.

## When to use

- Any edit under `packages/contracts/`, or to `scripts/gen-config-schema.ts` or
  `scripts/gen-ops-snapshot.ts`.
- For package boundaries and dependencies, use `working-in-the-monorepo`.

## Single source of types

Each shape is defined once, as a zod schema or a named `as const` list. Read
`.agents/skills/working-with-contracts/references/single-source.md`.

## Add a config field

Read `.agents/skills/working-with-contracts/references/config-field.md`.

## Add an enum value

Read `.agents/skills/working-with-contracts/references/enum-value.md`.

## Add a journal event kind

- Add it to `EVENT_KINDS`.
- Add its payload to `eventPayloadSchemas` as `z.looseObject` (or a `z.discriminatedUnion` of
  loose objects), enum fields as `z.enum(<LIST>)`. The `satisfies` makes a missing payload a
  compile error.
- Add a `samples` entry in `packages/contracts/test/events.test.ts` and update the kind-count test
  under `describe('event kinds')` there. That is a changed expected value: list it under Changed
  checks (`gitflow`).
- An existing kind only gains optional payload fields. Renaming or removing a kind or field, or
  adding a required field, is a user-visible break.
- `parseEvent` returns `skipped` for a kind it does not know. Callers treat `skipped` as ignore,
  never as an error.
- Envelope: `eventEnvelopeSchema` is a plain `z.object` and drops unknown keys. Add a new envelope
  field to it as optional; a required one makes stored lines `invalid`, a user-visible break.
- An older version drops a new envelope field, skips a new kind, and returns `invalid` for a new
  `ACTORS` or payload enum value. None of this is breaking: reader and writer ship in the same
  package, so only `board rollback` hits it. It keeps the live database when the migration count
  is unchanged, so the older reader meets these values, and across a migration it restores the
  pre-update backup (#220).
- Do not bump `EVENT_VERSION` for a new kind, a new optional field or a new enum value. Bump it
  only for an envelope change the current reader cannot read; that bump is a user-visible break,
  and the reader keeps parsing every earlier `v`.

## Add or change an operation

Operations, error codes and typed IDs: read
`.agents/skills/working-with-contracts/references/operation.md`.

## Port contract

Adding or changing a port, its obligations or capabilities: read
`.agents/skills/working-with-contracts/references/port-contract.md`.

## Breaking changes

Read references/breaking-changes.md for the user-visible break and rename rules.

## PR order

- Contract-first for a new kind, value, port, port member or required field: the contracts PR
  merges before consumers. It may carry enforcing tooling in `scripts/`, `eslint/` or
  `packages/testkit/`. An optional field or config key may ship with its first writer and reader.
  A new required port member is the exception once implementations exist: see
  `.agents/skills/working-with-contracts/references/port-contract.md`.
- This is the contracts exception to one issue, one PR; package boundaries are in
  `working-in-the-monorepo`.
- A rename is never contract-first. An internal rename is one PR with contracts and every
  consumer.
- A user-visible rename of stored data or config is the expand PR, contracts and writers
  together; config renames get a later removal PR.

## Checks

- After a config, operation, error code, enum or ID schema change, run `pnpm gen`, commit every
  file it changes, then run `pnpm check`.
