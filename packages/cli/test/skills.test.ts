import {
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli, type CliIo } from '../src/cli.ts';
import { installSkills } from '../src/skills.ts';

const temporaryDirectories: string[] = [];
const agents = ['.claude', '.codex'] as const;
const names = ['spur-board', 'spur-board-setup'] as const;

beforeEach(() => {
  vi.stubEnv('CODEX_HOME', '');
  vi.stubEnv('XDG_STATE_HOME', '');
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
  vi.unstubAllEnvs();
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
  it('dispatches through runCli without daemon configuration', async () => {
    const { home, packageRoot } = await fixture();
    const output = { stdout: '', stderr: '' };
    const io: CliIo = {
      isTTY: false,
      stdout: (text) => {
        output.stdout += text;
      },
      stderr: (text) => {
        output.stderr += text;
      },
    };
    expect(
      await runCli(['skills', 'install'], {
        env: {},
        io,
        setup: { home, packageRoot, now: () => new Date('2026-11-04T12:00:00.000Z') },
      }),
    ).toBe(0);
    expect(JSON.parse(output.stdout)).toHaveLength(4);
    expect(output.stderr).toBe('');
    expect(
      await readFile(join(destination(home, '.codex', 'spur-board-setup'), 'SKILL.md'), 'utf8'),
    ).toBe('Setup skill\n');
  });

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
    expect(
      (await stat(join(home, '.local', 'state', 'spur-board', 'skills-install.lock'))).isFile(),
    ).toBe(true);
    expect(await readdir(home)).not.toContain('.spur-board-skills-install.lock');
  });

  it('places the lock under a custom XDG state directory', async () => {
    const { root, home, packageRoot } = await fixture();
    const stateHome = join(root, 'state');

    await installSkills({ home, packageRoot, env: { XDG_STATE_HOME: stateHome } });

    expect((await stat(join(stateHome, 'spur-board', 'skills-install.lock'))).isFile()).toBe(true);
    expect(await readdir(home)).not.toContain('.spur-board-skills-install.lock');
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
    for (const agent of agents) {
      expect((await readdir(join(home, agent, 'skills'))).sort()).toEqual([...names].sort());
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

  it('preserves the working skill when copying into staging fails', async () => {
    const { home, packageRoot } = await fixture();
    await installSkills({ home, packageRoot });
    const installed = destination(home, '.claude', 'spur-board');
    const originalStamp = await readFile(join(installed, '.spur-board-install.json'), 'utf8');
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ version: '2.0.0' }));

    await expect(
      installSkills({
        home,
        packageRoot,
        copySkill: async (_source, staged) => {
          await writeFile(join(staged, 'partial.txt'), 'incomplete');
          throw new Error('copy failed');
        },
      }),
    ).rejects.toThrow('copy failed');

    expect(await readFile(join(installed, 'SKILL.md'), 'utf8')).toBe('Board skill\n');
    expect(await readFile(join(installed, '.spur-board-install.json'), 'utf8')).toBe(originalStamp);
    expect((await readdir(join(home, '.claude', 'skills'))).sort()).toEqual([
      'spur-board',
      'spur-board-setup',
    ]);
  });

  it('installs through symlinked agent and skills parent directories', async () => {
    for (const component of ['.claude', '.codex', 'skills'] as const) {
      const { root, home, packageRoot } = await fixture();
      const outside = join(root, 'outside');
      await mkdir(outside);
      await writeFile(join(outside, 'keep.txt'), 'keep');
      if (component === '.claude' || component === '.codex') {
        await symlink(outside, join(home, component), 'dir');
      } else {
        await mkdir(join(home, '.claude'));
        await symlink(outside, join(home, '.claude', 'skills'), 'dir');
      }

      expect(await installSkills({ home, packageRoot })).toHaveLength(4);
      expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
      const linkedParent = component === 'skills' ? outside : join(outside, 'skills');
      for (const name of names) {
        expect(await readFile(join(linkedParent, name, 'SKILL.md'), 'utf8')).toBe(
          name === 'spur-board' ? 'Board skill\n' : 'Setup skill\n',
        );
      }
    }
  });

  it('rejects a symlinked destination before changing any skill', async () => {
    for (const agent of agents) {
      const { root, home, packageRoot } = await fixture();
      const outside = join(root, 'outside');
      await mkdir(outside);
      await writeFile(join(outside, 'keep.txt'), 'keep');
      await mkdir(join(home, agent, 'skills'), { recursive: true });
      await symlink(outside, destination(home, agent, 'spur-board'), 'dir');

      await expect(installSkills({ home, packageRoot })).rejects.toThrow('symlink');
      expect(await readdir(outside)).toEqual(['keep.txt']);
      for (const other of agents) {
        await expect(readdir(destination(home, other, 'spur-board-setup'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
    }
  });

  it('honors CODEX_HOME through the CLI for existing and absent directories', async () => {
    for (const existing of [false, true]) {
      const { root, home, packageRoot } = await fixture();
      const codexHome = join(root, 'custom-codex');
      if (existing) {
        await mkdir(codexHome);
        await writeFile(join(codexHome, 'keep.txt'), 'keep');
      }
      const output = { stdout: '', stderr: '' };
      const io: CliIo = {
        isTTY: false,
        stdout: (text) => {
          output.stdout += text;
        },
        stderr: (text) => {
          output.stderr += text;
        },
      };

      expect(
        await runCli(['skills', 'install'], {
          env: { CODEX_HOME: codexHome },
          io,
          setup: { home, packageRoot },
        }),
      ).toBe(0);
      expect(output.stderr).toBe('');
      for (const name of names) {
        expect(await readFile(join(codexHome, 'skills', name, 'SKILL.md'), 'utf8')).toBe(
          name === 'spur-board' ? 'Board skill\n' : 'Setup skill\n',
        );
      }
      if (existing) expect(await readFile(join(codexHome, 'keep.txt'), 'utf8')).toBe('keep');
      await expect(stat(join(home, '.codex'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('accepts a symlinked home while checking skill directories under its real path', async () => {
    const { root, home, packageRoot } = await fixture();
    const linkedHome = join(root, 'linked-home');
    await symlink(home, linkedHome, 'dir');

    expect(await installSkills({ home: linkedHome, packageRoot })).toHaveLength(4);
    expect(
      await readFile(join(destination(home, '.claude', 'spur-board'), 'SKILL.md'), 'utf8'),
    ).toBe('Board skill\n');
  });

  it('restores only marked backups and preserves unrelated directories', async () => {
    const { home, packageRoot } = await fixture();
    await installSkills({ home, packageRoot });
    const parent = join(home, '.claude', 'skills');
    const installed = destination(home, '.claude', 'spur-board');
    const backup = join(parent, '.spur-board-backup-00000000-0000-4000-8000-000000000001');
    const staged = join(parent, '.spur-board-stage-notes');
    const unrelatedBackup = join(parent, '.spur-board-backup-notes');
    const unrelatedUuidBackup = join(
      parent,
      '.spur-board-backup-00000000-0000-4000-8000-000000000002',
    );
    await mkdir(staged);
    await writeFile(join(staged, 'keep.txt'), 'stage notes');
    await mkdir(unrelatedBackup);
    await writeFile(join(unrelatedBackup, 'keep.txt'), 'backup notes');
    await mkdir(unrelatedUuidBackup);
    await writeFile(join(unrelatedUuidBackup, 'keep.txt'), 'UUID backup notes');
    await writeFile(`${unrelatedUuidBackup}.owner`, 'user content');

    expect((await installSkills({ home, packageRoot })).every((result) => !result.changed)).toBe(
      true,
    );
    const original = await lstat(installed, { bigint: true });
    const identity = `${String(original.dev)}:${String(original.ino)}`;
    await writeFile(
      `${backup}.owner`,
      `spur-board backup 00000000-0000-4000-8000-000000000001 ${identity}\n`,
    );
    await rename(installed, backup);

    const results = await installSkills({ home, packageRoot });
    expect(results.every((result) => !result.changed)).toBe(true);
    expect(await readFile(join(installed, 'SKILL.md'), 'utf8')).toBe('Board skill\n');
    expect(await readFile(join(staged, 'keep.txt'), 'utf8')).toBe('stage notes');
    expect(await readFile(join(unrelatedBackup, 'keep.txt'), 'utf8')).toBe('backup notes');
    expect(await readFile(join(unrelatedUuidBackup, 'keep.txt'), 'utf8')).toBe('UUID backup notes');
    expect(await readFile(`${unrelatedUuidBackup}.owner`, 'utf8')).toBe('user content');
    expect((await readdir(parent)).sort()).toEqual(
      [
        ...names,
        '.spur-board-stage-notes',
        '.spur-board-backup-notes',
        '.spur-board-backup-00000000-0000-4000-8000-000000000002',
        '.spur-board-backup-00000000-0000-4000-8000-000000000002.owner',
      ].sort(),
    );
  });

  it('does not mistake a user backup for a pending owner record', async () => {
    const { home, packageRoot } = await fixture();
    await installSkills({ home, packageRoot });
    const parent = join(home, '.claude', 'skills');
    const installed = destination(home, '.claude', 'spur-board');
    const original = await lstat(installed, { bigint: true });
    const identity = `${String(original.dev)}:${String(original.ino)}`;
    const orphanId = '00000000-0000-4000-8000-000000000003';
    const userId = '00000000-0000-4000-8000-000000000004';
    const orphan = join(parent, `.spur-board-backup-${orphanId}`);
    const userBackup = join(parent, `.spur-board-backup-${userId}`);
    await writeFile(`${orphan}.owner`, `spur-board backup ${orphanId} ${identity}\n`);
    await mkdir(userBackup);
    await writeFile(join(userBackup, 'keep.txt'), 'user content');
    await writeFile(`${userBackup}.owner`, `spur-board backup ${userId} ${identity}\n`);

    expect((await installSkills({ home, packageRoot })).every((result) => !result.changed)).toBe(
      true,
    );
    await expect(readFile(`${orphan}.owner`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(userBackup, 'keep.txt'), 'utf8')).toBe('user content');
    expect(await readFile(join(installed, 'SKILL.md'), 'utf8')).toBe('Board skill\n');
  });

  it('removes only staging directories marked by an interrupted install', async () => {
    const { home, packageRoot } = await fixture();
    await installSkills({ home, packageRoot });
    const parent = join(home, '.claude', 'skills');
    const ownedId = '00000000-0000-4000-8000-000000000001';
    const unownedId = '00000000-0000-4000-8000-000000000002';
    const owned = join(parent, `.spur-board-stage-${ownedId}`);
    const unowned = join(parent, `.spur-board-stage-${unownedId}`);
    await mkdir(owned);
    await writeFile(join(owned, 'partial.txt'), 'incomplete copy');
    await writeFile(`${owned}.owner`, `spur-board stage ${ownedId}\n`);
    await mkdir(unowned);
    await writeFile(join(unowned, 'keep.txt'), 'user content');
    await writeFile(`${unowned}.owner`, 'user content');

    const results = await installSkills({ home, packageRoot });
    expect(results.every((result) => !result.changed)).toBe(true);
    await expect(readdir(owned)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(`${owned}.owner`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(unowned, 'keep.txt'), 'utf8')).toBe('user content');
    expect(await readFile(`${unowned}.owner`, 'utf8')).toBe('user content');
  });

  it('serializes concurrent upgrades so only one copy replaces each skill', async () => {
    const { home, packageRoot } = await fixture();
    await installSkills({ home, packageRoot });
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ version: '2.0.0' }));
    let copies = 0;
    const options = {
      home,
      packageRoot,
      copySkill: async (source: string, staged: string) => {
        copies += 1;
        await cp(source, staged, { recursive: true });
        await new Promise((done) => setTimeout(done, 10));
      },
    };

    const installs = await Promise.all([installSkills(options), installSkills(options)]);
    expect(
      installs.map((results) => results.filter((result) => result.changed).length).sort(),
    ).toEqual([0, 4]);
    expect(copies).toBe(4);
    for (const agent of agents) {
      expect((await readdir(join(home, agent, 'skills'))).sort()).toEqual([...names].sort());
      for (const name of names) {
        expect(
          JSON.parse(
            await readFile(
              join(destination(home, agent, name), '.spur-board-install.json'),
              'utf8',
            ),
          ),
        ).toMatchObject({ version: '2.0.0' });
      }
    }
  });
});
