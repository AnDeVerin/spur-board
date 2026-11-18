# Reviewer handoff

## Process
- Requirements - each criterion falsified against its verification; each invariant still holds.
  No dead code or duplicates; nothing simpler would do (skip after a simplify pass). No guard or
  cache for a case that does not occur.
- Tests - a bug fix ships a test that failed before the fix, or a stated manual scenario. A test
  whose `no_claim` swallows its criterion does not cover it. Search for the assertion, not the
  file name.
- Changed checks - CI `guardrails` checks the PR's `## Changed checks` section against each test
  file the diff adds, changes or deletes; do not recheck those. List what it cannot see: a changed
  expected value, a looser matcher, `continue-on-error`, a loosened threshold or lint rule. Each
  must appear in the developer's `Changed checks` with a reason; a missing one is MUST FIX.
- Regressions - changed interfaces and exports keep their callers working.
- Agent files - `.agents/`, `.claude/` or `.codex/` changed: the copies carry the same name,
  description and instructions as the source in `.agents/`.
- Conventions - the loaded skills. A comment states a non-obvious why, nothing else.
- Run the repo checks (`pnpm check`) and read each exit code directly.
- A finding on code the diff did not introduce says so; report it as SHOULD FIX.
- Report only issues you are more than 80% sure of.
