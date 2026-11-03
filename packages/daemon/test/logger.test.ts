import { describe, expect, it } from 'vitest';
import { createLogger, logCall, type Clock } from '../src/logger.ts';

const SECRET = 'value-to-hide-123456';
const QUOTED_SECRET = 'quote"inside-value-789';

function sink(): { lines: string[]; write(line: string): void } {
  const lines: string[] = [];
  return {
    lines,
    write(line: string) {
      lines.push(line);
    },
  };
}

function parsed(lines: readonly string[]): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('createLogger', () => {
  it('writes one JSON object per line', () => {
    const out = sink();
    createLogger(out, {}).info({ a: 1 }, 'hello');
    expect(parsed(out.lines)).toEqual([expect.objectContaining({ level: 30, msg: 'hello', a: 1 })]);
  });

  it('redacts secret values and credential keys everywhere', () => {
    const out = sink();
    const log = createLogger(out, { API_KEY: SECRET, OTHER: QUOTED_SECRET });
    log.info(`calling with ${SECRET}`);
    log.error({ err: new Error(`failed with ${SECRET}`) }, 'boom');
    log
      .child({ module: 'm', key: SECRET })
      .info({ headers: { authorization: 'Bearer abc' }, token: 'plain-token-value' }, 'request');
    log.info({ value: QUOTED_SECRET }, 'quoted');

    expect(out.lines).toHaveLength(4);
    for (const line of out.lines) {
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain(JSON.stringify(QUOTED_SECRET).slice(1, -1));
      expect(line).toContain('[Redacted]');
    }
    const [message, error, child, quoted] = parsed(out.lines);
    expect(message?.['msg']).toBe('calling with [Redacted]');
    expect(JSON.stringify(error?.['err'])).toContain('failed with [Redacted]');
    expect(child?.['module']).toBe('m');
    expect(child?.['key']).toBe('[Redacted]');
    expect(child?.['headers']).toEqual({ authorization: '[Redacted]' });
    expect(child?.['token']).toBe('[Redacted]');
    expect(quoted?.['value']).toBe('[Redacted]');
  });

  it('leaves short secret values alone', () => {
    const out = sink();
    createLogger(out, { SHORT: 'abc' }).info('abc stays');
    expect(parsed(out.lines)[0]?.['msg']).toBe('abc stays');
  });
});

describe('logCall', () => {
  function steppingClock(...times: number[]): Clock {
    return {
      now() {
        const next = times.shift();
        if (next === undefined) throw new Error('clock read too often');
        return next;
      },
    };
  }

  it('logs ok at info with the duration from the clock', async () => {
    const out = sink();
    const log = createLogger(out, {});
    await expect(
      logCall(log, steppingClock(1000, 1250), 'gh.search', () => Promise.resolve('v')),
    ).resolves.toBe('v');
    expect(parsed(out.lines)).toEqual([
      expect.objectContaining({
        level: 30,
        msg: 'external call',
        call: 'gh.search',
        duration_ms: 250,
        outcome: 'ok',
      }),
    ]);
  });

  it('logs error at warn and rethrows the same error', async () => {
    const out = sink();
    const log = createLogger(out, { API_KEY: SECRET });
    const e = new Error(`boom ${SECRET}`);
    await expect(
      logCall(log, steppingClock(1000, 1250), 'gh.search', () => Promise.reject(e)),
    ).rejects.toBe(e);
    const lines = parsed(out.lines);
    expect(lines).toEqual([
      expect.objectContaining({
        level: 40,
        msg: 'external call',
        call: 'gh.search',
        duration_ms: 250,
        outcome: 'error',
      }),
    ]);
    expect((lines[0]?.['err'] as { message: string }).message).toContain('boom');
    for (const line of out.lines) expect(line).not.toContain(SECRET);
  });
});
