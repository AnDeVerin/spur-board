import type { Config, SessionFacts, SessionLinkRole } from '@spur-board/contracts';

export interface SessionHealthSubject extends Pick<
  SessionFacts,
  'id' | 'health' | 'healthSince' | 'endedAt' | 'endReason'
> {
  taskId: string;
  role: SessionLinkRole;
}

export interface TaskPrState {
  hasOpenPr: boolean;
  hasMergedPr: boolean;
}

export interface HostLoadEpisode {
  /** The time the error entry reaching the configured session count began. */
  startedAt: number;
}

export type SessionHealthFlagKind =
  | 'stuck_worker'
  | 'stuck_orchestrator'
  | 'needs_input'
  | 'worker_idle'
  | 'worker_completed'
  | 'worker_killed'
  | 'worker_vanished';

const ENDED_WORKER_KINDS = {
  complete: 'worker_completed',
  kill: 'worker_killed',
  vanished: 'worker_vanished',
} as const satisfies Record<string, SessionHealthFlagKind>;

export interface SessionHealthFlag {
  taskId: string;
  sessionId: string;
  kind: SessionHealthFlagKind;
}

export interface SessionHealthStatus {
  taskId: string;
  sessionId: string;
  kind: 'rate_limited';
}

export interface SessionHealthInput {
  sessions: readonly SessionHealthSubject[];
  tasks: Readonly<Record<string, TaskPrState>>;
  spur: {
    blind: boolean;
    observationComplete: boolean;
  };
  config: Config['health'];
  /** Current Unix time in milliseconds. */
  now: number;
  /** Pass the previous result's episode to preserve a burst as error-session membership changes. */
  episode?: HostLoadEpisode | null;
}

export interface SessionHealthResult {
  flags: readonly SessionHealthFlag[];
  statuses: readonly SessionHealthStatus[];
  hostLoad: { kind: 'host_under_load' } | null;
  episode: HostLoadEpisode | null;
}

/** Derive actionable health facts without reading the clock or mutating input. */
export function evaluateSessionHealth(input: SessionHealthInput): SessionHealthResult {
  const { sessions, tasks, spur, config, now } = input;
  const previousEpisode = input.episode ?? null;
  if (spur.blind) {
    return { flags: [], statuses: [], hostLoad: null, episode: previousEpisode };
  }

  const errorEntries = new Map<string, number>();
  const liveWorkerTasks = new Set<string>();
  for (const session of sessions) {
    if (session.endedAt !== null) continue;
    if (session.role === 'worker') liveWorkerTasks.add(session.taskId);
    if (session.health === 'error' && !errorEntries.has(session.id)) {
      errorEntries.set(session.id, Date.parse(session.healthSince));
    }
  }

  let episode: HostLoadEpisode | null = null;
  if (previousEpisode !== null) {
    if (
      errorEntries.size >= config.hostLoad.sessions &&
      now - previousEpisode.startedAt < config.hostLoad.maxEpisodeMs
    ) {
      episode = previousEpisode;
    }
  } else {
    const entries = [...errorEntries.values()]
      .filter((since) => Number.isFinite(since) && since <= now)
      .sort((a, b) => a - b);
    for (let index = config.hostLoad.sessions - 1; index < entries.length; index++) {
      const thresholdEntry = entries[index];
      const firstEntry = entries[index - config.hostLoad.sessions + 1];
      if (
        thresholdEntry !== undefined &&
        firstEntry !== undefined &&
        thresholdEntry - firstEntry <= config.hostLoad.windowMs &&
        now - thresholdEntry < config.hostLoad.maxEpisodeMs
      ) {
        episode = { startedAt: thresholdEntry };
        break;
      }
    }
  }

  const flags: SessionHealthFlag[] = [];
  const statuses: SessionHealthStatus[] = [];
  const seen = new Set<string>();
  for (const session of sessions) {
    const identity = JSON.stringify([session.taskId, session.id]);
    if (seen.has(identity)) continue;
    seen.add(identity);

    const task = tasks[session.taskId];
    if (session.endedAt !== null) {
      if (
        session.role === 'worker' &&
        spur.observationComplete &&
        (session.endReason === 'complete' ||
          session.endReason === 'kill' ||
          session.endReason === 'vanished') &&
        task !== undefined &&
        !task.hasOpenPr &&
        !task.hasMergedPr &&
        !liveWorkerTasks.has(session.taskId)
      ) {
        flags.push({
          taskId: session.taskId,
          sessionId: session.id,
          kind: ENDED_WORKER_KINDS[session.endReason],
        });
      }
      continue;
    }

    if (session.health === 'rate_limited') {
      statuses.push({ taskId: session.taskId, sessionId: session.id, kind: 'rate_limited' });
      continue;
    }
    if (session.role === 'other') continue;

    const heldMs = now - Date.parse(session.healthSince);
    let kind: SessionHealthFlagKind | null = null;
    if (session.health === 'error' && episode === null && heldMs >= config.errorAfterMs) {
      kind = session.role === 'worker' ? 'stuck_worker' : 'stuck_orchestrator';
    } else if (session.health === 'needs_input' && heldMs >= config.needsInputAfterMs) {
      kind = 'needs_input';
    } else if (
      session.health === 'waiting' &&
      session.role === 'worker' &&
      task !== undefined &&
      !task.hasOpenPr &&
      heldMs >= config.idleInDevAfterMs
    ) {
      kind = 'worker_idle';
    }
    if (kind !== null) flags.push({ taskId: session.taskId, sessionId: session.id, kind });
  }

  return {
    flags,
    statuses,
    hostLoad: episode === null ? null : { kind: 'host_under_load' },
    episode,
  };
}
