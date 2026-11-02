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

| Decision | Alternative considered | Why |
| --- | --- | --- |
| <decision> | <alternative> | <why the chosen approach won> |

## Testing
<!--- One line per acceptance criterion of the issue: the test, command or output that proves it. -->
<!--- Steps a reviewer can repeat, plus the edge cases that matter. A green `pnpm check` is a given; don't list it. -->

- [ ] <criterion> - <test name, or command and the output it prints>

## Risk
<!--- high, medium or low, and a one-line reason: what can break and who notices. -->

- <high | medium | low> - <reason>

## Changed checks
<!--- Required when this PR deletes, skips or weakens a test, a snapshot, or a lint, TypeScript or CI setting: one line each, what changed and why. Otherwise delete this section. -->

Closes #<N>
