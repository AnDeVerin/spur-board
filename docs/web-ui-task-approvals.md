# Web UI: approvals

How the [task view](web-ui-task-view.md) of the [web UI](web-ui.md) shows the approvals of an
open pull request and what changed after each. The [Board](web-ui-board.md) card shows the same
facts in Ready to Merge.

## Approvals section

The **Approvals** section comes after Turn (or Why it is here) and before Latest submission. It
lists the latest approval of each reviewer of every open PR link, in link order, from the
`approvals` that `task.get` puts on the link; its header counts the rows. It is absent when no
open PR link carries approvals, so an open PR with no approval, a merged or closed PR and an
older server without the field show no section. Like every section of Now, it keeps its open or
closed state in this browser; it starts open.

Each row reads the reviewer, the first 7 characters of the approved commit (the full SHA in its
tooltip) and what changed since:

- `on the head` for an approval on the current head.
- `N commits since`, then ` · changed:` and the top-level entries those commits changed, in up
  to two groups that say it in words: `watched` with a warn chip per entry (tooltip
  `Changed since the approval; watched`), then `not watched` with a ghost chip per entry, or a
  default chip in a row with the attention tint (tooltip
  `Changed since the approval; not watched`), e.g.
  `3 commits since · changed: watched back/ front/ · not watched docs/`. An empty group is left
  out, and a long entry name wraps within the row. After merges only, the row reads
  `0 commits since` with no chip: merge commits, base-branch merges included, add neither
  commits nor entries.
- A `not counted` chip and the reason when the commits could not be counted:
  `history rewritten after the approval` (a rebase or force-push; a warn chip),
  `GitHub rate limit` (read again once the budget recovers) or
  `the PR is too large to compare` (above 100 commits), each with a ghost chip.
- `not read yet` until the commits after the approval are first read.

Watched entries are the project's `approvalWatch` (see the configuration reference); without the
key every changed entry counts as watched. A row asks for a look, and takes the attention tint,
when a watched entry changed after the approval or the history was rewritten after it. Its text
reads at full brightness at rest, so a `not watched` entry there takes the default chip rather
than the ghost chip. Other rows read muted until hovered. With two or more PR links carrying
approvals, each row starts with its PR ref. A long PR ref or login breaks within the row, so
the task view never scrolls sideways.

## On the card

In Ready to Merge, with approvals and no changes requested on the head, the reviews cell counts
every approval. The approval that asks most for a look drives the cell: a rewritten history, then
a watched change, then other commits since, then uncounted or unread, then the head. The cell
adds a quiet `+N` (commits since that approval, `+0` after merges only) or `?` (not counted or
not read yet), explained by its tooltip; on the head it adds nothing. When any approval asks for
a look, the cell turns yellow and a warn chip comes first among the markers: `approved before`
and up to two watched entries, wrapping within the card when long, then `+K` for the rest (the tooltip names the reviewer, the commit
and every watched entry), or `approval: history rewritten`. Changes requested keep the cell as
before and the chip still shows; when the facts are not confirmed the cells turn grey and the
chip stays.

Approvals are a hint only: no gate, move or turn reads them, and nothing blocks a merge on them.
