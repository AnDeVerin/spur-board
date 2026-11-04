---
name: skill-writer
description: Rules for writing and changing skills, role agents and AGENTS.md - format, frontmatter, triggers, size budgets, copies. Use when you create or edit anything under .agents/, .claude/ or .codex/, or AGENTS.md. Don't use for product code or docs (use the matching domain skill).
---

# Skill writer

Agent files are read by models on every run. Keep them short, exact and in sync.

## Skills

- Layout: `.agents/skills/<name>/SKILL.md`, plus optional `references/` (long material the skill
  links to) and `scripts/` (commands it runs). Nothing else in the directory.
- Skills live only in `.agents/skills/`. Claude Code sees them through the `.claude/skills`
  symlink and Codex reads `.agents/skills` itself; never add a copy elsewhere.
- Frontmatter has exactly two keys:
  - `name` - equal to the directory name;
  - `description` - one line, at most 300 characters: what the skill does, then a positive
    trigger `Use when ...` and a negative trigger `Don't use for ... (use <other skill>)`.
- The description is how a model decides to load the skill. Name the actions and paths that
  should trigger it, not the skill's internals.

## Roles

- Source: `.agents/agents/<role>.md`, frontmatter keys `name`, `description`, `model`, `effort`,
  `tools`, then the instructions as the body.
- A role description says what the role does, then where it sits in the flow:
  `Use after <role>, before <role>.`
- `.claude/agents/<role>.md` is a byte-for-byte copy of the source.
- `.codex/agents/<role>.toml` has `name` and `description` equal to the source,
  `model_reasoning_effort` equal to `effort`, `sandbox_mode` (`read-only` for roles that only
  read, `workspace-write` for roles that edit or commit), and `developer_instructions` holding
  the source body byte for byte in a `'''` literal string.
- Change the source and both copies in the same commit.

## Writing

- Imperative, present tense, English. One rule per bullet; no filler, no history, no
  motivation beyond one short why when the rule is not obvious.
- Point to another skill or file rather than restating it; two copies of a rule drift.
- Use one-line bullets of facts, rules and pointers. Reserve step-by-step instructions for
  process skills whose subject is a procedure, such as `manager` and `gitflow`.
- State a rule once. Cite an enforcing test or lint check by file, adding its `describe` name
  when the file is large. Do not quote test titles or restate a condition the check already makes
  impossible to violate.
- No emphasis by capitals or bold. State the rule plainly; a rule that needs shouting needs
  rewording. Exempt: verdict tokens such as `MUST FIX` or `CHANGES_REQUESTED`, literal strings a
  command matches, and text inside code blocks or inline code.
- Public text only. These files ship in a public repo: no absolute or home-relative machine
  paths, no reference to private notes or their directory, no internal decision or task IDs, no
  company, client or people names. Write ideas from private sources in your own words.

## Budgets

Measured in bytes with `wc -c`:

| File | Budget |
|---|---|
| `SKILL.md` | 5120 |
| each `references/*.md` | 8192 |
| each role `.md` | 4096 |
| `description` | 300 characters |

Over budget -> move detail to `references/`, or cut it. Do not raise the budget.

## Stale rules

A rule you find wrong or out of date while working on a task is fixed in the same PR, as its
own commit (`chore(agents): ...` or `fix(<skill>): ...`), and named in the PR description. Do
not leave it for later and do not mix it into the task's commits.

## Checking

Until a lint covers these rules, check by hand before committing:

- frontmatter keys, `name` equal to the directory, both triggers, description length;
- `wc -c` of every changed agent file against the budget;
- capitals or bold used for emphasis outside code;
- `cmp` of each role source with its `.claude/agents/` copy, and its body against the
  `developer_instructions` of the `.codex/agents/` copy.
