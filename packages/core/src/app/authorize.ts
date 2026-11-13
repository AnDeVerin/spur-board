import type {
  ActorId,
  AddresseeRole,
  BlockType,
  ColumnId,
  Config,
  GrantRule,
} from '@spur-board/contracts';
import { assertNever, parseActorId } from '@spur-board/contracts';
import { parseAddressee } from '../domain/blocks/blocks.ts';

export interface AuthorizationTarget {
  readonly project: string;
  readonly task: { readonly id: number; readonly column: ColumnId } | null;
  readonly block: {
    readonly type: BlockType;
    readonly author: ActorId;
    readonly addressee_role: AddresseeRole;
  } | null;
  readonly workers: readonly {
    readonly session_id: string | null;
    readonly role: string | null;
    readonly banned: number;
  }[];
}

/** A missing target is carried past authorization so a state error cannot precede a denial.
 * `id` identifies the object actually resolved for an input ID in a batch.
 */
export type ResolvedTarget =
  | { readonly kind: 'found'; readonly value: AuthorizationTarget; readonly id?: string }
  | { readonly kind: 'missing'; readonly id?: string };

export interface AuthorizationState {
  readonly config: Config;
  readonly target: ResolvedTarget;
  readonly mode?: string;
}

export type AuthorizationDecision =
  | { readonly status: 'allowed' }
  | { readonly status: 'unresolved' }
  | { readonly status: 'denied'; readonly hint: string };

/** True for the operator token and for a session of a Spur project with the `operator` role. */
export function isOperator(actor: ActorId, config: Config): boolean {
  if (actor === 'operator') return true;
  const parsed = parseActorId(actor);
  return (
    parsed?.actor === 'agent' &&
    config.projects.some((project) =>
      project.spurProjects.some(
        (spur) => spur.name === parsed.actorRef.project && spur.role === 'operator',
      ),
    )
  );
}

/** The Spur project that curates one board project, or null when it has none. */
export function curatorProject(config: Config, projectId: string): string | null {
  return (
    config.projects
      .find((project) => project.id === projectId)
      ?.spurProjects.find((spur) => spur.role === 'curator')?.name ?? null
  );
}

function worker(actor: ActorId, target: AuthorizationTarget): boolean {
  const parsed = parseActorId(actor);
  return (
    parsed?.actor === 'agent' &&
    target.task !== null &&
    target.workers.some(
      (link) =>
        link.session_id === parsed.actorRef.session && link.role === 'worker' && link.banned === 0,
    )
  );
}

function orchestrator(
  actor: ActorId,
  target: AuthorizationTarget,
  config: Config,
  column: ColumnId,
): boolean {
  const project = config.projects.find((entry) => entry.id === target.project);
  const configured = project?.columns.find((entry) => entry.id === column)?.orchestrator;
  if (configured === 'operator') return isOperator(actor, config);
  const parsed = parseActorId(actor);
  return (
    parsed?.actor === 'agent' && configured !== 'none' && configured === parsed.actorRef.project
  );
}

/** A curator or orchestrator project of the board project; `none` and `operator` name no project. */
function roleProject(name: string, projectId: string, config: Config): boolean {
  if (name === curatorProject(config, projectId)) return true;
  if (name === 'none' || name === 'operator') return false;
  return (
    config.projects
      .find((project) => project.id === projectId)
      ?.columns.some((column) => column.orchestrator === name) === true
  );
}

/** A worker's identity is its session; a role's outlives the session, unless it worked the task. */
function blockAuthor(actor: ActorId, target: AuthorizationTarget, config: Config): boolean {
  const author = target.block?.author;
  if (author === undefined || author === 'system') return false;
  if (author === actor) return true;
  const by = parseActorId(actor);
  const of = parseActorId(author);
  if (by?.actor !== 'agent' || of?.actor !== 'agent') return false;
  if (by.actorRef.project !== of.actorRef.project) return false;
  const worked = (session: string) =>
    target.workers.some(
      (link) => link.session_id === session && (link.role === 'worker' || link.role === 'other'),
    );
  return (
    roleProject(by.actorRef.project, target.project, config) &&
    !worked(by.actorRef.session) &&
    !worked(of.actorRef.session)
  );
}

function matches(
  rule: GrantRule,
  actor: ActorId,
  target: AuthorizationTarget,
  config: Config,
): boolean {
  const parsed = parseActorId(actor);
  switch (rule.grant) {
    case 'operator':
      return isOperator(actor, config);
    case 'project-agent':
      return (
        parsed?.actor === 'agent' &&
        config.projects
          .find((project) => project.id === target.project)
          ?.spurProjects.some((spur) => spur.name === parsed.actorRef.project) === true
      );
    case 'task-worker':
      return worker(actor, target);
    case 'column-orchestrator':
      return target.task !== null && orchestrator(actor, target, config, target.task.column);
    case 'block-addressee': {
      if (target.block === null) return false;
      const addressee = parseAddressee(target.block.addressee_role);
      switch (addressee.kind) {
        case 'operator':
          return isOperator(actor, config);
        case 'curator':
          return (
            parsed?.actor === 'agent' &&
            parsed.actorRef.project === curatorProject(config, target.project)
          );
        case 'worker':
          return worker(actor, target);
        case 'orchestrator':
          return orchestrator(actor, target, config, addressee.column);
        default:
          return assertNever(addressee);
      }
    }
    case 'block-author':
      return blockAuthor(actor, target, config);
  }
}

/** Evaluate catalog grants against a trusted actor and the target's current board state. */
export function authorize(
  grants: 'any' | readonly GrantRule[],
  actor: ActorId,
  state: AuthorizationState,
): AuthorizationDecision {
  if (grants === 'any') return { status: 'allowed' };
  const rules = grants.filter((rule) => rule.mode === undefined || rule.mode === state.mode);
  const hint = `Allowed role: ${[...new Set(rules.map((rule) => rule.grant))].join(', ') || 'none'}.`;
  if (state.target.kind === 'missing') {
    if (rules.some((rule) => rule.grant === 'operator' && isOperator(actor, state.config))) {
      return { status: 'allowed' };
    }
    return rules.every((rule) => rule.grant === 'operator')
      ? { status: 'denied', hint }
      : { status: 'unresolved' };
  }
  const target = state.target.value;
  if (
    rules.some(
      (rule) =>
        (rule.blockTypes === undefined ||
          (target.block !== null && rule.blockTypes.includes(target.block.type))) &&
        matches(rule, actor, target, state.config),
    )
  ) {
    return { status: 'allowed' };
  }
  return { status: 'denied', hint };
}
