---
name: design-system
description: Rules for packages/web/src/ds/ - components, examples, tokens, themes, the quiet class, the kit and gallery. Use when you add or change a ds/ component or its examples, or run pnpm ds:build. Don't use for prototypes under design/ (use design/README.md) or other web code (use AGENTS.md).
---

# Design system

## What and where

- The design system is the shared UI of the web shell: `packages/web/src/ds/`.
- `packages/web/src/ds/index.ts` is the only entry; what it exports is the design system. It also
  imports `tokens.css`, so app code gets the tokens through it.
- Screen components (task card, task panel) live outside `ds/` and are built from it.
- Prototypes mount the same components from the kit as `DS.<Name>`; layout and rules:
  `design/README.md`.
- Building a screen from a prototype: `prototype` skill; prototype vs `ds/` differences and reason
  codes: `docs/design-system-decisions.md`.

## Component rules

- One folder per component: `<Name>/<Name>.tsx`, `<Name>.module.css`, `<Name>.examples.tsx`.
- Re-export each component by name from `index.ts` as `export { ... } from './<Name>/<Name>.tsx'`;
  no other value export (`export *`, local `export { x }`, `export const`, `export default`).
  Type-only exports are free. `packages/web/test/ds.test.ts` enforces it.
- `<Name>.examples.tsx` exports named zero-prop components, one per state or variant. The gallery
  shows each as `<Name> / <export>`.
- A component knows nothing about board data: no `@spur-board/*` import and no API client. The
  app passes data in as props.
- `ds/` files import only their own `ds/` files, `tokens.css` and browser packages such as
  `react`. Other code in `packages/web/src` and `packages/web/test` imports `ds/` only through
  `index.ts`.
- `packages/web/gallery/` and `packages/web/kit/` read `ds/` directly on purpose (the gallery
  reads `tokens.css` as raw text and globs the examples files); lint does not check them.
- Enforced by `eslint/ds-import-boundary.ts` (cases in `packages/testkit/test/lint-rules.test.ts`
  `describe('design system boundary'`) and `packages/web/test/ds.test.ts`.
- Each status color sits next to a visible word, or next to its own value text with the word
  visually hidden; a decorative dot is `aria-hidden`.
- A ds part whose placement measures its anchor or the window uses `@floating-ui/dom` (catalog,
  exact pin), not hand-written measuring (#776). CSS-only placement against the part's own
  trigger, as in `HoverMenu`, is exempt.
- A ds API change takes its own decisions row, returned after your output in a manager
  run: `docs/design-system-decisions.md`, `## Design system changes`.

## Tokens and themes

- Tokens stay byte-identical to `design/prototypes/board-v1/tokens.css`
  except exact operator-authorized differences (`scripts/web-tokens.test.ts`).
- Dark is the default; light applies under `data-theme="light"` on the root element. Light
  overrides only `--color-*`.
- Styles use tokens only, except structural literals and `@media` widths from `breakpoints`
  (`docs/design-system-decisions.md`). A raw hex or `rgb()` color outside `tokens.css` fails
  `scripts/web.test.ts`, which also scans the gallery sources.

## Kit and gallery

- The gallery source is `packages/web/gallery/`. It renders every example and the token table,
  with a dark and light switch that writes `?theme=`.
- What `pnpm ds:build` writes, serving the gallery and the kit test:
  `references/kit-and-gallery.md`.
- Kit output never ships: the tarball allowlist in `scripts/package.ts` rejects it.

## Focus ring and quiet pattern

- Focus ring (`:focus-visible`, the `focusRing` class) and the `quiet` container class: rules and
  exceptions in `references/focus-and-quiet.md`.
