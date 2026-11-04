// The adapters package: starts the runner that polls every source and reports to core.
import type { Config } from '@spur-board/contracts';
import { startRunner, type AdapterCore, type AdapterRunner } from './runner/runner.ts';
import { createSpurAdapter, type SpurNotice } from './spur/spur.ts';

export type { AdapterCore, AdapterRunner, SourceState } from './runner/runner.ts';

/** Starts polling each configured source. */
export function startAdapters(
  config: Config,
  core: AdapterCore,
  options: { onSpurNotice?: (notice: SpurNotice) => void } = {},
): AdapterRunner {
  return startRunner({
    entries: [
      {
        adapter: createSpurAdapter({
          baseUrl: config.adapters.spur.baseUrl,
          intervalMs: config.adapters.spur.intervalMs,
          flipSmoothingMs: config.health.flipSmoothingMs,
          onNotice: options.onSpurNotice,
        }),
      },
    ],
    core,
    config,
  });
}
