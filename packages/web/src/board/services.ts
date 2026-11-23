import { HOST_USAGE_LEVELS, hostUsageLevel } from '@spur-board/contracts/browser';
import type { IconName, MeterThresholds, StatusDotTone } from '../ds/index.ts';
import type { Output } from '../lib/api.ts';
import type { BoardSnapshot } from './data.ts';
import { clockTime, frozenNote } from './model.ts';

type BoardStatus = Output<'status.get'>;
type ServiceRow = BoardStatus['services'][number];
export type BoardSourceView = BoardStatus['sources'][number];

/** A tone and the word that names it, as the prototype writes them. */
interface Health {
  tone: StatusDotTone;
  word: string;
}

/** The status bar services in bar order; slack only when a Slack services row exists. */
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

/** The degraded word of a source the daemon's runner pauses for a rate limit. */
const BUDGET_WAIT = 'waits for rate budget';

/** Health of one source from its own fields, in core's order of reasons. */
function sourceState(source: BoardSourceView): Health {
  if (source.blindReason !== null) return { tone: 'error', word: `blind: ${source.blindReason}` };
  // A coded failure froze a github-project mirror.
  if (source.failure != null) return { tone: 'error', word: 'failing' };
  if (source.waitsForBudget) return { tone: 'warn', word: BUDGET_WAIT };
  if (source.lastCompleteAt === null)
    return { tone: 'warn', word: source.warmingUp ? 'warming up' : 'never completed' };
  if (source.stale) return { tone: 'warn', word: 'stale' };
  if (source.warmingUp) return { tone: 'warn', word: 'warming up' };
  return { tone: 'ok', word: 'polling' };
}

function serviceHealth(name: ServiceName, row: ServiceRow, sources: readonly BoardSourceView[]) {
  const tone = TONES[row.state];
  if (name === 'daemon') return { tone, word: row.state === 'healthy' ? 'running' : 'stalled' };
  if (name === 'slack') return { tone, word: row.state === 'healthy' ? 'up' : 'down' };
  if (row.state === 'healthy') return { tone, word: 'polling' };
  // The first member source, in status order, whose own state has the row's tone: the one core
  // names in the row's reason.
  const first = sources
    .filter((source) => serviceOf(source.source) === name)
    .map(sourceState)
    .find((health) => health.tone === tone);
  return first ?? { tone, word: row.state };
}

type HealthSnapshot = Pick<
  BoardSnapshot,
  'status' | 'readFailed' | 'unreadable' | 'update' | 'lastGoodAt'
>;

/**
 * Whether the board has Slack: the last good status has a slack `services[]` row, which core
 * writes only for a Slack gateway or a kept slack transport row. No status yet means no Slack.
 */
function hasSlack(status: BoardStatus | undefined): boolean {
  return status?.services.some((row) => row.service === 'slack') === true;
}

/**
 * The status bar buttons in the order daemon, slack when a Slack services row exists, github,
 * spur, then jira when status.get has a jira row or a jira source. Each takes its tone from its
 * `services[]` row and reads `unknown` without one; all read `unknown` before the first status,
 * and all but the daemon while the daemon does not answer.
 */
export function indicators(
  snapshot: HealthSnapshot,
  formatTime: (ms: number) => string,
): Indicator[] {
  const { status, readFailed, unreadable, update, lastGoodAt } = snapshot;
  const names: ServiceName[] = [
    'daemon',
    ...(hasSlack(status) ? ['slack' as const] : []),
    'github',
    'spur',
  ];
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
const USAGE: MeterThresholds = { ...HOST_USAGE_LEVELS, worse: 'high' };

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

/** The status bar dot of the host: the worst reading's level and the readings at warn or error. */
export interface HostAlert {
  tone: 'warn' | 'error';
  /** Each reading at warn or error, CPU, RAM, then volumes in the daemon's order. */
  text: string;
}

/** The host dot over CPU, RAM and every volume; null when every reading is below warn or unknown. */
export function hostAlert(host: BoardStatus['host']): HostAlert | null {
  if (host === null) return null;
  const readings: { percent: number; text: (used: string) => string }[] = [];
  if (host.cpuPercent !== null)
    readings.push({ percent: host.cpuPercent, text: (used) => `CPU ${used}% used` });
  const { memory } = host;
  if (memory !== null)
    readings.push({
      percent: memory.usedPercent,
      text: (used) => `RAM ${used}% used, ${formatBytes(memory.availableBytes)} free`,
    });
  for (const volume of host.volumes)
    readings.push({
      percent: volume.usedPercent,
      text: (used) =>
        `disk ${volume.mount} ${used}% used, ${formatBytes(volume.availableBytes)} free`,
    });
  let tone: HostAlert['tone'] | null = null;
  const texts: string[] = [];
  for (const reading of readings) {
    const level = hostUsageLevel(reading.percent);
    if (level === 'ok') continue;
    if (level === 'error' || tone === null) tone = level;
    texts.push(reading.text(String(Math.floor(reading.percent))));
  }
  return tone === null ? null : { tone, text: texts.join(' · ') };
}

/** One panel box: a service, the host or one source. */
export interface PanelBox {
  /** Unique within the panel. */
  id: string;
  /** The status bar button that scrolls to it; null for the host. */
  service: ServiceName | null;
  /** The board project whose group holds it; null for the shared boxes at the top. */
  project: string | null;
  icon: IconName;
  name: string;
  /** The coloured word in the head; null for the host, which has no single state. */
  health: Health | null;
  rows: PanelRow[];
}

const GONE: PanelRow[] = [{ key: 'Unknown while the daemon does not answer.', note: true }];
const FROZEN = frozenNote('ready-for-dev');

/** The last part of a source id: the repo of a GitHub source, the project of a Jira one. */
const tail = (source: string) => source.split(':').at(-1) ?? '';

/**
 * The panel boxes: the shared daemon, host, slack when a Slack services row exists, and spur,
 * then one run per project in the order its sources come, each with one box per GitHub pull
 * request source, GitHub issue source, Jira source and GitHub Project mirror source. A source box
 * takes its word from its own fields. While the daemon does not answer every box but the daemon
 * reads unknown; before the first status there are none.
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
      project: null,
      icon: ICONS[service],
      name: service,
      health: found ? { tone: found.tone, word: found.word } : UNKNOWN,
      rows,
    };
  };
  const sourceBox = (
    source: BoardSourceView,
    service: ServiceName | null,
    name: string,
    icon: IconName,
  ): PanelBox => ({
    id: source.source,
    service,
    project: source.project,
    icon,
    name,
    health: live ? sourceState(source) : UNKNOWN,
    rows: live ? sourceRows(source, formatTime) : GONE,
  });
  // A mirror box names its Project and, when frozen, the failure and what it means.
  const mirrorBox = (box: PanelBox, source: BoardSourceView): PanelBox => {
    if (!live) return box;
    const { failure } = source;
    const rows: PanelRow[] = [{ key: 'Project', text: tail(source.source) }, ...box.rows];
    if (failure != null)
      rows.push({ key: 'Failure', text: `${failure.code} · ${failure.message}` });
    if (source.blindReason !== null || failure != null) rows.push({ key: FROZEN, note: true });
    return { ...box, rows };
  };
  const sources = (status?.sources ?? []).filter((source) => source.source !== 'spur');
  // A kind with several sources in one project's group names each by its repo.
  const named = (
    project: string | null,
    prefix: string,
    name: string,
    service: ServiceName | null,
    icon: IconName,
    dress: (box: PanelBox, source: BoardSourceView) => PanelBox = (box) => box,
  ) => {
    const list = sources.filter(
      (source) => source.project === project && source.source.startsWith(`${prefix}:`),
    );
    return list.map((source) =>
      dress(
        sourceBox(
          source,
          service,
          list.length > 1 ? `${name} · ${tail(source.source)}` : name,
          icon,
        ),
        source,
      ),
    );
  };
  // A source with no project, which core does not send today, stays with the shared boxes.
  const grouped = [null, ...new Set(sources.flatMap((source) => source.project ?? []))].flatMap(
    (project) => [
      ...named(project, 'github', 'github pull requests', 'github', ICONS.github),
      ...named(project, 'github-issues', 'github issues', 'github', ICONS.github),
      ...named(project, 'jira', 'jira', 'jira', ICONS.jira),
      // A mirror has no status bar button: the board names a frozen one on its Backlog part.
      ...named(project, 'github-project', 'github project', null, 'mirror', mirrorBox),
    ],
  );
  const hasGithub = sources.some((source) => serviceOf(source.source) === 'github');
  const spurSource = status?.sources.find((source) => source.source === 'spur');
  const spur = spurSource
    ? sourceBox(spurSource, 'spur', 'spur', ICONS.spur)
    : serviceBox('spur', live ? [] : GONE);
  if (live?.spurUnavailable != null)
    spur.rows = [...spur.rows, { key: live.spurUnavailable, status: 'fail' }];
  return [
    serviceBox('daemon', live ? daemonRows(live.daemon, formatTime) : []),
    {
      id: 'host',
      service: null,
      project: null,
      icon: 'pulse',
      name: 'host',
      health: null,
      rows: live ? hostRows(live.host, live.hostLoad) : GONE,
    },
    ...(hasSlack(status)
      ? [
          serviceBox(
            'slack',
            live
              ? gatewayRows(
                  live.transport.find((gateway) => gateway.gateway === 'slack'),
                  formatTime,
                )
              : GONE,
          ),
        ]
      : []),
    spur,
    ...(hasGithub ? [] : [serviceBox('github', live ? [] : GONE)]),
    ...grouped,
  ];
}

/**
 * The box a status bar button scrolls to: a failing box of its service, else a degraded one, else
 * its first box; undefined when the service has none. Among boxes of one tone it takes the source
 * first in `order`, the `status.get` source order in which core picks the source its service row
 * names, then the first in panel order.
 */
export function scrollTarget(
  boxes: readonly PanelBox[],
  service: ServiceName,
  order: readonly string[] = [],
): string | undefined {
  const own = boxes.filter((box) => box.service === service);
  const rank = (box: PanelBox) => {
    const at = order.indexOf(box.id);
    return at === -1 ? order.length : at;
  };
  const worst = (tone: StatusDotTone) =>
    own
      .filter((box) => box.health?.tone === tone)
      .reduce<PanelBox | undefined>(
        (best, box) => (best === undefined || rank(box) < rank(best) ? box : best),
        undefined,
      );
  return (worst('error') ?? worst('warn') ?? own[0])?.id;
}
