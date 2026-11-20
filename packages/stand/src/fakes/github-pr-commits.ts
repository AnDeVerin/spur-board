// The commits of a fake GitHub pull request as `PrCommits` reads them.
import { createHash } from 'node:crypto';
import type { Pr } from './github-pr-control.ts';
import type { Args, WireObject } from './graphql.ts';

/** The base-branch commit a PR's first commit sits on by default; never one of its commits. */
export const BASE_SHA = createHash('sha1').update('stand-base').digest('hex');

/**
 * The PR's last `last` commits as `commits(last:)` lists them, each with its root tree and its
 * parents' trees. The trees hold every seeded `changed` name plus `README.md`; an entry's oid
 * moves exactly at the commits that list it, and a parent not listed has the base tree.
 */
export function commitsView(commits: Pr['commits'], args: Args): WireObject {
  const names = new Set(['README.md', ...commits.flatMap((commit) => commit.changed)]);
  const byOid = new Map(commits.map((commit) => [commit.oid, commit]));
  const versions = new Map<string, Map<string, string>>();
  const base = new Map([...names].map((name) => [name, 'base']));
  // Which commit last changed each entry; a cycle or an unlisted parent reads as base.
  const versionOf = (oid: string | undefined, seen = new Set<string>()): Map<string, string> => {
    const commit = oid === undefined ? undefined : byOid.get(oid);
    if (commit === undefined || seen.has(commit.oid)) return base;
    const known = versions.get(commit.oid);
    if (known !== undefined) return known;
    seen.add(commit.oid);
    const own = new Map(versionOf(commit.parents[0], seen));
    for (const name of commit.changed) own.set(name, commit.oid);
    versions.set(commit.oid, own);
    return own;
  };
  const tree = (oid: string): WireObject => ({
    entries: [...versionOf(oid)].map(([name, version]) => ({
      name: name.replace(/\/$/, ''),
      type: name.endsWith('/') ? 'tree' : 'blob',
      oid: createHash('sha1').update(`${name}@${version}`).digest('hex'),
    })),
  });
  const listed = commits.slice(-Number(args['last']));
  return {
    totalCount: commits.length,
    pageInfo: { hasPreviousPage: listed.length < commits.length },
    nodes: listed.map((commit) => ({
      commit: {
        oid: commit.oid,
        tree: tree(commit.oid),
        parents: (parentArgs: Args) => ({
          totalCount: commit.parents.length,
          nodes: commit.parents
            .slice(0, Number(parentArgs['first']))
            .map((oid) => ({ oid, tree: tree(oid) })),
        }),
      },
    })),
  };
}
