// @vitest-environment happy-dom
import { browserOperations, HOST_USAGE_LEVELS } from '@spur-board/contracts/browser';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { hostAlert, hostRows } from '../src/board/services.ts';
import { StatusDot } from '../src/ds/index.ts';
import { daemon, envelope, failure, healthy, hello, T, type Daemon } from './board-fixtures.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GIB = 2 ** 30;
const volume = (mount: string, usedPercent: number, availableBytes = 8.7 * GIB) => ({
  mount,
  totalBytes: 2 ** 40,
  availableBytes,
  usedPercent,
});
type Volume = ReturnType<typeof volume>;
const host = (
  extra: { cpuPercent?: number | null; ram?: number | null; volumes?: Volume[] } = {},
) => {
  const volumes = extra.volumes ?? [];
  return browserOperations['status.get'].output.shape.host.parse({
    sampledAt: T,
    cpuPercent: extra.cpuPercent ?? null,
    memory:
      extra.ram == null
        ? null
        : { totalBytes: 16 * GIB, availableBytes: 2 * GIB, usedPercent: extra.ram },
    disk: volumes[0] ?? null,
    volumes,
  });
};

describe('hostAlert', () => {
  it('maps each reading to its level at the 80 and 90 boundaries', () => {
    expect(hostAlert(host({ cpuPercent: 79.9 }))).toBeNull();
    expect(hostAlert(host({ cpuPercent: 80 }))?.tone).toBe('warn');
    expect(hostAlert(host({ ram: 89.9 }))?.tone).toBe('warn');
    expect(hostAlert(host({ ram: 90 }))?.tone).toBe('error');
    expect(hostAlert(host({ volumes: [volume('/', 79.9)] }))).toBeNull();
    expect(hostAlert(host({ volumes: [volume('/', 80)] }))?.tone).toBe('warn');
    expect(hostAlert(host({ volumes: [volume('/', 89.9)] }))?.tone).toBe('warn');
    expect(hostAlert(host({ volumes: [volume('/', 90)] }))?.tone).toBe('error');
  });

  it('takes the worst level over CPU, RAM and every volume', () => {
    expect(
      hostAlert(host({ cpuPercent: 85, ram: 81, volumes: [volume('/data', 50), volume('/', 95)] }))
        ?.tone,
    ).toBe('error');
    expect(
      hostAlert(host({ cpuPercent: 10, ram: 20, volumes: [volume('/data', 50), volume('/', 85)] }))
        ?.tone,
    ).toBe('warn');
    expect(
      hostAlert(host({ cpuPercent: 10, ram: 20, volumes: [volume('/data', 50), volume('/', 60)] })),
    ).toBeNull();
  });

  it('is null with no host or no readings', () => {
    expect(hostAlert(null)).toBeNull();
    expect(hostAlert(host())).toBeNull();
  });

  it('names each reading at warn or error in the order CPU, RAM, volumes', () => {
    expect(hostAlert(host({ cpuPercent: 10, volumes: [volume('/', 91.6)] }))?.text).toBe(
      'disk / 91% used, 8.7 GiB free',
    );
    expect(
      hostAlert(host({ cpuPercent: 10, ram: 82.5, volumes: [volume('/', 91), volume('/x', 3)] }))
        ?.text,
    ).toBe('RAM 82% used, 2.0 GiB free · disk / 91% used, 8.7 GiB free');
    expect(hostAlert(host({ cpuPercent: 99.9, ram: 50, volumes: [volume('/', 1)] }))?.text).toBe(
      'CPU 99% used',
    );
  });
});

describe('hostRows', () => {
  it('colours the meters at the shared host usage levels', () => {
    const rows = hostRows(host({ cpuPercent: 1, ram: 1, volumes: [volume('/', 1)] }), null);
    for (const row of rows)
      expect('meter' in row && row.meter.thresholds).toEqual({
        ...HOST_USAGE_LEVELS,
        worse: 'high',
      });
  });
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  container.id = 'root';
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  });
}
async function mount(value: unknown): Promise<Daemon> {
  const d = daemon();
  d.routes['status.get'] = () => Promise.resolve(envelope(value));
  history.replaceState(null, '', '/');
  vi.stubGlobal('fetch', d.fetcher);
  act(() => {
    root.render(createElement(App));
  });
  d.send(hello);
  await settle();
  return d;
}
const trigger = () => {
  const found = [...container.querySelectorAll<HTMLButtonElement>('footer button')].find(
    (button) => button.getAttribute('aria-label')?.split(':')[0] === 'services',
  );
  if (!found) throw new Error('no services trigger');
  return found;
};
const dot = (tone: 'warn' | 'error') =>
  renderToStaticMarkup(createElement(StatusDot, { tone, hollow: false }));
const withHost = (value: ReturnType<typeof host>) => ({ ...healthy(), host: value });
/** Clicks the trigger and returns aria-expanded before and after. */
const toggle = async () => {
  const before = trigger().getAttribute('aria-expanded');
  act(() => {
    trigger().click();
  });
  await settle();
  return [before, trigger().getAttribute('aria-expanded'), new URL(location.href).search];
};

describe('status bar services trigger', () => {
  it('keeps the healthy trigger as it was: no dot, no title', async () => {
    await mount(withHost(host({ cpuPercent: 10, ram: 50, volumes: [volume('/', 50)] })));
    expect(trigger().getAttribute('aria-label')).toBe('services');
    expect(trigger().hasAttribute('title')).toBe(false);
    expect(trigger().children).toHaveLength(2);
    expect(await toggle()).toEqual(['false', 'true', '?open=services']);
  });

  it('shows the worst tone with the readings in its name and title', async () => {
    await mount(withHost(host({ cpuPercent: 10, ram: 50, volumes: [volume('/', 92)] })));
    expect(trigger().getAttribute('aria-label')).toBe('services: disk / 92% used, 8.7 GiB free');
    expect(trigger().getAttribute('title')).toBe('services: disk / 92% used, 8.7 GiB free');
    expect(trigger().innerHTML).toContain(dot('error'));
    expect(trigger().textContent).toBe('services');
    expect(await toggle()).toEqual(['false', 'true', '?open=services']);
  });

  it('shows a warn dot between 80% and 90%', async () => {
    await mount(withHost(host({ ram: 85, volumes: [volume('/', 50)] })));
    expect(trigger().innerHTML).toContain(dot('warn'));
    expect(trigger().getAttribute('aria-label')).toBe('services: RAM 85% used, 2.0 GiB free');
  });

  it('drops the dot when the status read fails', async () => {
    const d = await mount(withHost(host({ volumes: [volume('/', 92)] })));
    expect(trigger().innerHTML).toContain(dot('error'));
    d.routes['status.get'] = failure;
    d.send('event: status\ndata: {}\n\n');
    await settle();
    expect(trigger().children).toHaveLength(2);
    expect(trigger().getAttribute('aria-label')).toBe('services');
    expect(trigger().hasAttribute('title')).toBe(false);
  });
});
