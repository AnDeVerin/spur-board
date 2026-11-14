import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../cli/src/cli.ts';
import { createE2eHarness } from './e2e-harness.ts';

type Harness = Awaited<ReturnType<typeof createE2eHarness>>;
const active: Harness[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const harness of active.splice(0)) await harness.dispose();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

const AT = '2026-11-04T08:00:00.000Z';
const TEXT =
  'spur-board skill updated to 1.2.3. Before your next board command, read the spur-board skill file again: ~/.claude/skills/spur-board/SKILL.md (Claude Code) or $CODEX_HOME/skills/spur-board/SKILL.md, by default ~/.codex/skills/spur-board/SKILL.md (Codex).';

async function insertSession(
  h: Harness,
  id: string,
  project: string,
  ended: boolean,
): Promise<void> {
  await h.store.db
    .insertInto('session_snapshot')
    .values({
      id,
      spur_project: project,
      branch: id,
      pr: null,
      raw_state: ended ? 'stopped' : 'running',
      state: ended ? 'stopped' : 'running',
      first_seen: AT,
      last_seen: AT,
      ended_at: ended ? AT : null,
      end_reason: ended ? 'kill' : null,
      detail: '{}',
      source: 'spur',
      observed_at: AT,
    })
    .execute();
}

async function packageFixture(): Promise<{ home: string; packageRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'board-skill-reload-e2e-'));
  directories.push(root);
  const home = join(root, 'home');
  const packageRoot = join(root, 'package');
  await mkdir(home);
  await mkdir(join(packageRoot, 'skills', 'spur-board'), { recursive: true });
  await mkdir(join(packageRoot, 'skills', 'setup'), { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  await writeFile(join(packageRoot, 'skills', 'spur-board', 'SKILL.md'), 'Board skill\n');
  await writeFile(join(packageRoot, 'skills', 'setup', 'SKILL.md'), 'Setup skill\n');
  return { home, packageRoot };
}

async function skillsInstall(h: Harness, home: string, packageRoot: string) {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    isTTY: false,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  };
  const code = await runCli(['skills', 'install'], {
    env: { BOARD_DAEMON_URL: h.address },
    io,
    setup: { home, packageRoot },
  });
  return { code, results: JSON.parse(stdout) as { changed: boolean }[], stderr };
}

it('messages each live session of a configured project once after a skill install', async () => {
  const h = await createE2eHarness({ productVersion: '1.2.3' });
  active.push(h);
  await h.start();
  await insertSession(h, 'worker-unlinked', 'worker', false);
  await insertSession(h, 'worker-ended', 'worker', true);
  await insertSession(h, 'foreign-live', 'foreign', false);
  const { home, packageRoot } = await packageFixture();
  const reloads = () => h.sends.filter((send) => send.text.includes('skill updated'));

  const first = await skillsInstall(h, home, packageRoot);
  expect(first.code).toBe(0);
  expect(first.results.every((entry) => entry.changed)).toBe(true);
  expect(first.stderr).toBe('Asked 2 running session(s) to re-read the spur-board skill.\n');
  for (let tick = 0; tick < 3; tick += 1) {
    h.advance(1_001);
    await h.pulse();
  }
  expect(
    reloads()
      .map((send) => send.session)
      .sort(),
  ).toEqual([h.session, 'worker-unlinked']);
  expect(reloads().every((send) => send.text === TEXT)).toBe(true);

  const second = await skillsInstall(h, home, packageRoot);
  expect(second.code).toBe(0);
  expect(second.results.every((entry) => !entry.changed)).toBe(true);
  expect(second.stderr).toBe('');
  for (let tick = 0; tick < 3; tick += 1) {
    h.advance(1_001);
    await h.pulse();
  }
  expect(reloads()).toHaveLength(2);
});
