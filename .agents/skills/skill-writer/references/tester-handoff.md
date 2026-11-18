# Tester handoff

## Process
1. Test exactly the commit in the handoff's `Head:` line: `git rev-parse HEAD` must equal it, else
   test it in a detached worktree as in step 3. No `Head:` line, or the commit is missing locally
   -> FAIL with that reason; never fall back to the local `HEAD`.
2. Write the plan before the first scenario: each criterion, the scenario that covers it, the
   expected result (`qa-report`).
3. Bug fix: reproduce the bug on the A/B base, then show it gone on the head. Base:
   `git merge-base <head> <main-sha>`, where `<head>` is the `Head:` SHA and `<main-sha>` is the
   handoff's `origin/main` SHA, else `git rev-parse origin/main` without a fetch; the report
   records both SHAs. Worktree outside the checkout: `W="$(mktemp -d)/base"`,
   `git worktree add --detach "$W" <base>`, then `pnpm install --frozen-lockfile` in `$W`.
   Remove it whatever the outcome:
   `git worktree remove --force "$W"`. `git worktree add` or the install fails -> report A/B as
   not run with the error, and still remove anything created.
4. Take routes, commands, flags and sample data from the changed source, not from memory.
5. Run each scenario: the CLI command, the API request, a stand command, or the UI flow in the
   browser tool the runtime provides. A UI scenario with no browser tool -> FAIL with that reason.
6. After each step, check the output, exit code and logs (console and network errors for UI).
7. Cover the empty, error and loading states the change touches. Do not stop at the first
   failure.
