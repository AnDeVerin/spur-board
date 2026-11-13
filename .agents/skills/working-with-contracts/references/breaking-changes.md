# Breaking contract changes

## Breaking changes

- Every workspace package is private; only spur-board will be published. A change is breaking
  only when users see it.
- User-visible: config keys and values, CLI/MCP/HTTP operations and their schemas, and data
  stored in the journal or database.
- User-visible breaks: renaming or removing a key, value, kind, field or operation; a new
  required config key, payload or envelope field; a tightened constraint; a changed meaning; a new
  required column; a `v` bump.
- A user-visible break needs `!` after the scope in the PR title (`feat(contracts)!: #N ...`;
  the squash commit takes the title) and Risk high with the migration described (Risk per
  `gitflow`).
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
  goes under Changed checks), run `pnpm gen` and commit every file it changes when config uses
  the list, and handle every exhaustive switch.
