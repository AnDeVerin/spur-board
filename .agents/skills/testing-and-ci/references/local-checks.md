# Local checks

## What runs where

- `pnpm check` (changed mode): format and lint on changed files; types and the `unit`,
  `integration` and `process` projects for changed packages plus their dependents
  (`withDependents`, `buildSteps` in `scripts/check.ts`). `startup` and package smoke run only when
  `packages/cli` is affected, `stand` only when `packages/stand` is. `scripts/gen-docs.test.ts`
  and `packages/skills/test/skill-sync.test.ts` also run when contracts or cli is affected.
- A change to a file in `GLOBAL_FILES` or `GLOBAL_DIRS` (`scripts/check-plan.ts`), or to a
  root `tsconfig*.json`, switches to full mode; a package's own `tsconfig.json` does not.
- `pnpm run check --pre-push` (the pre-push hook): changed-file format and lint, types and `unit`
  only.
- `pnpm check:full --only test`: `unit`, `integration`, `process` and `startup`.
- Run `pnpm run check --pre-push` by hand with the ref lines git passes on stdin, one
  `<local ref> <local sha> <remote ref> <remote sha>` per line: the local sha is HEAD, and an
  all-zero remote sha marks a new branch (`parsePushRefs`, `scripts/check.ts`).

## Traps

- After changing exports, run `pnpm check:full --only knip`: changed-mode `pnpm check` skips knip
  (`scripts/check.ts`, `buildSteps`). Test imports count as knip usage; inspect unused exports in
  script entry points by hand (`knip.json`, `package.json`).
- Keep a source helper private when no other module imports it; full knip reports same-file-only
  exports under this repo's default configuration (`knip.json`).
- Confirm a filtered test command ran test files. A missing package script or unmatched pnpm
  filter can exit successfully without exercising a test (`package.json`,
  `packages/cli/package.json`).
- Run the TypeScript step for `expectTypeOf` assertions; Vitest does not typecheck them. Package
  tsconfigs include `test`, and `buildSteps` runs `tsc --noEmit` (`scripts/check.ts`).
- Express rejected type shapes with `expectTypeOf(...).not.toExtend<...>()`, without a
  `@ts-expect-error` escape (`packages/contracts/test/gateway/gateway-types.test.ts`).
- With `erasableSyntaxOnly` and `exactOptionalPropertyTypes`, avoid constructor parameter
  properties and give optional fields an explicit `undefined` union when callers pass it
  (`tsconfig.base.json`).
- Give a new package a TypeScript source file before running typecheck, and add runtime
  dependencies when its source uses them; an empty scaffold can fail TypeScript or knip
  (`packages/daemon/tsconfig.json`, `scripts/check.ts`, `knip.json`).
- Read a changing abort flag through a function when a later check follows `await`; direct
  narrowing can survive the await and trip strict lint (`packages/adapters/src/runner/runner.ts`,
  `eslint.config.js`).
- Keep timing-sensitive startup checks in their own Vitest project. Select `startup` explicitly;
  compare base and branch under similar load before changing the threshold (`vitest.config.ts`,
  `scripts/check.ts`, `packages/cli/test/startup.test.ts`, `describe('board startup',`).
- Update one file's snapshots with the file before `-u`:
  `pnpm exec vitest run --project unit <file> -u`. `-u` takes an optional value, so `-u <file>`
  drops the filter and runs every unit file with snapshot updates on.
