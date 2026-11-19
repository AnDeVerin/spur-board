---
name: pr-comments-fix
description: Answer feedback on your own PR - collect unresolved review threads and new comments, fix or reply with a reason, push once, sign each post. Use when a review, a changes request, or a review or PR comment arrives on your PR. Don't use for opening a PR or writing its body (use gitflow).
---

# PR comments fix

Fix or answer every open PR point once, with a reason for each rejection.

## 1. Collect

- Head commit and reviews: `gh pr view <N> --json headRefOid,reviews,comments,isDraft`.
- Unresolved review threads, every page and every reply: `references/collect-threads.md`.
- Review bodies whose `commit.oid` equals `headRefOid`, and PR conversation comments posted after
  the head commit.
- Skip posts that carry this session's marker; they are your own.

## 2. Decide

- Check each comment's premise in the code before acting on it. Reviewers can be wrong.
- Premise holds and the request is in the issue's scope -> fix it.
- Premise is wrong, or the fix would break an invariant of the spec -> reply with the reason and
  the evidence (`file:line`, a command and its output).
- Request is outside the issue -> reply that it is out of scope and name the follow-up issue, or
  say one should be filed.

## 3. Fix and push once

- Make all fixes as new commits, following `gitflow`.
- Run `pnpm check`. Fix every failure first.
- The branch conflicts with `main`: merge `main` into it as `gitflow` says.
- Push once, after all fixes are committed, so reviewers get one notification and one new head.
- A fix changes a test or a check -> add its line to the PR's `## Changed checks` section
  (`gh pr edit <N> --body-file`).

## 4. Reply

- Each review thread gets one reply in that thread:

  ```
  gh api graphql -f id=<thread-id> -f body="$(cat .scratch/reply.md)" -f query='
    mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{
      pullRequestReviewThreadId:$id,body:$body}){comment{url}}}'
  ```

  Text: `Fixed in <sha>.` plus one line on what changed, or the reason it was not changed.
- Review bodies and conversation comments get a new PR comment:
  `gh pr comment <N> --body-file <file>`. Never use `--edit-last`; several sessions can share one
  GitHub login, and it would rewrite another session's comment.
- Sign every post: the session marker from your launch instructions, else
  `[AI-generated, session: $SPUR_SESSION]` with the variable expanded, as the last line, once.
- Resolve each thread you replied to, fixed, rejected or out of scope: after the reply, and
  after the push for a fix:

  ```
  gh api graphql -f id=<thread-id> -f query='
    mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}'
  ```

- A reopened thread -> `references/reopened-threads.md`.

## 5. Repeat and report

- A later review or comment notification -> run the collection again from step 1; the head and
  the set of open threads have changed.
- No open point, a `tester` or `designer` (code) verdict recorded `on <sha>` in the PR's Testing,
  and either an APPROVED review on `headRefOid` or an acceptance-gates-only failure -> apply
  `Final head` in `.agents/skills/manager/references/verdicts.md`, with the handoffs of
  `.agents/skills/manager/references/runtime.md`. Acceptance-gates-only failure:
  `pnpm ci:status <N>` lists `acceptance-gates` as the only counted failed job, the ci run is
  completed, and `gh run view <its ci run id> --log-failed` once shows
  `ci-ok: acceptance-gates failure FAIL` and no other `ci-ok: ... FAIL` line except
  `ci-ok: FAIL`; otherwise wait for the next notification. `--log-failed` prints nothing for an
  unfinished run, and on a PR edit `ci-ok` also carries the reused code run's failures. Write
  each verdict and line it gives into Testing, and into `## Acceptance gates` only the head of a
  tester PASS, a designer APPROVED or a `no UI change since <passed head>` line (else keep the
  last passed head or the placeholder), with `gh pr edit <N> --body-file`.
- Report in the session, not on the PR: `Fixed: <thread or comment> - <sha>` and
  `Rejected: <thread or comment> - <reason>`, one line each, plus the checks run and their exit
  codes.
