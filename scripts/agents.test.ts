import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('agents.ts', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const BEGIN = '<!-- BEGIN GENERATED SKILLS AND ROLES: pnpm agents:sync -->';
const END = '<!-- END GENERATED SKILLS AND ROLES -->';

const skillA = (description = "Do a. Use when b. Don't use for c.", body = '') =>
  [
    '---',
    'name: a',
    `description: ${description}`,
    '---',
    '',
    '# A',
    '',
    "- Run `scripts/foo.ts` (`scripts/foo.test.ts`, `describe('foo')`).",
    body,
  ].join('\n');

const manager = (body = '') =>
  [
    '---',
    'name: manager',
    "description: Route work through roles. Use when you run an issue. Don't use for code (use a).",
    '---',
    '',
    '# Manager',
    '',
    '- Hand off to `developer`, then `reviewer`.',
    '- Run `/a <x>` for the a step.',
    body,
  ].join('\n');

const role = (name: string, description: string, effort: string, body = `Do ${name} work.\n`) =>
  [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    'model: opus',
    `effort: ${effort}`,
    'tools: Read, Edit',
    '---',
    '',
    body,
  ].join('\n');

const BASE: Record<string, string> = {
  '.agents/skills/a/SKILL.md': skillA(),
  '.agents/skills/manager/SKILL.md': manager(),
  '.agents/agents/developer.md': role('developer', 'Build x | y. Use after reviewer.', 'medium'),
  '.agents/agents/reviewer.md': role('reviewer', 'Review the diff. Use after developer.', 'high'),
  'AGENTS.md': ['# Agents', '', '- Read `.agents/skills/a/SKILL.md`.', '', BEGIN, END, ''].join(
    '\n',
  ),
  'scripts/foo.ts': 'export {};\n',
  'scripts/foo.test.ts': "describe('foo', () => {});\n",
};

const TABLE = [
  BEGIN,
  '',
  '<!-- prettier-ignore-start -->',
  '',
  '| Name | Kind | Description |',
  '| --- | --- | --- |',
  '| [a](.agents/skills/a/SKILL.md) | skill | Do a |',
  '| [manager](.agents/skills/manager/SKILL.md) | skill | Route work through roles |',
  '| [developer](.agents/agents/developer.md) | role | Build x \\| y |',
  '| [reviewer](.agents/agents/reviewer.md) | role | Review the diff |',
  '',
  '<!-- prettier-ignore-end -->',
  '',
  END,
].join('\n');

const DEVELOPER_TOML = [
  'name = "developer"',
  'description = "Build x | y. Use after reviewer."',
  'model_reasoning_effort = "medium"',
  'sandbox_mode = "workspace-write"',
  "developer_instructions = '''",
  'Do developer work.',
  "'''",
  '',
].join('\n');

interface Result {
  status: number | null;
  stdout: string;
}

/** A temp git repo holding BASE in the index (no commit); `synced` also runs sync and adds it. */
function fixture(synced = true) {
  const dir = mkdtempSync(join(tmpdir(), 'agents-cli-'));
  const repo = join(dir, 'repo');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout;
  };
  const path = (file: string) => join(repo, file);
  const write = (file: string, text: string) => {
    mkdirSync(dirname(path(file)), { recursive: true });
    writeFileSync(path(file), text);
  };
  const read = (file: string) => readFileSync(path(file), 'utf8');
  const run = (...args: string[]): Result => {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: repo,
      env,
      encoding: 'utf8',
    });
    return { status: result.status, stdout: result.stdout };
  };
  mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  for (const [file, text] of Object.entries(BASE)) write(file, text);
  git('add', '-A');
  if (synced) {
    const sync = run('sync');
    if (sync.status !== 0) throw new Error(`fixture sync failed: ${sync.stdout}`);
    git('add', '-A');
  }
  return { dir, repo, git, path, write, read, run };
}

type Fixture = ReturnType<typeof fixture>;

describe('agents.ts CLI', () => {
  it('passes lint on the synced fixture', () => {
    const fx = fixture();
    expect(fx.run('lint')).toEqual({ status: 0, stdout: 'lint:agents: OK - 2 skills, 2 roles\n' });
    expect(fx.run('sync', '--check')).toEqual({ status: 0, stdout: 'agents:sync: up to date\n' });
  });

  it('rejects unknown arguments with exit 2', () => {
    const fx = fixture();
    expect(fx.run('sync', '--force').status).toBe(2);
    expect(fx.run().status).toBe(2);
  });

  it('generates copies, toml, link and table, then is idempotent', () => {
    const fx = fixture(false);
    expect(fx.run('sync')).toEqual({ status: 0, stdout: 'agents:sync: wrote 6 file(s)\n' });
    expect(fx.read('.claude/agents/developer.md')).toBe(BASE['.agents/agents/developer.md']);
    expect(fx.read('.claude/agents/reviewer.md')).toBe(BASE['.agents/agents/reviewer.md']);
    expect(fx.read('.codex/agents/developer.toml')).toBe(DEVELOPER_TOML);
    expect(readlinkSync(fx.path('.claude/skills'))).toBe('../.agents/skills');
    expect(fx.read('AGENTS.md')).toBe(
      ['# Agents', '', '- Read `.agents/skills/a/SKILL.md`.', '', TABLE, ''].join('\n'),
    );
    expect(fx.run('sync')).toEqual({ status: 0, stdout: 'agents:sync: up to date\n' });
  });

  it('uses the whole description when a skill lacks the cut text', () => {
    const fx = fixture();
    fx.write('.agents/skills/a/SKILL.md', skillA('Do a with no trigger.'));
    expect(fx.run('sync').status).toBe(0);
    expect(fx.read('AGENTS.md')).toContain(
      '| [a](.agents/skills/a/SKILL.md) | skill | Do a with no trigger |',
    );
  });

  it('removes a tracked stale toml, keeps untracked outputs, repairs a wrong link; refuses a real .claude/skills directory', () => {
    const fx = fixture();
    fx.write('.codex/agents/old.toml', 'name = "old"\n');
    fx.git('add', '.codex/agents/old.toml');
    fx.write('.codex/agents/local.toml', 'local\n');
    fx.write('.claude/agents/local.md', 'local\n');
    rmSync(fx.path('.claude/skills'));
    symlinkSync('../elsewhere', fx.path('.claude/skills'));
    expect(fx.run('sync', '--check')).toEqual({
      status: 1,
      stdout:
        'agents:sync: .codex/agents/old.toml: role old: no source .agents/agents/old.md - run pnpm agents:sync\n' +
        'agents:sync: .claude/skills: out of date (link -> ../elsewhere, want ../.agents/skills) - run pnpm agents:sync\n',
    });
    expect(fx.run('sync')).toEqual({ status: 0, stdout: 'agents:sync: wrote 2 file(s)\n' });
    expect(existsSync(fx.path('.codex/agents/old.toml'))).toBe(false);
    expect(fx.read('.codex/agents/local.toml')).toBe('local\n');
    expect(fx.read('.claude/agents/local.md')).toBe('local\n');
    expect(readlinkSync(fx.path('.claude/skills'))).toBe('../.agents/skills');

    rmSync(fx.path('.claude/skills'));
    fx.write('.claude/skills/keep.md', 'keep\n');
    expect(fx.run('sync')).toEqual({
      status: 1,
      stdout: 'agents:sync: .claude/skills: not a symlink - remove it and rerun pnpm agents:sync\n',
    });
    expect(fx.read('.claude/skills/keep.md')).toBe('keep\n');
  });

  it('refuses to overwrite an untracked file at a new role output', () => {
    const fx = fixture();
    fx.write('.claude/agents/tester.md', 'local\n');
    fx.write('.agents/agents/tester.md', role('tester', 'Test it. Use after reviewer.', 'medium'));
    fx.git('add', '.agents/agents/tester.md');
    expect(fx.run('sync')).toEqual({
      status: 1,
      stdout:
        'agents:sync: .claude/agents/tester.md: role tester: untracked file would be overwritten - git add or move it, then rerun pnpm agents:sync\n',
    });
    expect(fx.read('.claude/agents/tester.md')).toBe('local\n');
    expect(existsSync(fx.path('.codex/agents/tester.toml'))).toBe(false);
  });

  it('refuses a symlinked output directory before writing', () => {
    const fx = fixture();
    const outside = join(fx.dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'developer.toml'), 'outside\n');
    rmSync(fx.path('.codex/agents'), { recursive: true });
    symlinkSync(outside, fx.path('.codex/agents'));
    const line =
      '.codex/agents: not a directory - replace it with a real directory and rerun pnpm agents:sync\n';
    expect(fx.run('sync')).toEqual({ status: 1, stdout: `agents:sync: ${line}` });
    expect(readFileSync(join(outside, 'developer.toml'), 'utf8')).toBe('outside\n');
    expect(fx.read('.claude/agents/developer.md')).toBe(BASE['.agents/agents/developer.md']);
    const lint = fx.run('lint');
    expect(lint.status).toBe(1);
    expect(lint.stdout).toContain(`lint:agents: ${line}`);
  });

  it('reports a cited root file that was renamed, and skips code names and runtime files', () => {
    const fx = fixture();
    fx.write('knip.json', '{}\n');
    fx.write(
      '.agents/skills/a/SKILL.md',
      skillA(undefined, '- See `knip.json`, `ctx.log`, `config.yaml` and `SKILL.md`.\n'),
    );
    fx.git('add', '-A');
    expect(fx.run('lint').status).toBe(0);
    fx.git('mv', 'knip.json', 'knip.jsonc');
    const lint = fx.run('lint');
    expect(lint.status).toBe(1);
    expect(lint.stdout).toContain(
      'lint:agents: .agents/skills/a/SKILL.md:9: skill a: missing file knip.json - no tracked file has this name\n',
    );
    expect(lint.stdout).toContain('FAIL - 1 finding(s)');
  });

  it('names the skill and the path when a cited file is renamed', () => {
    const line = 'lint:agents: .agents/skills/a/SKILL.md:8: skill a: missing path scripts/foo.ts\n';
    const moved = fixture();
    moved.git('mv', 'scripts/foo.ts', 'scripts/bar.ts');
    const afterGitMv = moved.run('lint');
    expect(afterGitMv.status).toBe(1);
    expect(afterGitMv.stdout).toContain(line);

    const plain = fixture();
    renameSync(plain.path('scripts/foo.ts'), plain.path('scripts/bar.ts'));
    const afterMv = plain.run('lint');
    expect(afterMv.status).toBe(1);
    expect(afterMv.stdout).toContain(line);
  });

  it.each([
    ['.claude/agents/developer.md', 'role developer: '],
    ['.codex/agents/developer.toml', 'role developer: '],
    ['AGENTS.md', ''],
  ])('reports a hand edit of %s with the sync hint', (file, owner) => {
    const fx = fixture();
    const edited =
      file === 'AGENTS.md'
        ? fx.read(file).replace(END, `| [x](x) | skill | x |\n${END}`)
        : `${fx.read(file)}hand edit\n`;
    fx.write(file, edited);
    for (const [command, prefix] of [
      [['lint'], 'lint:agents'],
      [['sync', '--check'], 'agents:sync'],
    ] as const) {
      const result = fx.run(...command);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(
        `${prefix}: ${file}: ${owner}out of date - run pnpm agents:sync\n`,
      );
      expect(fx.read(file)).toBe(edited);
    }
  });

  it.each(['wrong-target link', 'real directory'])(
    'reports .claude/skills as a %s under lint and sync --check',
    (kind) => {
      const fx = fixture();
      rmSync(fx.path('.claude/skills'));
      const line =
        kind === 'wrong-target link'
          ? '.claude/skills: out of date (link -> ../elsewhere, want ../.agents/skills) - run pnpm agents:sync'
          : '.claude/skills: not a symlink - remove it and rerun pnpm agents:sync';
      if (kind === 'wrong-target link') symlinkSync('../elsewhere', fx.path('.claude/skills'));
      else fx.write('.claude/skills/keep.md', 'keep\n');
      for (const [command, prefix] of [
        [['lint'], 'lint:agents'],
        [['sync', '--check'], 'agents:sync'],
      ] as const) {
        const result = fx.run(...command);
        expect(result.status).toBe(1);
        expect(result.stdout).toContain(`${prefix}: ${line}\n`);
        if (kind === 'wrong-target link') {
          expect(readlinkSync(fx.path('.claude/skills'))).toBe('../elsewhere');
        } else {
          expect(fx.read('.claude/skills/keep.md')).toBe('keep\n');
        }
      }
    },
  );

  it.each([
    ['/home/someone/x', 'machine path /home/'],
    ['~/.config', 'machine path ~/.'],
    ['ip-10-0-0-1', 'hostname ip-10-0-0-1'],
    ['db.internal', 'hostname db.internal'],
    ['a@corp.io', 'email a@corp.io'],
  ])('reports %s in a tracked skill', (text, label) => {
    const fx = fixture();
    fx.write('.agents/skills/a/SKILL.md', skillA(undefined, `- See ${text} here.\n`));
    const result = fx.run('lint');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      `lint:agents: .agents/skills/a/SKILL.md:9: skill a: ${label}\n`,
    );
  });

  it('scans tracked skill scripts', () => {
    const fx = fixture();
    fx.write('.agents/skills/a/scripts/run.sh', '#!/bin/sh\ncd /home/someone/repo\n');
    fx.git('add', '.agents/skills/a/scripts/run.sh');
    const result = fx.run('lint');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      'lint:agents: .agents/skills/a/scripts/run.sh:2: skill a: machine path /home/\n',
    );
  });

  it('allows example.com emails and settings.local.json', () => {
    const fx = fixture();
    fx.write(
      '.agents/skills/a/SKILL.md',
      skillA(
        undefined,
        '- Mail dev@example.com or ops@mail.example.org; keep settings.local.json.\n',
      ),
    );
    expect(fx.run('lint')).toEqual({ status: 0, stdout: 'lint:agents: OK - 2 skills, 2 roles\n' });
  });

  it.each(['directory', 'symlink'])(
    'ignores an untracked %s skill and untracked outputs',
    (kind) => {
      const fx = fixture();
      const outputs = [
        '.claude/agents/developer.md',
        '.claude/agents/reviewer.md',
        '.codex/agents/developer.toml',
        '.codex/agents/reviewer.toml',
        'AGENTS.md',
      ];
      const snapshot = () => ({
        sync: fx.run('sync'),
        lint: fx.run('lint'),
        files: outputs.map((file) => fx.read(file)),
      });
      const before = snapshot();
      const local = [
        '---',
        'name: Local',
        "description: Local. Use when x. Don't use for y.",
        '---',
        '',
        '- Lives in /home/x/.',
        'x'.repeat(6000),
        '',
      ].join('\n');
      writeFileSync(join(fx.repo, '.git/info/exclude'), '.agents/skills/local\n');
      if (kind === 'directory') fx.write('.agents/skills/local/SKILL.md', local);
      else {
        const target = join(fx.dir, 'outside/local');
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, 'SKILL.md'), local);
        symlinkSync(target, fx.path('.agents/skills/local'));
      }
      fx.write('.claude/agents/local.md', 'local role\n');
      fx.write('.codex/agents/local.toml', 'name = "local"\n');
      expect(snapshot()).toEqual(before);
      expect(before.lint.status).toBe(0);
      expect(fx.read('.claude/agents/local.md')).toBe('local role\n');
      expect(fx.read('.codex/agents/local.toml')).toBe('name = "local"\n');
    },
  );

  const pad = (text: string, size: number) =>
    `${text}${'x'.repeat(size - Buffer.byteLength(text) - 1)}\n`;

  it.each<[string, (fx: Fixture) => void, string, boolean]>([
    [
      'a name that differs from the directory',
      (fx) => {
        fx.write('.agents/skills/a/SKILL.md', skillA().replace('name: a', 'name: b'));
      },
      '.agents/skills/a/SKILL.md:2: skill a: name "b" differs from the directory name a',
      false,
    ],
    [
      "a skill description without Don't use for",
      (fx) => {
        fx.write('.agents/skills/a/SKILL.md', skillA('Do a. Use when b.'));
      },
      `.agents/skills/a/SKILL.md:3: skill a: description needs "Use when ..." followed by "Don't use for ..."`,
      false,
    ],
    [
      'an extra key',
      (fx) => {
        fx.write('.agents/skills/a/SKILL.md', skillA().replace('---\n\n', 'foo: bar\n---\n\n'));
      },
      '.agents/skills/a/SKILL.md:4: skill a: unexpected key foo',
      false,
    ],
    [
      'a value with ": "',
      (fx) => {
        fx.write('.agents/skills/a/SKILL.md', skillA("Do a: now. Use when b. Don't use for c."));
      },
      '.agents/skills/a/SKILL.md:3: skill a: value of description contains ": " or " #"',
      false,
    ],
    [
      'a 301 code point description',
      (fx) => {
        const start = "Do a. Use when b. Don't use for c. ";
        fx.write('.agents/skills/a/SKILL.md', skillA(`${start}${'é'.repeat(301 - start.length)}`));
      },
      '.agents/skills/a/SKILL.md:3: skill a: description is 301 characters, over 300',
      false,
    ],
    [
      'a 5121 byte SKILL.md',
      (fx) => {
        fx.write('.agents/skills/a/SKILL.md', pad(skillA(), 5121));
      },
      '.agents/skills/a/SKILL.md: skill a: 5121 bytes, over the 5120-byte budget',
      false,
    ],
    [
      'an 8193 byte reference',
      (fx) => {
        fx.write('.agents/skills/a/references/r.md', pad('# R\n\n', 8193));
        fx.git('add', '.agents/skills/a/references/r.md');
      },
      '.agents/skills/a/references/r.md: skill a: 8193 bytes, over the 8192-byte budget',
      false,
    ],
    [
      'a 4097 byte role',
      (fx) => {
        fx.write('.agents/agents/reviewer.md', pad(BASE['.agents/agents/reviewer.md'] ?? '', 4097));
      },
      '.agents/agents/reviewer.md: role reviewer: 4097 bytes, over the 4096-byte budget',
      false,
    ],
    [
      'a 32769 byte AGENTS.md',
      (fx) => {
        fx.write('AGENTS.md', pad(fx.read('AGENTS.md'), 32769));
      },
      'AGENTS.md: 32769 bytes, over the 32768-byte budget',
      false,
    ],
    [
      'a stray tracked file in a skill',
      (fx) => {
        fx.write('.agents/skills/a/notes.txt', 'notes\n');
        fx.git('add', '.agents/skills/a/notes.txt');
      },
      '.agents/skills/a/notes.txt: skill a: unexpected file',
      false,
    ],
    [
      'a role missing from ROLE_SANDBOX',
      (fx) => {
        fx.write('.agents/agents/newrole.md', role('newrole', 'New. Use after developer.', 'low'));
        fx.git('add', '.agents/agents/newrole.md');
      },
      '.agents/agents/newrole.md: role newrole: missing from ROLE_SANDBOX in scripts/agents.ts',
      true,
    ],
    [
      "a role body with '''",
      (fx) => {
        fx.write(
          '.agents/agents/reviewer.md',
          role('reviewer', 'Review the diff. Use after developer.', 'high', "Say '''.\n"),
        );
      },
      ".agents/agents/reviewer.md: role reviewer: body contains '''",
      true,
    ],
    [
      'a tracked source deleted on disk',
      (fx) => {
        rmSync(fx.path('.agents/agents/reviewer.md'));
      },
      '.agents/agents/reviewer.md: role reviewer: tracked but missing on disk',
      true,
    ],
    [
      'AGENTS.md without the END marker',
      (fx) => {
        fx.write('AGENTS.md', fx.read('AGENTS.md').replace(`${END}\n`, ''));
      },
      'AGENTS.md: needs one',
      true,
    ],
    [
      'AGENTS.md with a duplicated BEGIN marker',
      (fx) => {
        fx.write('AGENTS.md', `${BEGIN}\n${fx.read('AGENTS.md')}`);
      },
      'AGENTS.md: needs one',
      true,
    ],
  ])('reports %s', (_name, mutate, finding, blocksSync) => {
    const fx = fixture();
    mutate(fx);
    const agents = fx.read('AGENTS.md');
    const lint = fx.run('lint');
    expect(lint.status).toBe(1);
    expect(lint.stdout).toContain(`lint:agents: ${finding}`);
    const sync = fx.run('sync');
    expect(sync.status).toBe(blocksSync ? 1 : 0);
    if (blocksSync) {
      expect(sync.stdout).toContain(`agents:sync: ${finding}`);
      expect(fx.read('AGENTS.md')).toBe(agents);
    }
  });

  it.each<[string, (fx: Fixture) => void, string]>([
    [
      'a /name span',
      (fx) => {
        fx.write('.agents/skills/a/SKILL.md', skillA(undefined, '- Run `/nope`.\n'));
      },
      '.agents/skills/a/SKILL.md:9: skill a: unregistered skill `nope`',
    ],
    [
      '(use name) in a skill description',
      (fx) => {
        fx.write(
          '.agents/skills/a/SKILL.md',
          skillA("Do a. Use when b. Don't use for c (use nope)."),
        );
      },
      '.agents/skills/a/SKILL.md:3: skill a: unregistered skill `nope`',
    ],
    [
      'after name in a role description',
      (fx) => {
        fx.write(
          '.agents/agents/reviewer.md',
          role('reviewer', 'Review the diff. Use after nope, before developer.', 'high'),
        );
      },
      '.agents/agents/reviewer.md:3: role reviewer: unregistered role `nope`',
    ],
    [
      'a `name` skill phrase',
      (fx) => {
        fx.write('.agents/skills/a/SKILL.md', skillA(undefined, '- Follow the `nope` skill.\n'));
      },
      '.agents/skills/a/SKILL.md:9: skill a: unregistered skill `nope`',
    ],
    [
      'a Skill: list',
      (fx) => {
        fx.write('.agents/skills/a/SKILL.md', skillA(undefined, '- Skill: `nope`.\n'));
      },
      '.agents/skills/a/SKILL.md:9: skill a: unregistered skill `nope`',
    ],
    [
      'a bare name in manager',
      (fx) => {
        fx.write('.agents/skills/manager/SKILL.md', manager('- Ask `nope`.\n'));
      },
      '.agents/skills/manager/SKILL.md:10: skill manager: unregistered name `nope` - name a tracked skill or role, or add it to NOT_AGENT_NAMES in scripts/agents.ts',
    ],
    [
      'a describe name missing from the cited test',
      (fx) => {
        fx.write(
          '.agents/skills/a/SKILL.md',
          skillA(undefined, "- See `scripts/foo.test.ts`, `describe('missing')`.\n"),
        );
      },
      ".agents/skills/a/SKILL.md:9: skill a: describe('missing') is not in scripts/foo.test.ts",
    ],
    [
      'a describe name wrapped onto the next line',
      (fx) => {
        fx.write(
          '.agents/skills/a/SKILL.md',
          skillA(undefined, "- See `scripts/foo.test.ts`,\n  `describe('missing')`.\n"),
        );
      },
      ".agents/skills/a/SKILL.md:9: skill a: describe('missing') is not in scripts/foo.test.ts",
    ],
  ])('reports %s', (_name, mutate, finding) => {
    const fx = fixture();
    mutate(fx);
    const result = fx.run('lint');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`lint:agents: ${finding}\n`);
  });

  it('accepts manager terms, non-agent spans and an uncited describe name', () => {
    const fx = fixture();
    fx.write(
      '.agents/skills/manager/SKILL.md',
      manager(
        '- Use `gh` on `origin/main`, return `PLAN_READY`, run `$SPUR_TODO_COMMAND`.\n' +
          '- Pick `read-only` or `workspace-write`; `add` with `pnpm` on `main`.\n',
      ),
    );
    fx.write(
      '.agents/skills/a/SKILL.md',
      skillA(
        undefined,
        "- Ask `nope`; keep `describe('missing')`.\n- See `scripts/foo.test.ts`,\n  `describe('foo')`.\n",
      ),
    );
    expect(fx.run('lint')).toEqual({ status: 0, stdout: 'lint:agents: OK - 2 skills, 2 roles\n' });
  });

  it('reports a role renamed under a bare manager reference', () => {
    const fx = fixture();
    fx.git('mv', '.agents/agents/reviewer.md', '.agents/agents/checker.md');
    fx.write(
      '.agents/agents/checker.md',
      role('checker', 'Review the diff. Use after developer.', 'high'),
    );
    const result = fx.run('lint');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      '.agents/skills/manager/SKILL.md:8: skill manager: unregistered name `reviewer`',
    );
  });
});

describe('agents.ts on this repo', () => {
  it('lint passes on the committed tree', () => {
    const result = spawnSync(process.execPath, [script, 'lint'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(result.stdout).toContain('lint:agents: OK - ');
    expect(result.status).toBe(0);
  });
});
