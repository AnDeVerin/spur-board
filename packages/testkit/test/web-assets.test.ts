import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSteps } from '../../../scripts/check.ts';
import type { Plan } from '../../../scripts/check-plan.ts';

const repository = resolve(import.meta.dirname, '../../..');
function plannedArgs(mode: 'full' | 'changed', prePush: boolean): string[] {
  const plan: Plan = {
    mode,
    reason: 'asset lifecycle fixture',
    formatFiles: [],
    lintFiles: [],
    packageDirs: ['packages/web'],
    agents: false,
  };
  const test = buildSteps(plan, prePush).find((step) => step.name === 'test');
  if (!test || !('commands' in test) || !test.commands[0]) throw new Error('Missing test command');
  return test.commands[0].args;
}
function write(root: string, name: string, content: string): void {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
interface BuildTrace {
  outDir: string;
  home: string;
  hasSecret: boolean;
  hasBus: boolean;
  nodeEnv: string;
}

describe('shared web asset lifecycle', () => {
  it.each([
    { name: 'direct unit, fresh', args: ['run', '--project', 'unit'], stale: false, fails: false },
    {
      name: 'changed check, stale',
      args: plannedArgs('changed', false),
      stale: true,
      fails: false,
    },
    { name: 'full check, fresh', args: plannedArgs('full', false), stale: false, fails: false },
    { name: 'pre-push, stale', args: plannedArgs('changed', true), stale: true, fails: false },
    {
      name: 'CI/mutation multi-project',
      args: [
        'run',
        '--project',
        'unit',
        '--project',
        'integration',
        '--project',
        'process',
        '--project',
        'startup',
        '--project',
        'stand',
      ],
      stale: true,
      fails: false,
    },
    { name: 'failed build, stale', args: ['run', '--project', 'unit'], stale: true, fails: true },
  ])('$name prepares once before workers or fails closed', ({ args, stale, fails }) => {
    const root = mkdtempSync(join(tmpdir(), 'web-assets-lifecycle-'));
    try {
      write(root, 'package.json', '{"type":"module"}');
      cpSync(join(repository, 'vitest.config.ts'), join(root, 'vitest.config.ts'));
      cpSync(join(repository, 'packages/testkit/src'), join(root, 'packages/testkit/src'), {
        recursive: true,
      });
      symlinkSync(join(repository, 'node_modules'), join(root, 'node_modules'), 'dir');
      if (stale) write(root, 'packages/web/dist/index.html', 'stale workspace output');
      const calls = join(root, 'builds.jsonl');
      const workers = join(root, 'workers.log');
      write(
        root,
        'packages/web/node_modules/vite/bin/vite.js',
        `
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const outDir = process.argv[process.argv.indexOf('--outDir') + 1];
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ outDir, home: process.env.HOME, hasSecret: 'BOARD_TOKEN' in process.env, hasBus: 'DBUS_SESSION_BUS_ADDRESS' in process.env, nodeEnv: process.env.NODE_ENV }) + '\\n');
console.log('BUILD_OUTPUT_SENTINEL');
if (process.env.TEST_ASSET_BUILD_FAIL === '1') process.exit(42);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'index.html'), 'fresh test assets');
`,
      );
      const consumer = `
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, inject, it } from 'vitest';
const assets = inject('webAssetsRoot');
expect(readFileSync(join(assets, 'index.html'), 'utf8')).toBe('fresh test assets');
expect(assets).toBe(join(inject('harnessRoot'), 'web'));
expect(process.env.BOARD_TOKEN).toBeUndefined();
expect(process.env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
expect(process.env.NODE_ENV).toBe('test');
appendFileSync(${JSON.stringify(workers)}, 'worker\\n');
it('has fresh assets at worker import', () => expect(readFileSync(join(assets, 'index.html'), 'utf8')).toBe('fresh test assets'));
`;
      for (const file of [
        'packages/web/test/assets.test.ts',
        'packages/web/test/assets.integration.test.ts',
        'packages/daemon/test/main.test.ts',
        'packages/cli/test/startup.test.ts',
        'packages/stand/test/scenarios.integration.test.ts',
      ])
        write(root, file, consumer);
      const result = spawnSync(
        process.execPath,
        [join(repository, 'node_modules/vitest/vitest.mjs'), ...args],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            NODE_ENV: 'test',
            BOARD_TOKEN: 'planted-test-value',
            DBUS_SESSION_BUS_ADDRESS: 'planted-test-bus',
            TEST_ASSET_BUILD_FAIL: fails ? '1' : '0',
            GITHUB_ACTIONS: 'false',
          },
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(fails ? 1 : 0);
      const builds = readFileSync(calls, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as BuildTrace);
      expect(builds).toHaveLength(1);
      const build = builds[0];
      if (!build) throw new Error('No build trace');
      expect(build.hasSecret).toBe(false);
      expect(build.hasBus).toBe(false);
      expect(build.nodeEnv).toBe('production');
      if (!fails) expect(result.stdout).not.toContain('BUILD_OUTPUT_SENTINEL');
      expect(dirname(build.home)).toBe(dirname(build.outDir));
      expect(existsSync(dirname(build.outDir))).toBe(false);
      expect(existsSync(workers)).toBe(!fails);
      if (fails) expect(result.stdout + result.stderr).toContain('Test web asset build failed');
      if (stale)
        expect(readFileSync(join(root, 'packages/web/dist/index.html'), 'utf8')).toBe(
          'stale workspace output',
        );
      else expect(existsSync(join(root, 'packages/web/dist'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
