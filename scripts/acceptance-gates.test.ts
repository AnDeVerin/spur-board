import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { gateSections, isUiPath, parseGates } from './acceptance-gates.ts';

const template = readFileSync(
  fileURLToPath(new URL('../.github/pull_request_template.md', import.meta.url)),
  'utf8',
);

describe('isUiPath', () => {
  it.each([
    ['packages/web/src/x.tsx', true],
    ['packages/web/index.html', true],
    ['packages/web/src/test/x.ts', true],
    ['docs/contributing/design-system-decisions.md', true],
    ['packages/web/test/a.test.ts', false],
    ['packages/web/gallery/x.tsx', false],
    ['packages/web/kit/x.ts', false],
    ['packages/webx/a.ts', false],
    ['design/prototypes/s/a.tsx', false],
    ['.agents/skills/qa-report/references/prototype-vs-build.md', false],
    ['docs/web-ui.md', false],
  ])('%s -> %s', (path, expected) => {
    expect(isUiPath(path)).toBe(expected);
  });
});

describe('parseGates', () => {
  const sha = 'a'.repeat(40);
  const shape = (line: string) =>
    `line "${line}" is not "tester: <sha | n/a>" or "designer: <sha | n/a>"`;

  it.each<[string, string, ReturnType<typeof parseGates>]>([
    [
      'both lines, short and upper-case SHA',
      `tester: ${sha}\n\ndesigner: ${sha.toUpperCase().slice(0, 7)}\n`,
      { ok: true, gates: { tester: sha, designer: 'aaaaaaa' } },
    ],
    [
      'n/a in any case',
      'tester: n/a\ndesigner: N/A',
      { ok: true, gates: { tester: null, designer: null } },
    ],
    [
      'an extra prose line',
      `tester: ${sha}\ndesigner: n/a\nsome note`,
      { ok: false, errors: [shape('some note')] },
    ],
    [
      'a bullet or a backticked value',
      `- tester: ${sha}\ndesigner: \`n/a\``,
      {
        ok: false,
        errors: [
          shape(`- tester: ${sha}`),
          'tester: no "tester:" line',
          'designer: "`n/a`" is not a commit SHA or n/a',
        ],
      },
    ],
    [
      'a fence line next to both lines',
      `tester: ${sha}\ndesigner: n/a\n\`\`\`\ntester: PASS\n\`\`\``,
      {
        ok: false,
        errors: [shape('```'), shape('```'), 'tester: 2 "tester:" lines, expected one'],
      },
    ],
    [
      'a fenced declaration alone',
      `~~~\ntester: ${sha}\ndesigner: n/a\n~~~`,
      { ok: false, errors: [shape('~~~'), shape('~~~')] },
    ],
    [
      'a duplicate line',
      `tester: ${sha}\ntester: n/a\ndesigner: n/a`,
      { ok: false, errors: ['tester: 2 "tester:" lines, expected one'] },
    ],
    ['a missing line', `tester: ${sha}`, { ok: false, errors: ['designer: no "designer:" line'] }],
    [
      'a malformed value',
      'tester: abc12\ndesigner: none',
      {
        ok: false,
        errors: [
          'tester: "abc12" is not a commit SHA or n/a',
          'designer: "none" is not a commit SHA or n/a',
        ],
      },
    ],
    [
      'the PR template placeholders',
      gateSections(template)[0] ?? '',
      {
        ok: false,
        errors: [
          'tester: "<sha | n/a>" is not a commit SHA or n/a',
          'designer: "<sha | n/a>" is not a commit SHA or n/a',
        ],
      },
    ],
  ])('%s', (_name, section, expected) => {
    expect(parseGates(section)).toEqual(expected);
  });
});

describe('PR template', () => {
  it('follows Acceptance gates with a heading gitflow never deletes', () => {
    const headings = template.split('\n').filter((line) => line.startsWith('## '));
    const next = headings[headings.indexOf('## Acceptance gates') + 1];
    expect(next).toBeDefined();
    expect(['## Changed checks', '## Design System decisions']).not.toContain(next);
  });
});

describe('acceptance-gates.ts CLI', () => {
  const script = fileURLToPath(new URL('acceptance-gates.ts', import.meta.url));

  function sandbox() {
    const dir = mkdtempSync(join(tmpdir(), 'acceptance-gates-cli-'));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    };
    for (const name of ['GITHUB_EVENT_NAME', 'GITHUB_EVENT_PATH', 'GITHUB_STEP_SUMMARY']) {
      Reflect.deleteProperty(env, name);
    }
    const repo = join(dir, 'repo');
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
      return result.stdout.trim();
    };
    mkdirSync(repo);
    git('init', '-q', '-b', 'main');
    /** Commits the files on the current branch and returns the new commit's SHA. */
    const commit = (files: Record<string, string>) => {
      for (const [path, text] of Object.entries(files)) {
        const file = join(repo, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
      }
      git('add', '-A');
      git('commit', '-qm', 'change');
      return git('rev-parse', 'HEAD');
    };
    const event = join(dir, 'event.json');
    return {
      git,
      commit,
      /** Starts the PR branch `topic` at the current main. */
      topic: () => git('checkout', '-q', '-b', 'topic'),
      /** Builds the pull_request merge ref: main merged with topic; HEAD^2 is the PR head. */
      merge: () => {
        git('checkout', '-q', 'main');
        git('merge', '-q', '--no-ff', 'topic', '-m', 'merge');
        return git('rev-parse', 'HEAD^2');
      },
      run: (body: string | null, args: string[] = [], extra: NodeJS.ProcessEnv = {}) => {
        writeFileSync(
          event,
          JSON.stringify({ pull_request: { body, user: { login: 'someone', type: 'User' } } }),
        );
        const result = spawnSync(process.execPath, [script, ...args], {
          cwd: repo,
          env: { ...env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event, ...extra },
          encoding: 'utf8',
        });
        return { status: result.status, stdout: result.stdout, stderr: result.stderr };
      },
    };
  }

  const body = (tester: string, designer: string) =>
    `## Testing\n\n- ok\n\n## Acceptance gates\n\ntester: ${tester}\ndesigner: ${designer}\n\n## Changed checks\n\nCloses #1`;
  const errorLine = (stdout: string) =>
    stdout.split('\n').filter((line) => line.startsWith('::error::'));
  const last = (stdout: string) => stdout.trimEnd().split('\n').at(-1);

  /** main with README, topic with one UI commit: the gate head. */
  function uiPr() {
    const box = sandbox();
    box.commit({ 'README.md': 'x\n' });
    box.topic();
    const gate = box.commit({ 'packages/web/src/a.tsx': 'export const a = 1;\n' });
    return { box, gate };
  }

  it('passes a non-UI PR with no section, or with the unedited template section', () => {
    const box = sandbox();
    box.commit({ 'README.md': 'x\n' });
    box.topic();
    box.commit({ 'scripts/x.ts': 'x\n', 'packages/web/test/a.test.ts': 'x\n' });
    box.merge();
    for (const text of [null, '', template]) {
      const result = box.run(text);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('acceptance-gates: PASS (no UI change)\n');
    }
  });

  it('passes a UI PR whose gate heads are the PR head', () => {
    const { box, gate } = uiPr();
    expect(box.merge()).toBe(gate);
    const result = box.run(body(gate, gate));
    expect(result.status).toBe(0);
    expect(last(result.stdout)).toBe(
      `acceptance-gates: PASS (no UI change since tester ${gate}, designer ${gate})`,
    );
  });

  it('passes when only non-UI, test, prototype or pairs files changed after the gate heads', () => {
    const { box, gate } = uiPr();
    box.commit({
      'README.md': 'y\n',
      'packages/web/test/a.test.ts': 'x\n',
      'packages/web/gallery/g.tsx': 'x\n',
      'design/prototypes/s/a.tsx': 'x\n',
      '.agents/skills/qa-report/references/prototype-vs-build.md': 'x\n',
    });
    box.merge();
    const result = box.run(body(gate, gate.slice(0, 7)));
    expect(result.status).toBe(0);
    expect(last(result.stdout)).toBe(
      `acceptance-gates: PASS (no UI change since tester ${gate}, designer ${gate.slice(0, 7)})`,
    );
  });

  it('fails naming the gate, its SHA and each UI file changed after it', () => {
    const { box, gate } = uiPr();
    const head = box.commit({
      'packages/web/src/b.tsx': 'export const b = 1;\n',
      'docs/contributing/design-system-decisions.md': 'x\n',
    });
    box.merge();
    const result = box.run(body(gate, head));
    expect(result.status).toBe(1);
    const [error, ...rest] = errorLine(result.stdout);
    expect(rest).toEqual([]);
    expect(error).toContain(`tester ${gate}: UI files changed since this head:`);
    expect(error).toContain('  - docs/contributing/design-system-decisions.md');
    expect(error).toContain('  - packages/web/src/b.tsx');
    expect(error).not.toContain(`designer ${head}`);
    expect(error).toContain('the cap never excuses the final-head run');
    expect(error).toContain('Editing the description re-runs this job');
    expect(last(result.stdout)).toBe('acceptance-gates: FAIL');
  });

  it('fails a UI PR with no section, or one only inside an HTML comment, naming the UI files', () => {
    const { box, gate } = uiPr();
    box.merge();
    for (const text of [null, 'Closes #1', `<!--\n${body(gate, gate)}\n-->`]) {
      const result = box.run(text);
      expect(result.status).toBe(1);
      const error = errorLine(result.stdout)[0];
      expect(error).toContain('- packages/web/src/a.tsx');
      expect(error).toContain('- tester: no "tester:" line');
      expect(error).toContain('- designer: no "designer:" line');
    }
  });

  it('checks only the gate that is not n/a', () => {
    const { box, gate } = uiPr();
    box.commit({ 'packages/web/src/b.tsx': 'x\n' });
    box.merge();
    const failed = box.run(body(gate, 'n/a'));
    expect(failed.status).toBe(1);
    const error = errorLine(failed.stdout)[0];
    expect(error).toContain(`tester ${gate}: UI files changed since this head:`);
    expect(error).not.toContain('designer');

    const passed = box.run(body('n/a', 'N/A'));
    expect(passed.status).toBe(0);
    expect(last(passed.stdout)).toBe(
      'acceptance-gates: PASS (no UI change since tester n/a, designer n/a)',
    );
  });

  it('fails a gate head on a side branch, on main after the branch point, or unknown', () => {
    const { box, gate } = uiPr();
    box.git('checkout', '-q', '-b', 'side');
    const side = box.commit({ 'side.txt': 'x\n' });
    box.git('checkout', '-q', 'main');
    const mainAfter = box.commit({ 'main.txt': 'x\n' });
    box.git('checkout', '-q', 'topic');
    const head = box.merge();
    for (const sha of [side, mainAfter]) {
      const result = box.run(body(sha, gate));
      expect(result.status).toBe(1);
      expect(errorLine(result.stdout)[0]).toContain(
        `tester ${sha}: not an ancestor of the PR head ${head}`,
      );
    }
    const unknown = 'f'.repeat(40);
    const result = box.run(body(gate, unknown));
    expect(result.status).toBe(1);
    expect(errorLine(result.stdout)[0]).toContain(
      `designer ${unknown}: not a commit in this repository`,
    );
  });

  it('fails a UI PR with template placeholders, a duplicate or a missing gate line', () => {
    const { box, gate } = uiPr();
    box.merge();
    const cases: [string, string][] = [
      [template, 'tester: "<sha | n/a>" is not a commit SHA or n/a'],
      [
        `## Acceptance gates\ntester: ${gate}\ntester: n/a\ndesigner: n/a`,
        'tester: 2 "tester:" lines',
      ],
      [`## Acceptance gates\ntester: ${gate}`, 'designer: no "designer:" line'],
    ];
    for (const [text, problem] of cases) {
      const result = box.run(text);
      expect(result.status).toBe(1);
      expect(errorLine(result.stdout)[0]).toContain(problem);
    }
  });

  const section = (gate: string) => `## Acceptance gates\n\ntester: ${gate}\ndesigner: n/a`;
  it.each<[string, (gate: string) => string, string | null]>([
    ['the section only', section, null],
    [
      'a fenced Acceptance gates example in Testing and the real section',
      (gate) =>
        `## Testing\n\n\`\`\`\n## Acceptance gates\ntester: n/a\n\`\`\`\n\n${section(gate)}\n\n## Risk\n\n- low`,
      null,
    ],
    [
      'no optional section after it, with Closes and a session marker after Risk',
      (gate) =>
        [
          '## Description\n\n- x',
          '## Testing\n\n- [x] ok',
          section(gate),
          '## Risk\n\n- low - docs',
          'Closes #1\n\n[AI-generated, session: s-1]\n',
        ].join('\n\n'),
      null,
    ],
    [
      'two real Acceptance gates headings',
      (gate) => `${section(gate)}\n\n## Acceptance Gates\n\ntester: n/a\ndesigner: n/a`,
      'more than one ## Acceptance gates section',
    ],
    [
      'the gate lines split across two headings, a third in an HTML comment',
      (gate) =>
        `## Acceptance gates\n\ntester: ${gate}\n\n## Acceptance gates\n\ndesigner: n/a\n\n<!--\n## Acceptance gates\n-->`,
      'more than one ## Acceptance gates section',
    ],
    [
      'a closed `## Acceptance gates ##` heading after a complete section',
      (gate) => `${section(gate)}\n\n## Acceptance gates ##\n\ntester: n/a\ndesigner: n/a`,
      'more than one ## Acceptance gates section',
    ],
    [
      'a closed `## Acceptance gates ##` heading as the only one',
      (gate) => `## Acceptance gates ##\n\ntester: ${gate}\ndesigner: n/a\n`,
      null,
    ],
    ...[1, 2, 3].map((indent): [string, (gate: string) => string, null] => [
      `a ${String(indent)}-space indented Risk heading after it`,
      (gate) => `${section(gate)}\n\n${' '.repeat(indent)}## Risk\n\n- low`,
      null,
    ]),
    ['a level 3 heading after it', (gate) => `${section(gate)}\n\n### Notes\n\nsome note`, null],
    [
      'a setext lookalike and a fenced heading besides the real section',
      (gate) =>
        `Acceptance gates\n---\n\n~~~\n## Acceptance gates\n~~~\n\n${section(gate)}\n\n## Risk\n\n- low`,
      null,
    ],
  ])('reads the section of a body with %s', (_name, text, problem) => {
    const { box, gate } = uiPr();
    box.merge();
    const result = box.run(text(gate));
    if (problem === null) {
      expect(result.status).toBe(0);
      expect(last(result.stdout)).toBe(
        `acceptance-gates: PASS (no UI change since tester ${gate}, designer n/a)`,
      );
    } else {
      expect(result.status).toBe(1);
      expect(errorLine(result.stdout)[0]).toContain(problem);
    }
  });

  it('fails a UI PR whose section holds a code fence, naming the line', () => {
    const { box, gate } = uiPr();
    box.merge();
    const result = box.run(
      `## Acceptance gates\n\n\`\`\`\ntester: ${gate}\n\`\`\`\n\ndesigner: ${gate}`,
    );
    expect(result.status).toBe(1);
    const error = errorLine(result.stdout)[0];
    expect(error).toContain('line "```" is not "tester: <sha | n/a>" or "designer: <sha | n/a>"');
    expect(last(result.stdout)).toBe('acceptance-gates: FAIL');
  });

  it('exits 2 on an argument or outside pull_request, and 1 off a merge ref', () => {
    const { box, gate } = uiPr();
    expect(box.run(body(gate, gate), ['x']).status).toBe(2);
    expect(box.run(body(gate, gate), [], { GITHUB_EVENT_NAME: 'push' }).status).toBe(2);
    const result = box.run(body(gate, gate));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('HEAD is not a merge commit with two parents');
  });
});

describe('acceptance-gates job in ci.yml', () => {
  interface Step {
    uses?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, unknown>;
  }
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const jobs = (
    parse(workflow) as {
      jobs: Record<string, { if?: string; permissions?: unknown; env?: unknown; steps?: Step[] }>;
    }
  ).jobs;

  it('runs acceptance-gates read-only on pull requests with no token or install', () => {
    const job = jobs['acceptance-gates'];
    expect(job?.if).toBe("github.event_name == 'pull_request'");
    expect(job?.permissions).toEqual({ contents: 'read' });
    const steps = job?.steps ?? [];
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with).toEqual({ 'persist-credentials': false, 'fetch-depth': 0 });
    expect(steps.flatMap((step) => (step.run === undefined ? [] : [step.run]))).toEqual([
      'node scripts/acceptance-gates.ts',
    ]);
    const exposed = JSON.stringify([
      job?.env ?? {},
      steps.map((step) => [step.env ?? {}, step.run]),
    ]);
    expect(exposed).not.toMatch(/github\.token|secrets\.|GITHUB_TOKEN/);
    expect(JSON.stringify(steps)).not.toMatch(/pnpm|install/);
  });
});
