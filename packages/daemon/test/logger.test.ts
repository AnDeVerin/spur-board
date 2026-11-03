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

  it('censors credential keys at any depth and in any casing', () => {
    const out = sink();
    const log = createLogger(out, {});
    log.info({ request: { options: { headers: { Authorization: 'Bearer abc' } } } }, 'deep');
    log.info(
      { headers: [{ 'Proxy-Authorization': 'Basic xyz', Cookie: 'sid=1' }], accessToken: 'at-1' },
      'mixed',
    );
    log.child({ bot_token: 'bt-1' }).info('bound');
    const err = Object.assign(new Error('rejected'), {
      config: { headers: { AUTHORIZATION: 'Bearer err' } },
    });
    log.error({ err }, 'failed');

    for (const line of out.lines) {
      for (const raw of ['Bearer abc', 'Basic xyz', 'sid=1', 'at-1', 'bt-1', 'Bearer err']) {
        expect(line).not.toContain(raw);
      }
    }
    const [deep, mixed, bound, failed] = parsed(out.lines);
    expect(deep?.['request']).toEqual({
      options: { headers: { Authorization: '[Redacted]' } },
    });
    expect(mixed?.['headers']).toEqual([
      { 'Proxy-Authorization': '[Redacted]', Cookie: '[Redacted]' },
    ]);
    expect(mixed?.['accessToken']).toBe('[Redacted]');
    expect(bound?.['bot_token']).toBe('[Redacted]');
    expect((failed?.['err'] as { config: unknown }).config).toEqual({
      headers: { AUTHORIZATION: '[Redacted]' },
    });
  });

  it('keeps keys that only contain a credential word', () => {
    const out = sink();
    createLogger(out, {}).info({ tokenCount: 3, authorizationUrl: 'https://example.com/a' }, 'ok');
    expect(parsed(out.lines)[0]).toEqual(
      expect.objectContaining({ tokenCount: 3, authorizationUrl: 'https://example.com/a' }),
    );
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
