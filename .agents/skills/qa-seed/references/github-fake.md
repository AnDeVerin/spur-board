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
- `fake github inspect` prints the last 500 GraphQL requests the fake answered: `seq`, operation,
  repo and PR numbers; `reset` clears them. Each `pnpm stand poll` restarts the adapters, so
  in-memory adapter state such as the PR cache starts empty on that poll.
