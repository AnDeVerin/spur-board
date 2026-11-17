import { browserOperations } from '@spur-board/contracts/browser';
import { describe, expect, it } from 'vitest';
import { formatDataTime } from '../src/board/model.ts';
import {
  daemonRows,
  gatewayRows,
  hostRows,
  indicators,
  panelBoxes,
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
const snap = (value: unknown, extra: { readFailed?: boolean; lastGoodAt?: number } = {}) => ({
  status: value === undefined ? undefined : parse(value),
  readFailed: extra.readFailed ?? false,
  lastGoodAt: extra.lastGoodAt,
});
const labels = (value: unknown, extra: { readFailed?: boolean; lastGoodAt?: number } = {}) =>
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

    const budget = status(undefined, [polled(PR), polled(ISSUES)], {
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
    const usage = (usedPercent: number) => ({ totalBytes: 100, availableBytes: 1, usedPercent });
    expect(
      texts(
        hostRows(
          { sampledAt: T, cpuPercent: null, memory: null, disk: usage(92) },
          'Host load: polls wait',
        ),
      ),
    ).toEqual([
      ['CPU', null, 100, undefined],
      ['RAM', null, 100, undefined],
      ['Disk', 92, 100, undefined],
      ['Host load: polls wait', 'wait'],
    ]);
  });
});
