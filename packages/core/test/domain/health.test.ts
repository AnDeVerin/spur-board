import { configSchema, unknownSessionHealthSchema } from '@spur-board/contracts';
import { describe, expect, it } from 'vitest';
import {
  evaluateSessionHealth,
  type SessionHealthInput,
  type SessionHealthSubject,
} from '../../src/index.ts';

const start = Date.parse('2026-01-01T00:00:00.000Z');
const config = configSchema.shape.health.parse({});
const noPr = { hasOpenPr: false, hasMergedPr: false };

function session(
  id: string,
  health: SessionHealthSubject['health'],
  heldMs: number,
  changes: Partial<SessionHealthSubject> = {},
): SessionHealthSubject {
  return {
    id,
    taskId: 'TASK-1',
    role: 'worker',
    health,
    healthSince: new Date(start - heldMs).toISOString(),
    endedAt: null,
    endReason: null,
    ...changes,
  };
}

function evaluate(changes: Partial<SessionHealthInput> = {}) {
  return evaluateSessionHealth({
    sessions: [],
    tasks: { 'TASK-1': noPr },
    spur: { blind: false, observationComplete: true },
    config,
    now: start,
    ...changes,
  });
}

describe('evaluateSessionHealth', () => {
  const stateCases: {
    name: string;
    subject: SessionHealthSubject;
    expected: string[];
  }[] = [
    { name: 'error at 89 seconds', subject: session('a', 'error', 89_000), expected: [] },
    {
      name: 'error at the 90-second boundary',
      subject: session('a', 'error', 90_000),
      expected: ['stuck_worker'],
    },
    {
      name: 'error at 91 seconds',
      subject: session('a', 'error', 91_000),
      expected: ['stuck_worker'],
    },
    {
      name: 'orchestrator error',
      subject: session('a', 'error', 90_000, { role: 'orchestrator' }),
      expected: ['stuck_orchestrator'],
    },
    {
      name: 'input wait before threshold',
      subject: session('a', 'needs_input', 119_000),
      expected: [],
    },
    {
      name: 'worker input wait at threshold',
      subject: session('a', 'needs_input', 120_000),
      expected: ['needs_input'],
    },
    {
      name: 'orchestrator input wait',
      subject: session('a', 'needs_input', 120_000, { role: 'orchestrator' }),
      expected: ['needs_input'],
    },
    {
      name: 'idle worker before threshold',
      subject: session('a', 'waiting', 1_799_000),
      expected: [],
    },
    {
      name: 'idle worker at threshold',
      subject: session('a', 'waiting', 1_800_000),
      expected: ['worker_idle'],
    },
    {
      name: 'orchestrator waiting for an hour',
      subject: session('a', 'waiting', 3_600_000, { role: 'orchestrator' }),
      expected: [],
    },
    { name: 'stale worker', subject: session('a', 'stale', 3_600_000), expected: [] },
    {
      name: 'unfamiliar health value',
      subject: session('a', unknownSessionHealthSchema.parse('new_state'), 3_600_000),
      expected: [],
    },
    {
      name: 'other role in error',
      subject: session('a', 'error', 91_000, { role: 'other' }),
      expected: [],
    },
  ];

  it.each(stateCases)('$name', ({ subject, expected }) => {
    expect(evaluate({ sessions: [subject] }).flags.map((flag) => flag.kind)).toEqual(expected);
  });

  it('uses configured thresholds and reports rate limiting as status only', () => {
    const shorter = {
      ...config,
      errorAfterMs: 10_000,
      needsInputAfterMs: 20_000,
      idleInDevAfterMs: 30_000,
    };
    const result = evaluate({
      config: shorter,
      sessions: [
        session('error', 'error', 10_000),
        session('input', 'needs_input', 20_000),
        session('idle', 'waiting', 30_000),
        session('limited', 'rate_limited', 0),
      ],
    });
    expect(result.flags.map((flag) => flag.kind)).toEqual([
      'stuck_worker',
      'needs_input',
      'worker_idle',
    ]);
    expect(result.statuses).toEqual([
      { taskId: 'TASK-1', sessionId: 'limited', kind: 'rate_limited' },
    ]);
    expect(result.hostLoad).toBeNull();
  });

  it('reports rate limiting for an other-role session without an actionable flag', () => {
    const result = evaluate({
      sessions: [session('reviewer', 'rate_limited', 0, { role: 'other' })],
    });
    expect(result.statuses).toEqual([
      { taskId: 'TASK-1', sessionId: 'reviewer', kind: 'rate_limited' },
    ]);
    expect(result.flags).toEqual([]);
  });

  it('does not flag waiting workers with an open PR, including draft PRs', () => {
    const waiting = session('a', 'waiting', 1_800_000);
    const result = evaluate({
      sessions: [waiting],
      tasks: { 'TASK-1': { hasOpenPr: true, hasMergedPr: false } },
    });
    expect(result.flags).toEqual([]);
  });

  it('keeps an error flag on a task with a draft PR', () => {
    expect(
      evaluate({
        sessions: [session('a', 'error', 91_000)],
        tasks: { 'TASK-1': { hasOpenPr: true, hasMergedPr: false } },
      }).flags.map((flag) => flag.kind),
    ).toEqual(['stuck_worker']);
  });

  it('groups a fourteen-session error burst into one host-load line', () => {
    const sessions = Array.from({ length: 14 }, (_, index) =>
      session(`s${String(index)}`, 'error', 100_000 - index * 3_000, {
        role: index % 2 === 0 ? 'worker' : 'other',
      }),
    );
    const result = evaluate({ sessions, now: start - 61_000 });
    expect(result.hostLoad).toEqual({ kind: 'host_under_load' });
    expect(result.episode).toEqual({ startedAt: start - 94_000 });
    expect(result.flags).toEqual([]);
  });

  it('starts an episode when the third distinct error enters at the window boundary', () => {
    const result = evaluate({
      sessions: [
        session('a', 'error', 60_000),
        session('b', 'error', 30_000, { role: 'other' }),
        session('c', 'error', 0),
      ],
    });
    expect(result.episode).toEqual({ startedAt: start });
    expect(result.hostLoad).toEqual({ kind: 'host_under_load' });
    expect(result.flags).toEqual([]);
  });

  it('keeps input-wait flags during a host-load episode', () => {
    const result = evaluate({
      sessions: [
        session('a', 'error', 40_000),
        session('b', 'error', 20_000),
        session('c', 'error', 0),
        session('d', 'needs_input', 120_000),
      ],
    });
    expect(result.hostLoad).toEqual({ kind: 'host_under_load' });
    expect(result.flags).toEqual([{ taskId: 'TASK-1', sessionId: 'd', kind: 'needs_input' }]);
  });

  it('rebuilds a recent burst from error entries after a delayed evaluation', () => {
    const entries = [
      session('a', 'error', 120_000),
      session('b', 'error', 119_000),
      session('c', 'error', 118_000),
    ];
    const result = evaluate({ sessions: entries });
    expect(result.hostLoad).toEqual({ kind: 'host_under_load' });
    expect(result.episode).toEqual({ startedAt: start - 118_000 });
    expect(result.flags).toEqual([]);
  });

  it('groups a burst whose 60-second window ended before evaluation', () => {
    const result = evaluate({
      sessions: [
        session('a', 'error', 90_000),
        session('b', 'error', 65_000),
        session('c', 'error', 40_000),
      ],
    });
    expect(result.hostLoad).toEqual({ kind: 'host_under_load' });
    expect(result.episode).toEqual({ startedAt: start - 40_000 });
    expect(result.flags).toEqual([]);
  });

  it('does not rebuild an expired burst or count duplicate session links', () => {
    const expired = [
      session('a', 'error', 300_020),
      session('b', 'error', 300_010),
      session('c', 'error', 300_000),
    ];
    const result = evaluate({ sessions: expired });
    expect(result.hostLoad).toBeNull();
    expect(result.flags.map((flag) => flag.kind)).toEqual([
      'stuck_worker',
      'stuck_worker',
      'stuck_worker',
    ]);
    const duplicate = session('a', 'error', 30_000);
    expect(
      evaluate({ sessions: [duplicate, { ...duplicate, taskId: 'TASK-2' }] }).hostLoad,
    ).toBeNull();
  });

  it('ends an episode after five minutes even when three errors remain', () => {
    const entries = [
      session('a', 'error', 300_020),
      session('b', 'error', 300_010),
      session('c', 'error', 300_000),
    ];
    const began = evaluate({ now: start - 300_000, sessions: entries });
    expect(began.episode).toEqual({ startedAt: start - 300_000 });
    const active = evaluate({ now: start - 1, sessions: entries, episode: began.episode });
    expect(active.flags).toEqual([]);
    const ended = evaluate({ sessions: entries, episode: active.episode });
    expect(ended.hostLoad).toBeNull();
    expect(ended.episode).toBeNull();
    expect(ended.flags.map((flag) => flag.kind)).toEqual([
      'stuck_worker',
      'stuck_worker',
      'stuck_worker',
    ]);
  });

  it('ends an episode early when fewer than three sessions remain in error', () => {
    const entries = [
      session('a', 'error', 100_020),
      session('b', 'error', 100_010),
      session('c', 'error', 100_000),
    ] as const;
    const began = evaluate({ now: start - 100_000, sessions: entries });
    const ended = evaluate({
      sessions: [entries[0], entries[1], session('c', 'working', 0)],
      episode: began.episode,
    });
    expect(ended.hostLoad).toBeNull();
    expect(ended.episode).toBeNull();
    expect(ended.flags.map((flag) => flag.kind)).toEqual(['stuck_worker', 'stuck_worker']);
  });

  it('keeps a prior episode active as error membership changes', () => {
    const began = evaluate({
      now: start - 100_000,
      sessions: [
        session('a', 'error', 100_020),
        session('b', 'error', 100_010),
        session('c', 'error', 100_000),
      ],
    });
    const continued = evaluate({
      sessions: [
        session('a', 'error', 100_020),
        session('b', 'error', 100_010),
        session('d', 'error', 1_000),
      ],
      episode: began.episode,
    });
    expect(continued.hostLoad).toEqual({ kind: 'host_under_load' });
    expect(continued.flags).toEqual([]);
    expect(continued.episode).toEqual(began.episode);
  });

  it('flags an ended worker by reason only after a complete observation without a PR or replacement', () => {
    const ended = session('a', 'stale', 0, {
      endedAt: new Date(start - 1_000).toISOString(),
      endReason: 'complete',
    });
    const kinds = {
      complete: 'worker_completed',
      kill: 'worker_killed',
      vanished: 'worker_vanished',
    } as const;
    for (const [reason, kind] of Object.entries(kinds) as [keyof typeof kinds, string][]) {
      const worker = { ...ended, endReason: reason };
      expect(evaluate({ sessions: [worker] }).flags.map((flag) => flag.kind)).toEqual([kind]);
      expect(
        evaluate({
          sessions: [worker],
          spur: { blind: false, observationComplete: false },
        }).flags,
      ).toEqual([]);
      expect(
        evaluate({
          sessions: [worker],
          tasks: { 'TASK-1': { hasOpenPr: true, hasMergedPr: false } },
        }).flags,
      ).toEqual([]);
      expect(
        evaluate({
          sessions: [worker],
          tasks: { 'TASK-1': { hasOpenPr: false, hasMergedPr: true } },
        }).flags,
      ).toEqual([]);
      expect(evaluate({ sessions: [worker, session('new', 'working', 0)] }).flags).toEqual([]);
    }
    expect(evaluate({ sessions: [{ ...ended, endReason: 'unknown' }] }).flags).toEqual([]);
    const incomplete = { blind: false, observationComplete: false };
    for (const [reason, kind] of Object.entries(kinds) as [keyof typeof kinds, string][]) {
      const worker = { ...ended, endReason: reason };
      expect(evaluate({ sessions: [worker] }).held).toEqual([]);
      expect(
        evaluate({ sessions: [worker], spur: incomplete }).held.map((flag) => flag.kind),
      ).toEqual([kind]);
      expect(
        evaluate({
          sessions: [worker],
          spur: incomplete,
          tasks: { 'TASK-1': { hasOpenPr: true, hasMergedPr: false } },
        }).held,
      ).toEqual([]);
      expect(
        evaluate({
          sessions: [worker],
          spur: incomplete,
          tasks: { 'TASK-1': { hasOpenPr: false, hasMergedPr: true } },
        }).held,
      ).toEqual([]);
      expect(
        evaluate({ sessions: [worker, session('new', 'working', 0)], spur: incomplete }).held,
      ).toEqual([]);
    }
  });

  it('suppresses every session output while Spur is blind', () => {
    const result = evaluate({
      sessions: [
        session('a', 'error', 90_000),
        session('b', 'needs_input', 120_000),
        session('c', 'rate_limited', 0),
        session('d', 'stale', 0, {
          endedAt: new Date(start).toISOString(),
          endReason: 'vanished',
        }),
      ],
      spur: { blind: true, observationComplete: true },
    });
    expect(result.flags).toEqual([]);
    expect(result.held).toEqual([]);
    expect(result.statuses).toEqual([]);
    expect(result.hostLoad).toBeNull();

    const waiting = evaluate({
      sessions: [
        session('d', 'stale', 0, {
          endedAt: new Date(start).toISOString(),
          endReason: 'vanished',
        }),
      ],
      spur: { blind: true, observationComplete: false },
    });
    expect(waiting.flags).toEqual([]);
    expect(waiting.held).toEqual([]);
  });
});
