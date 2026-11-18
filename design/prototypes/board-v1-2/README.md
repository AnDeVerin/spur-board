# Board V1.2 prototype

The board ready for a second project's flow, on the design system kit:

1. **Backlog group**: `todo`, `triage` and `ready-for-dev` read as one group.
2. **Manual order**: a third sort, Manual, beside Time and Key; a move between Backlog parts.
3. **Approval freshness**: a hint before the merge, never a condition.
4. **QA submit basis**: tested, carried or skipped, shown where the merge is decided.
5. **Column help**: who acts and the rules, from the column head.
6. **An orchestrator turn in the operator's hands**: submit or return it yourself.
7. **New reasons and states** in the Why table, the inbox and the services panel.

The card, the column, the board header, the task view shell, the inbox and the services panel are
simplified stand-ins for the app's own screen parts (`packages/web/src/board/`); they are not
proposals and the app keeps its own. Only the parts under "Proposed parts" are new. The task view
leaves out blocks and comments: they do not change here.

## Kit

Built on the kit of commit `17ff3e4` (`BUILD.json`: `"dirty": false`). Exports used: `Banner`,
`Button`, `Chip`, `CollapsibleSection`, `FormRow`, `Icon`, `IconButton`, `KeyValueBox`, `Logo`,
`Modal`, `React`, `ReactDOM`, `SidePanel`, `StatusDot`, `TabPanel`, `Tabs`, `TextArea`,
`TextInput`, `ThemeSwitch`, `focusRing`, `quiet`.

## Run

```bash
pnpm ds:build
python3 -m http.server 4391 --bind 127.0.0.1 --directory design
```

Open `http://127.0.0.1:4391/prototypes/board-v1-2/`. Stop the server when done. The server sends
no cache headers: after a rebuild, reload without the cache.

## States

Add `&theme=light` or `&theme=dark` to any URL; dark is the default. `&marks=off` hides the
"proposed" labels. `&project=acme-web` or `orbit-api` picks the project where a state does not.
An unknown value of any parameter falls back to the first one listed.

Two projects: `acme-web` has `todo` and a mirrored `ready`; `orbit-api` has all ten columns, three
Backlog parts moved by hand and a QA column with an orchestrator.

| State                                                    | URL                                          |
| -------------------------------------------------------- | -------------------------------------------- |
| Board, Backlog of two parts, one a mirror                | `?state=default`                             |
| Board, Backlog of three parts, ten columns               | `?state=default&project=orbit-api`           |
| Backlog folded into one column                           | `?state=todo-collapsed&project=orbit-api`    |
| Mirror not readable: the part is frozen                  | `?state=mirror-failing`                      |
| Empty board                                              | `?state=empty`                               |
| Sort menu open                                           | `?state=sort-menu`                           |
| Manual order on; cards can be dragged                    | `?state=sort-manual&project=orbit-api`       |
| A card in the hand and the drop line                     | `?state=drag`                                |
| A drag in the Time sort: the hint                        | `?state=drag-off`                            |
| Another viewer changed the order (after 1.5 s)           | `?state=order-changed`                       |
| A reorder failed                                         | `?state=reorder-failed`                      |
| Card menu: ends of the order and the other parts         | `?state=card-menu`                           |
| Move between parts: the reason form                      | `?state=move`                                |
| Move into a mirrored part: not available                 | `?state=move-mirror`                         |
| Move from the task view                                  | `?state=task-move`                           |
| Column help, Who: an orchestrator with a live session    | `?state=column-actor`                        |
| Column help, Who: no live session                        | `?state=column-actor-no-session`             |
| Column help, Rules: Dev, eight conditions                | `?state=column-rules`                        |
| Approval before changes in watched directories           | `?state=approval-stale`                      |
| Approval before changes outside them                     | `?state=approval-stale-quiet`                |
| Approvals on different commits                           | `?state=approval-multi`                      |
| History rewritten after the approval                     | `?state=approval-rewritten`                  |
| Not counted: the PR is too large                         | `?state=approval-uncounted`                  |
| QA verdict carried from another commit                   | `?state=qa-carried`                          |
| QA skipped                                               | `?state=qa-skipped`                          |
| History with the QA submit row                           | `?state=task-history`                        |
| An orchestrator turn the operator can close              | `?state=operator-turn`                       |
| Submit form                                              | `?state=operator-submit`                     |
| Return form                                              | `?state=operator-return`                     |
| The turn was closed by someone else                      | `?state=operator-turn-closed`                |
| Why: checks are running, the exit waits for green        | `?state=why-checks`                          |
| Why: a GitHub review rule blocks the merge               | `?state=why-review-rule`                     |
| Why: GitHub has not computed the merge state             | `?state=why-merge-unknown`                   |
| Inbox: no session to ring for a column orchestrator      | `?state=inbox`                               |
| Services: the GitHub Project source, healthy and failing | `?state=services`, `?state=services-failing` |

The column help states take `&column=<id>` for another column: `review`, `external-review`,
`ready-to-merge`, `ready-for-dev`, `triage`. Every card variant of sections 3 and 4 sits in
`ready-to-merge` of `orbit-api`; `acme-web` has no QA column and shows nothing of section 4.
Narrow screen: the same URLs at 375px.

## Decisions of the session (operator, 2026-11-18)

- The group is named **Backlog**; the parts keep their names (`todo`, `triage`, `ready`).
- A folded Backlog is one column with a section per part, cards on view. Folding is the viewer's
  own state, stored like the column sort. The prototype takes it from the URL state only.
- Sort: one letter in the column head, the first letter of Time, Key or Manual; a click opens a
  menu of the three, like the theme switch.
- Column help is one panel with the tabs Who and Rules, Who first. The second line of the column
  head opens it: an icon for who moves a task here (person, agent, dispatcher, mirror) and the
  name. This refines "two buttons" of the earlier decision. The panel follows its column.
- **Tabs in a panel header sit at the right, before Close, when the header has a title at the
  left.** Applies to the task view and to the help panel.
- A move between Backlog parts lives in the card menu, in a drop on another part and in the task
  view; all three open the same reason form. Sending the form is the confirmation.
- The card menu parts the moves inside the column from the moves to another part with a rule.

## Behaviour

### Backlog group

- A project with two or three Todo-group columns shows them under one band: the name, a fold
  control and the total. A project with `todo` alone shows a plain column and no band.
- Unfolded, each part is an ordinary column with its own count, sort and help; an empty part is a
  spine, like any empty column. Folded, the group is one column; an empty part says "empty".
- The second line of a part head names where its tasks come from: `manual`, or
  `mirror · <Project name>`.
- A mirror that cannot be read: the line turns to the attention colour and says `frozen`, the
  band shows a dot, a notice above the cards gives the cause and the time of the last read, and
  Who in the help repeats it. Tasks stay where they were.

### Sort and manual order

- Time and Key keep their direction button. Manual has none.
- Manual is one order for everyone, kept by the board; the choice of sort is the viewer's. A task
  entering a column goes to the end.
- In Manual a card has a grip before its key and the grab cursor. A drag shows a line where the
  card would land. `Alt+Up` and `Alt+Down` move the focused card one step; the card menu has
  "Move to top" and "Move to bottom".
- In Time and Key there is no grip. A drag inside the column moves nothing and shows a line under
  the head: the sort is kept, with a button to switch to Manual.
- When another viewer changes the order, the list rearranges by itself; the moved card is tinted
  for a moment and says who moved it.
- A reorder that fails leaves the card where it was and shows why under the column head, until
  dismissed.

### Move between Backlog parts

- From the card menu (`Move to <part>…`), by dropping the card on another part, or from the task
  view. A card of a part moved by hand can be dragged to another part in any sort.
- The card does not move until the form is sent. The reason is required and goes to the history.
  The task enters the end of the part.
- Into or out of a mirrored part: the menu item is listed but disabled with the cause under it; a
  drag over the part marks it in the attention colour with the same text and the drop is refused.

### Approval freshness

A hint for the operator before the merge. The project lists the top-level directories worth a
look (`approvalWatch`).

- On the card, in `ready-to-merge` only. The approvals cell keeps the count and gains a quiet
  suffix: `+N` commits since the approval, or `?` when not counted. When **any** approval
  predates a change in a watched directory, or the history was rewritten after it, the cell turns
  to the pending tone and one `warn` chip names the directories.
- An approval on the head, one that predates changes outside the watched directories, and "not
  counted" for a limit or a large PR stay quiet: the suffix and a tooltip only.
- In the task view, the Approvals section has a row per approval: author, commit, commits since,
  and a chip per changed directory, `warn` for a watched one. A row that asks for a look is
  tinted.

### QA submit basis

- `tested` shows nothing extra. `carried` shows a plain chip and `skipped` a `warn` chip on the
  card in `ready-to-merge`, with the source commit and the reason in the tooltip.
- The task view's Latest submission box and the History row already show the basis in the app
  (since 0.118.0). Here they are stand-ins, not proposals: the app keeps its own.
- A project without a QA column has no chip and no Latest submission section.

### Column help

- Rules: "Leaves to <column> when all hold", in the words of the Why table; "Returns to dev when
  any holds"; limits. A Backlog part leaves when work has started.
- Who: the executor (kind, Spur project, role, a link to the live session, or a warning that there
  is none), where questions go, and what happens when the executor is silent. For a Backlog part:
  who moves tasks into it, and the state of the mirror. A dispatcher column says that nobody
  takes a turn.
- With no live session the second line of the head is in the attention colour and says so.

### An orchestrator turn in the operator's hands

- The Turn section of the task view shows the open turn and, for a turn that is not the
  operator's, "Submit…" and "Return to dev…".
- Submit: the commit (the head by default), the basis, "carried from" and a reason where the basis
  needs them. Return: a reason. Each form says above its button what it closes, where the task
  goes and that it cannot be undone.
- A turn closed by someone else: both actions are disabled and a notice says who closed it and
  how.

## Proposed parts

| Part                 | Class                                 | Why proposed                                               |
| -------------------- | ------------------------------------- | ---------------------------------------------------------- |
| Group band and fold  | `proposed-group`                      | No grouping of columns in the app.                         |
| Sort menu            | `proposed-sort`                       | `HoverMenu` has an icon trigger and opens upward.          |
| Actor button         | `proposed-actor`                      | The executor line is plain text today.                     |
| Actor icons, grip    | `proposed-icon`                       | `Icon` has `person` only: agent, dispatcher, mirror, grip. |
| Help panel           | `proposed-popover`                    | No anchored panel in the system.                           |
| Card menu            | `proposed-menu`                       | As the sort menu, plus disabled items, a rule and a note.  |
| Drop line, drop zone | `proposed-drop-line`, `proposed-zone` | No drag in the app.                                        |
| Card in the hand     | `proposed-ghost`                      | For the `drag` state only; a real drag uses the browser's. |
| Move form            | `proposed-move`                       | A form under a card.                                       |
| Column notice        | `proposed-hint`                       | A line under a column head; the failure uses `Banner`.     |
| Approvals list       | `proposed-approvals`                  | New section of the task view.                              |
| Cell suffix          | `proposed-cell-suffix`                | A quiet figure after the count of a PR cell.               |
| Turn section         | `proposed-turn`                       | New section of the task view.                              |
| Inbox item           | `proposed-inbox-item`                 | A new kind of item.                                        |

Values with no token are declared at the top of `proto.css` and of its drag section:
`--proposed-size-popover` (380px), `--proposed-color-group-band`, `--proposed-shadow-popover`,
`--proposed-size-drop-line`, `--proposed-ghost-shift`, `--proposed-duration-moved`.
`--proposed-outline-dash` draws the "proposed" labels only.

## Design system decisions

One line per change to a component's API or default.

| Component   | Change                                                                     | Kind           |
| ----------- | -------------------------------------------------------------------------- | -------------- |
| `Modal`     | `actions` sit at the right of the header, before Close (was: after detail) | default change |
| `HoverMenu` | a text trigger (one letter) and a downward opening, for the sort menu      | new props      |
| `HoverMenu` | plain menu items, disabled items, a rule between groups and a note         | new variant    |
| `Icon`      | `agent`, `dispatcher`, `mirror`, `grip`                                    | new names      |
| `Tabs`      | used as a three-way choice in the submit form (Basis)                      | none; a use    |

`proto.css` overrides `DS.Modal` from outside by its class names (`.ds-Modal-actions`,
`.ds-Scrim-close`): that is the default change above, not a pattern to copy.

## Not as in the system, on purpose

- The help panel is `position: fixed` and follows its column by measuring on scroll; at the edge
  of the window it stays inside, and it leaves the window with its column.
- The move form opens under its card and widens the card's place in the list while open.

## Fixture

`fixture.json` holds invented projects, tasks and events, keyed by operation: `config.get`,
`status.get`, `columns.describe`, `task.get`, `task.history`, `inbox.list`, `services.get`.
`task.get` and `task.history` are keyed by task. Shapes that the catalogue does not have yet:

- `config.get` `columns[].group` (`"todo"` or null) and `columns[].source`: `{kind: "manual"}` or
  `{kind: "mirror", tracker, name, field, health, readAt, error?}`. `projects[].approvalWatch`:
  the watched top-level directories. `projects[].curator`.
- `status.get` `tasks[].position`: the place in the manual order of the column.
  `tasks[].submission`: `{column, by, sha, basis, from?, reason?}`.
  `prSummary[].approvals[]`: `{author, sha, onHead, commitsAfter, dirsChanged, notCounted}`, with
  `notCounted` one of `history_rewritten`, `rate_limit`, `pr_too_large` or null.
- `columns.describe`: per column `exit {to, conditions[{id, text}]}`, `returns[]`, `limits`,
  `executor {kind, role?, project?, session?}`, `escalation {chain[], silent}`, `movedBy`.
- `inbox.list` item of kind `no_recipient`: `{project, column, expects, turnsWaiting, oldestAt}`.
- `services.get`: the `github-project` source.

Writes the screen needs and the prototype only imitates: reorder a task within a column (key,
column, the key it goes before); move a task between Backlog parts (key, target part, reason);
take over and submit or return a turn.

`now` is the time the ages count to.
