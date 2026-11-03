import type { ActorId, BlockType, ColumnId, Config, GrantRule } from '@spur-board/contracts';
import { parseActorId } from '@spur-board/contracts';

export interface AuthorizationTarget {
  readonly project: string;
  readonly task: { readonly id: number; readonly column: ColumnId } | null;
  readonly block: {
    readonly type: BlockType;
    readonly author: ActorId;
    readonly addressee_role: 'operator' | 'worker' | `orchestrator:${ColumnId}`;
  } | null;
  readonly workers: readonly {
    readonly session_id: string | null;
    readonly role: string | null;
    readonly banned: number;
  }[];
}

/** A missing target is carried past authorization so a state error cannot precede a denial. */
export type ResolvedTarget =
  { readonly kind: 'found'; readonly value: AuthorizationTarget } | { readonly kind: 'missing' };

export interface AuthorizationState {
  readonly config: Config;
  readonly target: ResolvedTarget;
  readonly mode?: string;
}

export type AuthorizationDecision =
  | { readonly status: 'allowed' }
  | { readonly status: 'unresolved' }
  | { readonly status: 'denied'; readonly hint: string };

function operator(actor: ActorId, config: Config): boolean {
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
  if (configured === 'operator') return operator(actor, config);
  const parsed = parseActorId(actor);
  return (
    parsed?.actor === 'agent' && configured !== 'none' && configured === parsed.actorRef.project
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
      return operator(actor, config);
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
      const role = target.block.addressee_role;
      if (role === 'operator') return operator(actor, config);
      if (role === 'worker') return worker(actor, target);
      return orchestrator(actor, target, config, role.slice('orchestrator:'.length) as ColumnId);
    }
    case 'block-author':
      return target.block?.author === actor;
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
    if (rules.some((rule) => rule.grant === 'operator' && operator(actor, state.config))) {
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
