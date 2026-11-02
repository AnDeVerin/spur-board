// Session identity, credentials and proxy settings that must never reach test code.
const PREFIXES = ['SPUR_', 'BOARD_', 'SLACK_', 'JIRA_', 'GBRAIN_', 'ANTHROPIC_', 'OPENAI_'];
const EXACT = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  // A localhost proxy is an allowed network target, so a leaked proxy setting
  // would route remote traffic around the network guard.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'NODE_USE_ENV_PROXY',
]);
const SUFFIXES = ['_API_KEY', '_TOKEN', '_SECRET', '_PASSWORD'];

export function isScrubbed(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    EXACT.has(upper) ||
    PREFIXES.some((prefix) => upper.startsWith(prefix)) ||
    SUFFIXES.some((suffix) => upper.endsWith(suffix))
  );
}

/** Deletes every scrubbed name from `env` and returns the deleted names. */
export function scrubEnv(env: NodeJS.ProcessEnv): string[] {
  const removed = Object.keys(env).filter(isScrubbed);
  for (const name of removed) {
    Reflect.deleteProperty(env, name);
  }
  return removed;
}
