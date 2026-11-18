# Developer handoff

Detail for the `developer` role; `doc-reviewer` reads `## Doc surfaces`.

## Modes

- Tier 3: recon, then write Objective, Change map, Invariants and Criteria -> Verification into
  the output before editing. `stop at PLAN_READY` -> stop there with `Verdict: PLAN_READY`; when
  continued, revise on CHANGES_REQUESTED, implement on APPROVED or
  BLOCKED_DESIGN.
- `simplify pass` -> follow `code-simplifier` on the branch diff only; behaviour stays the same.

## Doc surfaces

- A behaviour change ships its doc updates in the same commit, on every surface it touches:
  `docs/*.md`, `README.md`, `SETUP.md`, `TROUBLESHOOTING.md`; `packages/skills/spur-board/` and
  its references; error hints in `packages/contracts/src/errors.ts`; operation descriptions and
  examples in `packages/contracts/src/ops/catalog.ts` (`--help`, MCP tools, `board schema`);
  field `.describe(` texts in `packages/contracts/src/ops/schemas.ts` and `catalog.ts` (CLI
  flags, MCP inputs); local command help in `packages/cli/src/cli.ts`.
- `docs/how-board-works*.md`, `docs/web-ui*.md` and their copies in
  `packages/skills/spur-board/references/` stay byte-identical.
- Changed generator source -> `pnpm gen`; commit every file it changes.
- A test or CI diff (modifier in `.agents/skills/manager/SKILL.md`) -> no doc edit.

## Changed checks

- Every changed test, snapshot, lint rule, TypeScript option or CI setting goes on its own line
  under `Changed checks`, with why. Deleted, skipped or weakened checks are never silent.
  The list in `.agents/skills/gitflow/references/pr-body.md` names the cases.
- Before the PR, run `pnpm guardrails <sha>` with the handoff's `origin/main` SHA and read its
  exit code; each file it reports gets its own `Changed checks` line.
