import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { APP_FILES } from '../../../scripts/package.ts';
import {
  COLUMNS,
  type Config,
  DEFAULT_HTTP_PORT,
  resolveWebOrigin,
  SPUR_MIN_VERSION,
} from '../../contracts/src/index.ts';
import { taskGetOutputSchema } from '../../contracts/src/browser.ts';

const readmePath = fileURLToPath(new URL('../../../README.md', import.meta.url));
const setupGuidePath = fileURLToPath(new URL('../../../SETUP.md', import.meta.url));
const troubleshootingPath = fileURLToPath(new URL('../../../TROUBLESHOOTING.md', import.meta.url));
const runbookPath = fileURLToPath(new URL('../../../docs/runbook.md', import.meta.url));
const docsUrl = new URL('../../../docs/', import.meta.url);
const updatePath = fileURLToPath(new URL('../setup/references/update.md', import.meta.url));
const publicGuides = [readmePath, setupGuidePath, troubleshootingPath, runbookPath].map((path) =>
  readFileSync(path, 'utf8'),
);
const updateRun = readFileSync(updatePath, 'utf8');
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const security = read('../../../SECURITY.md');
const webUi = read('../../../docs/web-ui.md');
const setupWeb = read('../setup/references/web.md');
const webDocs = [...publicGuides, security, webUi, setupWeb];

/** The text from `heading` up to the next heading of the same or a higher level. */
function section(text: string | undefined, heading: string): string {
  const level = /^#+/.exec(heading)?.[0].length ?? 0;
  const [, rest] = (text ?? '').split(`${heading}\n`);
  expect(rest, heading).toBeDefined();
  const end = rest?.search(new RegExp(`^#{1,${String(level)}} `, 'm')) ?? -1;
  return end === -1 ? (rest ?? '') : (rest?.slice(0, end) ?? '');
}
const flat = (text: string) => text.replace(/\s+/g, ' ');
const caddyLink = '#remote-access-through-caddy-with-basic-auth)';
const browserAccess = section(publicGuides[1], '### Optional browser access');
const caddySection = section(browserAccess, '#### Remote access through Caddy with basic auth');
const listening = section(publicGuides[2], '### web.listening');
const quickstart = readFileSync(new URL('quickstart.md', docsUrl), 'utf8');
const configReference = readFileSync(new URL('configuration.md', docsUrl), 'utf8');
const QUICKSTART_STEPS = [
  '1. Install the package',
  '2. Install the skills',
  '3. Put the example config and Spur projects in place',
  '4. Start the service',
  '5. Run `board doctor` until green',
  '6. Open a GitHub issue',
  '7. Watch the worker take it',
  '8. Watch the reviewer review it',
  '9. Merge the pull request',
  '10. See the task in Done',
];
const step = (n: number) => section(quickstart, `### ${QUICKSTART_STEPS[n - 1] ?? ''}`);
const BOARD_QUERY = /(?<!\/)\bboard (?:status|task|columns describe|inbox operator)\b/;

describe('public guide contents', () => {
  it('introduces newcomers with every built-in column and working links', () => {
    const overview = readFileSync(new URL('overview.md', docsUrl), 'utf8').replace(/\s+/g, ' ');
    for (const column of COLUMNS) expect(overview).toContain(column.name);
    const links = [...overview.matchAll(/\]\(([^)]+)\)/g)]
      .map((match) => match[1] ?? '')
      .filter((target) => !/^https?:/.test(target));
    expect(links).toEqual(
      expect.arrayContaining(['../SETUP.md', 'configuration.md', 'quickstart.md']),
    );
    for (const target of links) {
      const path = fileURLToPath(new URL(target.split('#')[0] ?? '', docsUrl));
      expect(existsSync(path), target).toBe(true);
    }
  });

  it('takes a newcomer from zero to Done with the minimal example', () => {
    for (const path of ['examples/minimal/config.yaml', 'examples/minimal/projects.spur.yaml'])
      expect(quickstart).toContain(`](../${path})`);
    expect(publicGuides[0]).toContain('(docs/quickstart.md)');
    const engines = (JSON.parse(read('../../cli/package.json')) as { engines: { node: string } })
      .engines.node;
    expect(engines).toBe('^24.12.0 || ^26.0.0');
    const requirements = flat(section(quickstart, '## Requirements'));
    for (const token of [
      'Node 24.12+ (24.x) or 26.x',
      `Spur ${SPUR_MIN_VERSION} or newer`,
      'systemd',
      'classic personal access token',
      '`repo`',
      '`read:org`',
      'Slack and the web UI are not needed',
      'spur init',
      'gh auth login',
      'git config --global user.email',
    ])
      expect(requirements).toContain(token);
    expect(quickstart.indexOf('## Requirements')).toBeLessThan(
      quickstart.indexOf(`### ${QUICKSTART_STEPS[0] ?? ''}`),
    );
    expect([...quickstart.matchAll(/^### (\d+\. .+)$/gm)].map((match) => match[1])).toEqual(
      QUICKSTART_STEPS,
    );
    for (const [index, heading] of QUICKSTART_STEPS.entries()) {
      const text = step(index + 1);
      for (const token of ['```', 'Success looks like', 'If it fails'])
        expect(text, heading).toContain(token);
    }
    const doctorStep = step(5);
    const doctorAt = doctorStep.search(/^board doctor$/m);
    for (const spawn of ['spur spawn example-reviewer', 'spur spawn example-operator']) {
      expect(doctorStep.indexOf(spawn), spawn).toBeGreaterThanOrEqual(0);
      expect(doctorStep.indexOf(spawn), spawn).toBeLessThan(doctorAt);
    }
    for (const token of [
      '(../TROUBLESHOOTING.md#httpport)',
      '(../TROUBLESHOOTING.md#eaddrinuse-the-daemon-restarts-every-5-seconds)',
      String(DEFAULT_HTTP_PORT),
    ])
      expect(step(4)).toContain(token);
    for (const fragment of [
      '#githubcredentials)',
      '#github-check-runs-or-review-teams-lack-access)',
      '#spurversion)',
    ])
      expect(step(5)).toContain(`(../TROUBLESHOOTING.md${fragment}`);
  });

  it('shows Board state only through the operator session', () => {
    for (const part of quickstart.split(/^#{2,3} /m))
      if (BOARD_QUERY.test(part)) expect(part, part.split('\n')[0]).toContain('example-operator');
    for (const match of quickstart.matchAll(/```([^\n]*)\n([\s\S]*?)```/g)) {
      if (!['', 'sh', 'bash', 'shell'].includes((match[1] ?? '').trim())) continue;
      for (const line of (match[2] ?? '').split('\n')) expect(line, line).not.toMatch(BOARD_QUERY);
    }
    for (const [n, column, query] of [
      [6, 'todo', 'board status'],
      [7, 'dev', 'board task example-org/example-repo#<N> --why'],
      [8, 'review', 'board status'],
      [10, 'done', 'board status'],
    ] as const) {
      expect(step(n)).toContain(query);
      expect(step(n)).toContain(`\`${column}\``);
    }
    // Turn reasons from packages/core/src/domain/gates.ts (dev, review) and dispatch.ts (done).
    expect(flat(step(7))).toContain('`dev: no_pr`');
    expect(flat(step(8))).toContain('`review: no_review_on_head`');
    expect(flat(step(10))).toContain('`done: wrap up`');
    expect(step(7)).toContain('gh pr list');
    expect(step(9)).toContain('gh issue view');
    expect(step(9)).toContain('--json state');
  });

  it('runs the setup commands in order on a fresh host and safely again', () => {
    const requirements = section(quickstart, '## Requirements');
    const three = step(3);
    // Where a later command needs something an earlier one creates: [text, first, then].
    const order: [string, string, string][] = [
      [three, 'mkdir -p ~/.config/spur-board', 'Copy the contents of `config.yaml`'],
      [three, 'install -m 600 /dev/null', 'GITHUB_TOKEN=<your token>'],
      [requirements, 'mkdir -p .agents/skills', 'ln -sfn'],
    ];
    for (const [text, first, then] of order) {
      expect(text.indexOf(first), first).toBeGreaterThanOrEqual(0);
      expect(text.indexOf(first), `${first} before ${then}`).toBeLessThan(text.indexOf(then));
    }
    // A rerun keeps an existing secrets file and replaces the skill link in place.
    expect(three).toContain('[ -e ~/.config/spur-board/secrets.env ] || install -m 600');
    expect(requirements).toMatch(/After step 3, from the\s+checkout/);
  });

  it('judges each step by fields returned by its Board query', () => {
    const prLink = taskGetOutputSchema.shape.links.element.safeParse({
      kind: 'pr',
      ref: 'example-org/example-repo#42',
      role: null,
    });
    const gates = readFileSync(
      fileURLToPath(new URL('../../core/src/domain/gates.ts', import.meta.url)),
      'utf8',
    );
    // Step, the Board fact a reader checks there, and whether it exists in the code.
    const facts: [number, string[], boolean][] = [
      [7, ['`links`', '`kind: pr`', '`ref`', '`example-org/example-repo#<PR>`'], prLink.success],
      [9, ['`review_on_head` gate met on the current head'], /^\s*review_on_head: \{/m.test(gates)],
    ];
    for (const [n, fields, exists] of facts) {
      expect(exists, `step ${String(n)}`).toBe(true);
      for (const field of fields) {
        expect(flat(step(n)), `step ${String(n)}: ${field}`).toContain(field);
      }
    }
  });

  it('asks the operator session only for registered board commands and flags', () => {
    // skill-sync skips `text` fences, so check the requests to example-operator here, against the
    // generated command reference.
    const cli = read('../../../docs/cli.md');
    const requests = [...quickstart.matchAll(/```text\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
    const invocations = requests.flatMap((text) => [...text.matchAll(/\bboard ([a-z][^.\n]*)/g)]);
    expect(invocations.length).toBeGreaterThan(0);
    // Step 9's gate explanation needs --why; without it the request returns no gates.
    expect(step(9)).toMatch(/\bboard task \S+ --why\b/);
    for (const [whole, rest = ''] of invocations) {
      const words = rest.split(/\s+/);
      const command = words[0] ?? '';
      const flags = words.filter((word) => word.startsWith('--'));
      const reference = section(cli, `### \`board ${command}\``);
      for (const flag of flags) expect(reference, `${whole}: ${flag}`).toContain(`\`${flag}\``);
    }
  });

  it('adds each optional column, Slack and the web UI with real keys', () => {
    const more = section(quickstart, '## Add more columns');
    const sub = (name: string) => section(more, `### ${name}`);
    const minimal = ['todo', 'dev', 'review', 'done'];
    for (const column of COLUMNS) {
      if (minimal.includes(column.id)) continue;
      const name = column.group === 'todo' ? 'The Backlog group' : column.name;
      expect(sub(name), column.id).toContain(`id: ${column.id}`);
    }
    const keys: [string, string[]][] = [
      ['The Backlog group', ['projects[].columns[].source']],
      ['Product Review', ['projects[].columns[].orchestrator']],
      ['External Review', ['projects[].columns[].approvalRule', 'projects[].checksGate']],
      ['QA', ['projects[].columns[].orchestrator']],
      ['Ready to Merge', ['projects[].columns[].requireResolvedThreads']],
      ['Slack', ['operator.slack', 'slack.channels.orchestrators', 'slack.channels.feed']],
      ['The web UI', ['web.port', 'web.publicOrigin']],
    ];
    expect([...more.matchAll(/^### (.+)$/gm)].map((match) => match[1])).toEqual(
      keys.map(([name]) => name),
    );
    for (const [name, names] of keys) {
      const text = sub(name);
      for (const key of names) {
        expect(text, name).toContain(`\`${key}`);
        expect(configReference, key).toContain(`\`${key}`);
      }
      expect(text, name).toMatch(
        /\]\((?:configuration\.md|\.\.\/SETUP\.md|how-board-works-columns\.md)/,
      );
    }
    expect(flat(sub('The web UI'))).toContain('no login of its own');
  });

  it('says the UI ships in the package and is off by default', () => {
    for (const doc of webDocs) expect(doc).not.toContain('supplied separately');
    expect(flat(browserAccess)).toContain('npm package ships the built web UI');
    expect(flat(browserAccess)).toContain('off by default');
  });

  it.each([
    ['SETUP Optional browser access', browserAccess],
    ['runbook web listener', section(publicGuides[3], '## 6. Optional web listener')],
    ['setup skill web reference', setupWeb],
    ['web UI Opening it', section(webUi, '## Opening it')],
    ['TROUBLESHOOTING web.listening', listening],
    ['SECURITY Optional web listener', section(security, '### Optional web listener')],
  ])('warns that the web UI has no login in %s', (_name, text) => {
    for (const token of [
      'no login of its own',
      'operator',
      '`127.0.0.1`',
      'authenticating reverse proxy',
      'SSH tunnel',
      caddyLink,
    ])
      expect(flat(text)).toContain(token);
  });

  it('ships one Caddy sample that matches the listener', () => {
    // The fences sit inside a numbered list item: strip its three-space indent.
    const fence = /```caddyfile\n([\s\S]*?) *```/g;
    const unindent = (text: string) => text.replace(/^ {3}/gm, '');
    expect(webDocs.flatMap((doc) => [...doc.matchAll(fence)])).toHaveLength(1);
    const sample = [...caddySection.matchAll(fence)][0];
    const body = unindent(sample?.[1] ?? '');
    for (const token of ['basic_auth', 'reverse_proxy 127.0.0.1:7777'])
      expect(body).toContain(token);
    expect(/@appfiles path (.+)/.exec(body)?.[1]?.split(' ')).toEqual(
      APP_FILES.map((file) => `/${file}`),
    );
    const after = caddySection.slice((sample?.index ?? 0) + (sample?.[0].length ?? 0));
    const yaml = unindent(/```yaml\n([\s\S]*?) *```/.exec(after)?.[1] ?? '');
    const origin = resolveWebOrigin((parse(yaml) as { web: Config['web'] }).web);
    expect(origin).toBe('https://board.example.com');
    expect(/^(\S+) \{/.exec(body)?.[1]).toBe(new URL(origin ?? 'x:').host);
    for (const token of ['/v1/events', '15 seconds', '`caddy hash-password`', 'no path'])
      expect(flat(caddySection)).toContain(token);
    for (const token of [
      'ssh -L 127.0.0.1:7777:127.0.0.1:7777',
      '`publicOrigin: http://127.0.0.1:7777`',
    ])
      expect(caddySection).toContain(token);
  });

  it('documents one host-package Caddy route in run order', () => {
    const steps = [
      '`caddy hash-password`',
      '```caddyfile',
      '(#4-install-the-service-and-choose-operator-access)',
      '`sudo systemctl reload caddy`',
      '`curl -sI https://board.example.com/`',
    ].map((step) => caddySection.indexOf(step));
    expect(steps.every((index) => index >= 0)).toBe(true);
    expect(steps).toEqual(steps.toSorted((a, b) => a - b));
    expect(caddySection).toContain(
      '`sudo cat /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt`',
    );
    expect(caddySection).not.toContain('docker run');
    const tunnel = caddySection.split('Without a proxy, an SSH tunnel works instead')[1] ?? '';
    const link = tunnel.indexOf('(#4-install-the-service-and-choose-operator-access)');
    expect(link).toBeGreaterThanOrEqual(0);
    expect(link).toBeLessThan(tunnel.indexOf('ssh -L 127.0.0.1:7777:127.0.0.1:7777'));
  });

  it('names both certificate variants and the boundary they leave', () => {
    for (const token of ['`tls internal`', '`80`', '`443`', '`bind`', 'root.crt'])
      expect(caddySection).toContain(token);
    const boundary = flat(section(security, '### Optional web listener'));
    for (const token of ['authenticating reverse proxy', 'private network', 'SSH login'])
      expect(boundary).toContain(token);
    expect(security).not.toContain('doctor and event routes');
  });

  it('says any proxy must pass Host and Origin unchanged', () => {
    for (const text of [caddySection, section(publicGuides[3], '## 6. Optional web listener')])
      expect(flat(text)).toContain('must pass the `Host` and `Origin` headers unchanged');
  });

  it('says what doctor checks for the web listener and what it does not', () => {
    for (const text of [caddySection, listening])
      for (const token of [
        '`web`',
        '`web.listening`',
        'Neither check probes the proxy, its authentication or TLS.',
      ])
        expect(flat(text)).toContain(token);
  });
  it('documents worker session links and the PR-author login', () => {
    const setup = publicGuides[1];
    expect(setup).toContain('open PRs under');
    const section = setup?.split('## 6. Link worker sessions to tasks')[1]?.split('\n## ')[0];
    expect(section).toBeDefined();
    for (const token of [
      'docs/configuration.md#session-links',
      '--link board-worker=',
      '`board link`',
      'any Spur project',
      'role: worker',
    ])
      expect(section).toContain(token);
  });

  it('documents a refused Spur session and the one-project rule', () => {
    const troubleshooting = publicGuides[2]?.replace(/\s+/g, ' ') ?? '';
    const section = troubleshooting.split('## Refused Spur session')[1]?.split(' ## ')[0];
    expect(section).toBeDefined();
    for (const sentence of [
      'Inside a Spur session the session wins over a token: `SPUR_SESSION` is sent and neither `BOARD_TOKEN` nor `.spur-board/token` is read.',
      "A session whose Spur project is in no `projects[].spurProjects` or top-level `spurProjects` of the Board's `config.yaml`, or is listed under several Board projects, is refused with `forbidden` (exit 1), and the hint names the Spur project and the fix.",
      "Keep the Spur project under exactly one Board project in the Board's `config.yaml`, not Spur's `spur.yaml`, and restart the Board daemon.",
      'To run two Board projects, give each its own Spur projects.',
    ])
      expect(section).toContain(sentence);
    expect(troubleshooting).toContain('A Spur project can be listed under only one Board project.');
  });

  it('documents that a stale session rereads SKILL.md and every references/ file', () => {
    const troubleshooting = publicGuides[2]?.replace(/\s+/g, ' ') ?? '';
    const section = troubleshooting.split('### sessions.stale')[1]?.split(' ### ')[0];
    expect(section).toBeDefined();
    for (const token of [
      'SKILL.md',
      'references/',
      '~/.claude/skills/spur-board/',
      '~/.codex/skills/spur-board/',
      '$CODEX_HOME/skills/spur-board/',
    ])
      expect(section).toContain(token);
    expect(section).not.toContain('skill file again');
  });

  it('documents the no-Slack mode', () => {
    const [readme, setup, troubleshooting] = publicGuides.map((text) => text.replace(/\s+/g, ' '));
    expect(readme).toContain('optionally a Slack app');
    expect(setup).toContain('Slack is optional.');
    expect(setup).toContain(
      'a block or turn addressed to you also rings the live session of that operator project',
    );
    expect(setup).toContain('leave `operator` and `slack` out of `config.yaml`');
    expect(setup).toContain('Add `operator.slack` back before `board rollback`');
    expect(setup).toContain('also remove `SLACK_BOT_TOKEN` and `SLACK_API_URL` from `secrets.env`');
    const check = troubleshooting?.split('### slack.configured')[1]?.split(' ### ')[0];
    expect(check).toContain('the Board runs without Slack');
    expect(check).toContain('Slack is partly configured');
    expect(check).toContain('Approving a new token needs Slack');
    expect(check).toContain('keep working until `board token revoke`');
    expect(check).not.toContain('only Spur sessions reach the Board');
    expect(check).toContain('remove `SLACK_BOT_TOKEN` and `SLACK_API_URL` from `secrets.env`');
    expect(flat(read('../../../SECURITY.md'))).toContain('only Slack can approve a request');
    expect(flat(read('../setup/SKILL.md'))).toContain('ask whether the operator wants Slack');
    expect(flat(read('../setup/references/access.md'))).toContain('Token approval needs Slack');
    for (const path of ['../../../docs/web-ui-status.md', '../../../docs/how-board-works-web.md'])
      expect(flat(read(path))).toContain('slack when a Slack gateway is configured');
  });

  it('documents when token create replaces an existing token file', () => {
    const troubleshooting = publicGuides[2]?.replace(/\s+/g, ' ') ?? '';
    expect(troubleshooting).toContain(
      'When `<folder>/.spur-board/token` already exists, `board token create` replaces it only if the daemon reports that token expired or denied; an approved, pending, revoked or unknown token stays in place and the command fails with `config`, naming the file and the fix.',
    );
  });

  it('documents that item retry restarts the answer_undelivered doorbell series', () => {
    const runbook = publicGuides[3]?.replace(/\s+/g, ' ') ?? '';
    const section = runbook.split('## 4. Answer never reached the agent')[1]?.split(' ## 5. ')[0];
    expect(section).toBeDefined();
    expect(section).toContain(
      'To ring again, for either cause: run `board item retry <item> --key <key>`. It clears the item and restarts the doorbell series',
    );
    expect(section).toContain('Spur refused the doorbell');
    expect(section).toContain('Then retry the item as below.');
  });

  it('documents board update and the rollback recovery', () => {
    const [, setup, troubleshooting] = publicGuides;
    for (const guide of [setup, updateRun]) {
      for (const token of ['`board update`', 'without `board update`', '`board service install`'])
        expect(guide).toContain(token);
      expect(guide).toContain('`board service restart` only when the service was active before');
      for (const token of ['`npm pack`', '10 minutes']) expect(guide).toContain(token);
      expect(guide).toContain('CHANGELOG.md');
    }
    for (const token of ['update_rolled_back', 'rollback_failed', '`board rollback --yes`'])
      expect(troubleshooting).toContain(token);
  });

  it('documents the semver policy and the changelog', () => {
    const policy = flat(section(read('../../../CONTRIBUTING.md'), '## Versions and the changelog'));
    for (const text of [
      'Breaking: the config schema, CLI commands and flags, MCP operations, HTTP API operations, error codes and their HTTP status or exit code, stored data and migrations, and web routes users bookmark.',
      'Not breaking: UI layout and wording.',
      '`BREAKING CHANGE: `',
      'no `#`',
      '`Closes #<N>`',
      '`RELEASE_CHANGELOG_COMMIT`',
      '#867',
      'Only on this account',
      'Contents: Read and write',
      '`RELEASE_APP_PRIVATE_KEY`',
      '`npm` environment',
      '`RELEASE_APP_CLIENT_ID`',
      '`main-review`',
      'Always allow',
      'To rotate the key, generate a new private key, replace the secret, then delete the old key.',
      'To revoke the identity',
    ])
      expect(policy).toContain(text);
    // The App, its key, its client ID and the bypass come before the switch.
    const on = policy.indexOf('Set the repository variable `RELEASE_CHANGELOG_COMMIT` to `true`');
    expect(on).toBeGreaterThan(0);
    for (const step of [
      'Contents: Read and write',
      '`RELEASE_APP_PRIVATE_KEY`',
      '`RELEASE_APP_CLIENT_ID`',
      'Always allow',
    ]) {
      expect(policy.indexOf(step), step).toBeGreaterThanOrEqual(0);
      expect(policy.indexOf(step), step).toBeLessThan(on);
    }
    const readme = flat(read('../../../README.md'));
    expect(readme).toContain('[Changelog](CHANGELOG.md)');
    expect(readme).toContain('CONTRIBUTING.md#versions-and-the-changelog');
  });

  it('keeps the agent bootstrap line and GitHub permission recovery', () => {
    const [readme, setup, troubleshooting] = publicGuides;
    expect(readme).toMatch(/^npx -y spur-board@latest skills install$/m);
    expect(readme).toContain('`spur-board-setup`');
    for (const guide of [setup, troubleshooting]) {
      expect(guide).toContain('classic personal access token');
      expect(guide).toContain('`repo`');
      expect(guide).toContain('`read:org`');
      expect(guide).toContain('SSO');
      expect(guide).toContain('`FORBIDDEN`');
      expect(guide).toContain('`CheckRun`');
      expect(guide).toContain('`INSUFFICIENT_SCOPES`');
    }
  });
});
