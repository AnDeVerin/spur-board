# Review approval gate

Deployment source: `github/`. Install both workflows under `.github/workflows/` and `approval-gate.mjs` under `.github/scripts/` in spur-board. The evaluator executes only trusted main-branch code. The review-event signal workflow has no token permissions and executes no repository code.

Required status: `Review approval`, expected source GitHub Actions (App ID 15368). Keep `ci-ok` required. Disable required approval count, CODEOWNER approval, last-push approval and additional unattributed-change approval: the custom gate replaces those review requirements, not CI or discussion resolution.

Accepted decisions for the current PR head SHA:

- Latest decisive review by `adv-board-reviewer[bot]` is APPROVED.
- Latest decisive review by `AnDeVerin` is APPROVED and the owner is not the PR author.
- For an owner-authored PR only: successful owner-dispatched override from main, bound to the exact PR number and full SHA. Both original and triggering actor must be AnDeVerin; reason must contain at least 10 characters.

A later dismissal or request-changes supersedes an earlier approval by the same reviewer. Human approval/override automatically dismisses outstanding request-changes reviews from our bot only. Other reviewers' blocking reviews are not silently dismissed.

## Manual paths (Mac mini may be offline)

For another author's PR, review in GitHub and select Approve. The signal workflow wakes the trusted evaluator.

For your own PR, Actions → Review approval gate → Run workflow → main:

- mode: override
- pr_number: PR number
- head_sha: full current head SHA
- reason: explanation of the override

The reason is stored in the Actions inputs and run summary; it is public repository audit data. Do not include secrets. A new SHA invalidates both approvals and overrides. The gate re-fetches the head before publishing its decision.

Run mode `evaluate` to re-evaluate a PR without granting an override (useful after installing the workflow or recovering an Actions outage). This needs no local worker and does not invoke Codex. No schedules or polling are used.

Override persistence is verified against successful workflow-dispatch run metadata: trusted workflow path/main branch, owner actor and triggering actor, and exact PR/SHA encoded in the run title. Deleting the audit run removes the override on the next evaluation. Re-running an override requires the same owner and current SHA.

GitHub Actions must be available. Gate errors leave merge blocked. The Actions App source restriction does not defend against a repository writer deliberately adding another same-repository workflow with statuses:write; protect workflow changes and keep repository write access limited to trusted contributors.
