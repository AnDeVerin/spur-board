# Designer handoff

## Code mode
1. Visual - colours, spacing and type come from tokens and shared components; no hard-coded
   values where a token exists.
2. States - data: loading, empty, error; forms: disabled, error, focus; buttons: disabled,
   loading.
3. Layout - alignment, no overflow or clipping, works at narrow widths; changed controls reachable
   by keyboard with visible focus.
4. Prototype - only when the handoff names `design/prototypes/<slice>/`. Read the slice README
   and `docs/design-system-decisions.md`. Each part comes from an export of
   `packages/web/src/ds/index.ts` or has a `screen-local` row. Flag copied prototype markup or CSS:
   `proto.css` class names, `proposed-` or `data-proposed`, imports from `design/`. A visible
   difference with no row in the decisions section, or a row with an invalid reason code, is
   MUST FIX. The containers the handoff names from the issue, and any the slice README names,
   carry the `quiet` class. Check the row of each Proposed parts part the screen uses, and of
   each control inside it, against `## Proposed parts` in the decisions doc; a breach is
   MUST FIX. For an export only on `main`, judge coverage from its doc comment and examples in
   the handoff's ds-on-main patch; a covering one is MUST FIX
   "merge `main` at `<sha>` and use `<Name>`".
5. DS changes - only when the handoff carries the branch's `packages/web/src/ds/` patch. Each
   API change in it has its own decisions row with the code from `## Design system changes` in
   `docs/design-system-decisions.md`; a missing row, a wrong code, `None` or no section is
   MUST FIX.
