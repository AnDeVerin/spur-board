---
name: working-in-the-monorepo
description: Package map, allowed dependencies, PR order, new packages, catalog versions, boundary lint errors. Use when you add a package, edit a package.json or pnpm-workspace.yaml, or import across packages. Don't use for contracts content (use working-with-contracts) or tests (use testing-and-ci).
---

# Working in the monorepo

## Package map

- What each package holds: `AGENTS.md` `## Packages`. The boundary rules: `eslint.config.js`.
- Runtime edges: core, adapters, gateway-slack and gateway-testkit depend on contracts; daemon
  depends on adapters, contracts, core and gateway-slack. The private stand depends on adapters,
  contracts, core, daemon, gateway-slack and testkit. Runtime dependencies point toward contracts;
  contracts depends on no workspace package at runtime.
- Dev edges: core, daemon and gateway-slack use gateway-testkit; contracts uses testkit; the CLI
  takes contracts as a dev dependency because its bundle inlines it. A dev dependency on
  `packages/testkit` or `packages/gateway-testkit` is allowed from any package except adapters
  and the CLI: their boundary lint covers their tests too and rejects both imports
  (`adapterBoundaryPatterns`, `cliBoundaryPatterns`), even `@spur-board/adapters/testing` inside
  adapters. Their tests import local fakes by relative path, e.g. `createFakeCore` from
  `packages/adapters/src/testing.ts`.
- Declare every workspace import in the importing package's `package.json` as `workspace:*`.
- Lint enforces only seven edges: adapters import only contracts and
  `packages/adapters/src/runner/`, and adapter folders do not import each other; the CLI imports
  only contracts; only core and daemon import SQLite; no other package imports the stand;
  production `src` does not import the Slack fake; `packages/core/src/domain/` imports no store,
  app, api, Kysely or Node IO module; `packages/core/src` imports no gateway package. Every other
  edge is held by `package.json` alone, so check the direction yourself.

## PR order

- One issue, one branch, one PR (`gitflow`), even when it spans several packages.
- The exception: a new contracts kind, value, port or required field merges first, then its
  consumers; see `working-with-contracts` `## PR order`.

## New package

Follow `references/new-package.md`.

## Dependency versions

- A new third-party dependency goes in the `catalog:` of `pnpm-workspace.yaml`, and each
  `package.json` uses it as `"catalog:"`. Do not pin a version in a package.
- The CLI bundles `@spur-board/*`. A runtime dependency listed in `neverBundle` in
  `packages/cli/tsdown.config.ts` stays external, so it also goes in `packages/cli/package.json`
  `dependencies`. `scripts/package.ts` rejects `workspace:` or `catalog:` left in the tarball.
- Renovate and release-age rules: `testing-and-ci`.

## Check scope

- Run `pnpm check` before you push. It checks changed packages plus the packages that depend on
  them (`withDependents` in `scripts/check.ts`), so a change to contracts tests its consumers.
- A change to a file in `GLOBAL_FILES` (`scripts/check-plan.ts`), such as a `package.json` at the
  root or `pnpm-workspace.yaml`, runs the full check.

## Boundary lint errors

Follow `references/boundary-lint-errors.md`.

## Domain skills

- `working-with-contracts` - schemas, events, ports and the contracts-first order.
- `working-with-storage` - the SQLite store in core.
- `running-the-daemon` - daemon modules and lifecycle.
- `writing-adapters` - adapters and the runner.
- `handling-errors` - error codes, hints and exit codes.
- `building-messenger-connectors` - messenger gateways and conformance.
- `testing-and-ci` - tests, checks and CI.
