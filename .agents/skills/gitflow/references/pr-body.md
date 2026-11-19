# PR body sections

## Mapping from the spec

- Description - what changes for the user, the CLI or API caller, or the agent, from the spec's
  Objective. Out-of-scope follow-ups go in the last bullet with their issue number.
- Architecture decisions - one row per `### Design` entry: decision, the alternative it beat,
  why. Reword each row in plain words; a spec row that cites a private decision or task ID, a
  person, a company or a machine path loses that reference in the PR. No material choice -> one
  line `None - <why>`, e.g. `None - follows the existing pattern in the manager skill`. Never
  invent an alternative to fill a row.
- Testing - one line per acceptance criterion of the issue, in the issue's order: the criterion,
  then the test, or the command and the output it printed, taken from the spec's
  `### Verification` and the close-out evidence. Tick `[x]` only when that proof was observed in
  this run; otherwise leave `[ ]` and write `pending - <why>`.
- Risk - `high`, `medium` or `low` with a one-line reason, from the spec's `### Risks`.
- Acceptance gates - required only when the PR changes a UI file: under `packages/web/` outside
  `test/`, `gallery/` and `kit/`, or `docs/design-system-decisions.md`. `tester:` and `designer:`
  each take the full head SHA of the gate's last passing run (tester PASS, designer APPROVED, or
  a `no UI change since` line); a FAIL or CHANGES_REQUESTED head never goes there. `n/a` only for
  a gate the task does not use (its modifier does not apply); an applicable gate that never
  passed keeps the placeholder, CI stays red, Testing names it under Missing and a human decides.
  CI `acceptance-gates` fails while a UI file changed after a named head; a description edit
  re-runs it. The cap never excuses the final-head run (Final head in
  `.agents/skills/manager/references/verdicts.md`).
- Changed checks - one line per entry below, from the developer's `Changed checks` output.

## Changed checks

This list wins over the template's shorter comment. Each of these gets its own line, saying what
changed and why:

- deleted tests, or fewer `expect` assertions;
- weakened or changed assertions: a looser matcher, a changed expected value;
- skipped or focused tests: `.skip`, `.only`, `xit`;
- changed snapshots or golden files;
- changed test, lint, TypeScript or CI config, or the shared test kit;
- disabled or loosened lint rules, e.g. `eslint-disable`;
- type escapes: `@ts-ignore`, `@ts-expect-error`, `as any`;
- `continue-on-error` or any other way to let a CI step fail silently;
- loosened thresholds: coverage, timeouts, retries.

CI `guardrails` fails until the section names each added, changed or deleted test file;
a description edit re-runs it. Add a changed expected value by hand.

Any other changed check gets a line. No entries -> delete the section.
