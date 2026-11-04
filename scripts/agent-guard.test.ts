import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decide } from './agent-guard.ts';

const GUARD = fileURLToPath(new URL('./agent-guard.ts', import.meta.url));

const lines = (...parts: string[]) => parts.join('\n');

// `echo $(echo $(... git status ...))` with `levels` substitutions.
function nested(levels: number): string {
  return `${'echo $('.repeat(levels)}git status${')'.repeat(levels)}`;
}

const DENY: [string, string][] = [
  // no-verify
  ['git commit --no-verify -m x', 'no-verify'],
  ['git commit --no-verif -m x', 'no-verify'],
  ['git commit -n -m x', 'no-verify'],
  ['git commit -nm x', 'no-verify'],
  ['git -C . commit --no-verify -m x', 'no-verify'],
  ['git push --no-verify', 'no-verify'],
  // hooks-path
  ['git -c core.hooksPath=/dev/null commit -m x', 'hooks-path'],
  ['git -c CORE.HooksPath=/dev/null commit -m x', 'hooks-path'],
  ['git config core.hooksPath x', 'hooks-path'],
  ['git config core.HOOKSPATH x', 'hooks-path'],
  ['git config --unset core.hookspath', 'hooks-path'],
  ['git config --unset-all core.hooksPath', 'hooks-path'],
  ['git config --local --remove-section core', 'hooks-path'],
  ['git config --rename-section core x', 'hooks-path'],
  ['git config --rename-section CORE x', 'hooks-path'],
  ['git config remove-section core', 'hooks-path'],
  ['git config rename-section core x', 'hooks-path'],
  ['git config --remove-section core.x', 'hooks-path'],
  ['git config --edit', 'hooks-path'],
  ['git config -e', 'hooks-path'],
  ['git config edit', 'hooks-path'],
  ['git config unset core.hooksPath', 'hooks-path'],
  ['git --config-env=core.hooksPath=X commit -m x', 'hooks-path'],
  ['GIT_CONFIG_COUNT=1 git commit -m x', 'hooks-path'],
  ['export GIT_CONFIG_PARAMETERS=x', 'hooks-path'],
  ['env GIT_CONFIG_GLOBAL=/tmp/c git commit -m x', 'hooks-path'],
  // force-push
  ['git push --force', 'force-push'],
  ['git push -f', 'force-push'],
  ['git push -uf origin x', 'force-push'],
  ['git push --force-with-lease', 'force-push'],
  ['git push --force-with-lease=main:abc origin main', 'force-push'],
  ['git push --force-w', 'force-push'],
  ['git push --force-if-includes', 'force-push'],
  ['git push --mirror', 'force-push'],
  ['git push origin +HEAD:x', 'force-push'],
  ['git push origin -- +HEAD:refs/heads/x', 'force-push'],
  [lines('git push \\', '  --force origin x'), 'force-push'],
  // merge
  ['gh pr merge 1', 'merge'],
  ['gh pr -R o/r merge 1', 'merge'],
  ['gh pr --repo=o/r merge 1', 'merge'],
  ['gh -R o/r pr merge 1', 'merge'],
  ['gh api -X PUT repos/o/r/pulls/1/merge', 'merge'],
  [
    "gh api graphql -f query='mutation{mergePullRequest(input:{pullRequestId:1}){clientMutationId}}'",
    'merge',
  ],
  ["gh api graphql -f query='mutation{enablePullRequestAutoMerge(input:{})}'", 'merge'],
  // context forms
  ['true && git push -f', 'force-push'],
  ['true; git push -f', 'force-push'],
  ['echo x | git push -f', 'force-push'],
  ['false || git push -f', 'force-push'],
  ['(git push -f)', 'force-push'],
  ['{ git push -f; }', 'force-push'],
  ['if true; then git push -f; fi', 'force-push'],
  ['for b in a; do git commit --no-verify -m x; done', 'no-verify'],
  ['true || (cd x && gh pr merge 1)', 'merge'],
  ["bash -c 'git push -f'", 'force-push'],
  ["bash -lc 'git push -f'", 'force-push'],
  ['sh -ec "gh pr merge 1"', 'merge'],
  ["zsh -c 'git commit -n -m x'", 'no-verify'],
  ['eval git push -f', 'force-push'],
  ['echo $(git push -f)', 'force-push'],
  ['echo `gh pr merge 1`', 'merge'],
  ['echo "$(git push -f)"', 'force-push'],
  ['cat <(git push -f)', 'force-push'],
  ['env X=1 git push -f', 'force-push'],
  ['timeout 60 git push -f', 'force-push'],
  ['nohup git push -f', 'force-push'],
  ['env -C /tmp git push -f', 'force-push'],
  ['env --chdir /tmp git push -f', 'force-push'],
  ["env -S 'git push -f'", 'force-push'],
  ["env -S'git push' -f", 'force-push'],
  ["env --split-string='gh pr merge' 1", 'merge'],
  ['timeout --signal KILL 60 git push -f', 'force-push'],
  ['timeout -s KILL 60 git push -f', 'force-push'],
  ['timeout --kill-after 5 60 git push -f', 'force-push'],
  ['timeout -k 5 60 git push -f', 'force-push'],
  ['sudo git push -f', 'force-push'],
  ['sudo -u root git push -f', 'force-push'],
  ['sudo -uroot git push -f', 'force-push'],
  ['sudo --user=root -E git push -f', 'force-push'],
  ['sudo --user root -- git push -f', 'force-push'],
  ['sudo -g wheel -C 3 -D /tmp -h host -p pw -r role -t type -T 5 -U u git push -f', 'force-push'],
  ["sudo -s 'git push -f'", 'force-push'],
  ['sudo -i git push -f', 'force-push'],
  ['sudo -u root -s gh pr merge 1', 'merge'],
  ['doas git push -f', 'force-push'],
  ['doas -u root -C /etc/doas.conf git push -f', 'force-push'],
  // wrappers: explicit ones and git or gh behind any other command
  ['stdbuf -oL git push --force', 'force-push'],
  ['stdbuf -o L git push -f', 'force-push'],
  ['stdbuf --output=L -e 0 git push -f', 'force-push'],
  ['setsid gh pr merge 1', 'merge'],
  ['setsid -w git commit --no-verify -m x', 'no-verify'],
  ['xargs git push -f', 'force-push'],
  ['xargs -n1 gh pr merge', 'merge'],
  ['flock /tmp/l git push -f', 'force-push'],
  ['ionice -c3 git push --force', 'force-push'],
  ['taskset 1 gh pr merge 1', 'merge'],
  ['chrt -i 0 git push -f', 'force-push'],
  ['run0 --user root git push -f', 'force-push'],
  // every git or gh word counts: the first may be an option value
  ['xargs -I git gh pr merge 1', 'merge'],
  ['xargs -I gh git push -f', 'force-push'],
  ['flock gh git push -f', 'force-push'],
  ['xargs -I{} -n1 git push -f', 'force-push'],
  ['xargs /usr/bin/git -c core.hooksPath=/dev/null commit -m x', 'hooks-path'],
  // $'...' is decoded as bash decodes it
  ["git push $'--for\\x63e'", 'force-push'],
  ["git push $'--for\\143e'", 'force-push'],
  ["git push $'--for\\u0063e'", 'force-push'],
  ["git push $'--for\\U00000063e'", 'force-push'],
  ["git push $'\\x2df'", 'force-push'],
  ['/usr/bin/git push -f', 'force-push'],
  // unquoted heredoc bodies are expanded by the shell
  [lines('git commit -F - <<EOF', 'fix `git push --force`', 'EOF'), 'force-push'],
  [lines('git commit -F - <<EOF', 'fix $(gh pr merge 1)', 'EOF'), 'merge'],
  // nesting
  [nested(9), 'nesting'],
];

const CLAUDE_COMMIT = lines(
  "git commit -m \"$(cat <<'EOF'",
  'feat(repo): #6 add the agent guard (#6)',
  '',
  '- refuses `git push --force` and `gh pr merge` (see AGENTS.md)',
  'EOF',
  ')"',
);

const heredocWith = (opener: string) =>
  lines(`git commit -F - ${opener}`, 'git push --force', 'mentions `gh pr merge 1`', 'EOF');

const ALLOW: string[] = [
  'git status',
  'git commit -m x',
  'git commit -am x',
  'git commit -mn',
  'git commit -m -n',
  'git commit -m "deny git push --force"',
  'git push',
  'git push -u origin claude-6-agent-workflow',
  'git push -n',
  'git push origin x 2>&1 | tail -5',
  'git log HEAD@{1}',
  'git config --get core.hooksPath',
  'gh pr view 91 --json number',
  'gh pr view -R o/r 91',
  'git push origin -- HEAD:refs/heads/x',
  'git commit --message "-n is not a flag"',
  'git commit --file -n',
  'env -C /tmp git status',
  'sudo apt-get update',
  'echo git push -f',
  'grep -r git push .',
  'rg "gh pr merge" .',
  "rg 'gh pr merge'",
  'stdbuf -oL pnpm test',
  'xargs git status',
  'xargs -I gh gh pr view 1',
  'man git-push',
  'git config --remove-section alias',
  "echo $'a\\tb\\n'",
  'gh pr create --title "x" --body "never run gh pr merge"',
  'gh api repos/o/r/pulls/91 --jq .number',
  "echo 'git push --force'",
  '# git push --force',
  heredocWith("<<'EOF'"),
  heredocWith('<<"EOF"'),
  heredocWith('<<\\EOF'),
  CLAUDE_COMMIT,
  nested(8),
];

describe('decide', () => {
  it('explains the pre-push check scope', () => {
    const decision = decide('git push --no-verify');
    expect(decision.allow).toBe(false);
    if (decision.allow) throw new Error('expected denial');
    expect(decision.reason).toContain('pushed-ref and affected-package checks on push');
  });
  it.each(DENY)('denies %j as %s', (command, rule) => {
    const decision = decide(command);
    expect(decision).toMatchObject({ allow: false, rule });
    expect(decision.allow ? '' : decision.reason).not.toBe('');
  });

  it.each(ALLOW)('allows %j', (command) => {
    expect(decide(command)).toEqual({ allow: true });
  });
});

describe('agent-guard.ts CLI', () => {
  const run = (input: string) => {
    const result = spawnSync(process.execPath, [GUARD], { input, encoding: 'utf8' });
    return { status: result.status, stderr: result.stderr };
  };
  const bash = (command: string) => JSON.stringify({ tool_name: 'Bash', tool_input: { command } });

  it('blocks a denied command with exit 2 and the reason on stderr', () => {
    const r = run(bash('gh pr merge 1'));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^agent-guard: blocked merge: \S/);
  });

  it.each(['git status', CLAUDE_COMMIT])('allows %j silently', (command) => {
    expect(run(bash(command))).toEqual({ status: 0, stderr: '' });
  });

  it('blocks input that is not JSON', () => {
    const r = run('not json');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('agent-guard: invalid hook input');
  });

  it.each([
    ['a Bash call without a command', { tool_name: 'Bash', tool_input: {} }],
    ['a Bash call with a renamed command field', { tool_name: 'Bash', tool_input: { cmd: 'x' } }],
    ['input without tool_name', { tool_input: {} }],
    ['input without tool_input', { tool_name: 'Bash' }],
  ])('blocks %s', (_name, input) => {
    const r = run(JSON.stringify(input));
    expect(r.status).toBe(2);
    expect(r.stderr).toBe('agent-guard: blocked input: no tool_input.command in Bash hook input\n');
  });

  it('allows another tool without a command', () => {
    expect(run(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'x' } }))).toEqual({
      status: 0,
      stderr: '',
    });
  });
});
