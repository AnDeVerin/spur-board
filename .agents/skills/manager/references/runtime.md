# Manager runtime

How the manager spawns roles, what it hands them, and how it tracks gates.

## Spawning a role

| | Claude Code | Codex |
|---|---|---|
| Role files | `.claude/agents/<role>.md` | `.codex/agents/<role>.toml` |
| Spawn | Agent tool, `subagent_type: <role>`, the handoff as the prompt | `spawn_agent`, `agent_type: <role>`, the handoff as the message |
| Wait | the tool returns the output | `wait_agent` on the spawned agent |
| Continue a role | SendMessage to its agent id | `followup_task` to the same agent, then `wait_agent` |

- On Codex, this skill is the explicit request to spawn sub-agents. Do not fork the conversation
  into a role: the handoff is all it gets. Do not set a model; the role file sets the effort.
- Unknown role on Codex -> stop with
  `Missing: .codex/agents not loaded - trust this project in the Codex config`.
- Continuation is unavailable (no such tool, or the agent is gone) -> spawn a new `developer`
  with the earlier `PLAN_READY` output, the designer verdict and the Clarify outcome, and record
  that under Assumptions.

## Handoff

Every spawn gets, and only gets:

- the issue number, title and acceptance criteria;
- the spec file path (tier 0: the acceptance criteria are the requirement);
- the mode, when the role has modes (architect draft | final | replan; designer plan | code);
- the previous gate's output block; `architect` also gets the researcher's `### Findings` next to
  the critic's selection;
- the Clarify outcome and the Assumptions so far;
- the `origin/main` SHA recorded at intake; roles use it wherever they would name `origin/main`;
- the cycle as `N/cap`;
- `reviewer` only: `PR: <url> | none`;
- `tester` only: `Head: <sha>`, from `git rev-parse HEAD` run right before each `tester` spawn -
  the last `developer` or fix commit, since no other role commits.

Never pass the raw conversation.

## Tracking

- `$SPUR_TODO_COMMAND` is set (a Spur session) -> one ledger item per gate: `add` before the
  spawn, `complete --reason <verdict>` after it, `cancel --reason` when a gate is skipped mid-run.
  A rerun or a fix cycle is a new item. See `"$SPUR_TODO_COMMAND" --help`.
- Otherwise use the runtime's plan tool (Claude Code TodoWrite, Codex `update_plan`).

## Spec file

`.scratch/spec-<issue-number>.md`, written only by the manager; roles read it. It holds the
architect's spec (tier 3: the developer's written plan), then `## Gate findings`, where each gate's
gaps are appended. Fix cycles append; they never rewrite earlier entries. A final-mode architect
returns the whole spec, which replaces everything above `## Gate findings`. Tier 0: the file holds
the acceptance criteria and the Clarify outcome.

## Findings

Collect every `FINDING:` line from role outputs. When the session keeps a findings log, append
them there; always list them under `Findings` in the `Manager Run` block.

## Checks

The repo's checks are its `pnpm` scripts; `pnpm check` is the single entry point once the
workspace exists. Before that, roles report `no checks available` instead of inventing a
command. Verify every check by its exit code, never through a pipe.
