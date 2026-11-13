# GitHub responses

GitHub-specific parsing rules for `GithubClient.query` callers in
`packages/adapters/src/github/`.

- GraphQL errors in a 200 response: `GithubClient.query` maps rate limiting to a synthetic 429
  and `INSUFFICIENT_SCOPES` to `auth`.
- Parse a GraphQL root only after `GithubClient.query` classifies `errors` and its scoped errors
  are handled; denied fields arrive null, so make them nullable.
- Unknown shape in one PR: leave it out, clear `complete`, report it `no_access` if requested;
  rethrow its error if nothing else answered. Other unknown shapes fail the poll.
- Comment history: read `references/comment-history.md`.

## Partial errors that keep complete

An exception to the SKILL.md rule "A missing or denied requested entity gets `not_found` or
`no_access`; any other partial error clears `complete`":

- Except a denied `closingIssuesReferences` (`deniedReference`) or a `null` `requestedReviewer`:
  drop it, keep `complete`.

## PR poll chunks and index

`pollRepository` in `packages/adapters/src/github/index.ts`; tests `describe('PR poll chunks')`
and `describe('PR index cache')` in `packages/adapters/test/github/prBatch.test.ts`.

- Order: discovery, its own request; the index of every requested PR (`indexQuery`, 50 aliases);
  full reads (`detailQuery`, 10 aliases) of the PRs the index shows changed and of newly
  discovered ones.
- A transient failure (5xx, cut-off body, timeout) of discovery, an index chunk or a detail
  chunk counts toward `MAX_FAILED_REQUESTS` per poll; an aliased chunk is resent as two halves
  down to one PR. At the cap nothing more is sent. If no request succeeded, rethrow the first
  failure.
- `throttled`, `auth`, `config`, an abort, a non-`AdapterError` or a failed `fullPr` page
  rejects the poll; nothing is resent.
- A requested PR left unread (chunk given up, never sent, or deferred because `remaining` fell
  below `github.reserveRemaining`) is `no_access`, the batch is incomplete, and an unread
  discovered PR holds the cursor. Discovery and the index still run below the reserve.
- An index alias with an error, an unknown shape or an unscoped error in its chunk means
  changed: read in full. Unscoped errors on a detail chunk still reject.
- Per-instance adapter state is allowed: the Spur adapter (`createSpurAdapter`) and the PR cache
  in the `githubSources` closure, keyed by number, holding only refs requested in the last poll.
- Cache fingerprint: `JSON.stringify` of the parsed index alias (`prIndex.ts`). It lists each
  check's name and state without `isRequired`: a `SUCCESS` rollup also covers skipped checks,
  which core judges red when required. Re-emit the cached facts only when the fingerprint and
  the `feedbackCursors` entry match, `feedbackComplete` is true, the read is younger than
  `OPEN_REFRESH_MS` or `CLOSED_REFRESH_MS`, the index lists every check, review, review thread
  and review request (the full read pages past 100, the index does not), and an open PR's
  rollup is `null` or `SUCCESS`: a failed rollup can hide a check that finished.
- Write the cache only from a full read with an index fingerprint of the same poll; otherwise
  delete the entry, as on `not_found`, `no_access` and `pollPr`. An old entry would re-emit facts
  older than ones already delivered.
- A new input to what a full read returns, such as a comment cursor, joins the cache key.
