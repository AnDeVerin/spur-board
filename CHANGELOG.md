# Changelog

Notable changes in each spur-board release, newest first. A breaking change lists what changed and how to migrate the config under **BREAKING CHANGES**; the versioning policy is in [CONTRIBUTING.md](CONTRIBUTING.md#versions-and-the-changelog). Releases before this file, and any release not listed here, are on the [GitHub releases page](https://github.com/AnDeVerin/spur-board/releases).

## [0.170.2](https://github.com/AnDeVerin/spur-board/compare/v0.170.1...v0.170.2) (2026-11-26)

### Bug Fixes

* **adapters:** [#906](https://github.com/AnDeVerin/spur-board/issues/906) read a skipped required check pending while a newer run of its workflow runs ([#907](https://github.com/AnDeVerin/spur-board/issues/907)) ([a7b6c3e](https://github.com/AnDeVerin/spur-board/commit/a7b6c3ee2b47e6d6c3111ec493f8979f11d66bc4))

## [0.170.1](https://github.com/AnDeVerin/spur-board/compare/v0.170.0...v0.170.1) (2026-11-25)

### Bug Fixes

* **gateway-slack:** [#903](https://github.com/AnDeVerin/spur-board/issues/903) reconnect Socket Mode after every drop and log why it dropped ([#904](https://github.com/AnDeVerin/spur-board/issues/904)) ([e5bb061](https://github.com/AnDeVerin/spur-board/commit/e5bb061ce7064190bb36b29122d4eb74d372a4ba))

## [0.170.0](https://github.com/AnDeVerin/spur-board/compare/v0.169.0...v0.170.0) (2026-11-24)

### Features

* **core:** [#900](https://github.com/AnDeVerin/spur-board/issues/900) submit a turn without a commit on a task with no PR ([#901](https://github.com/AnDeVerin/spur-board/issues/901)) ([3350492](https://github.com/AnDeVerin/spur-board/commit/3350492b7b0be7b4a4341e1cfd63ae15c4554f0c))

## [0.169.0](https://github.com/AnDeVerin/spur-board/compare/v0.168.0...v0.169.0) (2026-11-24)

### Features

* **stand:** [#898](https://github.com/AnDeVerin/spur-board/issues/898) refuse demo commands with external credentials and document where to run the stand ([#899](https://github.com/AnDeVerin/spur-board/issues/899)) ([a0e463e](https://github.com/AnDeVerin/spur-board/commit/a0e463ed3f86a0fdaa84f6d50d7f776c505f0a39))

## [0.168.0](https://github.com/AnDeVerin/spur-board/compare/v0.167.0...v0.168.0) (2026-11-24)

### Features

* **stand:** [#895](https://github.com/AnDeVerin/spur-board/issues/895) add a walkthrough scenario stepped by pnpm stand demo next ([#897](https://github.com/AnDeVerin/spur-board/issues/897)) ([0f10551](https://github.com/AnDeVerin/spur-board/commit/0f105514efe64f14ba9df0dbdadf40ce13a4f2fa))

## [0.167.0](https://github.com/AnDeVerin/spur-board/compare/v0.166.0...v0.167.0) (2026-11-24)

### Features

* **stand:** [#894](https://github.com/AnDeVerin/spur-board/issues/894) add a showcase scenario with every column and state for demos ([#896](https://github.com/AnDeVerin/spur-board/issues/896)) ([57bd31d](https://github.com/AnDeVerin/spur-board/commit/57bd31d888283305e577edb799d81209bc3a9e49))

## [0.166.0](https://github.com/AnDeVerin/spur-board/compare/v0.165.3...v0.166.0) (2026-11-24)

### Features

* **core:** [#891](https://github.com/AnDeVerin/spur-board/issues/891) wait for requested required reviewers instead of an immediate review-rule item ([#893](https://github.com/AnDeVerin/spur-board/issues/893)) ([64131c9](https://github.com/AnDeVerin/spur-board/commit/64131c9508388b229b6d26729fc1dbfb9773ec82))

## [0.165.3](https://github.com/AnDeVerin/spur-board/compare/v0.165.2...v0.165.3) (2026-11-24)

### Bug Fixes

* **ci:** [#842](https://github.com/AnDeVerin/spur-board/issues/842) fix the mutation dry run and shard the weekly run ([#892](https://github.com/AnDeVerin/spur-board/issues/892)) ([3d69b45](https://github.com/AnDeVerin/spur-board/commit/3d69b45380dd09bbe664b39d2d51b140cae1f421))

## [0.165.2](https://github.com/AnDeVerin/spur-board/compare/v0.165.1...v0.165.2) (2026-11-23)

### Bug Fixes

* **adapters:** [#888](https://github.com/AnDeVerin/spur-board/issues/888) cap the spur poll backoff at 60 s ([#890](https://github.com/AnDeVerin/spur-board/issues/890)) ([2b66d9e](https://github.com/AnDeVerin/spur-board/commit/2b66d9ece6a50955cf4025771b180263d245bee9))

## [0.165.1](https://github.com/AnDeVerin/spur-board/compare/v0.165.0...v0.165.1) (2026-11-23)

### Bug Fixes

* **testkit:** [#866](https://github.com/AnDeVerin/spur-board/issues/866) refuse Vitest runs started in a package dir ([#886](https://github.com/AnDeVerin/spur-board/issues/886)) ([4ed056c](https://github.com/AnDeVerin/spur-board/commit/4ed056c4b6265ad5c1e83b60d28abe0ef352a705))

## [0.165.0](https://github.com/AnDeVerin/spur-board/compare/v0.164.4...v0.165.0) (2026-11-23)

### Features

* **web:** [#811](https://github.com/AnDeVerin/spur-board/issues/811) open a project block in a block panel from the inbox ([#881](https://github.com/AnDeVerin/spur-board/issues/881)) ([dfddaa1](https://github.com/AnDeVerin/spur-board/commit/dfddaa1211dcaccfeb1c7b1062f30e932a7bf80f))

### Bug Fixes

* **web:** [#883](https://github.com/AnDeVerin/spur-board/issues/883) accept cross-site top-level navigations to the page ([#885](https://github.com/AnDeVerin/spur-board/issues/885)) ([5c20ec3](https://github.com/AnDeVerin/spur-board/commit/5c20ec3c28fb4dff63dd420a76cce5f42c6e5991))

## [0.164.4](https://github.com/AnDeVerin/spur-board/compare/v0.164.3...v0.164.4) (2026-11-23)

### Bug Fixes

* **web:** [#817](https://github.com/AnDeVerin/spur-board/issues/817) list the folded Backlog closest to Dev first ([#882](https://github.com/AnDeVerin/spur-board/issues/882)) ([0ce2116](https://github.com/AnDeVerin/spur-board/commit/0ce2116f375176382b2f3e73da82c83ccd4619ad))

## [0.164.3](https://github.com/AnDeVerin/spur-board/compare/v0.164.2...v0.164.3) (2026-11-23)

### Bug Fixes

* **web:** [#809](https://github.com/AnDeVerin/spur-board/issues/809) give the warn chip text the attention text token ([#878](https://github.com/AnDeVerin/spur-board/issues/878)) ([97eb403](https://github.com/AnDeVerin/spur-board/commit/97eb403b42d4ed5a6bc8762e8e3fcb6ec13eb1f9))

## [0.164.2](https://github.com/AnDeVerin/spur-board/compare/v0.164.1...v0.164.2) (2026-11-23)

### Bug Fixes

* **deps:** update runtime dependencies ([#868](https://github.com/AnDeVerin/spur-board/issues/868)) ([bdf4fbd](https://github.com/AnDeVerin/spur-board/commit/bdf4fbdb526bba6b5f5dd2341e5a1b07a31196fb))

## Upgrade notes from earlier releases

### 0.58.0

Change a dedicated worker column executor to `role: orchestrator`. For operator execution use the literal `orchestrator: operator`, rather than the name of an operator project. Curator executors remain supported.
