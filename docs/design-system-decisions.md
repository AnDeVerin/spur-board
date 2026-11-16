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

| Code                        | When                                                                                                   | Decision                                                                                           | Evidence required                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `match`                     | The prototype mounts a ds component and the build uses it the same way.                                | Use the ds part as is.                                                                             | Gallery example name, e.g. `Chip / Warn`.                     |
| `hand-built → base as is`   | The prototype hand-built a part that a ds component already covers.                                    | Use the ds component; the code wins over the prototype's look.                                     | Component name and gallery example.                           |
| `new base`                  | A hand-built part is shared by two or more screens, or the prototype README lists it as design system. | Add it to `packages/web/src/ds/` with examples.                                                    | The prototype README row, or the screens that share it.       |
| `screen-local`              | A hand-built part serves one screen only.                                                              | Build it outside `ds/` from ds components and tokens.                                              | The one screen that uses it.                                  |
| `DS override → new variant` | The prototype restyles a ds component with screen CSS.                                                 | Add a variant prop and an example to the component; never override it from screen CSS.             | The new prop and its gallery example.                         |
| `functional gap → prop`     | A ds component lacks behaviour the screen needs.                                                       | Add a prop; the default behaviour stays unchanged.                                                 | The new prop and its gallery example.                         |
| `older kit (<commit>)`      | The prototype mounts a kit older than the current `ds/`, and the component changed since.              | Follow the current `ds/`.                                                                          | Output of the older kit command below.                        |
| `nearest token`             | A `--proposed-*` value or a literal lands within the threshold of an existing token in both themes.    | Use the token from `verdict: in`; when it lists several, the one from the value's family.          | `pnpm ds:nearest` output with `verdict: in`.                  |
| `new token`                 | A value has no token within the threshold, or the script refuses it.                                   | Name it in `tokens.css` with a value in both themes, per the `design-system` skill's tokens rules. | `pnpm ds:nearest` output with `verdict: out`, or the refusal. |
| `default change avoided`    | The prototype needs a ds component to look different from its default.                                 | Keep the default and pass a prop at the call site; changing a default needs `operator decision`.   | The prop passed at the call site.                             |
| `ticket over prototype`     | The ticket and the prototype disagree.                                                                 | Build what the ticket says.                                                                        | A quote of the ticket.                                        |
| `operator decision`         | The operator decided the case.                                                                         | Follow the decision.                                                                               | Session and date of the decision.                             |

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
```

- Colours are compared by CIEDE2000 after converting sRGB (IEC 61966-2-1) to CIELAB under the D65
  white point, with no chromatic adaptation. A colour is in when ΔE00 ≤ 5.
- Candidates are the opaque hex tokens of each theme; alpha tokens are never candidates.
- Sizes are compared by the absolute px difference against the `px` tokens. A size is in when the
  difference is ≤ 1px. A size is any CSS number with `px`, in any case (`12px`, `.5px`,
  `1.2e1px`). A negative value is compared by its size; write it as `calc(-1 * var(--token))`.
- Both limits are inclusive. When several tokens share the minimum distance, the line lists all
  of them.
- `verdict: in <tokens>` lists every token that is nearest and within the limit in both themes:
  record `nearest token`. Otherwise `verdict: out`: record `new token`.
- The verdict can list several tokens: `13px` gives `--text-body, --space-3, --size-icon`. Pick
  the one from the value's family: a text size takes `--text-*`, spacing takes `--space-*`, an
  element size takes `--size-*`.
- Exit 0 for any computed result, in or out; exit 2 for a refused value.

```text
$ pnpm ds:nearest '#5aa8ff'
CIEDE2000, sRGB to CIELAB D65; in when ΔE00 ≤ 5 in both themes
dark  #5aa8ff: --color-status-working #58a6ff - ΔE00 0.58 - in
light #5aa8ff: --color-text-tertiary #818b98 - ΔE00 18.64 - out
verdict: out
```

### Values the script refuses

- An alpha colour (`#rgba`, `#rrggbbaa`, `rgba(...)`): decide it as `new token`, or record
  `operator decision` to keep it.
- A composite value such as `1px dashed var(--color-border-strong)`: run each colour or px part on
  its own; keywords such as `dashed` and `var()` parts need no check.
- Any other unit or a unitless value (`em`, `%`, `0`): decide it as `new token`, or record
  `operator decision` to keep the literal.

## PR section

A PR that changes UI carries a `## Design System decisions` section between `## Risk` and
`## Changed checks` (`.github/pull_request_template.md`): one row per difference between the
prototype and the build, or the single line `None` when there is none. A PR that changes no UI
deletes the section.

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

## board-v1

`design/prototypes/board-v1/` predates the kit: it mounts no design system components and every
part is hand-built (its README, `## Kit`). `older kit` does not apply to it; decide each of its
parts with the other codes.
