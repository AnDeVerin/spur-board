/**
 * The design system's breakpoints: named media queries, the only viewport widths a style may use.
 * A media query cannot read a custom property, so CSS writes the same text after `@media`
 * (`@media (max-width: 760px)`) and TS passes the entry itself (`matchMedia(breakpoints.narrow)`).
 * A new width adds an entry here first; `scripts/web.test.ts` rejects any other `@media` width in
 * `packages/web/src` (`docs/contributing/design-system-decisions.md`, code `breakpoint`).
 *
 * `narrow`: a phone or a narrow window; the board tightens its side padding.
 */
export const breakpoints = { narrow: '(max-width: 760px)' } as const;
