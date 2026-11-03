---
name: working-with-contracts
description: Rules for changing packages/contracts - zod schemas, config fields, enums, journal event kinds, port contracts, breaking changes and PR order. Use when you add or change anything under packages/contracts/ or review such a diff. Don't use for package boundaries (use working-in-the-monorepo).
---

# Working with contracts

`packages/contracts/` holds the shapes every package agrees on. Where a test or lint enforces a
rule, the rule names it.

## When to use

- Any edit under `packages/contracts/`, or to `scripts/gen-config-schema.ts`.
- Not for package boundaries or dependencies: use `working-in-the-monorepo`.
- Not for the operation catalog or the error format.

## Single source of types

Each shape is defined once, as a zod schema or a named `as const` list. Read
`.agents/skills/working-with-contracts/references/single-source.md`.

## Add a config field

Read `.agents/skills/working-with-contracts/references/config-field.md`.

## Add an enum value

- Add it to the list where it is defined, at its place by meaning, not at the end. `COLUMNS`
  order is the board's left-to-right order, enforced by `checkBoard`.
- Update its pin where one exists: `packages/contracts/test/enums.test.ts` for lists in
  `packages/contracts/src/enums.ts`, the fixture `Record` in
  `packages/contracts/test/gateway/schemas.test.ts` for gateway kinds. A changed expected value is
  a Changed checks entry (`gitflow`).
- Run `pnpm typecheck` and handle every exhaustive switch (`assertNever`).
- A list config uses: run `pnpm gen:config-schema`.
- A new `COLUMNS` entry also changes `ADDRESSEE_ROLES`, the config JSON Schema, and the default
  board of every project that omits `columns`: update the default-board test in
  `packages/contracts/test/config.test.ts` and say so in the PR Description. With
  `required: true`, every config that lists `columns` without it fails: a user-visible break.
- A new value in a list the journal uses is not breaking. A `COLUMNS[].name` change is display
  text only.

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
  package, so only a downgrade hits it, and downgrades are unsupported because migrations are
  forward-only (#21).
- Do not bump `EVENT_VERSION` for a new kind, a new optional field or a new enum value. Bump it
  only for an envelope change the current reader cannot read; that bump is a user-visible break,
  and the reader keeps parsing every earlier `v`.

## Port contract

Adding or changing a port, its obligations or capabilities: read
`.agents/skills/working-with-contracts/references/port-contract.md`.

## Breaking changes

- Every workspace package is private; only spur-board will be published. A change is breaking
  only when users see it.
- User-visible: config keys and values, CLI/MCP/HTTP operations and their schemas, and data
  stored in the journal or database.
- User-visible breaks: renaming or removing a key, value, kind, field or operation; a new
  required config key, payload or envelope field; a tightened constraint; a changed meaning; a new
  required column; a `v` bump.
- A user-visible break needs `!` in the PR title (`feat(contracts)!: #N ...`) and Risk high with
  the migration described (both per `gitflow`).
- A user-visible rename of stored data or config starts with one expand PR. Contracts have no
  `.transform`; consumers map old to new in their own code. Writers in the expand PR emit only
  the new.
  - A list value: the new value replaces the old one in the list that drives behaviour
    (`COLUMN_IDS` builds the default board, `ADDRESSEE_ROLES` and `checkBoard`). Only schemas
    that read stored data accept the old one, through a separate legacy list or
    `z.enum([...LIST, 'old'])`: journal payload and envelope enums, and config until the removal
    PR. A rule that runs on the config value (`checkBoard`) must let it pass too.
  - A config key or payload field: old and new are both optional during the expand step.
  - An event kind: the old kind stays in `EVENT_KINDS` for good.
  - The journal accepts the old value, field or kind for good, so stored lines stay readable; a
    journal rename is always a user-visible break with no removal PR.
  - A config rename gets a later removal PR. It drops the old value from the config-side enum or
    rejects it with a `.refine` or `error` callback; either way the error names the replacement.
  - A break that touches only operations needs no expand step.
- Not breaking: internal types, schemas, exports, port interfaces and obligations shared between
  workspace packages. Rename them in one PR with every consumer, no `!`. Also not breaking: a new
  kind, a new optional field, a new enum value in journal data.
- Is renaming an enum value breaking? It depends where the value is visible. Follow the list up
  to a top-level schema; one grep of the list's name is not enough:
  - Run `git grep -n -w <NAME> -- packages/contracts/src` for the list and for every list or
    schema const built from it, until no new name appears.
  - Example: `COLUMNS` -> `COLUMN_IDS`, `REQUIRED_COLUMN_IDS`; `COLUMN_IDS` -> `ADDRESSEE_ROLES`,
    `columnConfig`, `eventPayloadSchemas`.
  - The chain reaches `configSchema`, `eventEnvelopeSchema`, `eventPayloadSchemas`, or an
    operation or database schema: user-visible, breaking. Otherwise internal, not breaking.
- `COLUMNS[].id` is user-visible: the doc comment in `packages/contracts/src/enums.ts` says
  everything stored or addressed uses the id (config `columns`, the journal, addressee roles).
  `COLUMNS[].name` is display text.
- A rename also follows the "Add an enum value" steps: update the pin (the changed expected value
  goes under Changed checks), run `pnpm gen:config-schema` when config uses the list, and handle
  every exhaustive switch.

## PR order

- Contract-first for a new or expanded contract (a new kind, field, value, port member or port):
  the contracts PR merges before the PRs that consume it. It may carry the tooling that enforces
  it (a `scripts/` generator, an `eslint/` rule and its tests in `packages/testkit/`).
- This is the contracts exception to one PR per package; the general rule is in
  `working-in-the-monorepo`.
- A rename is never contract-first. An internal rename is one PR with contracts and every
  consumer.
- A user-visible rename of stored data or config is the expand PR, contracts and writers
  together; config renames get a later removal PR.

## Checks

- `pnpm check`, plus `pnpm gen:config-schema` when config changed.
