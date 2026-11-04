import type { Gateway, InboundEvent } from '@spur-board/contracts';
import { createInbound, type OperationRegistry, type Store } from '@spur-board/core';
import type { Module, ModuleContext } from './lifecycle.ts';

const RECOVERY_MS = 5 * 60_000;

/** Owns inbound recovery scheduling and waits for every accepted event on stop. */
export function createInboundModule(
  ctx: ModuleContext<Store>,
  gateway: Gateway,
  registry: OperationRegistry = {},
): Module & { sink(event: InboundEvent): Promise<void> } {
  const inbound = createInbound({
    store: ctx.store,
    gateway,
    config: ctx.config,
    clock: ctx.clock,
    registry,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> = Promise.resolve();
  let stopped = false;
  let signal: AbortSignal | undefined;

  const schedule = (): void => {
    if (stopped || signal?.aborted) return;
    timer = setTimeout(() => {
      timer = undefined;
      tick();
    }, RECOVERY_MS);
  };
  const tick = (): void => {
    if (stopped || signal?.aborted) return;
    active = ctx
      .logCall('inbound.recover', () => inbound.recover())
      .catch((err: unknown) => {
        ctx.log.error({ err }, 'inbound recovery failed');
      })
      .finally(schedule);
  };

  return {
    sink: (event) => inbound.sink(event),
    start(startSignal) {
      signal = startSignal;
      tick();
      return Promise.resolve();
    },
    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await active;
      await inbound.stop();
    },
  };
}
