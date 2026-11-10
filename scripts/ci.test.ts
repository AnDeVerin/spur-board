import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyChanges, decideCiOk, jobIdsFromWorkflow, secretsLogOpts } from './ci.ts';

const JOB_IDS = [
  'changes',
  'pr-title',
  'guardrails',
  'secrets',
  'workflows',
  'quality',
  'test',
  'package-smoke',
];

function allSuccess(): Record<string, { result: string; outputs?: Record<string, string> }> {
  return {
    changes: { result: 'success', outputs: { github: 'true', package: 'true' } },
    'pr-title': { result: 'success' },
    guardrails: { result: 'success' },
    secrets: { result: 'success' },
    workflows: { result: 'success' },
    quality: { result: 'success' },
    test: { result: 'success' },
    'package-smoke': { result: 'success' },
  };
}

function decide(
  overrides: Record<string, { result: string; outputs?: Record<string, string> }>,
  event = 'pull_request',
) {
  return decideCiOk({ needs: { ...allSuccess(), ...overrides }, event, jobIds: JOB_IDS });
}

const docsChange = { changes: { result: 'success', outputs: { github: 'false' } } };

describe('decideCiOk', () => {
  it('passes when every job succeeded', () => {
    const verdict = decide({});
    expect(verdict.ok).toBe(true);
    expect(verdict.lines).toContain('ci-ok: test success ok');
    expect(verdict.lines.at(-1)).toBe('ci-ok: PASS');
  });

  it('fails on a failed test job', () => {
    const verdict = decide({ test: { result: 'failure' } });
    expect(verdict.ok).toBe(false);
    expect(verdict.lines).toContain('ci-ok: test failure FAIL');
    expect(verdict.lines.at(-1)).toBe('ci-ok: FAIL');
  });

  it.each(JOB_IDS)('fails when %s was cancelled', (id) => {
    expect(decide({ [id]: { result: 'cancelled' } }).ok).toBe(false);
  });

  it('fails when changes was cancelled and workflows skipped', () => {
    expect(decide({ changes: { result: 'cancelled' }, workflows: { result: 'skipped' } }).ok).toBe(
      false,
    );
  });

  it('fails on an unknown result', () => {
    expect(decide({ secrets: { result: 'neutral' } }).ok).toBe(false);
  });

  it('fails on a missing result', () => {
    expect(
      decideCiOk({ needs: { ...allSuccess(), secrets: {} }, event: 'push', jobIds: JOB_IDS }).ok,
    ).toBe(false);
  });

  it('fails when a ci.yml job is missing from needs', () => {
    const needs: Record<string, { result: string }> = allSuccess();
    Reflect.deleteProperty(needs, 'secrets');
    const verdict = decideCiOk({ needs, event: 'pull_request', jobIds: JOB_IDS });
    expect(verdict.ok).toBe(false);
    expect(verdict.lines).toContain('ci-ok: secrets missing from needs FAIL');
  });

  it('fails without any job ids', () => {
    expect(decideCiOk({ needs: allSuccess(), event: 'push', jobIds: [] }).ok).toBe(false);
  });

  it('passes a docs-only change with workflows skipped', () => {
    expect(decide({ ...docsChange, workflows: { result: 'skipped' } }).ok).toBe(true);
  });

  it('fails when workflows is skipped although .github changed', () => {
    expect(decide({ workflows: { result: 'skipped' } }).ok).toBe(false);
  });

  it('fails when workflows is skipped and changes has no outputs', () => {
    expect(decide({ changes: { result: 'success' }, workflows: { result: 'skipped' } }).ok).toBe(
      false,
    );
  });

  it.each(['quality', 'test', 'secrets', 'changes'])('fails when %s is skipped', (id) => {
    expect(decide({ ...docsChange, [id]: { result: 'skipped' } }).ok).toBe(false);
  });

  it.each(['pr-title', 'guardrails'])('accepts a skipped %s only outside pull requests', (id) => {
    expect(decide({ [id]: { result: 'skipped' } }, 'pull_request').ok).toBe(false);
    expect(decide({ [id]: { result: 'skipped' } }, 'push').ok).toBe(true);
    expect(decide({ [id]: { result: 'skipped' } }, 'workflow_dispatch').ok).toBe(true);
  });

  it('accepts a skipped package smoke only for a package-unaffected pull request', () => {
    const changes = { result: 'success', outputs: { github: 'false', package: 'false' } };
    expect(decide({ changes, 'package-smoke': { result: 'skipped' } }).ok).toBe(true);
    expect(decide({ changes, 'package-smoke': { result: 'skipped' } }, 'push').ok).toBe(false);
    expect(
      decide({ changes, 'package-smoke': { result: 'skipped' } }, 'workflow_dispatch').ok,
    ).toBe(false);
    expect(decide({ 'package-smoke': { result: 'skipped' } }).ok).toBe(false);
    expect(
      decide({ changes: { result: 'failure' }, 'package-smoke': { result: 'skipped' } }).ok,
    ).toBe(false);
  });
});

describe('jobIdsFromWorkflow', () => {
  it('reads the job ids under jobs:', () => {
    const text = [
      'name: ci',
      'on:',
      '  push:',
      'jobs:',
      '  a:',
      '    steps:',
      '      - run: x',
      '  b-c:',
      '    needs: a',
      'env:',
      '  d:',
    ].join('\n');
    expect(jobIdsFromWorkflow(text)).toEqual(['a', 'b-c']);
  });

  it('reads every job of ci.yml, so ci-ok needs them all', () => {
    const text = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    expect(jobIdsFromWorkflow(text)).toEqual([...JOB_IDS, 'ci-ok', 'release']);
  });

  it('gates release on a successful main push after both package smoke legs', () => {
    const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const releaseCondition = workflow.match(/^  release:\n    needs: ci-ok\n    if: (.+)$/m)?.[1];
    expect(releaseCondition).toBe(
      "${{ !cancelled() && github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.ci-ok.result == 'success' }}",
    );
    expect(workflow).toContain(
      'needs: [changes, pr-title, guardrails, secrets, workflows, quality, test, package-smoke]',
    );
    expect(workflow).toMatch(/package-smoke:\n[\s\S]*?node: \[24, 26\]/);
    expect(workflow).toContain('id-token: write');
    expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|npm-token:/);
  });
});

describe('classifyChanges', () => {
  it('reports a docs-only change', () => {
    expect(classifyChanges(['README.md', 'docs/a.md'])).toEqual({
      github: false,
      package: false,
      code: false,
      docsOnly: true,
    });
  });

  it('reports a workflow change', () => {
    expect(classifyChanges(['.github/workflows/ci.yml'])).toEqual({
      github: true,
      package: true,
      code: true,
      docsOnly: false,
    });
  });

  it('reports a code change mixed with docs', () => {
    expect(classifyChanges(['LICENSE', 'scripts/ci.ts'])).toEqual({
      github: false,
      package: false,
      code: true,
      docsOnly: false,
    });
  });

  it('reports nothing for an empty change set', () => {
    expect(classifyChanges([])).toEqual({
      github: false,
      package: false,
      code: false,
      docsOnly: false,
    });
  });

  it('classifies package inputs but not unrelated tooling', () => {
    expect(classifyChanges(['packages/cli/src/bin.mjs']).package).toBe(true);
    expect(classifyChanges(['scripts/package-smoke.ts']).package).toBe(true);
    expect(classifyChanges(['scripts/update-smoke.ts']).package).toBe(true);
    expect(classifyChanges(['pnpm-lock.yaml']).package).toBe(true);
    expect(classifyChanges(['scripts/ci.ts']).package).toBe(false);
  });
});

describe('secretsLogOpts', () => {
  const before = 'a'.repeat(40);
  const after = 'b'.repeat(40);
  const full = '--full-history --all';

  it('scans the net change of a pull request', () => {
    expect(secretsLogOpts({ event: 'pull_request', beforeExists: false })).toBe(
      '--first-parent -m HEAD^1..HEAD',
    );
  });

  it('scans the pushed range', () => {
    expect(secretsLogOpts({ event: 'push', before, after, beforeExists: true })).toBe(
      `${before}..${after}`,
    );
  });

  it.each([
    ['an all-zero before', { before: '0'.repeat(40), beforeExists: true }],
    ['a before missing from the clone', { before, beforeExists: false }],
    ['a malformed before', { before: 'abc', beforeExists: true }],
    ['an empty before', { before: '', beforeExists: true }],
    ['an absent before', { before: undefined, beforeExists: true }],
    ['a malformed after', { before, after: 'HEAD', beforeExists: true }],
  ])('scans full history on a push with %s', (_name, input) => {
    expect(secretsLogOpts({ event: 'push', after, ...input })).toBe(full);
  });

  it.each(['workflow_dispatch', 'schedule', ''])('scans full history on event "%s"', (event) => {
    expect(secretsLogOpts({ event, before, after, beforeExists: true })).toBe(full);
  });
});

describe('ci.ts CLI', () => {
  const script = fileURLToPath(new URL('ci.ts', import.meta.url));

  function sandbox() {
    const dir = mkdtempSync(join(tmpdir(), 'ci-cli-'));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GITHUB_OUTPUT: join(dir, 'output'),
    };
    for (const name of ['GITHUB_EVENT_NAME', 'GITHUB_EVENT_PATH', 'NEEDS']) {
      Reflect.deleteProperty(env, name);
    }
    writeFileSync(join(dir, 'output'), '');
    const git = (cwd: string, ...args: string[]) => {
      const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
      return result.stdout.trim();
    };
    const repo = join(dir, 'repo');
    git(dir, 'init', '-q', '-b', 'main', repo);
    const commit = (file: string, message: string) => {
      writeFileSync(join(repo, file), `${message}\n`);
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', message);
      return git(repo, 'rev-parse', 'HEAD');
    };
    const run = (cwd: string, extra: NodeJS.ProcessEnv, ...args: string[]) => {
      const result = spawnSync(process.execPath, [script, ...args], {
        cwd,
        env: { ...env, ...extra },
        encoding: 'utf8',
      });
      return { status: result.status, output: readFileSync(join(dir, 'output'), 'utf8') };
    };
    return { dir, repo, git, commit, run };
  }

  function prMergeRef() {
    const box = sandbox();
    box.commit('a.txt', 'base');
    box.git(box.repo, 'checkout', '-q', '-b', 'topic');
    box.commit('README.md', 'docs one');
    box.commit('docs.md', 'docs two');
    box.git(box.repo, 'checkout', '-q', 'main');
    box.git(box.repo, 'merge', '-q', '--no-ff', 'topic', '-m', 'merge');
    return box;
  }

  it('secrets-range gives the net-diff range on a pull request merge ref', () => {
    const box = prMergeRef();
    const result = box.run(box.repo, { GITHUB_EVENT_NAME: 'pull_request' }, 'secrets-range');
    expect(result).toEqual({ status: 0, output: 'log-opts=--first-parent -m HEAD^1..HEAD\n' });
  });

  it('secrets-range fails closed on a pull request in a depth-1 clone', () => {
    const box = prMergeRef();
    const clone = join(box.dir, 'shallow');
    box.git(box.dir, 'clone', '-q', '--depth', '1', `file://${box.repo}`, clone);
    const result = box.run(clone, { GITHUB_EVENT_NAME: 'pull_request' }, 'secrets-range');
    expect(result).toEqual({ status: 1, output: '' });
  });

  it('secrets-range scans the pushed range', () => {
    const box = sandbox();
    const before = box.commit('a.txt', 'one');
    const after = box.commit('b.txt', 'two');
    const event = join(box.dir, 'event.json');
    writeFileSync(event, JSON.stringify({ before, after }));
    const result = box.run(
      box.repo,
      { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: event },
      'secrets-range',
    );
    expect(result).toEqual({ status: 0, output: `log-opts=${before}..${after}\n` });
  });

  it('secrets-range falls back to full history when the pushed range is empty', () => {
    const box = sandbox();
    box.commit('a.txt', 'one');
    const head = box.commit('b.txt', 'two');
    const event = join(box.dir, 'event.json');
    writeFileSync(event, JSON.stringify({ before: head, after: head }));
    const result = box.run(
      box.repo,
      { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: event },
      'secrets-range',
    );
    expect(result).toEqual({ status: 0, output: 'log-opts=--full-history --all\n' });
  });

  it('secrets-range scans full history on a push with an unknown before', () => {
    const box = sandbox();
    const after = box.commit('a.txt', 'one');
    const event = join(box.dir, 'event.json');
    writeFileSync(event, JSON.stringify({ before: 'c'.repeat(40), after }));
    const result = box.run(
      box.repo,
      { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: event },
      'secrets-range',
    );
    expect(result).toEqual({ status: 0, output: 'log-opts=--full-history --all\n' });
  });

  it('changes classifies the pull request diff', () => {
    const box = prMergeRef();
    const result = box.run(box.repo, { GITHUB_EVENT_NAME: 'pull_request' }, 'changes');
    expect(result).toEqual({
      status: 0,
      output: 'github=false\npackage=false\ndocs_only=true\ncode=false\n',
    });
  });

  it('changes reports everything without a base', () => {
    const box = prMergeRef();
    const result = box.run(box.repo, { GITHUB_EVENT_NAME: 'push' }, 'changes');
    expect(result).toEqual({
      status: 0,
      output: 'github=true\npackage=true\ndocs_only=true\ncode=true\n',
    });
  });

  it('changes fails closed when the base is missing', () => {
    const box = prMergeRef();
    const clone = join(box.dir, 'shallow');
    box.git(box.dir, 'clone', '-q', '--depth', '1', `file://${box.repo}`, clone);
    const result = box.run(clone, { GITHUB_EVENT_NAME: 'pull_request' }, 'changes');
    expect(result).toEqual({ status: 1, output: '' });
  });

  it('ok fails on invalid NEEDS JSON', () => {
    const box = sandbox();
    expect(box.run(box.dir, { NEEDS: '{not json' }, 'ok').status).toBe(1);
  });

  it('ok passes when every ci.yml job succeeded', () => {
    const box = sandbox();
    const needs = JSON.stringify(allSuccess());
    expect(box.run(box.dir, { NEEDS: needs, GITHUB_EVENT_NAME: 'push' }, 'ok').status).toBe(0);
  });
});
