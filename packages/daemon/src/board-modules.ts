import { startAdapters, type AdapterRunner, type StartAdaptersOptions } from '@spur-board/adapters';
import { createObservationCore, tickBoard, type Store } from '@spur-board/core';
import type { ModuleContext, ModuleEntry } from './lifecycle.ts';

const TICK_MS = 60_000;

interface BoardModuleOptions {
  /** Test seams preserve the real core and lifecycle behavior. */
  core?: ReturnType<typeof createObservationCore>;
  startAdapters?: typeof startAdapters;
  tick?: typeof tickBoard;
  productVersion?: string;
}

/** Compose the board's timer and adapter runner without adding lifecycle state to main. */
export function createBoardModules(
  ctxFor: (name: string) => ModuleContext<Store>,
  options: BoardModuleOptions = {},
): ModuleEntry[] {
  const coreCtx = ctxFor('board-core');
  const adapterCtx = ctxFor('board-adapters');
  const core =
    options.core ??
    createObservationCore({
      store: coreCtx.store,
      config: coreCtx.config,
      clock: coreCtx.clock,
      ...(options.productVersion === undefined ? {} : { productVersion: options.productVersion }),
    });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> = Promise.resolve();
  let stopped = false;
  let signal: AbortSignal | undefined;
  const tick = options.tick ?? tickBoard;
  const schedule = (): void => {
    if (stopped || signal?.aborted) return;
    timer = setTimeout(() => {
      timer = undefined;
      runTick();
    }, TICK_MS);
  };
  const runTick = (): void => {
    if (stopped || signal?.aborted) return;
    active = Promise.resolve()
      .then(() =>
        tick({
          store: coreCtx.store,
          config: coreCtx.config,
          clock: coreCtx.clock,
          completeSince: core.completeSince,
        }),
      )
      .catch((err: unknown) => {
        coreCtx.log.error({ err }, 'board tick failed');
      })
      .finally(schedule);
  };
  let runner: AdapterRunner | undefined;
  return [
    {
      name: 'board-core',
      stopStage: 'final',
      module: {
        start(startSignal) {
          signal = startSignal;
          runTick();
          return Promise.resolve();
        },
        async stop() {
          stopped = true;
          if (timer !== undefined) clearTimeout(timer);
          await active;
        },
      },
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
}
