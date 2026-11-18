---
name: prototype
description: Build a screen from a prototype in design/prototypes/ - read and run it, map its parts to the design system, place proposed values, fill the Design System decisions PR section. Use when you implement a screen from a prototype. Don't use for ds/ component rules (use design-system).
---

# Prototype

A prototype under `design/prototypes/<slice>/` is the spec for a screen. Who is right when the
prototype and the design system differ, the reason codes and the PR section format live in
`docs/design-system-decisions.md`; read it before the part map.

## Read and run

- Read the prototype README: the kit commit, the states with their URLs, the proposed parts and
  the data the screen shows.
- Run it as the `## Run` section of `design/README.md` says, and open every state in the dark and
  the light theme.
- `design/prototypes/board-v1/` has no kit: every part is hand-built
  (`design/prototypes/board-v1/README.md`), so `older kit` never applies to it.

## Map before code

- Before writing code, list each part of the screen: part, the ds component that covers it (or
  none), and its reason code from `docs/design-system-decisions.md`.
- A kit older than the current `packages/web/src/ds/` is checked with the older kit command in
  that doc, including its ancestor check.
- A part shared by two or more screens, or listed as design system in the prototype README, goes
  into `packages/web/src/ds/` with examples. A part of one screen stays outside `ds/`, built from
  ds components and tokens.
- Any change under `packages/web/src/ds/` also loads the `design-system` skill.
- A part from the README's Proposed parts table, and each control inside it, follows
  `## Proposed parts` in `docs/design-system-decisions.md`.

## Values

- Every `--proposed-*` value and every literal gets a decision: an existing token or a new one,
  named in `packages/web/src/ds/tokens.css` with a value in both themes. A structural literal
  and a media query width take the `structural literal` and `breakpoint` codes instead
  (`docs/design-system-decisions.md`).
- Decide with `pnpm ds:nearest '<hex>'`, `pnpm ds:nearest '<dark hex>' '<light hex>'`,
  `pnpm ds:nearest <n>px` or `pnpm ds:nearest <number> --family <name>`; quote a hex.
  `verdict: in` with a token of the value's family means `nearest token`; otherwise look for an
  equal token of the value's family in `tokens.css` before `new token` (family rule in
  `docs/design-system-decisions.md`). A refused value follows the route the script prints.

## Build

- Never copy prototype markup or CSS into the app; rebuild each part from ds components and
  tokens.
- Screen code imports the design system only through `packages/web/src/ds/index.ts`.

## PR

- Show each prototype state next to the built screen, in both themes. Open the build on a stand
  through the board-stand Sidecar (`qa-stand` skill) at the `webUrl` that `pnpm stand up`
  prints, never through a direct loopback server. A change whose visible UI is only in
  `packages/web/src/ds/` and that no screen uses yet takes the `pnpm ds:build` gallery instead
  (`.agents/skills/qa-report/references/prototype-vs-build.md`, "The build").
- Before you return the decisions section, run
  `git diff --name-only HEAD...<sha> -- packages/web/src/ds/` with the handoff's `origin/main`
  SHA; once a designer has run in a manager run, that is the SHA fetched before it. When it lists
  an export that covers a proposed part or a control inside one, merge that SHA into the branch
  (method in `gitflow`, History) and use the export.
- Fill `## Design System decisions` in the PR body: one row per difference with its reason code
  and evidence, or the single line `None`. The format and a filled example are in
  `docs/design-system-decisions.md`.
- In a manager run, `tester` takes the pairs
  (`.agents/skills/qa-report/references/prototype-vs-build.md`); return the filled section after
  your output block.
