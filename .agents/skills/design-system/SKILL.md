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

## Component rules

- One folder per component: `<Name>/<Name>.tsx`, `<Name>.module.css`, `<Name>.examples.tsx`.
- Re-export each component by name from `index.ts`; no `export *`.
- `<Name>.examples.tsx` exports named zero-prop components, one per state or variant. The gallery
  shows each as `<Name> / <export>`.
- A component knows nothing about board data: no `@spur-board/*` import, no API client, no
  `__BOARD_VERSION__`. The app passes data in as props.
- `ds/` files import only their own `ds/` files, `tokens.css` and browser packages such as
  `react`. Other code in `packages/web/src` and `packages/web/test` imports `ds/` only through
  `index.ts`.
- `packages/web/gallery/` and `packages/web/kit/` read `ds/` directly on purpose (the gallery
  reads `tokens.css` as raw text and globs the examples files); lint does not check them.
- Enforced by `eslint/ds-import-boundary.ts` (cases in `packages/testkit/test/lint-rules.test.ts`
  `describe('design system boundary'`) and `packages/web/test/ds.test.ts`.
- Each status color sits next to a visible word; a decorative dot is `aria-hidden`.

## Tokens and themes

- `packages/web/src/ds/tokens.css` is byte-identical to `design/prototypes/board-v1/tokens.css`;
  change both together or neither (`scripts/web.test.ts`).
- Dark is the default; light applies under `data-theme="light"` on the root element. Light
  overrides only `--color-*`.
- Styles use tokens only. A raw hex or `rgb()` color outside `tokens.css` fails
  `scripts/web.test.ts`, which also scans the gallery sources.
- That scan matches "#" followed by three to eight hex-like characters anywhere in source, so
  example labels avoid text such as "PR #1234"; write "PR 1234".

## Kit and gallery

- `pnpm ds:build` runs `packages/web/kit/build.ts` and writes the git-ignored kit folder at the
  top of design/: the DS script (global `DS`, React and ReactDOM bundled as `DS.React` and
  `DS.ReactDOM`), the DS stylesheet (tokens, component styles and the fonts inlined as data
  URLs), the gallery folder, compiled prototype scripts and the build info file (commit, commit
  date, dirty flag, sorted runtime exports). No build time: one commit gives byte-identical files.
- The gallery source is `packages/web/gallery/`. It renders every example and the token table,
  with a dark and light switch that writes `?theme=`.
- Serve the gallery from a loopback static server on a port in 4780-4799, e.g.
  `python3 -m http.server 4781 --bind 127.0.0.1 --directory design`, open `/kit/gallery/`, and
  stop the server when done. It needs no network.
- `packages/web/test/kit.test.ts` builds the kit twice and checks the outputs. It runs in the
  process project; the command is in `CONTRIBUTING.md` `## Web shell`.
- Kit output never ships: the tarball allowlist in `scripts/package.ts` rejects it.

## Quiet pattern

- The board is a quiet console: muted text (`--color-text-tertiary`) turns readable on demand.
- Add the `quiet` class from `ds/index.ts` to a container (`DS.quiet` in prototypes): a card,
  column header, inbox item, status bar, panel section or history row.
- Inside it, tertiary text reads `--color-text-secondary` while the container is hovered or holds
  focus, and always under `@media (hover: none)`, since touch cannot hover.
- Elements that brighten to primary on their own hover, such as links and the theme button, keep
  doing so.
- Under hover, Chip `ghost` and `default` share a text colour; the dashed border still tells them
  apart.
- A screen issue names the containers that take `quiet`.
- `quiet` is a scoped CSS Modules class, not a global one: Vite drops CSS Modules no bundle reads,
  so use the exported name, never a literal class string.
- Examples: gallery `Quiet / Rest`, `Quiet / HoverOrFocus` and `Quiet / Brightening`.
