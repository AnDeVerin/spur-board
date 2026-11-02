# AGENTS.md

## Workflow

- Work an issue with `/manager <issue-number>` (Codex: `$manager <issue-number>`). The skill
  scores the task into a tier and routes it through role agents; its rules are in
  `.agents/skills/manager/SKILL.md`.
- Role agents live in `.agents/agents/`. `.claude/agents/` and `.codex/agents/` are copies of
  them and `.claude/skills` links to `.agents/skills`; change the source and its copies in the
  same commit.
- The manager keeps its spec in `.scratch/spec-<issue-number>.md`. `.scratch/` is not committed.
