// The commit analyzer release.config.cjs loads: @semantic-release/commit-analyzer with the 0.x clamp.
import { createRequire } from 'node:module';

interface AnalyzerContext {
  lastRelease?: { version?: string };
}

interface CommitAnalyzer {
  analyzeCommits: (pluginConfig: unknown, context: AnalyzerContext) => Promise<string | null>;
}

const require = createRequire(import.meta.url);

/**
 * The release type commit-analyzer computes, except that a breaking change released from a 0.x
 * version is a minor: a major waits for the 1.0.0 cut, which removes this clamp. It wraps the
 * analyzer because semantic-release keeps the highest type any analyzer returns.
 */
export async function analyzeCommits(
  pluginConfig: unknown,
  context: AnalyzerContext,
): Promise<string | null> {
  const analyzer = (await import(
    require.resolve('@semantic-release/commit-analyzer')
  )) as CommitAnalyzer;
  const type = await analyzer.analyzeCommits(pluginConfig, context);
  const major = Number(context.lastRelease?.version?.split('.')[0] ?? 0);
  return type === 'major' && major < 1 ? 'minor' : type;
}
