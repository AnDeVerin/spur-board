import type { ServerResponse } from 'node:http';
import { startAdapters } from '@spur-board/adapters';
import type { Gateway } from '@spur-board/contracts';
import {
  createObservationCore,
  createOperationRegistry,
  firstPollDone,
  purgeExpiredCommands,
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
import { createJob } from './scheduler.ts';
import { createSystemdModule, createSystemdNotifier, type NotifySend } from './systemd.ts';

const DAY_MS = 86_400_000;

export interface DaemonModulePorts {
  productVersion?: string;
  gateway?: Gateway;
  spur?: SpurPort;
  startAdapters?: typeof startAdapters;
  tick?: typeof tickBoard;
  sessionFetcher?: typeof fetch;
  afterOperation?: (response: ServerResponse) => void | Promise<void>;
  onListening?: (address: string) => void;
  /** Without it the daemon sends no systemd notifications. */
  systemd?: { env: Readonly<Record<string, string | undefined>>; pid: number; send?: NotifySend };
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
    ...(ports.productVersion === undefined ? {} : { productVersion: ports.productVersion }),
  });
  const ctx = ctxFor('gateway-slack');
  const settings = slackSettings(ctx.config, ctx.secrets);
  const gateway = ports.gateway ?? (settings === null ? undefined : createSlackGateway(settings));
  const registry = createOperationRegistry({
    config: board.config,
    clock: board.clock,
    completeSince: core.completeSince,
    gateways: gateway === undefined ? [] : [gateway.kind],
    reapplyInbound: () => inbound?.reapply,
  });
  const notifier = createSystemdNotifier({
    log: ctxFor('systemd').log,
    ...(ports.systemd ?? { env: {}, pid: 0 }),
  });
  const commands = ctxFor('commands');
  const entries: ModuleEntry[] = [
    {
      name: 'commands',
      stopStage: 'final',
      // A failed first purge rejects start; a failed daily purge is logged.
      module: createJob({
        run: () =>
          purgeExpiredCommands(
            commands.store,
            commands.clock,
            commands.config.commands.retentionDays,
          ),
        intervalMs: DAY_MS,
        first: 'await',
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
      onTick: () => {
        notifier.watchdog();
      },
    }),
  );
  const inbound =
    gateway === undefined || (ports.gateway === undefined && settings?.appToken === undefined)
      ? undefined
      : createInboundModule(ctxFor('inbound'), gateway, registry);
  if (settings !== null && inbound === undefined)
    ctx.log.info('Slack inbound disabled: SLACK_APP_TOKEN is absent');
  const outbox = createOutboxModule(
    ctxFor('outbox'),
    gateway,
    ports.spur === undefined ? {} : { spur: ports.spur },
  );
  if (gateway !== undefined)
    entries.push({
      name: 'gateway-slack',
      stopStage: 'final',
      module: {
        // Inbound's result is the gateway's ack (G11); the outbox logs its own failure.
        start: () =>
          gateway.start(async (event) => {
            await Promise.all([
              inbound?.sink(event),
              event.kind === 'connection' ? outbox.connection(event.state) : undefined,
            ]);
          }),
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
  entries.push({ name: 'outbox', stopStage: 'outbox', module: outbox });
  entries.push({
    name: 'http',
    stopStage: 'final',
    module: createHttpModule(ctxFor('http'), {
      registry,
      firstPollDone: () => firstPollDone(board.store.db, board.config, core.completeSince),
      ...(ports.productVersion === undefined ? {} : { productVersion: ports.productVersion }),
      ...(ports.sessionFetcher === undefined ? {} : { fetcher: ports.sessionFetcher }),
      ...(ports.afterOperation === undefined ? {} : { afterOperation: ports.afterOperation }),
      ...(ports.onListening === undefined ? {} : { onListening: ports.onListening }),
    }),
  });
  entries.push({ name: 'systemd', stopStage: 'pollers', module: createSystemdModule(notifier) });
  return { entries, inbound, outbox };
}
