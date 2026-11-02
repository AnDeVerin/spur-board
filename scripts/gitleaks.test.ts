import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('./gitleaks.sh', import.meta.url));

interface Fake {
  output: string;
  exit: number;
}

// Writes a fake executable that records its arguments and the safe.directory setting it
// sees, prints `output` and exits with `exit`.
function fakeBin(dir: string, name: string, fake: Fake): void {
  writeFileSync(
    join(dir, name),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$@" "safe=$GIT_CONFIG_KEY_0=$GIT_CONFIG_VALUE_0" > '${join(dir, `${name}.args`)}'`,
      `printf '%s\\n' '${fake.output}'`,
      `exit ${String(fake.exit)}`,
    ].join('\n'),
  );
  chmodSync(join(dir, name), 0o755);
}

function argsOf(dir: string, name: string): string[] | undefined {
  const file = join(dir, `${name}.args`);
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : undefined;
}

const RANGE_OK: Fake = { output: '21505ad2541d5be6135ed84fc33697146cf75b8e', exit: 0 };
const SCANNED: Fake = { output: '8:16PM INF 1 commits scanned.', exit: 0 };

// Runs scripts/gitleaks.sh with fake `git` and `gitleaks` first on PATH.
function scan(opts: { git?: Fake; gitleaks?: Fake; logOpts?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gitleaks-sh-'));
  fakeBin(dir, 'git', opts.git ?? RANGE_OK);
  fakeBin(dir, 'gitleaks', opts.gitleaks ?? SCANNED);
  const env: Record<string, string> = { PATH: `${dir}:${process.env['PATH'] ?? ''}` };
  if (opts.logOpts !== undefined) env['GITLEAKS_LOG_OPTS'] = opts.logOpts;
  const result = spawnSync('sh', [SCRIPT], { cwd: dir, env, encoding: 'utf8' });
  return {
    status: result.status,
    stderr: result.stderr,
    git: argsOf(dir, 'git'),
    gitleaks: argsOf(dir, 'gitleaks'),
    dir,
  };
}

describe('scripts/gitleaks.sh', () => {
  it('passes when gitleaks scanned commits and found nothing', () => {
    expect(scan().status).toBe(0);
  });

  it('passes a valid range that scans 0 commits, such as a deletion-only change', () => {
    const r = scan({ gitleaks: { output: '8:29PM INF 0 commits scanned.', exit: 0 } });
    expect(r.status).toBe(0);
  });

  it('fails closed when gitleaks exits 0 after logging a git error', () => {
    const r = scan({
      gitleaks: {
        output: '8:16PM ERR [git] fatal: detected dubious ownership\n8:16PM INF 0 commits scanned.',
        exit: 0,
      },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('gitleaks logged an error');
  });

  it('fails closed without running gitleaks when git log fails on the range', () => {
    const r = scan({ git: { output: 'fatal: bad revision', exit: 128 } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('git log failed');
    expect(r.gitleaks).toBeUndefined();
  });

  it('fails closed when the range has no commits', () => {
    const r = scan({ git: { output: '', exit: 0 } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no commits');
  });

  it('keeps the gitleaks exit code when it finds a leak', () => {
    expect(scan({ gitleaks: { output: 'WRN leaks found: 1', exit: 1 } }).status).toBe(1);
  });

  it('passes the log options to gitleaks as one argument and to git log as flags', () => {
    const r = scan({ logOpts: '--first-parent -m HEAD^1..HEAD' });
    expect(r.gitleaks).toContain('--log-opts=--first-parent -m HEAD^1..HEAD');
    expect(r.git?.slice(0, 5)).toEqual(['log', '--format=%H', '--first-parent', '-m', 'HEAD^1..HEAD']);
  });

  it('scans the full history when no log options are set', () => {
    const r = scan();
    expect(r.gitleaks?.some((a) => a.startsWith('--log-opts'))).toBe(false);
    expect(r.git?.slice(0, 3)).toEqual(['log', '--format=%H', `safe=safe.directory=${r.dir}`]);
  });

  it('marks the working directory as a safe git directory for git and gitleaks', () => {
    const r = scan();
    expect(r.git).toContain(`safe=safe.directory=${r.dir}`);
    expect(r.gitleaks).toContain(`safe=safe.directory=${r.dir}`);
  });
});
