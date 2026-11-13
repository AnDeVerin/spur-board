import type { Gateway, InboundEvent } from '@spur-board/contracts';
import { createInbound, type Inbound, type OperationRegistry, type Store } from '@spur-board/core';
import type { Module, ModuleContext } from './lifecycle.ts';
import { createJob } from './scheduler.ts';

const RECOVERY_MS = 5 * 60_000;

/** Owns inbound recovery scheduling and waits for every accepted event on stop. */
export function createInboundModule(
  ctx: ModuleContext<Store>,
  gateway: Gateway,
  registry: OperationRegistry = {},
): Module & {
  sink(event: InboundEvent): Promise<void>;
  awaitRecovery(): Promise<void>;
  reapply: Inbound['reapply'];
  retrying: Inbound['retrying'];
} {
  const inbound = createInbound({
    store: ctx.store,
    gateway,
    config: ctx.config,
    clock: ctx.clock,
    registry,
  });
  const recovery = createJob({
    run: () => ctx.logCall('inbound.recover', () => inbound.recover()),
    intervalMs: RECOVERY_MS,
    onError: (err) => {
      ctx.log.error({ err }, 'inbound recovery failed');
    },
  });

  return {
    sink: (event) => inbound.sink(event),
    reapply: inbound.reapply,
    retrying: (item, run) => inbound.retrying(item, run),
    awaitRecovery: () => recovery.settled(),
    start: (signal) => recovery.start(signal),
    async stop() {
      // Abort the scan first: the recovery job's run waits for it.
      const draining = inbound.stop();
      await recovery.stop();
      await draining;
    },
  };
}
