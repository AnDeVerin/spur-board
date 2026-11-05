import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../src/smoke.ts';
import { makeHome } from './home.ts';

function fakeFetch(failGithub = false): typeof fetch {
  return (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === '/graphql') {
      if (failGithub) return Promise.resolve(new Response('', { status: 401 }));
      return Promise.resolve(
        Response.json({
          data: {
            rateLimit: { remaining: 123, resetAt: '2026-01-03T00:00:00.000Z' },
            repository: {
              pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              mergedBaseline: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          },
        }),
      );
    }
    if (url.pathname.endsWith('/issues/9'))
      return Promise.resolve(new Response('', { status: 404 }));
    if (url.pathname.endsWith('/issues')) return Promise.resolve(Response.json([]));
    if (url.pathname === '/sessions') return Promise.resolve(Response.json([]));
    throw new Error(`Unexpected fake URL ${url.pathname}`);
  };
}

async function command(home: string, failGithub = false, args: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main({
    args,
    env: { BOARD_HOME: home },
    home,
    writeOut: (line) => out.push(line),
    writeErr: (line) => err.push(line),
    fetch: fakeFetch(failGithub),
  });
  return { code, out: out.join(''), err: err.join('') };
}

describe('smoke command', () => {
  it('loads the normal config and secrets and reports configured source results', async () => {
    const result = await command(makeHome({ secrets: 'GITHUB_TOKEN=synthetic-secret\n' }));
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).toContain('"source":"github-issues:board:example-org/board"');
    expect(result.out).toContain('"source":"github:board:example-org/board"');
    expect(result.out).toContain('"source":"spur"');
    expect(result.out).not.toContain('synthetic-secret');
  });

  it('exits nonzero and names a failed source', async () => {
    const result = await command(makeHome({ secrets: 'GITHUB_TOKEN=wrong-token\n' }), true);
    expect(result.code).toBe(1);
    expect(result.err).toContain('github:board:example-org/board:');
    expect(result.err).not.toContain('wrong-token');
  });

  it('reports missing config and refuses loose secrets permissions before polling', async () => {
    const missing = await command(makeHome({ config: null }));
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('config file not found');
    const home = makeHome({ secrets: 'GITHUB_TOKEN=synthetic-secret\n' });
    chmodSync(join(home, 'secrets.env'), 0o644);
    const loose = await command(home);
    expect(loose.code).toBe(1);
    expect(loose.err).toContain('chmod 600');
    expect(loose.err).not.toContain('synthetic-secret');
  });

  it('accepts a tracker probe with a colon-bearing source id and reports its outcome', async () => {
    const result = await command(makeHome({ secrets: 'GITHUB_TOKEN=synthetic-secret\n' }), false, [
      '--ticket=github-issues:board:example-org/board::example-org/board#9',
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toContain('"status":"not_found"');
    expect(result.out).toContain('"effectiveComplete":false');
  });
});
