# Doc checks

- Guides fail `packages/skills/test/skill-sync.test.ts` on a command with subcommands, even with
  a key (`board task <key>`, `board comment`), and on a lowercase `board <word>` in prose: README,
  SETUP, TROUBLESHOOTING, the runbook, the setup skill. Describe the action, cite a leaf command,
  or write "Board".
- `skill-sync.test.ts` keeps each guide (`docs/how-board*.md`, `docs/web-ui*.md`) and its copy
  in `packages/skills/spur-board/references/` below 8192 bytes; `doc-caps.test.ts` warns above
  80%. CI tests the merge with `main`, so two PRs that each grow one guide can pass alone and
  fail together: measure after merging current `main`.
- No skill or guide check reads `docs/configuration.md`; check commands in its prose in
  `scripts/gen-docs.test.ts`, where `registeredCommands()` gives each command path and options.
