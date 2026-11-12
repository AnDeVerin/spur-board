# GitHub responses

GitHub-specific parsing rules for `GithubClient.query` callers in
`packages/adapters/src/github/`.

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
