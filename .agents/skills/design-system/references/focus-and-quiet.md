# Focus ring and quiet pattern

## Focus ring

- Every focusable ds part shows one ring on `:focus-visible`:
  `outline: var(--width-ring) solid var(--color-status-working)` and
  `outline-offset: var(--offset-ring)`.
- Text fields are the one exception: focus turns the border primary, with a transparent
  `var(--width-ring)` outline for forced colours mode; their buttons, such as Clear, take the ring.
- A screen, the gallery included, never defines its own ring; `scripts/web.test.ts` rejects any
  other outline, and any outline in CSS under `src/` outside `src/ds/`. A focusable screen element
  with no ds component, such as a card link, takes the `focusRing` class from `ds/index.ts`.
  Native elements in example scaffolding keep the browser ring.
- Disabled controls are not focusable, except a disabled HoverMenu item: it keeps roving focus
  and the ring, and is announced as disabled with its cause.
- Each focusable component has a `Focused` example whose caption names the keys to press.

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
