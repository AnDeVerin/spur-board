# Board V1.1 prototype

Three refinements of the shipped board, on the design system kit:

1. **Column sort**: sort the tasks of a column by key or by time in the column, either direction.
2. **Blocks** in the task view: a header band per block; closed blocks fold to three lines.
3. **History**: a run of alike journal rows folds into one row with a `+N` toggle.
4. **Colour**: soft tints on the card and in the task view.
5. **Dark theme tokens**: muted text and lines with more contrast.

The card, the column, the board header and the task view shell are simplified stand-ins for the
app's own screen parts (`packages/web/src/board/`); they are not proposals and the app keeps its
own. Only the parts under "Proposed parts" are new.

## Kit

Built on the kit of commit `f8a3250` (`BUILD.json`: `"dirty": false`). Exports used: `Button`,
`Chip`, `CollapsibleSection`, `Icon`, `KeyValueBox`, `Logo`, `Modal`, `StatusDot`, `React`, `ReactDOM`, `TabPanel`, `Tabs`,
`TextArea`, `ThemeSwitch`, `focusRing`, `quiet`.

## Run

```bash
pnpm ds:build
python3 -m http.server 4391 --bind 127.0.0.1 --directory design
```

Open `http://127.0.0.1:4391/prototypes/board-v1-1/`. Stop the server when done.

## States

Add `&theme=light` or `&theme=dark` to any URL; dark is the default. `&marks=off` hides the
"proposed" labels. An unknown value of any parameter falls back to the first one listed.

| State                                             | URL                                                     |
| ------------------------------------------------- | ------------------------------------------------------- |
| Board, each column sorted longest in column first | `/prototypes/board-v1-1/?state=board`                   |
| Board, another first sort                         | `?state=board&sort=entered-desc`, `key-asc`, `key-desc` |
| Board, one sort control for all columns (variant) | `?state=board&sortui=board`                             |
| Task view, Now: two open and three closed blocks  | `?state=task`                                           |
| Task view, Now, block headers as today (compare)  | `?state=task&head=plain`                                |
| Task view, History, runs folded                   | `?state=history`                                        |
| Any state without the tints (compare)             | `&color=off`                                            |
| Any state on today's dark tokens (compare)        | `&tokens=now`                                           |
| History, runs by kind and actor only (variant)    | `?state=history&group=kind`                             |

Reached by a click, not by URL: an unfolded closed block (click its folded text, "Show all" or
its header), an unfolded history run (click `+N`), a reversed or switched column sort. Any card
opens the one task of the fixture. Narrow screen: the same URLs at 375px.

## Behaviour

### Column sort

- Two quiet buttons end the executor line of a column head: the field, one letter (`K` for the
  key, `T` for the time in the column), and the direction (`↑` or `↓`). A click on the letter
  switches the field; a click on the arrow reverses. The tooltip of each spells out what it shows
  and what a click does.
- `T ↑` puts the task longest in the column first; `K ↑` the lowest key first. Keys
  compare numerically (`#9` before `#10`, `ABC-9` before `ABC-10`).
- Each column keeps its own sort, Done included. The first sort is `T ↑`.
- The card shows the time in the column beside its key, so the order can be read.
- A spine (an empty column) has no control.
- Sorting changes the view only: it writes nothing to the board.

### Blocks

- Each block is its own bordered box with a gap between boxes. Its header is a band: the id in
  small size, bold and primary colour, then author, age and addressee, and the state chip at the end.
- An open block is always whole and has no fold control. A block open for the operator has the
  attention rail and a tinted band; a block open for an agent has the working rail and band.
- A closed block starts folded: the band and the first three lines of its reason, then
  `… Show all · 2 replies` naming what the fold hides.
- Unfold: a click on the folded text, on "Show all" or on the band. The folded text stays
  selectable; a click that ends a text selection does not unfold.
- Fold again: the band, or "Collapse B<n>" at the end of the block, beside "Follow up".
- A closed block whose reason fits three lines and that has no replies and no outcome line has
  no fold control and no caret.
- Blocks keep the app's order: open first.

### History

- Rows stay newest first. Neighbouring rows are alike when their kind, actor, channel and summary
  are equal. A run of three or more alike rows folds into one row: the newest row, a `+N` toggle
  and `since <time of the oldest>`; the date is added when the oldest is from another day.
- A click on `+N` unfolds the run: every row shows, the first carries `N rows` to fold it back,
  and the rows share a rail and a faint fill so the run still reads as one.
- A run of two stays two rows.
- A run is known by the journal position of its oldest row, so a run keeps its fold state when a
  newer alike row joins it, and the count grows in place.
- `?group=kind` is the looser variant: the summary may differ, and the folded row shows the
  newest summary. It folds the four `pr_facts_changed` rows of the fixture, which say different
  things.

### Colour

One rule for a tint: a soft status fill and a coloured icon; the text and the border stay
neutral. Coloured text and a coloured border stay reserved for what asks for attention (failed
and pending cells, `warn` and `you` chips).

| Where     | Part                          | Tint                                                         |
| --------- | ----------------------------- | ------------------------------------------------------------ |
| Card      | A passing PR cell             | `--color-fill-ready`; the icon is green today                |
| Card      | The open blocks marker        | `--color-fill-error`, icon `--color-status-error`            |
| Task view | Ticket link                   | `--proposed-color-fill-violet`, icon `--color-accent-violet` |
| Task view | PR link                       | `--color-fill-ready`, icon `--color-status-ready`            |
| Task view | Session link                  | `--color-fill-working`, icon `--color-status-working`        |
| Task view | The chip of an answered block | `--color-fill-ready` and a green check icon                  |

A cell with no facts (`–`), the quick links in the card corner and the section summaries stay
plain: the Why table already colours what a summary counts (operator, session of 2026-11-17). The two buttons in
the prototype bar switch the tints and the dark tokens in place.

### Dark theme tokens

The proposed values replace four dark tokens on the whole page, design system components
included. Ratios are against `--color-bg-base` / `--color-bg-elevated`.

| Token                    | Now                     | Proposed               | Light theme |
| ------------------------ | ----------------------- | ---------------------- | ----------- |
| `--color-text-tertiary`  | `#6b6b70`, 3.67 / 3.38  | `#85858c`, 5.30 / 4.88 | 6.11        |
| `--color-border-subtle`  | `rgba(35, 35, 38, 0.6)` | `#2a2a2e`, 1.36 / 1.25 | -           |
| `--color-border-default` | `#232326`, 1.24 / 1.14  | `#38383d`, 1.67 / 1.53 | 1.43        |
| `--color-border-strong`  | `#323236`, 1.52 / 1.40  | `#48484f`, 2.14 / 1.97 | 1.84        |

Tertiary text now passes AA (4.5) at rest on both surfaces; a quiet container still lifts it to
secondary (7.52) on hover and focus. This replaces, for the dark theme, the earlier choice to
keep tertiary text under AA at rest (operator, session of 2026-11-17). The light theme does not
change.

## Proposed parts

| Part                | Class            | Why proposed                                             |
| ------------------- | ---------------- | -------------------------------------------------------- |
| Column sort control | `proposed-sort`  | No component: two text buttons, quieter than `Button`.   |
| Block               | `proposed-block` | The task view lists blocks as plain rows of one box.     |
| Fold toggle         | `proposed-fold`  | A text toggle with a caret; `Button` is too loud here.   |
| Folded text         | `proposed-clamp` | No line clamp in the system.                             |
| History run         | `proposed-run`   | The History table has one row per event and no grouping. |

Values with no token, declared at the top of `proto.css`: `--proposed-lines-fold` (3) and
`--proposed-size-block-rail` (3px; the card rail is `--size-rail`, 2px). `--proposed-outline-dash`
draws the "proposed" labels only. `--proposed-color-fill-violet` and the four
`--proposed-color-*` dark values are described under Colour and Dark theme tokens.

## Not as in the system, on purpose

- Section titles are one step larger. `proto.css` restyles `DS.CollapsibleSection` from outside
  (`.proposed-sections`): the title is `--text-body` and primary instead of `--text-micro` and
  secondary, the count `--text-small` instead of `--text-micro`. The operator asked for it for
  every section title (session of 2026-11-17), so this changes the component's default, not a
  variant. The block id is `--text-small`, one step under the section title.

- The state chip of a block open for an agent uses `Chip tone="warn"`; today every block chip is
  the default tone.

## Fixture

`fixture.json` holds invented tasks, blocks, comments and events, keyed by operation:
`config.get`, `status.get`, `task.get`, `task.history`. Two keys are not in the catalogue:

- `now`: the time the ages count to;
- `status.get` `tasks[].columnEnteredAt`: when the task entered its column. **`status.get` has
  no such field today**; sorting by time in the column needs it. `task.get` has the moves
  (`why.moves`), but the board reads rows from `status.get`.

`task.get` `title` stands for the ticket title the app takes from the `status.get` row.
