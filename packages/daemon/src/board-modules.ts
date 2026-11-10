import { startAdapters, type AdapterRunner, type StartAdaptersOptions } from '@spur-board/adapters';
import { BOARD_TICK_MS } from '@spur-board/contracts';
import { createObservationCore, tickBoard, type Store } from '@spur-board/core';
import type { ModuleContext, ModuleEntry } from './lifecycle.ts';
import { createJob } from './scheduler.ts';

interface BoardModuleOptions {
  /** Test seams preserve the real core and lifecycle behavior. */
  core?: ReturnType<typeof createObservationCore>;
  startAdapters?: typeof startAdapters;
  tick?: typeof tickBoard;
  /** Called only after a tick resolves; a failed or stalled tick never calls it. */
  onTick?: () => void;
}

/**
 * Compose the board's timer and adapter runner without adding lifecycle state to main. `tick`
 * runs the board-core job once more behind its active run and resolves when that run settles.
 */
export function createBoardModules(
  ctxFor: (name: string) => ModuleContext<Store>,
  options: BoardModuleOptions = {},
): { entries: ModuleEntry[]; tick: () => Promise<void> } {
  const coreCtx = ctxFor('board-core');
  const adapterCtx = ctxFor('board-adapters');
  const core =
    options.core ??
    createObservationCore({
      store: coreCtx.store,
      config: coreCtx.config,
      clock: coreCtx.clock,
    });
  const tick = options.tick ?? tickBoard;
  const boardCore = createJob({
    run: async () => {
      await tick({
        store: coreCtx.store,
        config: coreCtx.config,
        clock: coreCtx.clock,
        completeSince: core.completeSince,
      });
      options.onTick?.();
    },
    intervalMs: BOARD_TICK_MS,
    onError: (err) => {
      coreCtx.log.error({ err }, 'board tick failed');
    },
  });
  let runner: AdapterRunner | undefined;
  const entries: ModuleEntry[] = [
    {
      name: 'board-core',
      stopStage: 'final',
      module: boardCore,
    },
    {
      name: 'board-adapters',
      stopStage: 'pollers',
      module: {
        async start(startSignal) {
          const adapterOptions: StartAdaptersOptions = {
            secrets: adapterCtx.secrets,
            now: () => adapterCtx.clock.now(),
            fetch: (url, init) => adapterCtx.logCall('adapter.fetch', () => fetch(url, init)),
            warn: (message) => {
              adapterCtx.log.warn({ message }, 'adapter warning');
            },
            onPollFailure: ({ source, step, kind, error, issues }) => {
              adapterCtx.log.warn(
                { source, step, kind, err: error, ...(issues === undefined ? {} : { issues }) },
                'adapter poll failed',
              );
            },
            onSpurNotice: async (notice) => {
              if (notice.kind === 'restart') adapterCtx.log.info('spur restarted');
              else await core.notice(notice.kind, notice.value);
            },
          };
          runner = (options.startAdapters ?? startAdapters)(
            adapterCtx.config,
            core,
            adapterOptions,
          );
          if (startSignal.aborted) await runner.stop();
        },
        async stop() {
          await runner?.stop();
        },
      },
    },
  ];
  return { entries, tick: () => boardCore.trigger() };
}
