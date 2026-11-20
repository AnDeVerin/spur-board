// The GitHub Project status of a tracker repository's open issues, for a ready-for-dev column
// that mirrors it, and for `board doctor`.
import {
  AdapterError,
  type Adapter,
  type AdapterErrorKind,
  type Batch,
  type MirrorFailureCode,
  type ReadinessState,
  type ReadyMirror,
} from '@spur-board/contracts';
import { z } from 'zod';
import { parseWire } from '../runner/wire.ts';
import { GithubClient, type GraphError } from './client.ts';

/**
 * One read of the Project, its field and options, and the Project items of the repository's open
 * issues. The items are read through each issue's `projectItems` and matched to the Project by id
 * here: the Project's own `items` are never listed.
 */
export const PROJECT_MIRROR_QUERY =
  'query ProjectMirror($owner: String!, $repo: String!, $projectOwner: String!, $number: Int!, $field: String!) { rateLimit { cost limit remaining resetAt } repositoryOwner(login: $projectOwner) { ... on ProjectV2Owner { projectV2(number: $number) { id title field(name: $field) { __typename ... on ProjectV2SingleSelectField { id options { id name } } } } } } repository(owner: $owner, name: $repo) { issues(first: 100, states: [OPEN]) { pageInfo { hasNextPage } nodes { number projectItems(first: 20, includeArchived: true) { pageInfo { hasNextPage } nodes { isArchived project { id } fieldValueByName(name: $field) { __typename ... on ProjectV2ItemFieldSingleSelectValue { optionId } } } } } } } }';

const MALFORMED = 'Malformed GitHub Project response';
const SINGLE_SELECT = 'ProjectV2SingleSelectField';
const pageWire = z.object({ hasNextPage: z.boolean() });
const ownerWire = z
  .object({
    // Absent when the owner is not a Project owner, as for an owner of another type.
    projectV2: z
      .object({
        id: z.string().min(1),
        title: z.string().min(1),
        field: z
          .object({
            __typename: z.string(),
            options: z.array(z.object({ id: z.string().min(1), name: z.string() })).optional(),
          })
          .nullable(),
      })
      .nullish(),
  })
  .nullable();
const repositoryWire = z
  .object({
    issues: z.object({
      pageInfo: pageWire,
      nodes: z.array(
        z.object({
          number: z.int().positive(),
          // Null only with an error, which fails the read first; a null item is never guessed.
          projectItems: z
            .object({
              pageInfo: pageWire,
              nodes: z.array(
                z
                  .object({
                    isArchived: z.boolean(),
                    project: z.object({ id: z.string() }),
                    fieldValueByName: z
                      .object({ __typename: z.string(), optionId: z.string().nullish() })
                      .nullable(),
                  })
                  .nullable(),
              ),
            })
            .nullable(),
        }),
      ),
    }),
  })
  .nullable();

/** The tracker repository, `owner/name`, and the Project status its ready-for-dev mirrors. */
interface MirrorTarget {
  repo: string;
  mirror: Pick<ReadyMirror, 'owner' | 'number' | 'field' | 'value'>;
}

interface MirrorRead {
  projectId: string;
  title: string;
  /** The id of the option named by the configured value. */
  optionId: string;
  /** One entry per open issue of the repository, keyed `<repo>#<number>` as the tracker is. */
  readiness: { key: string; state: ReadinessState }[];
  budget: NonNullable<Batch['budget']>;
}

function failure(
  kind: AdapterErrorKind,
  code: MirrorFailureCode,
  message: string,
  options: { retryAt?: Date | undefined; cause?: unknown } = {},
): AdapterError {
  return new AdapterError(kind, message, { ...options, code });
}

function forbidden(target: MirrorTarget, cause?: unknown): AdapterError {
  const { owner, number } = target.mirror;
  return failure(
    'auth',
    'mirror_project_forbidden',
    `GitHub Project ${owner}/${String(number)} was not found or is not readable: check the number and the read:project scope`,
    cause === undefined ? {} : { cause },
  );
}

function fieldNotFound(target: MirrorTarget): AdapterError {
  const { owner, number, field, value } = target.mirror;
  return failure(
    'config',
    'mirror_field_not_found',
    `GitHub Project ${owner}/${String(number)} has no single-select field ${field} with option ${value}`,
  );
}

/** A client failure as the mirror reports it; an abort and a non-`AdapterError` pass through. */
function coded(error: unknown, target: MirrorTarget, signal: AbortSignal): unknown {
  if (signal.aborted || !(error instanceof AdapterError) || error.code !== undefined) return error;
  if (error.kind === 'auth') return forbidden(target, error);
  if (error.kind === 'throttled')
    return failure('throttled', 'mirror_rate_limited', error.message, {
      retryAt: error.retryAt,
      cause: error,
    });
  return failure(error.kind, 'mirror_read_failed', error.message, { cause: error });
}

/** The failure a GraphQL error means, by its path: the Project, its field, or anything else. */
function graphFailure(errors: readonly GraphError[], target: MirrorTarget): AdapterError | null {
  const under = (error: GraphError, ...path: string[]) =>
    path.every((part, i) => error.path?.[i] === part);
  if (errors.some((error) => under(error, 'repositoryOwner') && error.path?.[2] !== 'field'))
    return forbidden(target);
  if (errors.some((error) => under(error, 'repositoryOwner', 'projectV2', 'field')))
    return fieldNotFound(target);
  if (errors.length > 0)
    return failure('transient', 'mirror_read_failed', 'GitHub Project read returned an error');
  return null;
}

/**
 * Reads the mirror once through `client`. `cachedOptionId` is the option id an earlier read
 * resolved; without it the configured value is resolved by name. Throws an `AdapterError` with a
 * mirror failure code for every failure but an abort, so nothing partial is ever returned.
 */
async function readMirrorWith(
  client: GithubClient,
  target: MirrorTarget,
  signal: AbortSignal,
  cachedOptionId?: string,
): Promise<MirrorRead> {
  const [owner, repo] = target.repo.split('/');
  if (!owner || !repo)
    throw failure('config', 'mirror_read_failed', 'Invalid GitHub Issues repository');
  const { mirror } = target;
  try {
    const response = await client.query(
      PROJECT_MIRROR_QUERY,
      { owner, repo, projectOwner: mirror.owner, number: mirror.number, field: mirror.field },
      signal,
    );
    const failed = graphFailure(response.errors, target);
    if (failed !== null) throw failed;
    const project = parseWire(ownerWire, response.data['repositoryOwner'], MALFORMED, [
      'data',
      'repositoryOwner',
    ])?.projectV2;
    if (project === null || project === undefined) throw forbidden(target);
    const options = project.field?.__typename === SINGLE_SELECT ? project.field.options : undefined;
    const optionId =
      cachedOptionId === undefined
        ? options?.find((option) => option.name === mirror.value)?.id
        : options?.some((option) => option.id === cachedOptionId) === true
          ? cachedOptionId
          : undefined;
    if (optionId === undefined) throw fieldNotFound(target);
    const repository = parseWire(repositoryWire, response.data['repository'], MALFORMED, [
      'data',
      'repository',
    ]);
    if (repository === null)
      throw failure('transient', 'mirror_read_failed', 'GitHub repository was not returned');
    const issues = repository.issues;
    const readiness: MirrorRead['readiness'] = [];
    let incomplete = issues.pageInfo.hasNextPage;
    for (const issue of issues.nodes) {
      const items = issue.projectItems;
      if (items === null || items.nodes.includes(null))
        throw failure('transient', 'mirror_read_failed', 'GitHub Project items were not returned');
      if (items.pageInfo.hasNextPage) incomplete = true;
      const ready = items.nodes.some(
        (item) =>
          item !== null &&
          item.project.id === project.id &&
          !item.isArchived &&
          item.fieldValueByName?.optionId === optionId,
      );
      readiness.push({
        key: `${target.repo}#${String(issue.number)}`,
        state: ready ? 'ready' : 'not_ready',
      });
    }
    if (incomplete)
      throw failure(
        'transient',
        'mirror_snapshot_incomplete',
        'GitHub Project read did not fit one page',
      );
    return {
      projectId: project.id,
      title: project.title,
      optionId,
      readiness,
      budget: response.budget,
    };
  } catch (error) {
    throw coded(error, target, signal);
  }
}

/**
 * Reads the mirror once with `token`, for `board doctor`: the result, or an `AdapterError`
 * carrying its mirror failure code.
 */
export function readProjectMirror(
  target: MirrorTarget,
  {
    token,
    now,
    fetch: fetcher,
    signal,
  }: { token: string; now: () => number; fetch?: typeof fetch; signal: AbortSignal },
  cachedOptionId?: string,
): Promise<MirrorRead> {
  return readMirrorWith(new GithubClient(token, now, fetcher), target, signal, cachedOptionId);
}

interface GithubProjectOptions extends MirrorTarget {
  id: string;
  token: string;
  intervalMs: number;
  now: () => number;
  fetch?: typeof fetch;
}

/**
 * A github-project source: each poll is one complete read of the mirror, or a failure. The
 * option id resolved by the first read is kept, so a renamed option still matches and a removed
 * one fails `mirror_field_not_found`.
 */
export function createGithubProjectAdapter(options: GithubProjectOptions): Adapter {
  const client = new GithubClient(options.token, options.now, options.fetch);
  let optionId: string | undefined;
  return {
    id: options.id,
    intervalMs: options.intervalMs,
    takeUsage: () => client.takeUsage(),
    async poll(context) {
      const observedAt = new Date(options.now()).toISOString();
      try {
        const read = await readMirrorWith(client, options, context.signal, optionId);
        optionId = read.optionId;
        const usage = client.takeUsage();
        return {
          source: options.id,
          observedAt,
          complete: true,
          items: [],
          entities: [],
          mirror: { title: read.title, readiness: read.readiness },
          ...(usage === undefined ? {} : { usage }),
          budget: read.budget,
        };
      } catch (error) {
        if (error instanceof AdapterError) error.usage = client.takeUsage();
        throw error;
      }
    },
  };
}
