import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { currentIdentity, writeOwner } from '../src/sweep.ts';

const root = fileURLToPath(new URL('../../..', import.meta.url));

it('a run started with secrets, proxies and foreign dirs in env passes env.test.ts', () => {
  const work = mkdtempSync(join(tmpdir(), 'nested-'));
  const nestedTmp = join(work, 'tmp');
  mkdirSync(nestedTmp);
  const report = join(work, 'report.json');
  const proxy = 'http://127.0.0.1:9';

  const result = spawnSync(
    process.execPath,
    [
      join(root, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--project',
      'unit',
      'packages/testkit/test/env.test.ts',
      'packages/core/test/support/store.test.ts',
      '--reporter',
      'json',
      '--outputFile',
      report,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        SPUR_SESSION: 'planted',
        BOARD_TOKEN: 'planted',
        SLACK_BOT_TOKEN: 'planted',
        GH_TOKEN: 'planted',
        GITHUB_TOKEN: 'planted',
        JIRA_API_TOKEN: 'planted',
        GBRAIN_DATABASE_URL: 'planted',
        ANTHROPIC_API_KEY: 'planted',
        OPENAI_API_KEY: 'planted',
        SOME_SERVICE_TOKEN: 'planted',
        NODE_USE_ENV_PROXY: '1',
        HTTP_PROXY: proxy,
        http_proxy: proxy,
        HTTPS_PROXY: proxy,
        ALL_PROXY: proxy,
        NO_PROXY: '',
        XDG_CONFIG_HOME: '/nonexistent',
        XDG_DATA_DIRS: '/nonexistent',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/bus',
        NOTIFY_SOCKET: '/nonexistent/notify',
        TMPDIR: nestedTmp,
      },
    },
  );

  expect(result.status, result.stdout + result.stderr).toBe(0);
  const summary = JSON.parse(readFileSync(report, 'utf8')) as {
    numPassedTests: number;
    numFailedTests: number;
  };
  expect(summary.numPassedTests).toBeGreaterThanOrEqual(3);
  expect(summary.numFailedTests).toBe(0);
  // Teardown removed the nested run's temp root, and tests left nothing beside it.
  expect(readdirSync(nestedTmp)).toEqual([]);
}, 60_000);

function write(dir: string, name: string, content: string): void {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

it.skipIf(process.platform !== 'linux')(
  'a run whose workers get another TMPDIR and HOME keeps temp dirs under its root and sweeps dead runs',
  () => {
    const repo = mkdtempSync(join(tmpdir(), 'repin-repo-'));
    try {
      const parent = join(repo, 'parent-tmp');
      const decoy = join(repo, 'decoy-tmp');
      mkdirSync(parent);
      mkdirSync(decoy);
      write(repo, 'package.json', '{"type":"module"}');
      cpSync(join(root, 'vitest.config.ts'), join(repo, 'base.config.ts'));
      write(
        repo,
        'vitest.config.ts',
        `import base from './base.config.ts';
const env = { TMPDIR: ${JSON.stringify(decoy)}, HOME: ${JSON.stringify(decoy)} };
export default { ...base, test: { ...base.test, env } };
`,
      );
      cpSync(join(root, 'packages/testkit/src'), join(repo, 'packages/testkit/src'), {
        recursive: true,
      });
      symlinkSync(join(root, 'node_modules'), join(repo, 'node_modules'), 'dir');
      write(
        repo,
        'packages/web/node_modules/vite/bin/vite.js',
        `import { mkdirSync } from 'node:fs';
mkdirSync(process.argv[process.argv.indexOf('--outDir') + 1], { recursive: true });
`,
      );
      write(
        repo,
        'packages/core/test/leak.test.ts',
        `import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, inject, it } from 'vitest';
it('makes temp dirs under the run root', () => {
  const runRoot = inject('harnessRoot') + '/';
  expect(homedir().startsWith(runRoot), homedir()).toBe(true);
  for (const prefix of ['board-', 'core-', 'web-api-', 'block-', 'daemon-home-']) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    expect(dir.startsWith(runRoot), dir).toBe(true);
  }
});
`,
      );

      // A root whose owner is gone, and one owned by this live worker. Without the full host
      // identity (a container without a machine id, say) the sweep keeps the young dead root.
      const self = currentIdentity();
      const provable = Boolean(self.bootId && self.pidNs && self.machineId);
      const exited = spawnSync(process.execPath, ['-e', '']);
      const dead = join(parent, 'spur-board-test-dead');
      mkdirSync(join(dead, 'tmp'), { recursive: true });
      writeFileSync(
        join(dead, 'owner.json'),
        JSON.stringify({
          pid: exited.pid,
          createdAt: Date.now(),
          startTicks: '1',
          ...currentIdentity(),
        }),
      );
      const live = join(parent, 'spur-board-test-live');
      mkdirSync(join(live, 'tmp'), { recursive: true });
      writeOwner(live);

      const result = spawnSync(
        process.execPath,
        [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--project', 'unit'],
        {
          cwd: repo,
          encoding: 'utf8',
          env: { ...process.env, TMPDIR: parent, GITHUB_ACTIONS: 'false' },
        },
      );

      const output = result.stdout + result.stderr;
      expect(result.status, output).toBe(0);
      const pinned = output.split('\n').find((line) => line.includes('testkit: re-pinned'));
      expect(pinned, output).toMatch(/parent: \d+/);
      // The parent's arguments (here the vitest entry point) never reach the log.
      expect(pinned).not.toContain('vitest.mjs');
      expect(readdirSync(decoy)).toEqual([]);
      expect(readdirSync(parent).sort()).toEqual(
        provable ? ['spur-board-test-live'] : ['spur-board-test-dead', 'spur-board-test-live'],
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  },
  60_000,
);
