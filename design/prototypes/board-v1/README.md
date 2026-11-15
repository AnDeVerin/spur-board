# Board V1 prototype

The design of the spur-board web UI, V1: the board, the task card, the task view, the inbox, the services panel and
their states. It is the spec for the screens. It is not part of the app build or the npm package.

## Run

Serve this folder with any static server and open it. No network and no daemon are needed.

```bash
python3 -m http.server 4391 --bind 127.0.0.1 --directory design/prototypes/board-v1
```

- `http://localhost:4391/` is the board.
- `http://localhost:4391/states.html` lists every page and state, each in the dark and the light theme.

## Kit

**None.** This is the first prototype: the design system has no components yet, so every part here is hand-built and
proposed. Base commit of the repo: `8cf2e0f`.

Because there is no kit to mount, the screen is plain JavaScript (`app.js`), not React. Later prototypes mount design
system components as `DS.<Name>` and hand-build only what is new.

## Files

| File           | What it is                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------ |
| `tokens.css`   | Design tokens for both themes. The first version of `packages/web/src/ds/tokens.css`: take it as is                |
| `proto.css`    | Styles of the hand-built parts. Tokens only, no raw colors                                                         |
| `app.js`       | The screen and its states                                                                                          |
| `fixture.json` | Sample data. Invented; no real tasks, people or hosts                                                              |
| `fonts/`       | JetBrains Mono (Regular, Medium, Bold) with its OFL license                                                        |
| `states.html`  | Index of pages and states                                                                                          |
| `explore/`     | Design exploration kept for reference: three task card variants (C was chosen) and the logo options (C was chosen) |

## States

Each state opens by URL. Add `&theme=light`, `&theme=dark` or `&theme=auto`; the default is dark.

| State                                     | URL                    |
| ----------------------------------------- | ---------------------- |
| Board, live                               | `/`                    |
| Task view, a block waits for the operator | `/?open=509`           |
| Inbox                                     | `/?open=inbox`         |
| Services                                  | `/?open=services`      |
| Loading                                   | `/?state=loading`      |
| Empty project                             | `/?state=empty`        |
| Stream reconnecting                       | `/?state=reconnecting` |
| Stream lost, data is stale                | `/?state=offline`      |
| Daemon unreachable                        | `/?state=daemon-down`  |
| A source is blind (Spur)                  | `/?state=source-blind` |
| Shadow project                            | `/?state=shadow`       |
| Block: answer not sent                    | `/?state=block-failed` |
| Long title and many markers               | `/?state=long`         |

Turn states are on the live board: acked by an agent (`#509`), not acked (`#515`), the operator's turn (`#510`),
executor stalled (`#508`), no open turn (`#513`).

Block states are in the task view of `#509`: open for the operator (`B89`), answered in Slack (`B84`). Answer `B89`
to see "answered on the board".

## Proposed parts

All of them are hand-built here and are candidates for the design system or for screen components.

| Part                                                                          | Where                      | Kind          |
| ----------------------------------------------------------------------------- | -------------------------- | ------------- |
| Status dot (filled with glow, hollow)                                         | everywhere                 | design system |
| Chip (plain, warn, dashed, filled "you")                                      | card, task view            | design system |
| Icon set, 16px grid, 1.6 stroke                                               | everywhere                 | design system |
| Button (primary, outlined), icon button                                       | task view, panels          | design system |
| Text area with its form row                                                   | task view                  | design system |
| Key-value box with pass, wait and fail rows                                   | task view, services        | design system |
| Collapsible section with a sticky header and a summary                        | task view                  | design system |
| Tabs (underline in the modal, segmented in the inbox)                         | task view, inbox           | design system |
| Modal, side panel, scrim                                                      | task view, inbox, services | design system |
| Banner (error, warning, info)                                                 | under the header           | design system |
| Hover menu                                                                    | theme switch               | design system |
| Skeleton                                                                      | loading                    | design system |
| Meter                                                                         | services                   | design system |
| Logo: the Spur mark in a frame                                                | header                     | design system |
| Gate lights: four fixed cells (CI, merge, threads, reviews)                   | card                       | screen        |
| Task card with the turn rail and the turn line                                | board                      | screen        |
| Column, empty column spine, compact done list                                 | board                      | screen        |
| Header: project select, dispatcher mode, filter, live indicator, inbox button | board                      | screen        |
| Status bar: one icon and one dot per service, theme menu, version             | board                      | screen        |
| Task view: "Why it is here", blocks, comments, history                        | modal                      | screen        |
| Inbox list with filters and the "recently handled" tail                       | side panel                 | screen        |
| Services panel                                                                | side panel                 | screen        |

## Decisions the design makes

- **Layout A:** a kanban board; the inbox and the services open as a right side panel; a task opens as a centered
  modal over the whole board, the inbox included.
- **Card:** the gate cells sit in the same place on every card, so a column scans vertically. A passing gate is
  muted; only a failing or a waiting gate gets a fill.
- **Turn:** the left rail and the dot in the turn line share one color: blue for an agent, yellow for a turn nobody
  acked (dashed rail, hollow dot) and for the operator's turn, red for a stalled executor.
- **The only filled marker** on the board is a block addressed to the operator (`B89 → you`) and the inbox counter.
- **A card with no PR and no turn** shows only its key, title and markers.
- **Empty columns** collapse to a 34px spine with the column name. `done` is a compact list.
- **The filter dims** cards that do not match; it does not hide them.
- **Status bar:** icons and dots only. Details open in the services panel on click.
- **Theme:** one icon in the status bar shows the current choice; its menu offers light, dark and auto.
- **Task view:** two tabs, `Now` and `History`. Sections collapse on a double click of the header or a click on
  its chevron. Headers stick while the section scrolls.
- **History** shows journal events with absolute time, `hh:mm dd/mm/yy`.
- **Stale data:** when the stream is lost or the daemon does not answer, the columns dim and a banner names the
  time of the data. A short reconnect changes only the indicator in the header.

## Not in V1

- **Follow-up on an answered block.** The board has no operation for it yet; see #540. The design is ready and
  opens with `/?open=509&followup=1`.
- **Mobile layout.** Narrow screens work: columns scroll sideways, the modal and the panels take the full screen.
  It was not designed further.
- The project switcher menu.

## Deliberate differences from the Spur tokens

- `--color-text-tertiary` in the dark theme is `#6b6b70`, not `#555558`: the original is hard to read at 10px.
- `--color-status-attention` in the light theme is `#9a6700`, not `#bf8700`, so that text passes on white.
- `--color-you-bg` in the dark theme is `#c9a227`, a muted gold: the pure yellow pulled too much attention.

Contrast was judged by eye, not measured.

## Fixture

`fixture.json` has the prototype's own shape, because the operations that will feed these screens are not all in the
catalog yet. Where the data comes from:

| Fixture key                 | Operation                                                                         |
| --------------------------- | --------------------------------------------------------------------------------- |
| `config`, `columns`, `done` | `config.get` and `status.get` rows with the turn, the PR summary and links (#527) |
| `tasks`                     | `task.get`                                                                        |
| `inbox`, `handled`          | the operator inbox query (#532)                                                   |
| `services`                  | `status.get` sources, with the GitHub rate budget (#528)                          |

Notes for the build:

- The fixture shows the same gates for every column. The real list of gates comes per column.
- `turn_opened` and `turn_acked` in the history come with #526.
- The fields of the services panel are a proposal; align them with what `status.get` returns.
