# Web UI: status bar and services

The status bar and the services panel of the [web UI](web-ui.md) show service health for
every project, whatever project is chosen in the header.

## Status bar

Left to right: **services** toggles its panel; service buttons (daemon, slack, github, spur, jira
when any project uses Jira); Light/Dark/Auto theme menu with the choice's icon; daemon version, empty until
the first status read.

Service dots follow `status.get` health: green healthy, amber degraded, red failing. Names read
`<service>: <word>`:

- daemon: `running`, `stalled` after 120 s without a completed tick, `no answer since <time>` when
  the UI cannot read it, or `no answer` if the first read fails. `unreadable since <time>` or
  `unreadable` when the daemon answers but the page cannot read the answer. `updated to <version>`
  when reads fail after an update.
- slack: `up` or `down`.
- github, spur and jira: `polling` when healthy. GitHub takes the worst across repository pull
  request and issue sources. Otherwise the first source matching the service's colour supplies
  `blind: <reason>`, `waits for rate budget`, `never completed`, `warming up` or `stale`;
  `waits for rate budget` means the daemon holds back that source's regular poll, because its last
  poll left a GitHub budget under the configured reserve, was throttled, or failed while the last
  budget was under the reserve, unless the source is blind, which outranks the wait; hover for
  the reason. After a daemon restart a button reads `warming up` until every source of its own
  service, in every project, has polled once: an unpolled Jira source does not keep github or spur
  warming up, and a blind source, a source waiting for its rate budget, or a stale one listed
  first, of the same service shows its word instead.
- `unknown`, with a hollow dot, for a service with no health row, for all before the first status
  read, and for all but the daemon while the daemon does not answer.

The **services** trigger shows its own dot when a host reading is at 80% used or more: amber, or
red at 90%, for the worst of CPU, RAM and every disk volume. Its name and tooltip then read
`services: <readings>`, each reading at that level joined by `·`, such as
`services: disk / 91% used, 8.7 GiB free`. Below 80%, and while the daemon does not answer, it
has no dot and reads `services`.

The bar follows each `status` stream message, about every 30 s, and reads nothing itself.

## Services panel

Opened from the bar or by `?open=services`, the left panel shows boxes from `status.get` only:

- daemon: Version, Started, Last dispatch.
- host: CPU, RAM and Disk percent bars, amber at 80% and red at 90%; an unread value shows
  `— / 100`, never 0. One Disk bar per volume, least free space first, keyed `Disk <mount>` when
  there are several and `Disk` when there is one, with the free space in binary units after the
  bar, such as `41.1 GiB free`. A volume that cannot be read is left out; `Disk — / 100` means
  no volume could be read or no sample yet. A host load wait adds an amber row.
- slack: when down, Down since, Reason and Spaces.
- spur, then one group per project, headed by the project id, with one box per GitHub source,
  one per Jira source and one `github project` box per GitHub Project mirror of that project. Each box is headed by its own state, so every source the
  daemon holds back for a rate limit reads `waits for rate budget`, even before its first complete
  poll after a restart. A blind source reads its blind reason instead, `blind: stale`,
  `blind: auth` or `blind: config`, because blind outranks the wait. Each box shows Last
  complete poll, Last observation, Blind (when blind), Freshness, Warming up, Points last hour
  (pull request sources) and Budget: a bar of requests left over the limit with its reset time,
  amber at 20% and red at 5%; `<n> left` without a limit; `—` without a budget. The spur box
  adds an availability line while Spur is unavailable. A `github project` box starts with
  `Project <owner/number>`; when its last read failed it reads `failing` (or its blind reason)
  and adds `Failure <code> · <message>` and a note that `ready-for-dev` is frozen. It has no
  status bar button.

A box name adds `· <repo>` only when its group has two sources of that kind. A service button
scrolls the panel to its service's failing box, else its degraded box, else its first box; among
boxes in the same state it takes the one whose word the button shows, the source the daemon
blames. Healthy services omit their healthy-since time. Before the first status the panel waits;
an unreachable daemon makes boxes unknown. Lost live updates with a reachable daemon show
`Data from <time>` and retain data. Close, Escape, the scrim or services button closes the panel;
focus returns to its opener, or services after a link.

While open, header and columns are inert; the bar accepts pointer only (Tab stays in the panel).
Narrow panels cover the bar. Opening and closing add history entries; Back after close reopens it.

## Host resources

The daemon samples the host every 30 s. A disk volume at 90% used or more in two samples in a row
raises one operator item, and it reaches Slack through the feed like the other items:

<!-- prettier-ignore-start -->
| Kind | Condition | Action | Severity | Clears when | URL |
| --- | --- | --- | --- | --- | --- |
| `board_observation` `host-disk:<mount>` | a volume at 90% used or more in two samples in a row; the text reads `host disk <mount>: <n>% used, <x.y> GiB free` | check the task, then close the item | attention | a sample below 80%, or you close the item | none |
<!-- prettier-ignore-end -->

Between 80% and 90% an open item stays, and its inbox text follows the latest sample, while the
Slack line keeps the percent it was raised with. A closed item stays closed until a sample below
80% ends the episode. CPU and RAM never raise an item.
