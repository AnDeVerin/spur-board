import { describe, expect, it } from 'vitest';
import { createFakeHost, parseFakeHostArgs } from '../src/fakes/host.ts';

/** Percent used of a volume as the daemon's sampler computes it. */
async function usedPercent(host: ReturnType<typeof createFakeHost>, path: string) {
  const fs = await host.probe.volume(path);
  const used = (fs.blocks - fs.bfree) * fs.bsize;
  const available = fs.bavail * fs.bsize;
  return Math.round((1000 * used) / (used + available)) / 10;
}

/** CPU busy percent between two reads, as the sampler computes it. */
function cpuPercent(host: ReturnType<typeof createFakeHost>) {
  const before = host.probe.cpuTimes();
  const after = host.probe.cpuTimes();
  return 100 * (1 - (after.idle - before.idle) / (after.total - before.total));
}

function memoryPercent(host: ReturnType<typeof createFakeHost>) {
  const { totalBytes, availableBytes } = host.probe.memory();
  return (100 * (totalBytes - availableBytes)) / totalBytes;
}

describe('fake host', () => {
  it('starts at CPU 10, RAM 50 and one volume / at 50', async () => {
    const host = createFakeHost();
    expect(host.probe.diskPaths).toEqual(['/']);
    expect(await usedPercent(host, '/')).toBe(50);
    expect(cpuPercent(host)).toBeCloseTo(10);
    expect(memoryPercent(host)).toBe(50);
  });

  it('sets what the probe returns with each verb', async () => {
    const host = createFakeHost();
    expect(host.control('disk', { percent: 95 }).status).toBe(200);
    expect(host.control('disk', { percent: 85.5, mount: '/data' }).status).toBe(200);
    expect(host.control('cpu', { percent: 99 }).status).toBe(200);
    expect(host.control('ram', { percent: 81 }).status).toBe(200);
    expect(host.probe.diskPaths).toEqual(['/', '/data']);
    expect(await usedPercent(host, '/')).toBe(95);
    expect(await usedPercent(host, '/data')).toBe(85.5);
    const [root, data] = await Promise.all([host.probe.volume('/'), host.probe.volume('/data')]);
    expect(root.dev).not.toBe(data.dev);
    expect(data.mount).toBe('/data');
    expect(cpuPercent(host)).toBeCloseTo(99);
    expect(memoryPercent(host)).toBeCloseTo(81);
    expect(host.control('inspect', {})).toEqual({
      status: 200,
      body: {
        cpu: 99,
        ram: 81,
        volumes: [
          { mount: '/', percent: 95 },
          { mount: '/data', percent: 85.5 },
        ],
      },
    });
  });

  it('restores the defaults on reset', async () => {
    const host = createFakeHost();
    host.control('disk', { percent: 95, mount: '/data' });
    host.control('cpu', { percent: 99 });
    host.reset();
    expect(host.probe.diskPaths).toEqual(['/']);
    expect(await usedPercent(host, '/')).toBe(50);
    expect(cpuPercent(host)).toBeCloseTo(10);
  });

  it('answers 400 to an unknown verb or a bad percent', () => {
    const host = createFakeHost();
    expect(host.control('swap', { percent: 1 }).status).toBe(400);
    expect(host.control('disk', { percent: 101 }).status).toBe(400);
    expect(host.control('cpu', { percent: 'x' }).status).toBe(400);
    expect(host.control('cpu', { percent: 5, mount: '/' }).status).toBe(400);
    expect(host.control('inspect', {}).body).toMatchObject({ cpu: 10 });
  });
});

describe('parseFakeHostArgs', () => {
  it('parses the verbs and keeps --home out of args', () => {
    expect(parseFakeHostArgs(['host', 'disk', '95', '/', '--home', 'h'])).toEqual({
      ok: true,
      value: { system: 'host', verb: 'disk', args: { percent: 95, mount: '/' }, home: 'h' },
    });
    expect(parseFakeHostArgs(['host', 'ram', '80.5'])).toEqual({
      ok: true,
      value: { system: 'host', verb: 'ram', args: { percent: 80.5 } },
    });
    expect(parseFakeHostArgs(['host', 'inspect'])).toEqual({
      ok: true,
      value: { system: 'host', verb: 'inspect', args: {} },
    });
  });

  it.each([
    [['host']],
    [['host', 'swap', '5']],
    [['host', 'disk', 'abc']],
    [['host', 'disk', '101']],
    [['host', 'cpu']],
    [['host', 'cpu', '5', '/']],
    [['host', 'disk', '5', 'data']],
    [['host', 'inspect', 'x']],
  ])('refuses %j', (rest) => {
    expect(parseFakeHostArgs(rest).ok).toBe(false);
  });
});
