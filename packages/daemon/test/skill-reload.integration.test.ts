import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
const named = (names: string) =>
  `spur-board skill updated to 1.2.3. Before your next board command, read these files of the spur-board skill again: ${names}. They are under ~/.claude/skills/spur-board/ (Claude Code) or $CODEX_HOME/skills/spur-board/, by default ~/.codex/skills/spur-board/ (Codex).`;
const INSTALLED = '2026-11-04T08:00:30.000Z';
const notAsked = 'Running sessions were not asked to re-read the spur-board skill';
const REFERENCE_RULE = 'Rule only in references/errors.md\n';

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
  await mkdir(join(packageRoot, 'skills', 'spur-board', 'references'), { recursive: true });
  await mkdir(join(packageRoot, 'skills', 'setup'), { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  await writeFile(join(packageRoot, 'skills', 'spur-board', 'SKILL.md'), 'Board skill\n');
  await writeFile(
    join(packageRoot, 'skills', 'spur-board', 'references', 'errors.md'),
    REFERENCE_RULE,
  );
  await writeFile(join(packageRoot, 'skills', 'setup', 'SKILL.md'), 'Setup skill\n');
  return { home, packageRoot };
}

async function skillsInstall(h: Harness, home: string, packageRoot: string, now = INSTALLED) {
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
    setup: { home, packageRoot, now: () => new Date(now) },
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

  h.advance(60_000);
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
  expect(reloads().every((send) => send.text === named('SKILL.md, references/errors.md'))).toBe(
    true,
  );
  expect(reloads().every((send) => send.text.includes('references/'))).toBe(true);
  for (const agent of ['.claude', '.codex'])
    expect(
      await readFile(join(home, agent, 'skills', 'spur-board', 'references', 'errors.md'), 'utf8'),
    ).toBe(REFERENCE_RULE);

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

async function pulses(h: Harness): Promise<void> {
  for (let tick = 0; tick < 3; tick += 1) {
    h.advance(1_001);
    await h.pulse();
  }
}

it('names only the reference an update changed and nothing after a version-only update', async () => {
  const h = await createE2eHarness({ productVersion: '1.2.3' });
  active.push(h);
  await h.start();
  await insertSession(h, 'worker-unlinked', 'worker', false);
  const { home, packageRoot } = await packageFixture();
  const reloads = () => h.sends.filter((send) => send.text.includes('skill updated'));
  const setVersion = (version: string) =>
    writeFile(join(packageRoot, 'package.json'), JSON.stringify({ version }));

  await setVersion('1.2.2');
  const old = await skillsInstall(h, home, packageRoot, '2026-11-03T00:00:00.000Z');
  expect(old.code).toBe(0);
  expect(old.stderr).toContain(notAsked);
  await pulses(h);
  expect(reloads()).toEqual([]);

  await setVersion('1.2.3');
  await writeFile(
    join(packageRoot, 'skills', 'spur-board', 'references', 'errors.md'),
    'A new rule in references/errors.md\n',
  );
  h.advance(60_000);
  const update = await skillsInstall(h, home, packageRoot);
  expect(update.code).toBe(0);
  expect(update.stderr).toBe('Asked 2 running session(s) to re-read the spur-board skill.\n');
  await pulses(h);
  expect(reloads().toSorted((a, b) => a.session.localeCompare(b.session))).toEqual(
    [
      { session: 'worker-unlinked', text: named('references/errors.md') },
      { session: h.session, text: named('references/errors.md') },
    ].toSorted((a, b) => a.session.localeCompare(b.session)),
  );

  h.advance(60_000);
  await setVersion('1.2.4');
  const bump = await skillsInstall(h, home, packageRoot, '2026-11-04T08:03:00.000Z');
  expect(bump.code).toBe(0);
  expect(bump.stderr).toContain(notAsked);
  await pulses(h);
  expect(reloads()).toHaveLength(2);
  const stamp = JSON.parse(
    await readFile(
      join(home, '.claude', 'skills', 'spur-board', '.spur-board-install.json'),
      'utf8',
    ),
  ) as { files: Record<string, { changedAt: string; changedIn: string }> };
  expect(stamp.files['references/errors.md']).toMatchObject({
    changedAt: INSTALLED,
    changedIn: '1.2.3',
  });
  const delivered = await h.store.db
    .selectFrom('outbox')
    .select(['payload', 'state'])
    .where('dedupe_key', 'like', 'doorbell:skill-reload:1.2.3:%')
    .execute();
  expect(delivered).toHaveLength(2);
  for (const row of delivered) {
    expect(row.state).toBe('done');
    const { queuedAt } = JSON.parse(row.payload) as { queuedAt: string };
    expect(Date.parse(queuedAt)).toBeGreaterThan(Date.parse(INSTALLED));
  }
});
