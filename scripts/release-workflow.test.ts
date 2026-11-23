import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { parse } from 'yaml';

interface WorkflowStep {
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  'timeout-minutes'?: number;
  if?: string;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  steps?: WorkflowStep[];
}

describe('release workflow isolation', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const jobs = (parse(workflow) as { jobs: Record<string, WorkflowJob> }).jobs;
  const installsUnpinned = /\b(package|upgrade|update):smoke\b|\bnpm (install|i)\b/;
  const runs = (id: string) => (jobs[id]?.steps ?? []).map((step) => step.run ?? '');

  it('allows both upgrade smoke jobs time for npm registry propagation', () => {
    for (const id of ['package-smoke', 'release-smoke']) {
      expect(jobs[id]?.['timeout-minutes'], id).toBe(35);
    }
  });

  it('grants no write scope or token to jobs that install unpinned packages', () => {
    const installing = Object.entries(jobs).filter(([, job]) =>
      (job.steps ?? []).some((step) => installsUnpinned.test(step.run ?? '')),
    );
    expect(installing.map(([id]) => id).sort()).toEqual(['package-smoke', 'release-smoke']);
    for (const [id, job] of installing) {
      expect(job.permissions, id).toEqual({ contents: 'read' });
      const exposed = JSON.stringify([
        job.env ?? {},
        (job.steps ?? []).map((step) => [step.env ?? {}, step.run ?? '']),
      ]);
      expect(exposed, id).not.toMatch(/github\.token|secrets\.|GITHUB_TOKEN/);
    }
    for (const [id, job] of Object.entries(jobs)) {
      if (id !== 'release') expect(job.permissions?.['id-token'], id).toBeUndefined();
    }
    expect(jobs['release']?.permissions?.['id-token']).toBe('write');
    for (const run of runs('release')) {
      expect(run).not.toMatch(/:smoke\b|check:full|\bnpm (install|i)\b/);
    }
  });

  it('smokes package and upgrade once per event and checks the candidate first', () => {
    for (const [id, job] of Object.entries(jobs)) {
      for (const step of job.steps ?? []) {
        if (!/\b(package|upgrade):smoke\b/.test(step.run ?? '')) continue;
        if (id === 'package-smoke') expect(step.if).toBe("github.event_name == 'pull_request'");
        else {
          expect(id).toBe('release-smoke');
          expect(job.if).toBe("github.event_name != 'pull_request'");
        }
      }
    }
    expect(jobs['release-build']?.if).toBe("github.event_name != 'pull_request'");
    const smoke = runs('release-smoke');
    const checked = smoke.findIndex((run) => run.startsWith('sha256sum --check'));
    expect(checked).toBeGreaterThanOrEqual(0);
    expect(checked).toBeLessThan(smoke.findIndex((run) => run.startsWith('pnpm package:smoke')));
    expect(checked).toBeLessThan(smoke.findIndex((run) => run.startsWith('pnpm upgrade:smoke')));
  });

  const releaseSteps = jobs['release']?.steps ?? [];
  const releaseStep = (id: string) => releaseSteps.find((step) => step.id === id);

  it('publishes the candidate release-build reported', () => {
    const publish = releaseStep('semantic-release');
    // Exact env: no GIT_CREDENTIALS or GH_TOKEN on the step; the API token stays github.token.
    expect(publish?.env).toEqual({
      GITHUB_TOKEN: '${{ github.token }}',
      APP_TOKEN: '${{ steps.release-app.outputs.token }}',
      RELEASE_CANDIDATE_VERSION: '${{ needs.release-build.outputs.version }}',
      RELEASE_CANDIDATE_SHA256: '${{ needs.release-build.outputs.sha256 }}',
      RELEASE_CHANGELOG_COMMIT: '${{ vars.RELEASE_CHANGELOG_COMMIT }}',
    });
    expect(publish?.run).toBe(
      [
        'if [ -n "$APP_TOKEN" ]; then export GIT_CREDENTIALS="x-access-token:$APP_TOKEN"; fi',
        'unset APP_TOKEN',
        'pnpm exec semantic-release',
        '',
      ].join('\n'),
    );
  });

  it('mints the release App token only when the changelog commit is on', () => {
    const app = releaseStep('release-app');
    expect(app?.uses).toMatch(/^actions\/create-github-app-token@[0-9a-f]{40}$/);
    expect(app?.if).toBe("vars.RELEASE_CHANGELOG_COMMIT == 'true'");
    expect(app?.with).toEqual({
      'client-id': '${{ vars.RELEASE_APP_CLIENT_ID }}',
      'private-key': '${{ secrets.RELEASE_APP_PRIVATE_KEY }}',
      'permission-contents': 'write',
    });
    const index = (find: (step: WorkflowStep) => boolean) => releaseSteps.findIndex(find);
    const download = index((step) => step.uses?.startsWith('actions/download-artifact@') ?? false);
    const minted = index((step) => step.id === 'release-app');
    const released = index((step) => step.id === 'semantic-release');
    expect(download).toBeGreaterThanOrEqual(0);
    expect(download).toBeLessThan(minted);
    expect(minted).toBeLessThan(released);
    expect(released).toBe(releaseSteps.length - 1);
    const reading = (pattern: RegExp) =>
      releaseSteps.filter((step) => pattern.test(JSON.stringify(step))).map((step) => step.id);
    expect(reading(/steps\.release-app/)).toEqual(['semantic-release']);
    expect(reading(/secrets\./)).toEqual(['release-app']);
    expect(JSON.stringify(jobs['release']?.env ?? {})).not.toMatch(/steps\.release-app|secrets\./);
    for (const [id, job] of Object.entries(jobs)) {
      if (id !== 'release') expect(JSON.stringify(job), id).not.toMatch(/secrets\./);
    }
    for (const step of releaseSteps) {
      expect(step.run ?? '').not.toMatch(/GITHUB_ENV|GITHUB_OUTPUT|\$\{\{/);
    }
  });

  it('exports the App token to semantic-release only when the token step ran', () => {
    const run = releaseStep('semantic-release')?.run ?? '';
    const bin = mkdtempSync(join(tmpdir(), 'release-step-'));
    onTestFinished(() => {
      rmSync(bin, { recursive: true, force: true });
    });
    writeFileSync(
      join(bin, 'pnpm'),
      '#!/bin/sh\necho "$*|${GIT_CREDENTIALS-unset}|${APP_TOKEN-unset}"\nexit "${PNPM_EXIT:-0}"\n',
      { mode: 0o755 },
    );
    // A run step without `shell:` runs as `bash -e {0}`; no workflow sets shell or defaults.
    const step = (env: Record<string, string>) =>
      spawnSync('bash', ['-e', '-c', run], {
        encoding: 'utf8',
        env: { PATH: `${bin}:${process.env['PATH'] ?? ''}`, ...env },
      });
    expect(step({ APP_TOKEN: '' })).toMatchObject({
      status: 0,
      stdout: 'exec semantic-release|unset|unset\n',
    });
    expect(step({ APP_TOKEN: 'tok-123' })).toMatchObject({
      status: 0,
      stdout: 'exec semantic-release|x-access-token:tok-123|unset\n',
    });
    expect(step({ APP_TOKEN: '', PNPM_EXIT: '7' }).status).toBe(7);
  });

  it('builds and smokes the candidate without a dependency cache', () => {
    for (const id of ['release-build', 'release-smoke']) {
      const setupNode = jobs[id]?.steps?.filter((step) =>
        step.uses?.startsWith('actions/setup-node@'),
      );
      expect(setupNode, id).toHaveLength(1);
      expect(setupNode?.[0]?.with?.['cache'], id).toBeUndefined();
    }
  });
});
