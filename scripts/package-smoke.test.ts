import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  command,
  prepareSkillsForSmoke,
  runSmokeSteps,
  smokeInstalled,
  smokeSteps,
  verifySchema,
  verifyVersion,
} from './package-smoke.ts';

describe('packed smoke steps', () => {
  it('uses the packed product skill and fixtures only setup', () => {
    const root = mkdtempSync(join(tmpdir(), 'board-packed-skills-'));
    try {
      const product = join(root, 'skills/spur-board/SKILL.md');
      const reference = join(root, 'skills/spur-board/references/commands.md');
      mkdirSync(join(root, 'skills/spur-board/references'), { recursive: true });
      writeFileSync(
        product,
        '# Real product skill\n\n- `board status` — [details](references/commands.md#board-status)\n',
      );
      writeFileSync(reference, '# Worker commands\n');
      prepareSkillsForSmoke(root);
      expect(readFileSync(reference, 'utf8')).toBe('# Worker commands\n');
      expect(readFileSync(join(root, 'skills/setup/SKILL.md'), 'utf8')).toBe(
        '# Packed smoke fixture\n',
      );
      prepareSkillsForSmoke(root);
      expect(existsSync(product)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to replace a missing packed product skill with a fixture', () => {
    const root = mkdtempSync(join(tmpdir(), 'board-packed-skills-'));
    try {
      expect(() => {
        prepareSkillsForSmoke(root);
      }).toThrow('Packed product skill spur-board is missing.');
      expect(existsSync(join(root, 'skills/setup/SKILL.md'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a packed skill with a missing command page', () => {
    const root = mkdtempSync(join(tmpdir(), 'board-packed-skills-'));
    try {
      const product = join(root, 'skills/spur-board/SKILL.md');
      mkdirSync(join(root, 'skills/spur-board'), { recursive: true });
      writeFileSync(product, '- `board status` — [details](references/commands.md#board-status)\n');
      expect(() => {
        prepareSkillsForSmoke(root);
      }).toThrow('missing references/commands.md');
      expect(existsSync(join(root, 'skills/setup/SKILL.md'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the staged checks in one ordered list', () => {
    expect(smokeSteps.map((step) => step.name)).toEqual([
      'version',
      'daemon',
      'schema',
      'status',
      'mcp',
      'service unit',
      'skills install',
    ]);
    expect(smokeSteps.filter((step) => step.baseline).map((step) => step.name)).toEqual([
      'version',
      'daemon',
      'schema',
      'mcp',
    ]);
  });

  it('fails for a broken daemon or schema step', async () => {
    const context = { binary: '', expectedVersion: '', env: {}, home: '', packageRoot: '' };
    await expect(
      runSmokeSteps(context, [
        { name: 'daemon', run: () => Promise.reject(new Error('daemon failed')) },
      ]),
    ).rejects.toThrow('daemon failed');
    expect(() => {
      verifySchema({ code: 1, stdout: '', stderr: 'schema failed' });
    }).toThrow('schema failed');
    expect(() => {
      verifySchema({ code: 0, stdout: '{}', stderr: '' });
    }).toThrow('invalid catalog');
  });

  it('compares the packed binary version with its manifest', () => {
    expect(() => {
      verifyVersion({ code: 0, stdout: '0.0.0\n', stderr: '' }, '0.1.0');
    }).toThrow();
    expect(() => {
      verifyVersion({ code: 0, stdout: '0.1.0\n', stderr: '' }, '0.1.0');
    }).not.toThrow();
  });

  it('terminates a hung packed command before smoke can continue', async () => {
    const started = performance.now();
    await expect(
      command(
        process.execPath,
        ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
        {},
        50,
      ),
    ).rejects.toThrow('timed out');
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it('closes the fake API when the installed binary is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'board-missing-bin-'));
    try {
      await expect(
        smokeInstalled(join(root, 'missing-board'), join(root, 'home'), '0.1.0'),
      ).rejects.toThrow('ENOENT');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
