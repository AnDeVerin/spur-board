# New package checklist

Model it on `packages/adapters/package.json` and `packages/adapters/tsconfig.json`.
There is no template.

- `packages/<x>/package.json`:
  - `"name": "@spur-board/<x>"`, `"version": "0.0.0"`, `"private": true`, `"type": "module"`;
  - `exports` pointing at the source, e.g. `"."` to `./src/index.ts`;
  - a `typecheck` script, `tsc --noEmit -p .`;
  - no package `test` script: the root `vitest.config.ts` include already runs
    `packages/<x>/test/`, and a filtered script can pass without running a test;
  - dependencies as `SKILL.md` `## Package map` and `## Dependency versions` say.
- `packages/<x>/tsconfig.json` extends the root `tsconfig.base.json` with `include` set to `src`
  and `test`.
- The first source file and its runtime dependencies land before typecheck runs: see the
  `testing-and-ci` bullet that starts "Give a new package".
- Run `pnpm install` so the workspace links the package.
- Add a line to `AGENTS.md` `## Packages`, with the skill that covers it if one exists.
- A package that must not import some other package gets a boundary rule: see `SKILL.md`
  `## Boundary lint errors`.
