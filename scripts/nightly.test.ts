import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { jobIdsFromWorkflow } from './ci.ts';
import { closeNightlyIssue, decideNightly, reportNightlyFailure } from './nightly.ts';

type Call = { path: string; method: string; body?: unknown };

/** A fake GitHub API that lists `open` issues and records every call. */
function fakeGithub(open: Array<{ number: number; title: string; pull_request?: unknown }>) {
  const calls: Call[] = [];
  const fetcher: typeof fetch = (url, init) => {
    const path = new URL(url instanceof Request ? url.url : url).pathname;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ path, method, body });
    if (path.endsWith('/issues') && method === 'GET') return Promise.resolve(Response.json(open));
    return Promise.resolve(Response.json({}));
  };
  return { calls, fetcher };
}

const DEFAULT_TITLE = 'Nightly published package smoke failed';

describe('nightly issue reporting', () => {
  it('creates one labeled issue, then comments on it for a second failure', async () => {
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    let issueCreated = false;
    const fetcher: typeof fetch = (url, init) => {
      const path = new URL(url instanceof Request ? url.url : url).pathname;
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ path, method, body });
      if (path.endsWith('/issues') && method === 'GET') {
        return Promise.resolve(
          Response.json(
            issueCreated ? [{ number: 7, title: 'Nightly published package smoke failed' }] : [],
          ),
        );
      }
      if (path.endsWith('/labels/ci-nightly'))
        return Promise.resolve(new Response(null, { status: 404 }));
      if (path.endsWith('/issues') && method === 'POST') issueCreated = true;
      return Promise.resolve(Response.json({}));
    };
    const base = { repository: 'owner/repo', token: 'test-token', fetcher };
    expect(await reportNightlyFailure({ ...base, runUrl: 'https://example.test/first' })).toBe(
      'created',
    );
    expect(await reportNightlyFailure({ ...base, runUrl: 'https://example.test/second' })).toBe(
      'updated',
    );
    expect(
      calls.filter((call) => call.method === 'POST' && call.path.endsWith('/issues')),
    ).toHaveLength(1);
    expect(
      calls.filter((call) => call.method === 'POST' && call.path.endsWith('/comments')),
    ).toHaveLength(1);
    expect(calls.find((call) => call.path.endsWith('/comments'))?.body).toEqual({
      body: 'The published package failed its nightly install smoke.\n\nRun: https://example.test/second',
    });
  });

  it('fails closed when the API cannot list existing issues', async () => {
    const fetcher: typeof fetch = () => Promise.resolve(new Response(null, { status: 500 }));
    await expect(
      reportNightlyFailure({
        repository: 'owner/repo',
        token: 'test-token',
        runUrl: 'https://example.test/run',
        fetcher,
      }),
    ).rejects.toThrow('GitHub API GET');
  });

  it('creates a separate issue for a custom title and leaves the default-title issue alone', async () => {
    const { calls, fetcher } = fakeGithub([{ number: 7, title: DEFAULT_TITLE }]);
    expect(
      await reportNightlyFailure({
        repository: 'owner/repo',
        token: 'test-token',
        runUrl: 'https://example.test/run',
        title: 'Nightly tests failed',
        summary: 'The nightly tests failed.',
        fetcher,
      }),
    ).toBe('created');
    expect(calls.some((call) => call.path.includes('/issues/7'))).toBe(false);
    expect(
      calls.find((call) => call.method === 'POST' && call.path.endsWith('/issues'))?.body,
    ).toEqual({
      title: 'Nightly tests failed',
      body: 'The nightly tests failed.\n\nRun: https://example.test/run',
      labels: ['ci-nightly'],
    });
  });

  it('closes only the open issue with its own title after a green run', async () => {
    const { calls, fetcher } = fakeGithub([
      { number: 7, title: DEFAULT_TITLE },
      { number: 8, title: 'Nightly tests failed', pull_request: {} },
      { number: 9, title: 'Nightly tests failed' },
    ]);
    expect(
      await closeNightlyIssue({
        repository: 'owner/repo',
        token: 'test-token',
        runUrl: 'https://example.test/green',
        title: 'Nightly tests failed',
        fetcher,
      }),
    ).toBe('closed');
    expect(calls.filter((call) => call.method === 'POST')).toEqual([
      {
        path: '/repos/owner/repo/issues/9/comments',
        method: 'POST',
        body: { body: 'A green run closed this issue.\n\nRun: https://example.test/green' },
      },
    ]);
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([
      {
        path: '/repos/owner/repo/issues/9',
        method: 'PATCH',
        body: { state: 'closed', state_reason: 'completed' },
      },
    ]);
    expect(calls.some((call) => /\/issues\/[78]\b/.test(call.path))).toBe(false);
  });

  it('only lists issues when a green run has no open issue to close', async () => {
    const { calls, fetcher } = fakeGithub([]);
    expect(
      await closeNightlyIssue({
        repository: 'owner/repo',
        token: 'test-token',
        runUrl: 'https://example.test/green',
        fetcher,
      }),
    ).toBe('none');
    expect(calls.map((call) => call.method)).toEqual(['GET']);
  });
});

describe('decideNightly', () => {
  it.each([
    [{ a: { result: 'success' }, b: { result: 'failure' } }, 'fail'],
    [{ a: { result: 'success' }, b: { result: 'cancelled' } }, 'fail'],
    [{ a: { result: 'skipped' }, b: { result: 'failure' } }, 'fail'],
    [{ a: { result: 'success' }, b: { result: 'success' } }, 'ok'],
    [{ a: { result: 'success' }, b: { result: 'skipped' } }, 'none'],
    [{ a: { result: 'skipped' } }, 'none'],
    [{}, 'none'],
  ] as const)('%j -> %s', (needs, verdict) => {
    expect(decideNightly(needs)).toBe(verdict);
  });
});

describe('nightly.ts CLI', () => {
  const script = fileURLToPath(new URL('nightly.ts', import.meta.url));

  function run(args: string[], extra: Record<string, string> = {}) {
    const stripped = ['GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_TOKEN', 'NEEDS'];
    const inherited = Object.entries(process.env).filter(([key]) => !stripped.includes(key));
    const env = { ...Object.fromEntries(inherited), ...extra };
    return spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' });
  }

  it('exits 1 on an invalid NEEDS', () => {
    const result = run(['needs'], { NEEDS: '{"test": {}}' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('invalid NEEDS');
  });

  it('exits 0 without a change when every job was skipped', () => {
    const result = run(['needs'], {
      NEEDS: JSON.stringify({ test: { result: 'skipped' }, links: { result: 'skipped' } }),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('nightly: no change');
    expect(result.stderr).toBe('');
  });

  it('rejects an unknown mode before reading the environment', () => {
    const result = run(['bogus']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unknown mode "bogus"');
    expect(result.stderr).not.toContain('missing GitHub Actions environment');
  });

  it('exits 2 on a failure report without the GitHub Actions environment', () => {
    const result = run(['fail']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('missing GitHub Actions environment');
  });
});

/** Each job's lines under `jobs:`, keyed by job id. */
function jobBlocks(text: string): Map<string, string> {
  const lines = text.split('\n');
  const ids = jobIdsFromWorkflow(text);
  const starts = ids.map((id) => lines.indexOf(`  ${id}:`));
  return new Map(
    ids.map((id, index) => {
      const end = starts[index + 1] ?? lines.length;
      return [id, lines.slice(starts[index], end).join('\n')];
    }),
  );
}

describe('scheduled workflows', () => {
  const dir = new URL('../.github/workflows/', import.meta.url);
  const workflows = readdirSync(dir)
    .filter((name) => name.endsWith('.yml'))
    .map((name) => ({ name, text: readFileSync(new URL(name, dir), 'utf8') }))
    .filter(({ text }) => text.includes('node scripts/nightly.ts'));

  it('finds the nightly workflows', () => {
    expect(workflows.map(({ name }) => name)).toContain('nightly.yml');
  });

  describe.each(workflows)('$name', ({ text }) => {
    const blocks = jobBlocks(text);

    it('grants no permissions at the top level', () => {
      expect(text).toMatch(/^permissions: \{\}$/m);
    });

    it('pins every action by commit SHA or image digest', () => {
      const uses = [...text.matchAll(/^\s*(?:- )?uses: (\S+)/gm)].map((match) => match[1]);
      expect(uses.length).toBeGreaterThan(0);
      for (const ref of uses) {
        expect(ref).toMatch(/^(?:[^@\s]+@[0-9a-f]{40}|docker:\/\/[^@\s]+@sha256:[0-9a-f]{64})$/);
      }
    });

    it('checks out without persisting credentials', () => {
      const checkouts = text.match(/uses: actions\/checkout@/g) ?? [];
      expect(checkouts.length).toBeGreaterThan(0);
      expect(text.match(/^\s+persist-credentials: false$/gm) ?? []).toHaveLength(checkouts.length);
    });

    it('gives every job a timeout and its own permissions', () => {
      expect(blocks.size).toBeGreaterThan(0);
      for (const block of blocks.values()) {
        expect(block).toMatch(/^ {4}timeout-minutes: \d+$/m);
        expect(block).toMatch(/^ {4}permissions:$/m);
      }
    });

    it('grants issues: write only to the reporting job', () => {
      for (const block of blocks.values()) {
        if (block.includes('issues: write')) expect(block).toContain('node scripts/nightly.ts');
      }
    });

    it('reports after every job, only on the default branch', () => {
      for (const [id, block] of blocks) {
        if (!block.includes('node scripts/nightly.ts needs')) continue;
        const needs = /^ {4}needs: \[(.*)\]$/m
          .exec(block)?.[1]
          ?.split(',')
          .map((n) => n.trim());
        expect(needs?.toSorted()).toEqual([...blocks.keys()].filter((job) => job !== id).sort());
        expect(block).toContain("    if: ${{ !cancelled() && github.ref == 'refs/heads/main' }}");
      }
    });

    it('closes the issue only after a green run on the default branch', () => {
      for (const step of text.split(/\n(?= {6}- )/)) {
        if (!step.includes('node scripts/nightly.ts ok')) continue;
        expect(step).toContain("if: ${{ success() && github.ref == 'refs/heads/main' }}");
      }
    });
  });
});

describe('nightly-tests.yml', () => {
  const text = readFileSync(
    new URL('../.github/workflows/nightly-tests.yml', import.meta.url),
    'utf8',
  );
  const shuffled = text.split('\n').filter((line) => line.includes('--sequence.shuffle'));

  it('shuffles every Vitest project', () => {
    const config = readFileSync(new URL('../vitest.config.ts', import.meta.url), 'utf8');
    const projects = [...config.matchAll(/name: '([\w-]+)'/g)].map((match) => match[1]);
    const named = shuffled.flatMap((line) =>
      [...line.matchAll(/--project ([\w-]+)/g)].map((match) => match[1]),
    );
    expect(projects.length).toBeGreaterThan(0);
    expect([...new Set(named)].sort()).toEqual([...new Set(projects)].sort());
  });

  it('seeds every shuffled run with the run id', () => {
    expect(shuffled.length).toBeGreaterThan(0);
    for (const line of shuffled) expect(line).toContain('--sequence.seed="$SEED"');
    expect(text).toContain('SEED: ${{ github.run_id }}');
  });
});
