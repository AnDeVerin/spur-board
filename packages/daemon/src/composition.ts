import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { startAdapters, type AdapterRunner } from '@spur-board/adapters';
import { resolveWebOrigin, type Gateway } from '@spur-board/contracts';
import {
  createObservationCore,
  createOperationRegistry,
  firstPollDone,
  purgeEndedTokenRequests,
  purgeExpiredCommands,
  tickBoard,
  type SpurPort,
  type Store,
} from '@spur-board/core';
import { createSlackGateway } from '@spur-board/gateway-slack';
import { createBoardModules } from './board-modules.ts';
import { createHostProbe, createHostSampler, type HostProbe } from './host-metrics.ts';
import { createHttpModule, createWebModule, listenerPort } from './http-module.ts';
import { createInboundModule } from './inbound-module.ts';
import type { ModuleContext, ModuleEntry } from './lifecycle.ts';
import { createOutboxModule, slackSettings } from './outbox-module.ts';
import { createJob } from './scheduler.ts';
import { createSystemdModule, createSystemdNotifier, type NotifySend } from './systemd.ts';
import { z } from 'zod';

const DAY_MS = 86_400_000;

export interface DaemonModulePorts {
  productVersion?: string;
  gateway?: Gateway;
  spur?: SpurPort;
  startAdapters?: (...args: Parameters<typeof startAdapters>) => AdapterRunner;
  tick?: typeof tickBoard;
  sessionFetcher?: typeof fetch;
  afterOperation?: (response: ServerResponse) => void | Promise<void>;
  onListening?: (address: string) => void;
  onWebListening?: (address: string) => void;
  webRoot?: string | URL;
  /**
   * One of the directories whose volumes `status.get` `host.volumes` measures: the database's
   * directory.
   */
  dataDir?: string;
  /** Replaces the host probe; defaults to the real host and `dataDir`. */
  hostProbe?: HostProbe;
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
  /** Runs the board-core tick once more behind its active run; resolves when it settles. */
  tick: () => Promise<void>;
} {
  const board = ctxFor('board-core');
  const core = createObservationCore({
    store: board.store,
    config: board.config,
    clock: board.clock,
    warn: (fields, message) => {
      board.log.warn(fields, message);
    },
    ...(ports.productVersion === undefined ? {} : { productVersion: ports.productVersion }),
  });
  const ctx = ctxFor('gateway-slack');
  const settings = slackSettings(ctx.config, ctx.secrets);
  const gateway =
    ports.gateway ??
    (settings === null
      ? undefined
      : createSlackGateway({
          ...settings,
          now: () => ctx.clock.now(),
          onError: (err, work) => {
            ctx.log.error(
              { err },
              work === 'connection' ? 'slack connection event failed' : 'slack envelope failed',
            );
          },
        }));
  const hostCtx = ctxFor('host-metrics');
  const host = createHostSampler({
    probe: ports.hostProbe ?? createHostProbe(ports.dataDir),
    clock: hostCtx.clock,
    log: hostCtx.log,
  });
  // Set by the web listener once bound and by each completed tick; status.get and config.get read them.
  let webPort: number | undefined;
  let lastDispatchAt: string | null = null;
  const registry = createOperationRegistry({
    config: board.config,
    clock: board.clock,
    completeSince: core.completeSince,
    healthySince: core.healthySince,
    hostMetrics: () => host.read(),
    gateways: gateway === undefined ? [] : [gateway.kind],
    reapplyInbound: () => inbound?.reapply,
    prPoller: () => boardModules.pollPr,
    budgetWaits: () => boardModules.budgetWaits(),
    ...(ports.productVersion === undefined ? {} : { productVersion: ports.productVersion }),
    lastDispatchAt: () => lastDispatchAt,
    webOrigin: () =>
      webPort === undefined ? undefined : resolveWebOrigin(board.config.web, webPort),
  });
  const notifier = createSystemdNotifier({
    log: ctxFor('systemd').log,
    ...(ports.systemd ?? { env: {}, pid: 0 }),
  });
  const commands = ctxFor('commands');
  const tokenRequests = ctxFor('token-requests');
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
    {
      name: 'token-requests',
      stopStage: 'final',
      // Starts without delaying the daemon; every failed purge is logged.
      module: createJob({
        run: () =>
          purgeEndedTokenRequests(tokenRequests.store, new Date(tokenRequests.clock.now())),
        intervalMs: DAY_MS,
        first: 'background',
        onError: (err) => {
          tokenRequests.log.error({ err }, 'token request purge failed');
        },
      }),
    },
    // Samples in the background; stop abandons a disk read that hangs.
    { name: 'host-metrics', stopStage: 'pollers', module: host.module },
  ];
  const boardModules = createBoardModules(ctxFor, {
    core,
    ...(ports.startAdapters === undefined ? {} : { startAdapters: ports.startAdapters }),
    ...(ports.tick === undefined ? {} : { tick: ports.tick }),
    onTick: () => {
      lastDispatchAt = new Date(board.clock.now()).toISOString();
      notifier.watchdog();
    },
  });
  entries.push(...boardModules.entries);
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
  const runOperation: NonNullable<Parameters<typeof createHttpModule>[1]>['runOperation'] = (
    id,
    input,
    run,
  ) =>
    id === 'item.retry' && inbound !== undefined && isItemInput(input)
      ? inbound.retrying(input.item, run)
      : run();
  // One daemon instance ID: the API's `x-board-instance` and the web stream's `hello`.
  const instance = randomUUID();
  const web =
    board.config.web.port === undefined
      ? undefined
      : createWebModule(ctxFor('web'), {
          registry,
          runOperation,
          instance,
          firstPollDone: () => firstPollDone(board.store.db, board.config, core.completeSince),
          ...(ports.afterOperation === undefined ? {} : { afterOperation: ports.afterOperation }),
          ...(ports.webRoot === undefined ? {} : { webRoot: ports.webRoot }),
          ...(ports.productVersion === undefined ? {} : { productVersion: ports.productVersion }),
          onListening: (address: string) => {
            webPort = listenerPort(address);
            ports.onWebListening?.(address);
          },
        });
  if (web !== undefined) entries.push({ name: 'web', stopStage: 'final', module: web });
  entries.push({
    name: 'http',
    stopStage: 'final',
    module: createHttpModule(ctxFor('http'), {
      registry,
      runOperation,
      instance,
      webListening: () => web?.listening() === true,
      firstPollDone: () => firstPollDone(board.store.db, board.config, core.completeSince),
      ...(ports.productVersion === undefined ? {} : { productVersion: ports.productVersion }),
      ...(ports.sessionFetcher === undefined ? {} : { fetcher: ports.sessionFetcher }),
      ...(ports.afterOperation === undefined ? {} : { afterOperation: ports.afterOperation }),
      ...(ports.onListening === undefined ? {} : { onListening: ports.onListening }),
    }),
  });
  entries.push({ name: 'systemd', stopStage: 'pollers', module: createSystemdModule(notifier) });
  return { entries, inbound, outbox, tick: boardModules.tick };
}

const itemInput = z.object({ item: z.string() });
function isItemInput(input: unknown): input is { item: string } {
  return itemInput.safeParse(input).success;
}
