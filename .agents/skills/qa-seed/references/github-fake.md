# GitHub fake

- `fake github pr <n> comment` and `fake github pr <n> review <state>` add a comment, or a review
  on the head, at the stand clock. The author is `--author`, else `stand-reviewer`, or `stand-bot`
  with `--bot`; keep bots off `stand-reviewer`, or its approvals stop counting. `review` with
  `--threads <n>` also opens n unresolved review threads; `fake github pr <n> resolve` resolves
  them all, or one with `--thread PRRT_<n>_<i>`.
- `fake github pr <n> merge` changes only the PR: issues in its `closingIssuesReferences` stay
  open. A scenario closes them with `fakes.github('issue-close', ...)`, by hand
  `fake github issue <n> close`.
- `fake github pr <n> edit <index>` edits comment `<index>` (0 is the oldest) at the stand clock;
  the PR's `updatedAt` stays, so only the index `edited` alias shows it.
- `fake github pr <n> create --seed` takes `commits`: `[{oid, parents, changed}]`, oldest first,
  the last `oid` equal to `headRefOid` or `create` answers 400. `changed` names the top-level
  entries a commit changes, `name/` for a directory; a parent not listed is base history. Without
  `commits` the PR has one commit at its head. `push <sha>` appends a commit on the old head that
  changes nothing.
- A PR's commits are read only once core requests it: a PR created after its issue is only
  discovered on the first poll, so poll twice before reading its `approvals`.
- `fake github issue <n> project-status <Backlog|Ready|Done|none|archived|removed>` sets the
  issue's Status in the one fake GitHub Project, `stand-org/1` ("Stand roadmap", field `Status`);
  `none` clears the field, `archived` archives the item, `removed` takes the issue out; follow it
  with `pnpm stand poll`. Another Project number or field name answers `NOT_FOUND`, as on GitHub.
- `fake github inspect` prints the last 500 GraphQL requests the fake answered: `seq`, operation,
  repo and PR numbers; `reset` clears them. Each `pnpm stand poll` restarts the adapters, so
  in-memory adapter state such as the PR cache starts empty on that poll.
