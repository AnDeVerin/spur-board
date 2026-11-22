import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const readmePath = fileURLToPath(new URL('../../../README.md', import.meta.url));
const setupGuidePath = fileURLToPath(new URL('../../../SETUP.md', import.meta.url));
const troubleshootingPath = fileURLToPath(new URL('../../../TROUBLESHOOTING.md', import.meta.url));
const runbookPath = fileURLToPath(new URL('../../../docs/runbook.md', import.meta.url));
const updatePath = fileURLToPath(new URL('../setup/references/update.md', import.meta.url));
const publicGuides = [readmePath, setupGuidePath, troubleshootingPath, runbookPath].map((path) =>
  readFileSync(path, 'utf8'),
);
const updateRun = readFileSync(updatePath, 'utf8');
const flat = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8').replace(/\s+/g, ' ');

describe('public guide contents', () => {
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
    expect(setup).toContain('leave `operator` and `slack` out of `config.yaml`');
    expect(setup).toContain('Add `operator.slack` back before `board rollback`');
    const check = troubleshooting?.split('### slack.configured')[1]?.split(' ### ')[0];
    expect(check).toContain('the Board runs without Slack');
    expect(check).toContain('Slack is partly configured');
    expect(flat('../../../SECURITY.md')).toContain('only Slack can approve a request');
    expect(flat('../setup/SKILL.md')).toContain('ask whether the operator wants Slack');
    expect(flat('../setup/references/access.md')).toContain('Token approval needs Slack');
    for (const path of ['../../../docs/web-ui-status.md', '../../../docs/how-board-works-web.md'])
      expect(flat(path)).toContain('slack when a Slack gateway is configured');
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
    }
    for (const token of ['update_rolled_back', 'rollback_failed', '`board rollback --yes`'])
      expect(troubleshooting).toContain(token);
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
