import { describe, expect, it } from 'vitest';
import {
  command,
  runSmokeSteps,
  smokeSteps,
  verifySchema,
  verifyVersion,
} from './package-smoke.ts';

describe('packed smoke steps', () => {
  it('keeps the staged checks in one ordered list', () => {
    expect(smokeSteps.map((step) => step.name)).toEqual(['version', 'daemon', 'schema']);
  });

  it('fails for a broken daemon or schema step', async () => {
    const context = { binary: '', expectedVersion: '', env: {} };
    await expect(
      runSmokeSteps(context, [
        { name: 'daemon', run: () => Promise.reject(new Error('daemon failed')) },
      ]),
    ).rejects.toThrow('daemon failed');
    expect(() => {
      verifySchema({ code: 1, stdout: '', stderr: 'schema failed' });
    }).toThrow('schema failed');
    expect(() => {
      verifySchema({ code: 0, stdout: '{}', stderr: '' });
    }).toThrow('invalid catalog');
  });

  it('compares the packed binary version with its manifest', () => {
    expect(() => {
      verifyVersion({ code: 0, stdout: '0.0.0\n', stderr: '' }, '0.1.0');
    }).toThrow();
    expect(() => {
      verifyVersion({ code: 0, stdout: '0.1.0\n', stderr: '' }, '0.1.0');
    }).not.toThrow();
  });

  it('terminates a hung packed command before smoke can continue', async () => {
    const started = performance.now();
    await expect(
      command(
        process.execPath,
        ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
        {},
        50,
      ),
    ).rejects.toThrow('timed out');
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});
