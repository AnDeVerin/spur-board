import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installSkills } from '../src/skills.ts';

const temporaryDirectories: string[] = [];
const agents = ['.claude', '.codex'] as const;
const names = ['spur-board', 'spur-board-setup'] as const;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function fixture(): Promise<{ root: string; home: string; packageRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'board-skills-'));
  temporaryDirectories.push(root);
  const home = join(root, 'home');
  const packageRoot = join(root, 'package');
  await mkdir(home);
  await mkdir(join(packageRoot, 'skills', 'spur-board'), { recursive: true });
  await mkdir(join(packageRoot, 'skills', 'setup'), { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  await writeFile(join(packageRoot, 'skills', 'spur-board', 'SKILL.md'), 'Board skill\n');
  await writeFile(join(packageRoot, 'skills', 'setup', 'SKILL.md'), 'Setup skill\n');
  return { root, home, packageRoot };
}

function destination(home: string, agent: (typeof agents)[number], name: (typeof names)[number]) {
  return join(home, agent, 'skills', name);
}

describe('skills install', () => {
  it('installs both package skills with version and time in both user skill folders', async () => {
    const { home, packageRoot } = await fixture();
    const installedAt = '2026-11-04T12:00:00.000Z';
    const results = await installSkills({
      home,
      packageRoot,
      now: () => new Date(installedAt),
    });
    expect(results).toHaveLength(4);
    expect(results.every((result) => result.changed)).toBe(true);
    for (const agent of agents) {
      for (const name of names) {
        const path = destination(home, agent, name);
        expect((await readdir(path)).sort()).toEqual(['.spur-board-install.json', 'SKILL.md']);
        expect(JSON.parse(await readFile(join(path, '.spur-board-install.json'), 'utf8'))).toEqual({
          version: '1.2.3',
          installedAt,
        });
        expect(await readFile(join(path, 'SKILL.md'), 'utf8')).toBe(
          name === 'spur-board' ? 'Board skill\n' : 'Setup skill\n',
        );
      }
    }
  });

  it('leaves current installations byte-for-byte unchanged on a second run', async () => {
    const { home, packageRoot } = await fixture();
    await installSkills({ home, packageRoot, now: () => new Date('2026-11-04T12:00:00.000Z') });
    const path = destination(home, '.claude', 'spur-board');
    await writeFile(join(path, 'operator-note.txt'), 'keep this file\n');
    const stamp = await readFile(join(path, '.spur-board-install.json'), 'utf8');

    const results = await installSkills({
      home,
      packageRoot,
      now: () => new Date('2026-11-05T12:00:00.000Z'),
    });
    expect(results.every((result) => !result.changed)).toBe(true);
    expect((await readdir(path)).sort()).toEqual([
      '.spur-board-install.json',
      'SKILL.md',
      'operator-note.txt',
    ]);
    expect(await readFile(join(path, '.spur-board-install.json'), 'utf8')).toBe(stamp);
    expect(await readFile(join(path, 'operator-note.txt'), 'utf8')).toBe('keep this file\n');
  });

  it('replaces old, unstamped and invalid copies while preserving current copies', async () => {
    const { home, packageRoot } = await fixture();
    await installSkills({ home, packageRoot, now: () => new Date('2026-11-04T12:00:00.000Z') });
    const old = destination(home, '.claude', 'spur-board');
    const unstamped = destination(home, '.codex', 'spur-board-setup');
    const invalid = destination(home, '.claude', 'spur-board-setup');
    await writeFile(
      join(old, '.spur-board-install.json'),
      JSON.stringify({ version: '0.9.0', installedAt: '2026-11-01T12:00:00.000Z' }),
    );
    await writeFile(join(old, 'stale.txt'), 'stale');
    await rm(join(unstamped, '.spur-board-install.json'));
    await writeFile(join(unstamped, 'stale.txt'), 'stale');
    await writeFile(join(invalid, '.spur-board-install.json'), 'invalid JSON');
    await writeFile(join(invalid, 'stale.txt'), 'stale');
    const current = destination(home, '.codex', 'spur-board');
    const currentStamp = await readFile(join(current, '.spur-board-install.json'), 'utf8');

    const results = await installSkills({
      home,
      packageRoot,
      now: () => new Date('2026-11-05T12:00:00.000Z'),
    });
    expect(results.filter((result) => result.changed)).toEqual([
      { agent: 'claude', skill: 'spur-board', changed: true },
      { agent: 'claude', skill: 'spur-board-setup', changed: true },
      { agent: 'codex', skill: 'spur-board-setup', changed: true },
    ]);
    for (const path of [old, unstamped, invalid]) {
      expect((await readdir(path)).sort()).toEqual(['.spur-board-install.json', 'SKILL.md']);
    }
    expect(await readFile(join(current, '.spur-board-install.json'), 'utf8')).toBe(currentStamp);
  });

  it('does not replace any installed skill when a bundled source is missing', async () => {
    const { home, packageRoot } = await fixture();
    await installSkills({ home, packageRoot });
    const installed = destination(home, '.claude', 'spur-board');
    await writeFile(join(installed, 'keep.txt'), 'keep');
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ version: '2.0.0' }));
    await rm(join(packageRoot, 'skills', 'setup'), { recursive: true });

    await expect(installSkills({ home, packageRoot })).rejects.toThrow(
      'Bundled skill is missing or invalid',
    );
    expect(await readFile(join(installed, 'keep.txt'), 'utf8')).toBe('keep');
    expect(
      JSON.parse(await readFile(join(installed, '.spur-board-install.json'), 'utf8')),
    ).toMatchObject({ version: '1.2.3' });
  });
});
