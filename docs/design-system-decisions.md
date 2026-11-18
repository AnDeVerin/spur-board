# Design system decisions

A screen is built from a prototype under `design/prototypes/<slice>/` (layout and rules in
[design/README.md](../design/README.md)). The prototype and the build differ in places: a part
the prototype hand-built that the design system already has, a value with no token, a kit older
than the current `packages/web/src/ds/`. This page says who is right in each case, the reason
code to record, and the PR section where each difference is listed for review.

## Who is right

From first to last; the first source that speaks decides:

1. An operator decision recorded in the task (session and date).
2. The ticket: its scope and acceptance criteria.
3. For an existing design system component or token, the code in `packages/web/src/ds/`. For a
   hand-built part or a `--proposed-*` value, the prototype.

The prototype shows intent; it never overrides a ds component that already covers the part.

## Reason codes

Each difference between the prototype and the build gets exactly one code.

| Code                        | When                                                                                                                                                                                                     | Decision                                                                                           | Evidence required                                                                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `match`                     | The prototype mounts a ds component and the build uses it the same way.                                                                                                                                  | Use the ds part as is.                                                                             | Gallery example name, e.g. `Chip / Warn`.                                                                                                                  |
| `hand-built → base as is`   | The prototype hand-built a part that a ds component already covers.                                                                                                                                      | Use the ds component; the code wins over the prototype's look.                                     | Component name and gallery example.                                                                                                                        |
| `new base`                  | A hand-built part is shared by two or more screens, or the prototype README lists it as design system.                                                                                                   | Add it to `packages/web/src/ds/` with examples.                                                    | The prototype README row, or the screens that share it.                                                                                                    |
| `screen-local`              | A hand-built part serves one screen only.                                                                                                                                                                | Build it outside `ds/` from ds components and tokens.                                              | The one screen that uses it.                                                                                                                               |
| `DS override → new variant` | The prototype restyles a ds component with screen CSS.                                                                                                                                                   | Add a variant prop and an example to the component; never override it from screen CSS.             | The new prop and its gallery example.                                                                                                                      |
| `functional gap → prop`     | A ds component lacks behaviour the screen needs.                                                                                                                                                         | Add a prop; the default behaviour stays unchanged.                                                 | The new prop and its gallery example.                                                                                                                      |
| `older kit (<commit>)`      | The prototype mounts a kit older than the current `ds/`, and the component changed since.                                                                                                                | Follow the current `ds/`.                                                                          | Output of the older kit command below.                                                                                                                     |
| `nearest token`             | `pnpm ds:nearest` gives a `--proposed-*` value or a literal `verdict: in` with a token of the value's family, or a check by hand finds a token of the value's family equal to the value.                 | Use that token of the value's family.                                                              | `pnpm ds:nearest` output with `verdict: in` listing a token of the value's family, or the family checked and the equal token.                              |
| `new token`                 | No token of the value's family equals the value: after `verdict: out`, a `verdict: in` that lists no token of its family, or a refusal, the family checked by hand in `tokens.css` holds no equal token. | Name it in `tokens.css` with a value in both themes, per the `design-system` skill's tokens rules. | `pnpm ds:nearest` output with `verdict: out` or with `verdict: in` listing no token of the value's family, or the refusal; and the family checked by hand. |
| `default change avoided`    | The prototype needs a ds component to look different from its default.                                                                                                                                   | Keep the default and pass a prop at the call site; changing a default needs `operator decision`.   | The prop passed at the call site.                                                                                                                          |
| `structural literal`        | A value places or sizes a box to its container (list below).                                                                                                                                             | Keep the literal.                                                                                  | The property and value, e.g. `.menu bottom: 100%`.                                                                                                         |
| `breakpoint`                | A viewport width in a media query (below).                                                                                                                                                               | Use an entry of `breakpoints`, written as the same literal.                                        | The entry name, e.g. `breakpoints.narrow`.                                                                                                                 |
| `ticket over prototype`     | The ticket and the prototype disagree.                                                                                                                                                                   | Build what the ticket says.                                                                        | A quote of the ticket.                                                                                                                                     |
| `operator decision`         | The operator decided the case.                                                                                                                                                                           | Follow the decision.                                                                               | Session and date of the decision.                                                                                                                          |

Record `operator decision` only for a decision the operator made in person, named in the task or
answered by the operator; an answer from the curator or a reviewer applies an existing rule, so its
row takes that rule's code (`nearest token`, `new token`, `ticket over prototype`, ...).

## Older kit

The prototype README names the kit commit from `BUILD.json`. List the changes to a component
since that commit:

```bash
git log <kit commit>..origin/main -- packages/web/src/ds/<Name>
```

The repo squash-merges, so a kit built on a branch is often not an ancestor of `main`, and the
log above lists the whole squash commit or nothing useful. Check first:

```bash
git merge-base --is-ancestor <kit commit> origin/main
```

When it exits non-zero, compare the trees instead:

```bash
git diff --stat <kit commit> origin/main -- packages/web/src/ds/<Name>
```

A change in the output means `older kit (<commit>)`; no change means the kit is current for that
component.

## Nearest token

`pnpm ds:nearest` prints the nearest token in the dark and the light theme and a verdict. Quote a
hex: an unquoted `#` starts a shell comment.

```bash
pnpm ds:nearest '#5aa8ff'            # one colour, both themes
pnpm ds:nearest '#5aa8ff' '#0969da'  # dark value, then light value
pnpm ds:nearest 13px
pnpm ds:nearest 500 --family weight  # a unitless value within one token family
```

- Colours are compared by CIEDE2000 after converting sRGB (IEC 61966-2-1) to CIELAB under the D65
  white point, with no chromatic adaptation. A colour is in when ΔE00 ≤ 5.
- Candidates are the opaque hex tokens of each theme; alpha tokens are never candidates.
- Sizes are compared by the absolute px difference against the `px` tokens. A size is in when the
  difference is ≤ 1px. A size is any CSS number with `px`, in any case (`12px`, `.5px`,
  `1.2e1px`). A negative value is compared by its size; write it as `calc(-1 * var(--token))`.
- A unitless value (a bare CSS number such as `500`, `1.4` or `0.25`) takes `--family <name>`, the
  first segment of its tokens' names in `tokens.css`: `font-weight` takes `weight`,
  `line-height` takes `leading`, `opacity` takes `opacity`, `z-index` takes `z`, `stroke-width`
  takes `stroke`, `line-clamp` takes `lines`, a unitless `border-radius` takes `radius`. The
  candidates are the unitless tokens named `--<name>` or `--<name>-*`, compared by the signed
  difference (`-1` is 2 from `1`). The limits are `leading` Δ ≤ 0.05, `opacity` Δ ≤ 0.05,
  `stroke` Δ ≤ 0.05; any other family Δ ≤ 0 (exact), so an equal value is always in. A refusal
  lists the families `tokens.css` has.
- All limits are inclusive. When several tokens share the minimum distance, the line lists all
  of them (`0.25 --family opacity` lists `--opacity-skeleton-pulse, --opacity-dimmed`); pick one
  by meaning.
- `verdict: in <tokens>` lists every token that is nearest and within the limit in both themes.
  Record `nearest token` when it lists a token of the value's family (next bullet). Otherwise,
  and on `verdict: out`, look in `tokens.css` for a token of the value's family that equals the
  value and that the script did not compare: `border-radius: 0px` equals `--radius: 0`, so run
  `pnpm ds:nearest 0 --family radius`. An equal token is `nearest token`; none is `new token`,
  with the family checked named in the evidence.
- The family rule holds for every verdict: a text size takes `--text-*`, spacing takes
  `--space-*`, an element size takes `--size-*`. When the verdict lists several tokens (`13px`
  gives `--text-body, --text-lead, --space-3, --size-icon`), pick one from the value's family; when it
  lists none from that family, check the family for an equal token as above, and record
  `new token` only when there is none. A token of another family never counts, even if it is
  nearer (a `42px` gap gives `in --size-header` and no `--space-*` equals 42px: `new token`).
- Exit 0 for any computed result, in or out; exit 2 for a refused value.

```text
$ pnpm ds:nearest '#5aa8ff'
CIEDE2000, sRGB to CIELAB D65; in when ΔE00 ≤ 5 in both themes
dark  #5aa8ff: --color-status-working #58a6ff - ΔE00 0.58 - in
light #5aa8ff: --color-border-strong #b7c0c9 - ΔE00 19.01 - out
verdict: out
```

```text
$ pnpm ds:nearest 500 --family weight
unitless difference within --weight-*; in when Δ ≤ 0 in both themes
dark  500: --weight-medium 500 - Δ 0 - in
light 500: --weight-medium 500 - Δ 0 - in
verdict: in --weight-medium
```

### Values the script refuses

Each route below ends the same way: an equal token of the value's family is `nearest token`, none
is `new token`, and the evidence names the family checked; or record `operator decision` to keep
the literal.

- A structural literal (`0`, `100%`, a keyframe stop, `1` or `-1` as a multiplier, below) stays
  literal: record `structural literal`. Check this first.
- A unitless value without `--family` (`0.6`): run it again with its property's family
  (`pnpm ds:nearest 0.6 --family opacity`).
- An alpha colour (`#rgba`, `#rrggbbaa`, `rgba(...)`): compare it by hand with the alpha
  `--color-*` tokens of each theme.
- Any other unit (`em`, `s`, `deg`, `%`): check the value's family in `tokens.css` by hand
  (`0.02em` letter spacing equals `--tracking-body`).
- A composite value such as `1px dashed var(--color-border-strong)`: run each colour or px part on
  its own; keywords such as `dashed` and `var()` parts need no check.

## Structural literals and breakpoints

Both codes apply rule 3 of [Who is right](#who-is-right): the prototype is the source of visual
values, and these values carry none. Neither is an operator decision.

- A structural literal places or sizes a box to its container and carries no visual choice:
  `0`, `100%` and `50%` (`right: 0; bottom: 100%` puts a menu above its trigger, `width: 100%`
  fills a row), `auto`, keyframe stops (`0%`, `50%`, `100%`), and `1` or `-1` as a multiplier.
  The one case relative to the box itself is centring with `translate: -50%` (`50%` times `-1`).
  Spacing, sizes, colours, radii, durations, opacities and z-indexes never qualify; they follow
  the token rules and `pnpm ds:nearest`.
- A breakpoint is a viewport width in a media query, where a custom property cannot be read. The
  list is `breakpoints` in `packages/web/src/ds/Breakpoints/Breakpoints.tsx`, exported from
  `ds/index.ts`; `narrow` is `(max-width: 760px)`. CSS writes the same literal after `@media`,
  and TS passes the entry to `matchMedia`. A new width adds an entry there first.
  `scripts/web.test.ts` fails on any other `@media` width in `packages/web/src`.

## PR section

A PR that changes UI carries a `## Design System decisions` section between `## Risk` and
`## Changed checks` (`.github/pull_request_template.md`): one row per difference between the
prototype and the build and one per change to a `ds/` part's API (`## Design system changes`),
or the single line `None` when there is none. A PR that changes no UI deletes the section.

The reviewer accepts or rejects each row; a difference missing from the section is a finding.

Filled:

```markdown
## Design System decisions

| Part           | Case                          | Decision                  | Reason code               | Evidence                                                   |
| -------------- | ----------------------------- | ------------------------- | ------------------------- | ---------------------------------------------------------- |
| Status tag     | hand-built tag in `proto.css` | `Chip` with `tone="warn"` | `hand-built → base as is` | `Chip / Warn`; `?state=default&theme=dark`                 |
| Row status dot | prototype mounts `StatusDot`  | `StatusDot` as is         | `match`                   | `StatusDot / Ok`                                           |
| Link colour    | `--proposed-link: #5aa8ff`    | `--color-status-working`  | `nearest token`           | `pnpm ds:nearest '#5aa8ff' '#0969da'` -> `verdict: in ...` |
```

None:

```markdown
## Design System decisions

None
```

## Design system changes

A change to the API of a part in `packages/web/src/ds/` is a UI change, prototype or not, so the
PR carries the decisions section with one row per API change. `None`, or no section, with a ds
API change is a finding. In a manager run the `developer` returns the section after its output
block.

API changes:

- an export added to or removed from `ds/index.ts`;
- a prop added, removed or renamed, or its type or default changed, a state prop such as `busy`
  included;
- a new member of an exported variant or tone union;
- a token added, removed, renamed or given another value in `tokens.css`;
- a part's CSS taking another token for an existing state.

Not API changes, no row of their own:

- a `<Name>.examples.tsx` change alone, doc comments and tests;
- CSS that serves only a new prop's state; that prop's row covers it;
- a change that keeps the props and the rendered output, such as a refactor or a bug fix.

Codes, all from the table above:

| Change                                                                               | Code                        |
| ------------------------------------------------------------------------------------ | --------------------------- |
| New export                                                                           | `new base`                  |
| New prop or state prop                                                               | `functional gap → prop`     |
| New variant or tone member                                                           | `DS override → new variant` |
| New token                                                                            | `new token`                 |
| Changed prop type or default, a token given another value, another token for a state | `operator decision`         |
| Removed or renamed export, prop, variant member or token                             | `operator decision`         |

The last two rows follow `default change avoided`: changing a default needs `operator decision`.
Without one recorded, a changed type or default, removal or rename is a finding: keep the type,
the default or the name and add a prop or a variant; for a token, keep the value, or add a
`new token` and use it.

## Proposed parts

A slice README lists the parts the prototype adds in a Proposed parts table. Compare each part,
and each control inside it, with `packages/web/src/ds/index.ts` on the branch merged with the
latest `main`.

- An export covers a proposed part, or a control inside one, when its doc comment or gallery
  example describes that part or control. In board-v1-1, `TextToggle` covers the History run
  toggle (a control inside History run) and the Fold toggle.
- A covered part or control uses that export. Another component in its place is a finding, even
  with a row in the decisions section.
- An uncovered part is built in the PR, with a `new base` or `screen-local` row. A covered
  control inside a built part still uses its export.
- Another component may stand in for an uncovered part only under `ticket over prototype` (the
  ticket says to wait for the issue that adds the part; quote it) or `operator decision`. The
  row's evidence also says "not in `ds/` yet" and names that issue. A stand-in row under any other
  code, or one that names no issue, is a finding.
- A covering export that landed on `main` after the branch was cut counts: merge that `main`
  into the branch first, then use the export (`prototype` skill, `## PR`).

## board-v1

`design/prototypes/board-v1/` predates the kit: it mounts no design system components and every
part is hand-built (its README, `## Kit`). `older kit` does not apply to it; decide each of its
parts with the other codes.
