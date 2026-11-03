// The adapters package: starts the runner that polls every source and reports to core.
import type { Config } from '@spur-board/contracts';
import { startRunner, type AdapterCore, type AdapterRunner } from './runner/runner.ts';

export type { AdapterCore, AdapterRunner, SourceState } from './runner/runner.ts';

/** Starts polling every configured source. No adapter is wired yet (#24-#26). */
export function startAdapters(config: Config, core: AdapterCore): AdapterRunner {
  return startRunner({ entries: [], core, config });
}
