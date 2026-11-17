import { execFileSync } from 'node:child_process';

/** Resolve the checkout's reachable release, with a local-development fallback. */
export function standVersion(repositoryDir: string): string {
  try {
    return (
      execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*'], {
        cwd: repositoryDir,
        // Do not inherit Git overrides that could select a different repository or run hooks.
        env: { PATH: process.env['PATH'] ?? '' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .trim()
        .replace(/^v/, '') || 'dev'
    );
  } catch {
    // Git and release tags are optional for a disposable stand.
    return 'dev';
  }
}
