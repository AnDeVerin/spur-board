import { SESSION_STATUSES, actorIdSchema, type ActorId, type Config } from '@spur-board/contracts';
import type { Store } from '../store/store.ts';
import { CommandError } from '../app/commands.ts';

/** A normalized response from the live session-detail endpoint. A null result means 404. */
export interface LiveSession {
  readonly project: string;
  readonly status: string;
}

export interface IdentityPorts {
  readonly store: Store;
  readonly config: Config;
  readonly lookupSession: (id: string) => Promise<LiveSession | null>;
  readonly verifyToken: (token: string) => Promise<{ name: string } | null>;
}

export interface IdentifiedCaller {
  readonly actor: ActorId;
  readonly tokenName?: string;
}

function sessionActor(project: string, session: string, config: Config): ActorId {
  const matches = config.projects.filter((entry) =>
    entry.spurProjects.some((spur) => spur.name === project),
  );
  if (matches.length !== 1) throw new CommandError('forbidden', 'Unknown session project.');
  const actor = actorIdSchema.safeParse(`agent:${project}/${session}`);
  if (!actor.success) throw new CommandError('forbidden', 'Invalid session identity.');
  return actor.data;
}

/** Resolve the caller at the HTTP boundary; a session header always outranks a token. */
export async function identifyCaller(
  ports: IdentityPorts,
  headers: { session: string | undefined; authorization: string | undefined },
): Promise<IdentifiedCaller> {
  const { session, authorization } = headers;
  if (session !== undefined) {
    if (!actorIdSchema.safeParse(`agent:project/${session}`).success) {
      throw new CommandError('forbidden', 'Invalid session identity.');
    }
    const snapshot = await ports.store.db
      .selectFrom('session_snapshot')
      .select(['spur_project', 'ended_at', 'raw_state', 'state'])
      .where('id', '=', session)
      .executeTakeFirst();
    if (snapshot !== undefined) {
      if (
        snapshot.ended_at !== null ||
        snapshot.raw_state === 'completed' ||
        snapshot.raw_state === 'killed' ||
        snapshot.state === 'completed' ||
        snapshot.state === 'killed'
      ) {
        throw new CommandError('forbidden', 'The session has ended.');
      }
      return { actor: sessionActor(snapshot.spur_project, session, ports.config) };
    }
    let live: LiveSession | null;
    try {
      live = await ports.lookupSession(session);
    } catch {
      throw new CommandError('identity_unavailable', 'Session identity is unavailable.');
    }
    if (live === null) throw new CommandError('forbidden', 'Unknown session.');
    if (
      typeof live !== 'object' ||
      typeof live.project !== 'string' ||
      typeof live.status !== 'string' ||
      !SESSION_STATUSES.some((status) => status === live.status)
    ) {
      throw new CommandError('identity_unavailable', 'Invalid session response.');
    }
    if (live.status === 'completed' || live.status === 'killed') {
      throw new CommandError('forbidden', 'The session has ended.');
    }
    return { actor: sessionActor(live.project, session, ports.config) };
  }
  const bearer = authorization?.match(/^Bearer (\S+)$/i)?.[1];
  if (bearer !== undefined) {
    try {
      const token = await ports.verifyToken(bearer);
      if (token !== null) return { actor: 'operator', tokenName: token.name };
    } catch {
      throw new CommandError('identity_unavailable', 'Token verification is unavailable.');
    }
  }
  throw new CommandError('forbidden', 'A session or accepted token is required.');
}

/** Actor-only form used where audit metadata is unnecessary. */
export async function identify(
  ports: IdentityPorts,
  headers: { session: string | undefined; authorization: string | undefined },
): Promise<ActorId> {
  return (await identifyCaller(ports, headers)).actor;
}
