import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('./gitleaks.sh', import.meta.url));

// Runs scripts/gitleaks.sh with a fake `gitleaks` first on PATH. The fake records its
// arguments and the safe.directory setting it sees, prints `output` and exits with `exit`.
function scan(fake: { output: string; exit: number }, logOpts?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'gitleaks-sh-'));
  const argsFile = join(dir, 'args');
  writeFileSync(
    join(dir, 'gitleaks'),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$@" "safe=$GIT_CONFIG_KEY_0=$GIT_CONFIG_VALUE_0" > '${argsFile}'`,
      `printf '%s\\n' '${fake.output}'`,
      `exit ${String(fake.exit)}`,
    ].join('\n'),
  );
  chmodSync(join(dir, 'gitleaks'), 0o755);
  const env: Record<string, string> = { PATH: `${dir}:${process.env['PATH'] ?? ''}` };
  if (logOpts !== undefined) env['GITLEAKS_LOG_OPTS'] = logOpts;
  const result = spawnSync('sh', [SCRIPT], { cwd: dir, env, encoding: 'utf8' });
  return {
    status: result.status,
    stderr: result.stderr,
    args: readFileSync(argsFile, 'utf8').trim().split('\n'),
    dir,
  };
}

describe('scripts/gitleaks.sh', () => {
  it('passes when gitleaks scanned commits and found nothing', () => {
    const r = scan({ output: '8:16PM INF 1 commits scanned.', exit: 0 });
    expect(r.status).toBe(0);
  });

  it('fails closed when gitleaks exits 0 after scanning no commits', () => {
    const r = scan({ output: '8:16PM INF 0 commits scanned.', exit: 0 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('scanned no commits');
  });

  it('fails closed when gitleaks prints no commit count', () => {
    expect(scan({ output: 'no leaks found', exit: 0 }).status).toBe(1);
  });

  it('keeps the gitleaks exit code when it finds a leak', () => {
    expect(scan({ output: '8:16PM INF 1 commits scanned.', exit: 1 }).status).toBe(1);
  });

  it('passes the log options to gitleaks as one argument', () => {
    const r = scan({ output: 'INF 2 commits scanned.', exit: 0 }, '--first-parent -m HEAD^1..HEAD');
    expect(r.args).toContain('--log-opts=--first-parent -m HEAD^1..HEAD');
  });

  it('scans the full history when no log options are set', () => {
    const r = scan({ output: 'INF 41 commits scanned.', exit: 0 });
    expect(r.args.some((a) => a.startsWith('--log-opts'))).toBe(false);
    expect(r.args).toContain('git');
  });

  it('marks the working directory as a safe git directory', () => {
    const r = scan({ output: 'INF 1 commits scanned.', exit: 0 });
    expect(r.args).toContain(`safe=safe.directory=${r.dir}`);
  });
});
