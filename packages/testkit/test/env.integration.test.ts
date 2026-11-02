import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

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
  // Teardown removed the nested run's temp root.
  expect(readdirSync(nestedTmp).filter((name) => name.startsWith('spur-board-test-'))).toEqual([]);
}, 60_000);
