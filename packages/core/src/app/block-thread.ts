import {
  assertNever,
  parseActorId,
  type ActorId,
  type AddresseeRole,
  type Config,
  type Persona,
} from '@spur-board/contracts';
import type { Selectable } from 'kysely';
import { parseAddressee } from '../domain/blocks/blocks.ts';
import type { BlockTable, TaskTable } from '../store/schema.ts';
import type { Trx } from './board-utils.ts';
import { curatorProject } from './authorize.ts';
import type { CommandContext } from './commands.ts';
import { enqueueConversationOpen, enqueueConversationReply } from './outbox.ts';
import type { BlockSubject } from './subject.ts';

type Task = Selectable<TaskTable>;
type Block = Selectable<BlockTable>;

export function orchestrator(config: Config, task: Task): string | null {
  const name = config.projects
    .find((project) => project.id === task.project)
    ?.columns.find((column) => column.id === task.column)?.orchestrator;
  return name === undefined || name === 'none' ? null : name;
}

/**
 * The role an actor speaks for on a block's subject. On a project-level block, which has no
 * column, an agent is the curator or a worker.
 */
export function authorRole(config: Config, subject: BlockSubject, actor: ActorId): AddresseeRole {
  if (actor === 'operator') return 'operator';
  const parsed = parseActorId(actor);
  if (
    parsed?.actor === 'agent' &&
    config.projects.some((project) =>
      project.spurProjects.some(
        (spur) => spur.name === parsed.actorRef.project && spur.role === 'operator',
      ),
    )
  ) {
    return 'operator';
  }
  if (parsed?.actor !== 'agent') return 'worker';
  const { task } = subject;
  if (task !== null && parsed.actorRef.project === orchestrator(config, task))
    return `orchestrator:${task.column}`;
  return parsed.actorRef.project === curatorProject(config, subject.project) ? 'curator' : 'worker';
}

function personaRole(role: AddresseeRole): Persona['role'] {
  const addressee = parseAddressee(role);
  switch (addressee.kind) {
    case 'operator':
      return 'board';
    case 'worker':
      return 'worker';
    case 'curator':
      return 'curator';
    case 'orchestrator':
      return 'orchestrator';
    default:
      return assertNever(addressee);
  }
}

export function personaFor(config: Config, subject: BlockSubject, actor: ActorId): Persona {
  if (actor === 'system') return { name: 'board', role: 'board' };
  if (actor === 'operator') return { name: 'operator', role: 'board' };
  const parsed = parseActorId(actor);
  if (parsed?.actor !== 'agent') throw new Error('Invalid actor');
  const { project } = parsed.actorRef;
  const entry = config.projects
    .flatMap((p) => p.spurProjects)
    .find((spur) => spur.name === project);
  return {
    name: entry?.displayName ?? project,
    role: personaRole(authorRole(config, subject, actor)),
    ...(entry?.icon === undefined ? {} : { icon: entry.icon }),
  };
}

export async function queueBlockOpen(
  trx: Trx,
  subject: BlockSubject,
  block: Block,
  ctx: CommandContext,
  config: Config,
): Promise<void> {
  if (authorRole(config, subject, block.author) === 'operator') return;
  const comments = await trx
    .selectFrom('comment')
    .select(['id', 'author'])
    .where('block_id', '=', block.id)
    .orderBy('id')
    .execute();
  const opened = await enqueueConversationOpen(trx, {
    blockId: block.id,
    commentId: comments[0]?.id ?? null,
    persona: personaFor(config, subject, comments[0]?.author ?? block.author),
    at: new Date(ctx.at),
  });
  if (opened === null) return;
  for (const comment of comments.slice(1)) {
    await enqueueConversationReply(trx, {
      commentId: comment.id,
      persona: personaFor(config, subject, comment.author),
      at: new Date(ctx.at),
    });
  }
}
