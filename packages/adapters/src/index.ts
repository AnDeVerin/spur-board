// The adapters package: starts the runner that polls every source and reports to core.
import type { Config } from '@spur-board/contracts';
import { startRunner, type AdapterCore, type AdapterRunner } from './runner/runner.ts';
import { githubSources, type GithubOptions } from './github/index.ts';

export type { AdapterCore, AdapterRunner, SourceState } from './runner/runner.ts';

/** Starts polling each configured GitHub repository. */
export function startAdapters(
  config: Config,
  core: AdapterCore,
  github: GithubOptions,
): AdapterRunner {
  return startRunner({ entries: githubSources(config, github), core, config });
}
