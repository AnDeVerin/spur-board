/** External facts are untrusted, including their navigation URLs. */
export function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** `<owner>/<repo>#<n>`, the GitHub form of a pull request or issue ref. */
const GITHUB_REF = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;

/** The GitHub owner, repo and number of a ref in `<owner>/<repo>#<n>` form; else null. */
export function githubRef(ref: string): { owner: string; repo: string; number: string } | null {
  const match = GITHUB_REF.exec(ref);
  if (!match) return null;
  const [, owner = '', repo = '', number = ''] = match;
  return { owner, repo, number };
}

/**
 * The web URL of a `task.get` link: a pull request or a GitHub issue ticket in
 * `<owner>/<repo>#<n>` form. A Jira ticket and a short `<repo>#<n>` ref have no URL the board
 * knows, so they get null; a session's URL comes from `sessionLinkHref`.
 */
export function taskLinkHref(link: { kind: string; ref: string }): string | null {
  if (link.kind !== 'pr' && link.kind !== 'ticket') return null;
  const ref = githubRef(link.ref);
  if (!ref) return null;
  const path = link.kind === 'pr' ? 'pull' : 'issues';
  return safeExternalUrl(`https://github.com/${ref.owner}/${ref.repo}/${path}/${ref.number}`);
}

/**
 * The Spur UI page of a session, `<origin>/sessions/<id>`, with the id as one path segment;
 * null when `web.spurUiOrigin` is null or the URL is not http(s).
 */
export function sessionLinkHref(origin: string | null, id: string): string | null {
  if (origin === null) return null;
  return safeExternalUrl(`${origin.replace(/\/+$/, '')}/sessions/${encodeURIComponent(id)}`);
}
