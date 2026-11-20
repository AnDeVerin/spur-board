<!--- Title: a conventional commit with the issue number first in the subject, e.g. "feat(core): #15 add the config schema". Releases are versioned from the type. -->
<!--- Readers: the reviewer and the maintainer. Every line should help one of them; cut the rest. -->
<!--- Long supporting material (payloads, logs, evidence lists) goes in a <details> block. -->

## Description

<!--- 2-5 bullets, one or two lines each. Lead with what changes for the user, the CLI or API caller, or the agent, not with how the code does it. -->
<!--- No file lists, no restating the diff; implementation choices belong in Architecture decisions. -->
<!--- When relevant, last bullet: "Not in this PR: <follow-up or known limitation> (#N)". -->

- <what changes, for whom>

## Architecture decisions

<!--- Material, non-obvious choices only, from the approved spec and the final diff. Usually 1-4 rows, one sentence per cell. -->
<!--- No such choices: replace the table with one line "None - <why, e.g. follows the existing pattern in X>". -->
<!--- Never invent a rejected alternative to fill a row. -->

| Decision   | Alternative considered | Why                           |
| ---------- | ---------------------- | ----------------------------- |
| <decision> | <alternative>          | <why the chosen approach won> |

## Testing

<!--- One line per acceptance criterion of the issue: the test, command or output that proves it. -->
<!--- Steps a reviewer can repeat, plus the edge cases that matter. A green `pnpm check` is a given; don't list it. -->

- [ ] <criterion> - <test name, or command and the output it prints>

## Acceptance gates

<!--- Required when this PR changes a UI file: a path under packages/web/ outside its top-level test/, gallery/ and kit/, or docs/design-system-decisions.md (prototype paths do not count). Each line takes the full head SHA of the gate's last passing run (tester PASS, designer APPROVED, or a no UI change since line counted from such a head), never a failed head. Write n/a only for a gate this task does not use; an applicable gate that has not passed keeps its last passed head, or the placeholder when it never passed: CI stays red, Testing names it under Missing and a human decides. The section holds only the two lines below; any other line fails. CI acceptance-gates fails while a UI file changed after a named head; a description edit re-runs it. A PR that changes no UI file passes whatever this says: delete the section then. -->
<!--- n/a only when the PR changes no file that gate covers; re-check it after every UI change. -->

tester: <sha | n/a>
designer: <sha | n/a>

## Risk

<!--- high, medium or low, and a one-line reason: what can break and who notices. -->

- <high | medium | low> - <reason>

## Design System decisions

<!--- UI change only: one row per difference between a prototype and the build and one per change to a `ds/` part's API, or the single line "None" when there is none; reason codes and rules in docs/design-system-decisions.md. Delete this section when the PR changes no UI. -->

| Part   | Case   | Decision   | Reason code   | Evidence            |
| ------ | ------ | ---------- | ------------- | ------------------- |
| <part> | <case> | <decision> | <reason code> | <state URL or file> |

## Changed checks

<!--- Required when this PR adds, changes or deletes a test file: one line per file; CI guardrails fails until each has one. Also required when it deletes, skips or weakens a test, a snapshot, or a lint, TypeScript or CI setting: one line each, what changed and why. Otherwise delete this section. -->

Closes #<N>
