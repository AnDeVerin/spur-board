// What changed after each approval of a PR that is not on its head, from one `commitsQuery` read:
// the commits after it and the top-level entries they changed, base-branch merges left out.
import type { PrApprovalPair, PrFacts } from '@spur-board/contracts';
import { z } from 'zod';
import type { ResponseData } from './client.ts';

// A top-level entry; `type` stays a string (`tree`, `blob`, a submodule's `commit`). A name with
// a slash is no top-level entry, so the read is unreadable rather than a pair the batch rejects.
// `mode` is git's file mode as a number: `chmod +x` changes it and keeps the blob.
const entryWire = z.object({
  name: z.string().regex(/^[^/]+$/),
  type: z.string(),
  mode: z.int(),
  oid: z.string(),
});
// Null entries are an unreadable tree, never an empty one.
const treeWire = z.object({ entries: z.array(entryWire).nullable() });
const commitWire = z.object({
  oid: z.string(),
  tree: treeWire,
  parents: z.object({
    totalCount: z.int().nonnegative(),
    nodes: z.array(z.object({ oid: z.string(), tree: treeWire })),
  }),
});
const commitsRootWire = z
  .object({
    pullRequest: z
      .object({
        baseRefName: z.string(),
        commits: z.object({
          totalCount: z.int().nonnegative(),
          pageInfo: z.object({ hasPreviousPage: z.boolean() }),
          nodes: z.array(z.object({ commit: commitWire })),
        }),
      })
      .nullable(),
  })
  .nullable();
type Commit = z.output<typeof commitWire>;
type Entry = z.output<typeof entryWire>;

/** The approved commits of `facts` that are not its head, once each, in review order. */
export function offHeadApprovals(facts: PrFacts): string[] {
  const shas = facts.reviews
    .filter((review) => review.state === 'approved' && review.commitSha !== facts.headSha)
    .map((review) => review.commitSha);
  return [...new Set(shas)];
}

/**
 * The top-level entries that differ between two root trees, by content or by mode: `name/` for a
 * tree, else `name`.
 */
function changedEntries(tree: readonly Entry[], parent: readonly Entry[]): string[] {
  const own = new Map(tree.map((entry) => [entry.name, entry]));
  const before = new Map(parent.map((entry) => [entry.name, entry]));
  const out: string[] = [];
  for (const name of new Set([...own.keys(), ...before.keys()])) {
    const now = own.get(name);
    const then = before.get(name);
    const entry = now ?? then;
    if (entry !== undefined && (now?.oid !== then?.oid || now?.mode !== then?.mode))
      out.push(entry.type === 'tree' ? `${name}/` : name);
  }
  return out;
}

/**
 * The pair of every approval of `facts` off its head, or `'unreadable'` when the response cannot
 * answer for this head: any GraphQL error, a null repository or pull request, a malformed part, a
 * null tree, a commit with parents left out, or the head missing from the list. Never throws on
 * response content.
 *
 * More than 100 commits gives `pr_too_large`. An approved commit is an ancestor of the head when
 * the head reaches it through listed parents, or when it is an unlisted parent of a commit the
 * head reaches: a commit that landed on the base drops out of the list. Any other gives
 * `history_rewritten`. Otherwise the commits after an approval are those the head reaches and it
 * does not; only those with fewer than two parents count, each compared with its first parent's
 * root tree, so a merge from the base adds neither commits nor entries. `base` is the base branch
 * the list was read against.
 */
export function approvalPairs(
  facts: PrFacts,
  response: Pick<ResponseData, 'data' | 'errors'>,
): { pairs: PrApprovalPair[]; base: string } | 'unreadable' {
  if (response.errors.length > 0) return 'unreadable';
  const parsed = commitsRootWire.safeParse(response.data['repository']);
  const pr = parsed.success ? parsed.data?.pullRequest : undefined;
  if (pr === undefined || pr === null) return 'unreadable';
  const { commits, baseRefName: base } = pr;
  const listed = commits.nodes.map((node) => node.commit);
  const readable = listed.every(
    (commit) =>
      commit.tree.entries !== null &&
      commit.parents.nodes.length === commit.parents.totalCount &&
      commit.parents.nodes.every((parent) => parent.tree.entries !== null),
  );
  if (!readable) return 'unreadable';
  const headSha = facts.headSha;
  const approved = offHeadApprovals(facts);
  if (commits.totalCount > listed.length || commits.pageInfo.hasPreviousPage)
    return {
      pairs: approved.map((approvedSha) => ({ approvedSha, headSha, notCounted: 'pr_too_large' })),
      base,
    };
  const byOid = new Map(listed.map((commit) => [commit.oid, commit]));
  if (!byOid.has(headSha)) return 'unreadable';
  // Commits reachable from `start` through parents in the list; base history is not listed.
  const reach = (start: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [start];
    for (let oid = stack.pop(); oid !== undefined; oid = stack.pop()) {
      const commit = byOid.get(oid);
      if (commit === undefined || seen.has(oid)) continue;
      seen.add(oid);
      for (const parent of commit.parents.nodes) stack.push(parent.oid);
    }
    return seen;
  };
  const fromHead = reach(headSha);
  // Base history the head's listed commits name as parents.
  const unlisted = new Set(
    [...fromHead].flatMap((oid) =>
      (byOid.get(oid)?.parents.nodes ?? [])
        .map((parent) => parent.oid)
        .filter((parent) => !byOid.has(parent)),
    ),
  );
  const pairs = approved.map((approvedSha): PrApprovalPair => {
    if (!fromHead.has(approvedSha) && !unlisted.has(approvedSha))
      return { approvedSha, headSha, notCounted: 'history_rewritten' };
    const before = reach(approvedSha);
    const after = [...fromHead]
      .filter((oid) => !before.has(oid))
      .map((oid) => byOid.get(oid))
      .filter((commit): commit is Commit => commit !== undefined && commit.parents.totalCount < 2);
    const changed = new Set(
      after.flatMap((commit) =>
        changedEntries(commit.tree.entries ?? [], commit.parents.nodes[0]?.tree.entries ?? []),
      ),
    );
    return { approvedSha, headSha, commitsAfter: after.length, changed: [...changed].sort() };
  });
  return { pairs, base };
}
