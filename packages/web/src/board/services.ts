import type { IconName, MeterThresholds, StatusDotTone } from '../ds/index.ts';
import type { Output } from '../lib/api.ts';
import type { BoardSnapshot } from './data.ts';

type BoardStatus = Output<'status.get'>;
type ServiceRow = BoardStatus['services'][number];
export type BoardSourceView = BoardStatus['sources'][number];

/** A tone and the word that names it, as the prototype writes them. */
interface Health {
  tone: StatusDotTone;
  word: string;
}

export type ServiceName = 'daemon' | 'slack' | 'github' | 'spur' | 'jira';

export interface Indicator extends Health {
  service: ServiceName;
  icon: IconName;
  /** `<service>: <word>`, the accessible name. */
  label: string;
  /** The label, plus the services reason when the word is the rate budget wait. */
  title: string;
}

const ICONS: Record<ServiceName, IconName> = {
  daemon: 'pulse',
  slack: 'hash',
  github: 'pr',
  spur: 'mark',
  jira: 'diamond',
};

const UNKNOWN: Health = { tone: 'unknown', word: 'unknown' };

const TONES: Record<ServiceRow['state'], StatusDotTone> = {
  healthy: 'ok',
  degraded: 'warn',
  failing: 'error',
};

/** Service of a source id, by its prefix as core rolls it up; null for any other source. */
function serviceOf(source: string): 'github' | 'spur' | 'jira' | null {
  const prefix = source.split(':')[0];
  if (prefix === 'github' || prefix === 'github-issues') return 'github';
  if (prefix === 'spur' || prefix === 'jira') return prefix;
  return null;
}

/** Health of one source from its own fields, in core's order of reasons. */
function sourceState(source: BoardSourceView): Health {
  if (source.blindReason !== null) return { tone: 'error', word: `blind: ${source.blindReason}` };
  if (source.lastCompleteAt === null)
    return { tone: 'warn', word: source.warmingUp ? 'warming up' : 'never completed' };
  if (source.stale) return { tone: 'warn', word: 'stale' };
  if (source.warmingUp) return { tone: 'warn', word: 'warming up' };
  return { tone: 'ok', word: 'polling' };
}

/** The only degraded reason core reads from config, which the browser cannot see. */
const BUDGET_WAIT = 'waits for rate budget';

function serviceHealth(name: ServiceName, row: ServiceRow, sources: readonly BoardSourceView[]) {
  const tone = TONES[row.state];
  if (name === 'daemon') return { tone, word: row.state === 'healthy' ? 'running' : 'stalled' };
  if (name === 'slack') return { tone, word: row.state === 'healthy' ? 'up' : 'down' };
  if (row.state === 'healthy') return { tone, word: 'polling' };
  // The first member source, in status order, whose own state has the row's tone.
  const first = sources
    .filter((source) => serviceOf(source.source) === name)
    .map(sourceState)
    .find((health) => health.tone === tone);
  return first ?? { tone, word: BUDGET_WAIT };
}

const pad = (value: number) => String(value).padStart(2, '0');
/** UTC `hh:mm`, as the prototype writes a budget reset. */
function clockTime(iso: string): string {
  const date = new Date(iso);
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

type HealthSnapshot = Pick<
  BoardSnapshot,
  'status' | 'readFailed' | 'unreadable' | 'update' | 'lastGoodAt'
>;

/**
 * The status bar buttons in the order daemon, slack, github, spur, then jira when status.get has
 * a jira row or a jira source. Each takes its tone from its `services[]` row and reads `unknown`
 * without one; all read `unknown` before the first status, and all but the daemon while the
 * daemon does not answer.
 */
export function indicators(
  snapshot: HealthSnapshot,
  formatTime: (ms: number) => string,
): Indicator[] {
  const { status, readFailed, unreadable, update, lastGoodAt } = snapshot;
  const names: ServiceName[] = ['daemon', 'slack', 'github', 'spur'];
  const hasJira =
    status?.services.some((row) => row.service === 'jira') === true ||
    status?.sources.some((source) => serviceOf(source.source) === 'jira') === true;
  if (hasJira) names.push('jira');
  return names.map((service) => {
    let health = UNKNOWN;
    let reason: string | null = null;
    if (readFailed) {
      if (service === 'daemon') {
        const word = unreadable ? 'unreadable' : 'no answer';
        health = {
          tone: 'error',
          word:
            update !== undefined
              ? `updated to ${update.version}`
              : lastGoodAt === undefined
                ? word
                : `${word} since ${formatTime(lastGoodAt)}`,
        };
      }
    } else if (status) {
      const row = status.services.find((candidate) => candidate.service === service);
      if (row) {
        health = serviceHealth(service, row, status.sources);
        if (health.word === BUDGET_WAIT) reason = row.reason;
      }
    }
    const label = `${service}: ${health.word}`;
    return {
      service,
      icon: ICONS[service],
      ...health,
      label,
      title: reason === null ? label : `${label} · ${reason}`,
    };
  });
}

/** One panel row: text, a Meter with optional text after it, or a message row with a status. */
export type PanelRow =
  | { key: string; text: string }
  | {
      key: string;
      meter: { value: number | null; limit: number; thresholds: MeterThresholds };
      text?: string;
    }
  | { key: string; status: 'wait' | 'fail' }
  | { key: string; note: true };

const NONE = '—';
const BUDGET: MeterThresholds = { warn: 0.2, error: 0.05, worse: 'low' };
const USAGE: MeterThresholds = { warn: 0.8, error: 0.9, worse: 'high' };

/** Rows of one source box: polls, blind reason, freshness, points and budget. */
export function sourceRows(
  source: BoardSourceView,
  formatTime: (ms: number) => string,
): PanelRow[] {
  const time = (iso: string | null) => (iso === null ? NONE : formatTime(Date.parse(iso)));
  const rows: PanelRow[] = [
    {
      key: 'Last complete poll',
      text: source.lastCompleteAt === null ? '— never completed' : time(source.lastCompleteAt),
    },
    { key: 'Last observation', text: time(source.observedAt) },
  ];
  if (source.blindReason !== null)
    rows.push({
      key: 'Blind',
      text:
        source.message === null ? source.blindReason : `${source.blindReason} · ${source.message}`,
    });
  rows.push(
    { key: 'Freshness', text: source.stale ? 'stale' : 'fresh' },
    { key: 'Warming up', text: source.warmingUp ? 'yes' : 'no' },
  );
  if (source.pointsLastHour !== undefined)
    rows.push({ key: 'Points last hour', text: String(source.pointsLastHour) });
  const { budget } = source;
  if (budget === null) rows.push({ key: 'Budget', text: NONE });
  else if (budget.limit === null)
    rows.push({
      key: 'Budget',
      text: `${String(budget.remaining)} left · resets ${clockTime(budget.resetAt)}`,
    });
  else
    rows.push({
      key: 'Budget',
      meter: { value: budget.remaining, limit: budget.limit, thresholds: BUDGET },
      text: `resets ${clockTime(budget.resetAt)}`,
    });
  return rows;
}

/** Rows of a gateway box: none while up; when down, since when, why and which spaces. */
export function gatewayRows(
  gateway: BoardStatus['transport'][number] | undefined,
  formatTime: (ms: number) => string,
): PanelRow[] {
  if (gateway?.state !== 'down') return [];
  return [
    {
      key: 'Down since',
      text: gateway.since === null ? NONE : formatTime(Date.parse(gateway.since)),
    },
    { key: 'Reason', text: gateway.reason ?? NONE },
    { key: 'Spaces', text: gateway.spaces.length === 0 ? NONE : gateway.spaces.join(', ') },
  ];
}

/** Rows of the daemon box. */
export function daemonRows(
  daemon: BoardStatus['daemon'],
  formatTime: (ms: number) => string,
): PanelRow[] {
  return [
    { key: 'Version', text: daemon.version },
    { key: 'Started', text: formatTime(Date.parse(daemon.startedAt)) },
    {
      key: 'Last dispatch',
      text: daemon.lastDispatchAt === null ? NONE : formatTime(Date.parse(daemon.lastDispatchAt)),
    },
  ];
}

const BYTE_UNITS = ['KiB', 'MiB', 'GiB', 'TiB'] as const;

/** Bytes in binary units: an integer below 1 KiB, else one decimal, the unit picked after rounding. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(Math.floor(bytes))} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (unit < BYTE_UNITS.length - 1 && Number(value.toFixed(1)) >= 1024) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${BYTE_UNITS[unit] ?? 'TiB'}`;
}

/**
 * Rows of the host box: CPU, RAM and one Disk row per volume in percent, unknown when not
 * sampled, and the load wait. Disk rows keep the daemon's order (least free space first) and are
 * keyed by mount when there are several.
 */
export function hostRows(host: BoardStatus['host'], hostLoad: BoardStatus['hostLoad']): PanelRow[] {
  const usage = (key: string, value: number | null | undefined, text?: string): PanelRow => ({
    key,
    meter: { value: value ?? null, limit: 100, thresholds: USAGE },
    ...(text === undefined ? {} : { text }),
  });
  const volumes = host?.volumes ?? [];
  const rows = [
    usage('CPU', host?.cpuPercent),
    usage('RAM', host?.memory?.usedPercent),
    ...(volumes.length === 0
      ? [usage('Disk', null)]
      : volumes.map((volume) =>
          usage(
            volumes.length === 1 ? 'Disk' : `Disk ${volume.mount}`,
            volume.usedPercent,
            `${formatBytes(volume.availableBytes)} free`,
          ),
        )),
  ];
  if (hostLoad !== null) rows.push({ key: hostLoad, status: 'wait' });
  return rows;
}

/** One panel box: a service, the host or one source. */
export interface PanelBox {
  /** Unique within the panel. */
  id: string;
  /** The status bar button that scrolls to it; null for the host. */
  service: ServiceName | null;
  icon: IconName;
  name: string;
  /** The coloured word in the head; null for the host, which has no single state. */
  health: Health | null;
  rows: PanelRow[];
}

const GONE: PanelRow[] = [{ key: 'Unknown while the daemon does not answer.', note: true }];

/** The last part of a source id: the repo of a GitHub source, the project of a Jira one. */
const tail = (source: string) => source.split(':').at(-1) ?? '';

/**
 * The panel boxes: daemon, host, slack, one per GitHub source, spur, one per Jira source. A
 * source box takes its word from its own fields. While the daemon does not answer every box but
 * the daemon reads unknown; before the first status there are none.
 */
export function panelBoxes(
  snapshot: HealthSnapshot,
  formatTime: (ms: number) => string,
): PanelBox[] {
  const { status, readFailed } = snapshot;
  if (status === undefined && !readFailed) return [];
  // The status the boxes may show: none while the daemon does not answer.
  const live = readFailed ? undefined : status;
  const bar = new Map(indicators(snapshot, formatTime).map((item) => [item.service, item]));
  const serviceBox = (service: ServiceName, rows: PanelRow[]): PanelBox => {
    const found = bar.get(service);
    return {
      id: service,
      service,
      icon: ICONS[service],
      name: service,
      health: found ? { tone: found.tone, word: found.word } : UNKNOWN,
      rows,
    };
  };
  const sourceBox = (source: BoardSourceView, service: ServiceName, name: string): PanelBox => ({
    id: source.source,
    service,
    icon: ICONS[service],
    name,
    health: live ? sourceState(source) : UNKNOWN,
    rows: live ? sourceRows(source, formatTime) : GONE,
  });
  // A kind with several sources names each by its repo, or its project for Jira.
  const named = (prefix: string, name: string, service: ServiceName) => {
    const list = (status?.sources ?? []).filter((source) => source.source.startsWith(`${prefix}:`));
    return list.map((source) =>
      sourceBox(source, service, list.length > 1 ? `${name} · ${tail(source.source)}` : name),
    );
  };
  const github = [
    ...named('github', 'github pull requests', 'github'),
    ...named('github-issues', 'github issues', 'github'),
  ];
  const spurSource = status?.sources.find((source) => source.source === 'spur');
  const spur = spurSource
    ? sourceBox(spurSource, 'spur', 'spur')
    : serviceBox('spur', live ? [] : GONE);
  if (live?.spurUnavailable != null)
    spur.rows = [...spur.rows, { key: live.spurUnavailable, status: 'fail' }];
  return [
    serviceBox('daemon', live ? daemonRows(live.daemon, formatTime) : []),
    {
      id: 'host',
      service: null,
      icon: 'pulse',
      name: 'host',
      health: null,
      rows: live ? hostRows(live.host, live.hostLoad) : GONE,
    },
    serviceBox(
      'slack',
      live
        ? gatewayRows(
            live.transport.find((gateway) => gateway.gateway === 'slack'),
            formatTime,
          )
        : GONE,
    ),
    ...(github.length > 0 ? github : [serviceBox('github', live ? [] : GONE)]),
    spur,
    ...named('jira', 'jira', 'jira'),
  ];
}
