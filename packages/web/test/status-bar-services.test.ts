import { browserOperations } from '@spur-board/contracts/browser';
import { describe, expect, it } from 'vitest';
import type { BoardUpdate } from '../src/board/update.ts';
import { formatDataTime } from '../src/board/model.ts';
import {
  daemonRows,
  gatewayRows,
  hostRows,
  indicators,
  panelBoxes,
  scrollTarget,
  sourceRows,
  type PanelRow,
} from '../src/board/services.ts';
import {
  HEALTHY,
  ISSUES,
  PR,
  SLACK_UP,
  T,
  T_TEXT,
  healthy,
  polled,
  service,
  source,
  status,
} from './board-fixtures.ts';

const parse = (value: unknown) => browserOperations['status.get'].output.parse(value);
const time = formatDataTime;
const first = <V>(list: readonly V[]): V => {
  const [found] = list;
  if (found === undefined) throw new Error('empty list');
  return found;
};
interface Extra {
  readFailed?: boolean;
  unreadable?: boolean;
  update?: BoardUpdate;
  lastGoodAt?: number;
}
const snap = (value: unknown, extra: Extra = {}) => ({
  status: value === undefined ? undefined : parse(value),
  readFailed: extra.readFailed ?? false,
  unreadable: extra.unreadable ?? false,
  update: extra.update,
  lastGoodAt: extra.lastGoodAt,
});
const labels = (value: unknown, extra: Extra = {}) =>
  indicators(snap(value, extra), time).map((item) => item.label);

const texts = (rows: PanelRow[]) =>
  rows.map((row) =>
    'text' in row && !('meter' in row)
      ? [row.key, row.text]
      : 'meter' in row
        ? [row.key, row.meter.value, row.meter.limit, row.text]
        : 'status' in row
          ? [row.key, row.status]
          : [row.key],
  );

describe('status bar indicators', () => {
  it('one button per listed service, named with its word', () => {
    expect(labels(healthy())).toEqual([
      'daemon: running',
      'slack: up',
      'github: polling',
      'spur: polling',
    ]);
    const stalled = status(undefined, [], {
      services: [
        service('daemon', 'degraded'),
        service('slack', 'failing'),
        service('jira', 'degraded'),
      ],
      sources: [source('jira:a', { lastCompleteAt: null, warmingUp: true })],
    });
    expect(labels(stalled)).toEqual([
      'daemon: stalled',
      'slack: down',
      'github: unknown',
      'spur: unknown',
      'jira: warming up',
    ]);
    const [, , , , jira] = indicators(snap(stalled), time);
    expect(jira).toMatchObject({ icon: 'diamond', tone: 'warn' });
  });

  it('a service with no row reads unknown', () => {
    expect(labels(status())).toEqual([
      'daemon: unknown',
      'slack: unknown',
      'github: unknown',
      'spur: unknown',
    ]);
    const jiraSource = status(undefined, [polled('jira:a')], { services: HEALTHY });
    expect(labels(jiraSource).at(-1)).toBe('jira: unknown');
    expect(indicators(snap(jiraSource), time).at(-1)?.tone).toBe('unknown');
  });

  it('maps the github row and its source words', () => {
    const blind = status(undefined, [polled(PR), polled(ISSUES, { blindReason: 'auth' })], {
      services: [service('github', 'failing')],
    });
    const [, , github] = indicators(snap(blind), time);
    expect(github).toMatchObject({ label: 'github: blind: auth', tone: 'error' });
    const boxes = panelBoxes(snap(blind), time);
    expect(boxes.find((item) => item.id === ISSUES)?.health).toEqual({
      tone: 'error',
      word: 'blind: auth',
    });
    expect(boxes.find((item) => item.id === PR)?.health).toEqual({ tone: 'ok', word: 'polling' });

    const budget = status(undefined, [polled(PR, { waitsForBudget: true }), polled(ISSUES)], {
      services: [service('github', 'degraded', { reason: `${PR} waits for its rate budget` })],
    });
    const [, , waiting] = indicators(snap(budget), time);
    expect(waiting?.label).toBe('github: waits for rate budget');
    expect(waiting?.title).toBe(`github: waits for rate budget · ${PR} waits for its rate budget`);

    const stale = polled(PR, { stale: true });
    const warming = polled(ISSUES, { warmingUp: true });
    const degraded = { services: [service('github', 'degraded')] };
    expect(labels(status(undefined, [stale, warming], degraded))[2]).toBe('github: stale');
    expect(labels(status(undefined, [warming, stale], degraded))[2]).toBe('github: warming up');
  });

  it('reads unknown before the first status and while the daemon does not answer', () => {
    expect(labels(undefined)).toEqual([
      'daemon: unknown',
      'slack: unknown',
      'github: unknown',
      'spur: unknown',
    ]);
    const at = Date.parse(T);
    expect(labels(healthy(), { readFailed: true, lastGoodAt: at })).toEqual([
      `daemon: no answer since ${T_TEXT}`,
      'slack: unknown',
      'github: unknown',
      'spur: unknown',
    ]);
  });

  it('names an unreadable daemon answer apart from no answer', () => {
    const at = Date.parse(T);
    expect(labels(healthy(), { readFailed: true, unreadable: true })[0]).toBe('daemon: unreadable');
    expect(labels(healthy(), { readFailed: true, unreadable: true, lastGoodAt: at })).toEqual([
      `daemon: unreadable since ${T_TEXT}`,
      'slack: unknown',
      'github: unknown',
      'spur: unknown',
    ]);
  });

  it('names the version a board update brought while reads fail', () => {
    const update = { version: '2.0.0', mode: 'blocked', keepsDrafts: true } as const;
    for (const unreadable of [false, true])
      expect(
        labels(healthy(), { readFailed: true, unreadable, update, lastGoodAt: Date.parse(T) })[0],
      ).toBe('daemon: updated to 2.0.0');
  });
});

describe('services panel rows', () => {
  it('maps each source field to a row', () => {
    const later = '2026-11-15T14:45:00.000Z';
    expect(
      texts(
        sourceRows(
          first(
            parse(
              status(undefined, [
                polled(PR, {
                  observedAt: later,
                  pointsLastHour: 12,
                  budget: { remaining: 4200, limit: 5000, resetAt: '2026-11-15T15:10:00.000Z' },
                }),
              ]),
            ).sources,
          ),
          time,
        ),
      ),
    ).toEqual([
      ['Last complete poll', T_TEXT],
      ['Last observation', '14:45 15/11/26'],
      ['Freshness', 'fresh'],
      ['Warming up', 'no'],
      ['Points last hour', '12'],
      ['Budget', 4200, 5000, 'resets 15:10'],
    ]);
    const blindSource = first(
      parse(
        status(undefined, [
          source('spur', {
            blindReason: 'auth',
            message: 'token refused',
            stale: true,
            warmingUp: true,
            budget: { remaining: 30, limit: null, resetAt: '2026-11-15T15:10:00.000Z' },
          }),
        ]),
      ).sources,
    );
    expect(texts(sourceRows(blindSource, time))).toEqual([
      ['Last complete poll', '— never completed'],
      ['Last observation', '—'],
      ['Blind', 'auth · token refused'],
      ['Freshness', 'stale'],
      ['Warming up', 'yes'],
      ['Budget', '30 left · resets 15:10'],
    ]);
    const noBudget = first(parse(status(undefined, [polled('jira:a')])).sources);
    expect(texts(sourceRows(noBudget, time)).at(-1)).toEqual(['Budget', '—']);
  });

  it('a github-project source: its own box in its project group, healthy and failing with its code', () => {
    const MIRROR = 'github-project:a:ex/1';
    const FROZEN =
      'ready-for-dev is frozen: tasks stay where they were until the mirror reads again.';
    const boxesWith = (extra: Record<string, unknown> = {}) =>
      panelBoxes(
        snap(
          status(
            undefined,
            [polled('spur'), polled('github:a:ex/repo'), polled(MIRROR, extra), polled('jira:a')],
            { services: [...HEALTHY, service('jira', 'healthy')], transport: [SLACK_UP] },
          ),
        ),
        time,
      );
    const mirror = (extra: Record<string, unknown> = {}) =>
      first(boxesWith(extra).filter((box) => box.id === MIRROR));
    expect(boxesWith().map((box) => box.id)).toEqual([
      'daemon',
      'host',
      'slack',
      'spur',
      'github:a:ex/repo',
      'jira:a',
      MIRROR,
    ]);
    const healthyBox = mirror();
    expect(healthyBox).toMatchObject({
      service: null,
      project: 'a',
      icon: 'mirror',
      name: 'github project',
      health: { tone: 'ok', word: 'polling' },
    });
    expect(texts(healthyBox.rows)).toEqual([
      ['Project', 'ex/1'],
      ['Last complete poll', T_TEXT],
      ['Last observation', T_TEXT],
      ['Freshness', 'fresh'],
      ['Warming up', 'no'],
      ['Budget', '—'],
    ]);
    const failing = mirror({
      failure: { code: 'mirror_read_failed', message: 'GitHub answered 502' },
    });
    expect(failing.health).toEqual({ tone: 'error', word: 'failing' });
    expect(texts(failing.rows).slice(-2)).toEqual([
      ['Failure', 'mirror_read_failed · GitHub answered 502'],
      [FROZEN],
    ]);
    const blind = mirror({
      blindReason: 'auth',
      message: 'token refused',
      failure: {
        code: 'mirror_project_forbidden',
        message: 'GitHub Project ex/1 was not found or is not readable: forbidden',
      },
    });
    expect(blind.health).toEqual({ tone: 'error', word: 'blind: auth' });
    expect(texts(blind.rows)).toContainEqual(['Blind', 'auth · token refused']);
    expect(texts(blind.rows).slice(-2)).toEqual([
      [
        'Failure',
        'mirror_project_forbidden · GitHub Project ex/1 was not found or is not readable: forbidden',
      ],
      [FROZEN],
    ]);
    // A stale mirror with no failure is not frozen.
    expect(texts(mirror({ stale: true }).rows).flat()).not.toContain(FROZEN);
    // No status bar button and no scroll target: the github button keeps its box.
    expect(scrollTarget(boxesWith(), 'github')).toBe('github:a:ex/repo');
    expect(
      labels(
        status(undefined, [polled(MIRROR, { blindReason: 'auth' })], {
          services: [...HEALTHY, service('github-project', 'failing')],
        }),
      ),
    ).toEqual(['daemon: running', 'slack: up', 'github: polling', 'spur: polling']);
  });

  it('groups source boxes by project after the shared boxes', () => {
    const boxes = panelBoxes(
      snap(
        status(
          undefined,
          [
            polled('spur'),
            polled('jira:a'),
            polled('github:a:ex/repo'),
            polled('github-issues:b:ex/other'),
            polled('github:b:ex/other'),
            polled('github:b:ex/third'),
          ],
          { services: [...HEALTHY, service('jira', 'healthy')], transport: [SLACK_UP] },
        ),
      ),
      time,
    );
    expect(boxes.map((box) => box.id)).toEqual([
      'daemon',
      'host',
      'slack',
      'spur',
      'github:a:ex/repo',
      'jira:a',
      'github:b:ex/other',
      'github:b:ex/third',
      'github-issues:b:ex/other',
    ]);
    expect(boxes.map((box) => box.project)).toEqual([
      null,
      null,
      null,
      null,
      'a',
      'a',
      'b',
      'b',
      'b',
    ]);
    expect(boxes.slice(4).map((box) => box.name)).toEqual([
      'github pull requests',
      'jira',
      'github pull requests · ex/other',
      'github pull requests · ex/third',
      'github issues',
    ]);
  });

  describe('scrolls a service button to its worst box', () => {
    const ok = polled('github:a:ex/repo');
    const stale = polled('github:b:ex/other', { stale: true });
    const blind = polled('github:b:ex/third', { blindReason: 'auth' });
    const budget = { remaining: 10, limit: 5000, resetAt: '2026-11-15T15:00:00.000Z' };
    const waiting = (name: string) => polled(name, { budget, waitsForBudget: true });
    const github = (state: 'healthy' | 'degraded' | 'failing', reason?: string) => [
      ...HEALTHY.filter((row) => row.service !== 'github'),
      service('github', state, reason === undefined ? {} : { reason }),
    ];
    const WAIT = 'waits for rate budget';
    // `sources` in status.get order; `words` maps each source box to its head tone and word.
    it.each([
      {
        when: 'a box is failing',
        name: 'jira' as const,
        sources: [polled('jira:a'), polled('jira:b', { blindReason: 'auth' })],
        services: [...HEALTHY, service('jira', 'failing', { reason: 'jira:b blind (auth)' })],
        expected: 'jira:b',
        words: { 'jira:a': 'ok polling', 'jira:b': 'error blind: auth' },
      },
      {
        when: 'a failing box beats an earlier degraded one',
        name: 'github' as const,
        sources: [ok, stale, blind],
        services: github('failing', 'github:b:ex/third blind (auth)'),
        expected: 'github:b:ex/third',
        words: {
          'github:a:ex/repo': 'ok polling',
          'github:b:ex/other': 'warn stale',
          'github:b:ex/third': 'error blind: auth',
        },
      },
      {
        when: 'one source of a later project waits for its rate budget',
        name: 'github' as const,
        sources: [ok, waiting('github:b:ex/other'), polled('github:b:ex/third')],
        services: github('degraded', 'github:b:ex/other waits for its rate budget'),
        expected: 'github:b:ex/other',
        words: {
          'github:a:ex/repo': 'ok polling',
          'github:b:ex/other': `warn ${WAIT}`,
          'github:b:ex/third': 'ok polling',
        },
      },
      {
        when: 'sources of two projects wait for their rate budget',
        name: 'github' as const,
        sources: [waiting('github:a:ex/repo'), waiting('github:b:ex/other')],
        services: github('degraded', 'github:a:ex/repo waits for its rate budget'),
        expected: 'github:a:ex/repo',
        words: { 'github:a:ex/repo': `warn ${WAIT}`, 'github:b:ex/other': `warn ${WAIT}` },
      },
      {
        // The first poll after a restart was incomplete and under the reserve.
        when: 'a source waits for its rate budget before its first complete poll',
        name: 'github' as const,
        sources: [
          polled('github:a:ex/repo', {
            budget,
            waitsForBudget: true,
            warmingUp: true,
            lastCompleteAt: null,
          }),
        ],
        services: github('degraded', 'github:a:ex/repo waits for its rate budget'),
        expected: 'github:a:ex/repo',
        words: { 'github:a:ex/repo': `warn ${WAIT}` },
      },
      {
        // Core lists the issues tracker before the repos and blames it; the panel shows PRs first.
        when: 'the issues source waits for its rate budget and the PR source is stale',
        name: 'github' as const,
        sources: [waiting('github-issues:b:ex/other'), stale],
        services: github('degraded', 'github-issues:b:ex/other waits for its rate budget'),
        expected: 'github-issues:b:ex/other',
        words: { 'github:b:ex/other': 'warn stale', 'github-issues:b:ex/other': `warn ${WAIT}` },
      },
      {
        when: 'all boxes are healthy',
        name: 'github' as const,
        sources: [polled('github-issues:a:ex/repo'), ok, polled('github:b:ex/other')],
        services: github('healthy'),
        expected: 'github:a:ex/repo',
        words: {
          'github:a:ex/repo': 'ok polling',
          'github-issues:a:ex/repo': 'ok polling',
          'github:b:ex/other': 'ok polling',
        },
      },
    ])('$when', ({ name, sources, services, expected, words }) => {
      const snapshot = snap(status(undefined, [polled('spur'), ...sources], { services }));
      const boxes = panelBoxes(snapshot, time);
      const own = boxes.filter((box) => box.service === name);
      expect(
        Object.fromEntries(
          own.map((box) => [box.id, [box.health?.tone, box.health?.word].join(' ')]),
        ),
      ).toEqual(words);
      const order = snapshot.status?.sources.map((entry) => entry.source);
      expect(scrollTarget(boxes, name, order)).toBe(expected);
    });
  });

  it('maps gateway, daemon and host fields to rows', () => {
    expect(gatewayRows(undefined, time)).toEqual([]);
    expect(
      gatewayRows(parse(status(undefined, [], { transport: [SLACK_UP] })).transport[0], time),
    ).toEqual([]);
    const down = parse(
      status(undefined, [], {
        transport: [
          { gateway: 'slack', state: 'down', since: T, reason: 'token revoked', spaces: ['feed'] },
        ],
      }),
    ).transport[0];
    expect(texts(gatewayRows(down, time))).toEqual([
      ['Down since', T_TEXT],
      ['Reason', 'token revoked'],
      ['Spaces', 'feed'],
    ]);
    expect(
      texts(daemonRows({ version: '9.8.7-rc.1', startedAt: T, lastDispatchAt: null }, time)),
    ).toEqual([
      ['Version', '9.8.7-rc.1'],
      ['Started', T_TEXT],
      ['Last dispatch', '—'],
    ]);
    expect(texts(hostRows(null, null))).toEqual([
      ['CPU', null, 100, undefined],
      ['RAM', null, 100, undefined],
      ['Disk', null, 100, undefined],
    ]);
    const volume = (mount: string, usedPercent: number, availableBytes: number) => ({
      mount,
      totalBytes: 2 ** 50,
      availableBytes,
      usedPercent,
    });
    const host = (volumes: ReturnType<typeof volume>[]) => ({
      sampledAt: T,
      cpuPercent: null,
      memory: null,
      disk: volumes[0] ?? null,
      volumes,
    });
    const diskRows = (volumes: ReturnType<typeof volume>[]) =>
      texts(hostRows(host(volumes), null)).slice(2);
    expect(texts(hostRows(host([]), null))).toEqual([
      ['CPU', null, 100, undefined],
      ['RAM', null, 100, undefined],
      ['Disk', null, 100, undefined],
    ]);
    expect(texts(hostRows(host([volume('/', 92, 44093947904)]), 'Host load: polls wait'))).toEqual([
      ['CPU', null, 100, undefined],
      ['RAM', null, 100, undefined],
      ['Disk', 92, 100, '41.1 GiB free'],
      ['Host load: polls wait', 'wait'],
    ]);
    // Several volumes are keyed by mount and keep the daemon's order.
    expect(diskRows([volume('/', 58, 44093947904), volume('/home', 33, 338548621312)])).toEqual([
      ['Disk /', 58, 100, '41.1 GiB free'],
      ['Disk /home', 33, 100, '315.3 GiB free'],
    ]);
    // Binary units, an integer below 1 KiB, the unit picked after rounding, TiB the cap.
    for (const [bytes, text] of [
      [0, '0 B free'],
      [1023, '1023 B free'],
      [1024, '1.0 KiB free'],
      [1048545, '1.0 MiB free'],
      [1099478073344, '1.0 TiB free'],
      [2048 * 2 ** 40, '2048.0 TiB free'],
    ] as const)
      expect(diskRows([volume('/', 10, bytes)])).toEqual([['Disk', 10, 100, text]]);
  });
});
