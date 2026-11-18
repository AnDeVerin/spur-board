# Web UI: status bar and services

The status bar and the services panel of the [web UI](web-ui.md) show service health.

## Status bar

Left to right: **services** toggles its panel; service buttons (daemon, slack, github, spur, jira
when listed); Light/Dark/Auto theme menu with the choice's icon; daemon version, empty until
the first status read.

Service dots follow `status.get` health: green healthy, amber degraded, red failing. Names read
`<service>: <word>`:

- daemon: `running`, `stalled` after 120 s without a completed tick, `no answer since <time>` when
  the UI cannot read it, or `no answer` if the first read fails.
- slack: `up` or `down`.
- github, spur and jira: `polling` when healthy. GitHub takes the worst across repository pull
  request and issue sources. Otherwise the first source matching the service's colour supplies
  `blind: <reason>`, `never completed`, `warming up` or `stale`. Else `waits for rate budget`
  means a GitHub budget reached its configured reserve; hover for the reason.
- `unknown`, with a hollow dot, for a service with no health row, for all before the first status
  read, and for all but the daemon while the daemon does not answer.

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
- One box per GitHub source, spur, one per Jira source, headed by its own state: Last complete
  poll, Last observation, Blind (when blind), Freshness, Warming up, Points last hour (pull request
  sources) and Budget: a bar of requests left over the limit with its reset time, amber at 20% and
  red at 5%; `<n> left` without a limit; `—` without a budget. The spur box adds an availability
  line while Spur is unavailable.

Healthy services omit their healthy-since time. Before the first status the panel waits; an
unreachable daemon makes boxes unknown. Lost live updates with a reachable daemon show
`Data from <time>` and retain data. Close, Escape, the scrim or services button closes the panel;
focus returns to its opener, or services after a link.

While open, header and columns are inert; the bar accepts pointer only (Tab stays in the panel).
Narrow panels cover the bar. Opening and closing add history entries; Back after close reopens it.
