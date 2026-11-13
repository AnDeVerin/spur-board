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
  /**
   * Start of the oldest last complete poll over the task's PR sources, in Unix milliseconds;
   * null while any of them is blind or has never completed a poll. A "no PR" fact counts only
   * from a poll that began at or after the moment it is judged against.
   */
  prCompleteAt: number | null;
  /** Session ids holding an open worker turn of the task. */
  turnSessions?: readonly string[];
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
  | 'worker_vanished'
  | 'worker_lost';

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
  /**
   * Flags that wait on a complete Spur observation, or on a complete poll of the task's PR
   * sources since the worker ended or began waiting: an open item for one stays and none is
   * raised.
   */
  held: readonly SessionHealthFlag[];
  statuses: readonly SessionHealthStatus[];
  hostLoad: { kind: 'host_under_load' } | null;
  episode: HostLoadEpisode | null;
}

/** Derive actionable health facts without reading the clock or mutating input. */
export function evaluateSessionHealth(input: SessionHealthInput): SessionHealthResult {
  const { sessions, tasks, spur, config, now } = input;
  const previousEpisode = input.episode ?? null;
  if (spur.blind) {
    return { flags: [], held: [], statuses: [], hostLoad: null, episode: previousEpisode };
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
  const held: SessionHealthFlag[] = [];
  const statuses: SessionHealthStatus[] = [];
  const seen = new Set<string>();
  for (const session of sessions) {
    const identity = JSON.stringify([session.taskId, session.id]);
    if (seen.has(identity)) continue;
    seen.add(identity);

    const task = tasks[session.taskId];
    if (session.endedAt !== null) {
      // A worker killed or gone while it holds an open turn is lost whatever its PRs are.
      if (
        session.role === 'worker' &&
        (session.endReason === 'kill' || session.endReason === 'vanished') &&
        task?.turnSessions?.includes(session.id) === true &&
        !liveWorkerTasks.has(session.taskId)
      ) {
        const flag: SessionHealthFlag = {
          taskId: session.taskId,
          sessionId: session.id,
          kind: 'worker_lost',
        };
        (spur.observationComplete ? flags : held).push(flag);
        continue;
      }
      if (
        session.role === 'worker' &&
        (session.endReason === 'complete' ||
          session.endReason === 'kill' ||
          session.endReason === 'vanished') &&
        task !== undefined &&
        !task.hasOpenPr &&
        !task.hasMergedPr &&
        !liveWorkerTasks.has(session.taskId)
      ) {
        const flag: SessionHealthFlag = {
          taskId: session.taskId,
          sessionId: session.id,
          kind: ENDED_WORKER_KINDS[session.endReason],
        };
        (spur.observationComplete && prsPolledSince(task, session.endedAt) ? flags : held).push(
          flag,
        );
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
    let fresh = true;
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
      fresh = prsPolledSince(task, session.healthSince);
    }
    if (kind !== null)
      (fresh ? flags : held).push({ taskId: session.taskId, sessionId: session.id, kind });
  }

  return {
    flags,
    held,
    statuses,
    hostLoad: episode === null ? null : { kind: 'host_under_load' },
    episode,
  };
}

/** Whether every PR source of the task completed a poll that began at or after `since`. */
function prsPolledSince(task: TaskPrState, since: string): boolean {
  return task.prCompleteAt !== null && task.prCompleteAt >= Date.parse(since);
}
