# Boundary lint errors

| Message starts with | Rule in `eslint.config.js` | Fix |
|---|---|---|
| Adapters import only @spur-board/contracts | `adapterBoundaryPatterns` | Take the type from contracts; reach core through the runner port. |
| Adapters do not import core or daemon files | `adapterBoundaryPatterns` | Same: go through the runner port. |
| Adapter folders do not import each other | `siblingPattern` | Move shared code to `packages/adapters/src/runner/` or the GitHub client. |
| The CLI imports only @spur-board/contracts | `cliBoundaryPatterns` | Call the daemon through the HTTP client. |
| The CLI may import only its own files | `cli-import-boundary` (local) | Same as above, for relative paths. |
| Production packages do not import the stand | `standBoundaryPatterns` | Drive the board from the stand, never the reverse. |
| Only packages/core and packages/daemon may import the SQLite driver | `sqliteMessage` | Go through `@spur-board/core`. |
| Use a static import so the boundary lint can check it | `dynamicImportBan`, `importTypeBan` | Replace `import()` and `import('x').T` with a static import. |
| Do not compare a project id with a string literal | `no-project-literal-compare` (local) | Read the behaviour from the config. |
| core/src/domain has no IO | `domainBoundaryPatterns` | Take the data as an argument; keep queries in `packages/core/src/app/`. |
| Core does not import a gateway package | `gatewayBoundaryPatterns` | Use the Gateway port from contracts; the daemon wires the gateway in. |

- Same-rule options replace earlier ones: a block that sets `no-restricted-imports` or
  `no-restricted-syntax` restates every ban it still needs, such as the SQLite ban in each
  adapters block.
- A new boundary gets a case in `packages/testkit/test/lint-rules.test.ts` (see
  `describe('adapters boundary',` and `describe('CLI boundary',`).
