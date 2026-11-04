import {
  parseActorId,
  type ActorId,
  type AddresseeRole,
  type BlockOutcome,
  type BlockType,
  type ColumnId,
} from '@spur-board/contracts';

export class BlockRuleError extends Error {
  readonly code: 'block_not_open' | 'wrong_block_type' | 'forbidden' | 'stale_comment_revision';
  constructor(
    code: 'block_not_open' | 'wrong_block_type' | 'forbidden' | 'stale_comment_revision',
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

interface Routing {
  type: BlockType;
  author: ActorId;
  authorRole: AddresseeRole;
  column: ColumnId;
  orchestrator: string | null;
  hasWorker: boolean;
}

/** Roles survive a change in the session currently filling them. */
export function blockAddressee(input: Routing): AddresseeRole {
  const { type, author, authorRole, column, orchestrator, hasWorker } = input;
  if (author === 'system') {
    return orchestrator !== null ? `orchestrator:${column}` : hasWorker ? 'worker' : 'operator';
  }
  if (type === 'code') return 'worker';
  if (type === 'dependency' || type === 'external') return authorRole;
  if (orchestrator === null) return 'operator';
  if (orchestrator === 'operator') return 'operator';
  const parsed = parseActorId(author);
  if (parsed?.actor === 'agent' && parsed.actorRef.project === orchestrator) return 'operator';
  return `orchestrator:${column}`;
}

export interface CurrentBlock {
  type: BlockType;
  state: 'open' | 'unblocked';
  outcome: BlockOutcome | null;
  unblockedBy: ActorId | null;
  author: ActorId;
  addressee: AddresseeRole;
}

function requireOpen(block: CurrentBlock): void {
  if (block.state === 'open') return;
  throw new BlockRuleError(
    'block_not_open',
    `Block was ${block.outcome ?? 'unblocked'} by ${block.unblockedBy ?? 'unknown'}.`,
  );
}

export function escalateBlock(block: CurrentBlock): { addressee: AddresseeRole; changed: boolean } {
  requireOpen(block);
  return { addressee: 'operator', changed: block.addressee !== 'operator' };
}

export function answerBlock(block: CurrentBlock): void {
  requireOpen(block);
  if (block.type !== 'needs_input') {
    throw new BlockRuleError('wrong_block_type', 'Only a question block can be answered.');
  }
}

export function closeBlock(
  block: CurrentBlock,
  input:
    | { mode: 'done'; ref?: string }
    | { mode: 'reason'; reason: string }
    | { mode: 'withdraw'; actor: ActorId },
): { outcome: 'done' | 'reason' | 'withdrawn'; outcomeReason: string | null } {
  requireOpen(block);
  if (input.mode === 'withdraw') {
    if (block.type !== 'needs_input' || block.author !== input.actor) {
      throw new BlockRuleError('forbidden', 'Only the question author can withdraw it.');
    }
    return { outcome: 'withdrawn', outcomeReason: null };
  }
  if (input.mode === 'done') {
    if (block.type !== 'code') {
      throw new BlockRuleError('wrong_block_type', 'Done applies to a code block.');
    }
    return { outcome: 'done', outcomeReason: input.ref ?? null };
  }
  return { outcome: 'reason', outcomeReason: input.reason };
}

export function editComment(
  revision: number,
  ackedRevision: number | null,
): {
  revision: number;
  clarification: boolean;
} {
  return { revision: revision + 1, clarification: ackedRevision !== null };
}

export function acknowledgeComment(revision: number, requested: number): number {
  if (revision !== requested) {
    throw new BlockRuleError(
      'stale_comment_revision',
      `Comment revision is ${String(revision)}; requested ${String(requested)}.`,
    );
  }
  return requested;
}
