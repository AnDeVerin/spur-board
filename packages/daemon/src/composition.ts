import type { ServerResponse } from 'node:http';
import { startAdapters } from '@spur-board/adapters';
import type { Gateway } from '@spur-board/contracts';
import {
  commandRetention,
  createObservationCore,
  createOperationRegistry,
  tickBoard,
  type SpurPort,
  type Store,
} from '@spur-board/core';
import { createSlackGateway } from '@spur-board/gateway-slack';
import { createBoardModules } from './board-modules.ts';
import { createHttpModule } from './http-module.ts';
import { createInboundModule } from './inbound-module.ts';
import type { ModuleContext, ModuleEntry } from './lifecycle.ts';
import { createOutboxModule, slackSettings } from './outbox-module.ts';

export interface DaemonModulePorts {
  gateway?: Gateway;
  spur?: SpurPort;
  startAdapters?: typeof startAdapters;
  tick?: typeof tickBoard;
  sessionFetcher?: typeof fetch;
  afterOperation?: (response: ServerResponse) => void | Promise<void>;
  onListening?: (address: string) => void;
}

/** The production module graph, with replaceable external ports for in-process tests. */
export function createDaemonModules(
  ctxFor: (name: string) => ModuleContext<Store>,
  ports: DaemonModulePorts = {},
): {
  entries: ModuleEntry[];
  inbound: ReturnType<typeof createInboundModule> | undefined;
  outbox: ReturnType<typeof createOutboxModule>;
} {
  const board = ctxFor('board-core');
  const core = createObservationCore({
    store: board.store,
    config: board.config,
    clock: board.clock,
  });
  const registry = createOperationRegistry({
    config: board.config,
    clock: board.clock,
    completeSince: core.completeSince,
  });
  const commands = ctxFor('commands');
  const entries: ModuleEntry[] = [
    {
      name: 'commands',
      stopStage: 'final',
      module: commandRetention({
        store: commands.store,
        clock: commands.clock,
        retentionDays: commands.config.commands.retentionDays,
        onError: (err) => {
          commands.log.error({ err }, 'command purge failed');
        },
      }),
    },
  ];
  entries.push(
    ...createBoardModules(ctxFor, {
      core,
      ...(ports.startAdapters === undefined ? {} : { startAdapters: ports.startAdapters }),
      ...(ports.tick === undefined ? {} : { tick: ports.tick }),
    }),
  );
  const ctx = ctxFor('gateway-slack');
  const settings = slackSettings(ctx.config, ctx.secrets);
  const gateway = ports.gateway ?? (settings === null ? undefined : createSlackGateway(settings));
  const inbound =
    gateway === undefined || (ports.gateway === undefined && settings?.appToken === undefined)
      ? undefined
      : createInboundModule(ctxFor('inbound'), gateway, registry);
  if (settings !== null && inbound === undefined)
    ctx.log.info('Slack inbound disabled: SLACK_APP_TOKEN is absent');
  if (gateway !== undefined)
    entries.push({
      name: 'gateway-slack',
      stopStage: 'final',
      module: {
        start: () =>
          gateway.start(
            inbound === undefined ? () => Promise.resolve() : (event) => inbound.sink(event),
          ),
        async stop() {
          try {
            await gateway.stop();
          } finally {
            await inbound?.stop();
          }
        },
      },
    });
  if (inbound !== undefined)
    entries.push({ name: 'inbound', stopStage: 'pollers', module: inbound });
  const outbox = createOutboxModule(
    ctxFor('outbox'),
    gateway,
    ports.spur === undefined ? {} : { spur: ports.spur },
  );
  entries.push({ name: 'outbox', stopStage: 'outbox', module: outbox });
  entries.push({
    name: 'http',
    stopStage: 'final',
    module: createHttpModule(ctxFor('http'), {
      registry,
      ...(ports.sessionFetcher === undefined ? {} : { fetcher: ports.sessionFetcher }),
      ...(ports.afterOperation === undefined ? {} : { afterOperation: ports.afterOperation }),
      ...(ports.onListening === undefined ? {} : { onListening: ports.onListening }),
    }),
  });
  return { entries, inbound, outbox };
}
