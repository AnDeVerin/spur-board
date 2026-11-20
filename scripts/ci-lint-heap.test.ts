import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface WorkflowStep {
  run?: string;
  uses?: string;
  env?: Record<string, string>;
}

interface WorkflowJob {
  env?: Record<string, string>;
  steps?: WorkflowStep[];
}

describe('quality lint heap', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const parsed = parse(workflow) as {
    env?: Record<string, string>;
    jobs: Record<string, WorkflowJob>;
  };

  it('raises the Node heap only on the quality step that runs whole-repo lint', () => {
    const lintSteps = Object.entries(parsed.jobs).flatMap(([id, job]) =>
      (job.steps ?? [])
        .filter((step) => /pnpm check:full --only \S*\blint\b/.test(step.run ?? ''))
        .map((step) => ({ id, step })),
    );
    expect(lintSteps.map(({ id }) => id)).toEqual(['quality']);
    const lintStep = lintSteps[0]?.step;
    expect(lintStep?.env).toEqual({ NODE_OPTIONS: '--max-old-space-size=8192' });

    expect(parsed.env?.['NODE_OPTIONS']).toBeUndefined();
    for (const [id, job] of Object.entries(parsed.jobs)) {
      expect(job.env?.['NODE_OPTIONS'], id).toBeUndefined();
      for (const step of job.steps ?? []) {
        if (step === lintStep) continue;
        expect(step.env?.['NODE_OPTIONS'], `${id}: ${step.run ?? step.uses ?? ''}`).toBeUndefined();
      }
    }
  });
});
