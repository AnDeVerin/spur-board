import { JIRA_PROJECT_KEY, REF_NUMBER } from '@spur-board/contracts/browser';

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
 * `<owner>/<repo>#<n>` form. A Jira ticket gets null here, its URL comes from
 * `ticketBrowseHref`; a short `<repo>#<n>` ref has no URL the board knows; a session's URL comes
 * from `sessionLinkHref`.
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

/** A Jira task key, as `PROJ-12`, in the grammar of the contracts task key. */
const JIRA_KEY = new RegExp(`^${JIRA_PROJECT_KEY}-${REF_NUMBER}$`);

/**
 * The ticket page of a Jira key, `<base><key>`, where `base` is `config.get`
 * `projects[].ticketBrowseBase`; null when the base is null, the key is not Jira-shaped (free
 * text, `<owner>/<repo>#<n>`, `<repo>#<n>`) or the URL is not http(s).
 */
export function ticketBrowseHref(base: string | null, key: string): string | null {
  if (base === null || !JIRA_KEY.test(key)) return null;
  return safeExternalUrl(`${base}${encodeURIComponent(key)}`);
}
