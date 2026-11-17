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
proposed. Base commit of the repo: `caa1985`.

Because there is no kit to mount, the screen is plain JavaScript (`app.js`), not React. Later prototypes mount design
system components as `DS.<Name>` and hand-build only what is new.

## Files

| File           | What it is                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------ |
| `tokens.css`   | Design tokens for both themes. The first version of `packages/web/src/ds/tokens.css`: take it as is                |
| `proto.css`    | Styles of the hand-built parts. Tokens only, no raw colors                                                         |
| `app.js`       | The screen and its states                                                                                          |
| `fixture.json` | Sample data keyed by operation (see [Data sources](#data-sources)). Invented; no real people or hosts              |
| `fonts/`       | JetBrains Mono (Regular, Medium, Bold) with its OFL license                                                        |
| `states.html`  | Index of pages and states                                                                                          |
| `explore/`     | Design exploration kept for reference: three task card variants (C was chosen) and the logo options (C was chosen) |

## States

Each state opens by URL. Add `&theme=light`, `&theme=dark` or `&theme=auto`; the default is dark.

| State                                                        | URL                     |
| ------------------------------------------------------------ | ----------------------- |
| Board, live                                                  | `/`                     |
| Task view, a block waits for the operator                    | `/?open=509`            |
| Inbox                                                        | `/?open=inbox`          |
| Services                                                     | `/?open=services`       |
| Loading                                                      | `/?state=loading`       |
| Empty project                                                | `/?state=empty`         |
| Stream reconnecting                                          | `/?state=reconnecting`  |
| Stream lost, data is stale                                   | `/?state=offline`       |
| Daemon unreachable                                           | `/?state=daemon-down`   |
| A source is blind (Spur)                                     | `/?state=source-blind`  |
| Shadow project: dispatcher shadow, shadowColumn on every row | `/?state=shadow`        |
| Block: answer not sent                                       | `/?state=block-failed`  |
| Long title, many markers, a source not polled yet            | `/?state=long`          |
| Follow-up on an answered block                               | `/?open=509&followup=1` |

`?open=<n>` opens the task whose key ends with `#<n>`; an unknown number opens nothing. `&open=services` composes
with `loading`, `offline`, `daemon-down` and `long`, and `&open=inbox` with `source-blind`. `long` carries three
concerns: a card with every marker, the PR status edge cases (two pull requests, conflicting, changes requested,
unconfirmed) and a GitHub source that has never completed a poll.

On the live board:

- Turns: taken by an agent (`#509`, `#511`, `#523`, `#512`), not taken (`#515`), the operator's turn (`#510`),
  executor stalled (`#508`, with `B90 → you`), no open turn (`#513`, `#516`, `#520`).
- Markers and cells: returned with 3 findings plus `1 block` (`#511`), a block for the worker (`#512`), a draft
  (`#523`), mergeability unknown (`#510`), a pull request linked but not observed yet (`#515`).
- Blocks: in `#509`, `B89` is open for the operator and `B84` was answered in Slack; in `#511`, `B81` was answered
  on the board. Answer `B89` to see "answered on the board".
- Every task has its own History tab, from its journal events.

## Proposed parts

All of them are hand-built here and are candidates for the design system or for screen components.

| Part                                                                                            | Where                      | Kind          |
| ----------------------------------------------------------------------------------------------- | -------------------------- | ------------- |
| Status dot (filled with glow, hollow, unknown)                                                  | everywhere                 | design system |
| Chip (plain, warn, dashed, filled "you")                                                        | card, task view            | design system |
| Icon set, 16px grid, 1.6 stroke                                                                 | everywhere                 | design system |
| Button (primary, outlined), icon button                                                         | task view, panels          | design system |
| Text area with its form row                                                                     | task view                  | design system |
| Key-value box with pass, wait, fail and muted rows                                              | task view, services        | design system |
| Collapsible section with a sticky header and a summary                                          | task view                  | design system |
| Tabs (underline in the modal, segmented in the inbox)                                           | task view, inbox           | design system |
| Modal, side panel (right or left), scrim                                                        | task view, inbox, services | design system |
| Banner (error, warning, info)                                                                   | under the header           | design system |
| Hover menu                                                                                      | theme switch               | design system |
| Skeleton                                                                                        | loading                    | design system |
| Meter                                                                                           | services                   | design system |
| Logo: the Spur mark in a frame                                                                  | header                     | design system |
| Quiet hover: tertiary text turns secondary in a hovered or focused container                    | everywhere (#535)          | design system |
| PR status: four fixed cells (checks, merge, threads, reviews)                                   | card                       | screen        |
| Task card with the turn rail and the turn line                                                  | board                      | screen        |
| Column, empty column spine, compact done list                                                   | board                      | screen        |
| Header: project select, dispatcher mode, filter, live indicator, inbox button                   | board                      | screen        |
| Status bar: services trigger on the left, one icon and one dot per service, theme menu, version | board                      | screen        |
| Task view: "Why it is here", blocks, comments, history                                          | modal                      | screen        |
| Inbox list with filters and the "recently handled" tail                                         | side panel, right          | screen        |
| Services panel, docked left, with the host slot proposed (#546)                                 | side panel, left           | screen        |

## Decisions the design makes

- **Layout A:** a kanban board; the inbox opens as a right side panel and the services as a left side panel; a task
  opens as a centered modal over the whole board, the inbox included.
- **Card:** the PR status cells sit in the same place on every card, so a column scans vertically. They are facts
  from `prSummary`, not a gate verdict: the gate lives in "Why it is here". A good fact is muted; only a failing or
  a pending fact gets a fill. An unknown fact is a neutral `?` or `–`, and an unconfirmed summary drops every fill.
  Each cell has an accessible name that spells the fact out.
- **Turn:** the left rail and the dot in the turn line share one color: blue for an agent, yellow for a turn nobody
  has taken (dashed rail, hollow dot) and for the operator's turn, red for a stalled executor. The line reads
  `taken · <age>`, `not taken · <age>`, `open · <age>` or `stalled · <age>`.
- **The only filled marker** on the board is a block addressed to the operator (`B89 → you`) and the inbox counter.
  Other open blocks on the same card add a plain `+N` chip; with no operator block they read `N block(s)`.
- **Task keys** are stored in full, as the operations return them (`example-org/spur-board#509`), and drawn as
  `#509`; the full key is in the title.
- **A card with no PR and no turn** shows only its key, title and markers.
- **Empty columns** collapse to a 34px spine with the column name. `done` is a compact list of every done row; the
  column scrolls.
- **The filter dims** cards that do not match; it does not hide them.
- **Status bar:** a services trigger on the left, then icons and dots only. The trigger and each icon open the
  services panel; the trigger closes it again.
- **Quiet console:** tertiary text turns secondary while its container is hovered or holds focus; without hover it
  stays secondary.
- **Theme:** one icon in the status bar shows the current choice; its menu offers light, dark and auto.
- **Task view:** two tabs, `Now` and `History`. Sections collapse on a double click of the header or a click on
  its chevron. Headers stick while the section scrolls.
- **History** shows journal events newest first with absolute time, `hh:mm dd/mm/yy`, the summary, the actor and
  the kind.
- **Stale data:** when the stream is lost or the daemon does not answer, the columns dim and a banner names the
  time of the data. A short reconnect changes only the indicator in the header.
- **Known limit:** the light `you` chip is white on `#bf8700`, about 3.1:1, below 4.5:1 for small text. The token
  stays as it is; the chip text is bold and always paired with a block id.
- **Follow-up:** built in #540: an answered question shows `Follow up`, which swaps in the answer field with
  `Send follow-up` and an icon Cancel. The prototype shows it only with `/?open=509&followup=1`.

## Not in V1

- **Mobile layout.** Narrow screens work: columns scroll sideways, the modal and the panels take the full screen.
  It was not designed further.
- The project switcher menu.

## Deliberate differences from the Spur tokens

- `--color-text-tertiary` in the dark theme is `#6b6b70`, not `#555558`: the original is hard to read at 10px.
- `--color-status-attention` in the light theme is `#9a6700`, not `#bf8700`, so that text passes on white.
- `--color-you-bg` in the dark theme is `#c9a227`, a muted gold: the pure yellow pulled too much attention.

Contrast was judged by eye, not measured.

## Data sources

`fixture.json` is keyed by operation: `config.get`, `status.get` (detail rows), `task.get` and `task.history` (both
keyed by task key) and `inbox.operator`. Each value is a subset of that operation's output. Fields marked with an
issue are pending there; the rest are on `main`. The fixture carries no field this table does not name.

| UI region                                                        | Operation and field                                                                                                                                                                                                                                                  | Source                           |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Header: project, dispatcher mode                                 | `config.get` `projects[].id`, `.dispatcher.mode`                                                                                                                                                                                                                     | main                             |
| Header: inbox counter                                            | `inbox.operator` `items[]` count                                                                                                                                                                                                                                     | #532                             |
| Header: live indicator, banners, filter, theme                   | client only                                                                                                                                                                                                                                                          | -                                |
| Column order, name, executor line                                | `config.get` `projects[].columns[].id`, `.executor.kind`, `.executor.name`                                                                                                                                                                                           | main                             |
| Stall routing, not drawn                                         | `config.get` `projects[].spurProjects[].name`, `.role`. No `curator` role exists, so the stall block goes to the operator                                                                                                                                            | main                             |
| Column count, done list                                          | `status.get` `tasks[]` grouped by `.column`; done rows `.key`, `.ticket.title`                                                                                                                                                                                       | main                             |
| Card key                                                         | `status.get` `tasks[].key`, stored as `example-org/spur-board#509` and drawn as `#509`; `.project`                                                                                                                                                                   | main                             |
| Card ticket link                                                 | `tasks[].links.ticket` (href drawn as `#`)                                                                                                                                                                                                                           | main                             |
| Card and task view title                                         | `status.get` (detail) `tasks[].ticket.title`; task.get has no title                                                                                                                                                                                                  | main                             |
| Card PR link                                                     | `tasks[].links.prs[].repo`, `.number`, `.url` (href `#`)                                                                                                                                                                                                             | main                             |
| Session link                                                     | `tasks[].links.sessions[].id`; the URL comes from `config.get` `web.spurUiOrigin` and is drawn as `#`                                                                                                                                                                | main; origin #547                |
| PR status cells                                                  | `tasks[].prSummary[].repo`, `.number`, `.checks.pass`, `.checks.fail`, `.checks.pending`, `.mergeable`, `.threads.unresolved`, `.threads.total`, `.reviewsOnHead.approved`, `.reviewsOnHead.changesRequested`, `.draft`, `.unconfirmed`                              | main (#527)                      |
| Block chip                                                       | `tasks[].openBlocks`; `tasks[].blocks[].id`, `.addressee`                                                                                                                                                                                                            | main; `blocks` #547              |
| Returned chip                                                    | `tasks[].returned.from`, `.at`, `.by`, `.block`, `.findings`                                                                                                                                                                                                         | #547                             |
| Shadow chip                                                      | `tasks[].shadowColumn`, `.shadowDiffers`, present only while `dispatcher.mode` is `shadow` (set by `?state=shadow`)                                                                                                                                                  | main                             |
| Turn line, open-turn row                                         | `tasks[].turn.id`, `.addressee`, `.at`, `.taken.by`, `.taken.at`, `.addressedTo`                                                                                                                                                                                     | main                             |
| Turn stalled                                                     | `tasks[].turn.stalledSince`                                                                                                                                                                                                                                          | #547                             |
| Task view header                                                 | `task.get` (keyed by task key) `task.key`, `task.column`, `why.moves[].at`, `.to`                                                                                                                                                                                    | main                             |
| Turn consistency, not drawn                                      | `task.get` `turn.id`, `.addressee`, `.at`, `.taken.by`, `.taken.at`, equal to the status.get row turn                                                                                                                                                                | main                             |
| Why it is here                                                   | `task.get` `why.column` (the shadow column in shadow mode), `why.gates[].column`, `.conditions[].condition`, `.state`, `.reason`, `why.holds[]`; next column from `config.get` column order                                                                          | main                             |
| Blocks                                                           | `task.get` `blocks[].id`, `.author`, `.addressee`, `.reason`, `.at`, `.state`, `.outcome`, `.unblockedAt`                                                                                                                                                            | main                             |
| Block answered via                                               | `task.get` `blocks[].answeredVia`                                                                                                                                                                                                                                    | #532                             |
| Block answer, comments                                           | `task.get` `comments[].id`, `.block`, `.author`, `.at`, `.text`                                                                                                                                                                                                      | main                             |
| History (per task key)                                           | `task.history` `events[].at`, `.kind`, `.actor`, `.summary`                                                                                                                                                                                                          | main (#526)                      |
| Inbox items                                                      | `inbox.operator` `items[].id`, `.project`, `.kind`, `.text`, `.at`, `.task` (full key), `.severity`, `.column`                                                                                                                                                       | #532                             |
| Recently handled                                                 | `inbox.operator` `handled[]`, the same fields plus `.answeredVia`                                                                                                                                                                                                    | #532                             |
| Status bar version, daemon box                                   | `status.get` `daemon.version`, `.startedAt`                                                                                                                                                                                                                          | #547                             |
| Service boxes: state and age (daemon, GitHub, Spur, Jira, Slack) | `status.get` `services[].service` (`daemon`, `github`, `spur`, `jira`, `slack`), `.state`, `.since`, `.lastGoodAt`, `.reason`; not in the fixture                                                                                                                    | #546                             |
| Daemon last dispatch                                             | `status.get` `daemon.lastDispatchAt`: not drawn, not in the fixture                                                                                                                                                                                                  | #547                             |
| Host CPU, RAM, disk                                              | `status.get` `host.sampledAt`, `.cpuPercent`, `.memory.totalBytes`, `.memory.availableBytes`, `.memory.usedPercent`, `.disk` (same fields); `host`, `.memory` and `.disk` may be null. The prototype still draws a placeholder tagged `proposed`; not in the fixture | #546                             |
| Host load line                                                   | `status.get` `hostLoad`                                                                                                                                                                                                                                              | main                             |
| GitHub boxes (PR poll, issues)                                   | `status.get` `sources[].source` (`github:…`, `github-issues:…`), `.lastCompleteAt`, `.blindReason`, `.message`, `.budget.remaining`, `.budget.limit`, `.budget.resetAt`, `.stale`, `.warmingUp`, `.healthySince` (not in the fixture)                                | main (#528); `healthySince` #546 |
| Spur box                                                         | `sources[]` `spur` (same fields), `spurUnavailable`                                                                                                                                                                                                                  | main                             |
| Jira box (when present; none in the fixture)                     | `sources[]` `jira:<project>`                                                                                                                                                                                                                                         | main                             |
| Slack box                                                        | `status.get` `transport[].gateway`, `.state`, `.since`, `.reason`, `.spaces`                                                                                                                                                                                         | main                             |

Notes for the build:

- Card titles need `status.get` with detail: compact rows carry no `ticket`.
- The inbox shape, its severity (`attention` for a block or a turn that waits for the operator, `failure` for a
  system failure) and `answeredVia` follow #532; block lists, returns, stalls and the daemon follow #547; host
  metrics, service health and `healthySince` follow #546. Rename the fixture fields if those issues land with other
  names.
- Every exit condition comes per column from `task.get` `why.gates`; the prototype draws only the gate of
  `why.column`.
- Ages count from a fixed clock, `2026-11-15T15:00:00Z`, so screenshots stay stable.
