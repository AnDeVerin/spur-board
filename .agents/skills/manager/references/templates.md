# Manager templates

## Clarify batch

Send once, then end the turn.

```
## Clarification needed

1. **<topic>**: <question>? (default: <best guess>)
2. **<topic>**: <question>? (default: <best guess>)

Reply with numbers to override, or "ok" to accept the defaults.
Codex: mention $manager in the reply so the run resumes.
```

A reply with numbers overrides those defaults; anything else accepts them all.

## Manager Run

The last thing the manager prints.

```
## Manager Run
Task: #<N> <title>
Tier: <0-3> - ambiguity <low|med|high>, blast <low|med|high>
Acceptance criteria:
- <criterion>
Execution:
- research / critic: SELECTED | SKIPPED
- architect: DRAFT | DRAFT+FINAL | REPLAN | REPLAN+FINAL | SKIPPED
- spec-critic: SPEC_APPROVED (x<N>) | BLOCKED_SPEC | SKIPPED
- designer: plan APPROVED (x<N>), code APPROVED (x<N>) | BLOCKED_DESIGN (<mode>) | SKIPPED
- clarify: DONE (<N> asked, <M> assumed) | DEFAULTS (<M>) | SKIPPED
- developer: DONE (x<N>)
- simplify: DONE | SKIPPED
- reviewer: APPROVED (x<N>) | BLOCKED_REVIEW | SKIPPED
- tester: PASS (x<N>) | SKIPPED
- pr: <url> | SKIPPED - <reason>
Spec file: .scratch/spec-<N>.md
Evidence:
- <criterion> - <gate>: <proof>
Assumptions: <default applied> | none
Risks: <from architect and reviewer> | none
Findings: <FINDING lines> | none
Missing: <gate or evidence> | none
```
