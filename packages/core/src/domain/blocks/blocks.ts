import {
  assertNever,
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
  curator?: string | null;
  hasWorker: boolean;
}

/** Roles survive a change in the session currently filling them. */
export function blockAddressee(input: Routing): AddresseeRole {
  const { type, author, authorRole, column, orchestrator, curator = null, hasWorker } = input;
  if (author === 'system') {
    return orchestrator !== null ? `orchestrator:${column}` : hasWorker ? 'worker' : 'operator';
  }
  if (type === 'code') return 'worker';
  if (type === 'dependency' || type === 'external') return authorRole;
  const parsed = parseActorId(author);
  const asker = parsed?.actor === 'agent' ? parsed.actorRef.project : null;
  if (asker !== null && asker === curator) return 'operator';
  if (orchestrator === 'operator') return 'operator';
  if (orchestrator !== null && asker !== orchestrator) return `orchestrator:${column}`;
  return curator === null ? 'operator' : 'curator';
}

type ParsedAddressee =
  { kind: 'operator' | 'curator' | 'worker' } | { kind: 'orchestrator'; column: ColumnId };

function orchestratorColumn(role: `orchestrator:${ColumnId}`): ColumnId {
  return role.slice('orchestrator:'.length) as ColumnId;
}

/** A new role fails typecheck here; a new kind fails at each caller's `assertNever`. */
export function parseAddressee(role: AddresseeRole): ParsedAddressee {
  switch (role) {
    case 'operator':
    case 'curator':
    case 'worker':
      return { kind: role };
    default:
      return { kind: 'orchestrator', column: orchestratorColumn(role) };
  }
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

/** Only a question stops at the curator; every other step goes straight to the operator. */
function nextAddressee(
  current: AddresseeRole,
  type: BlockType,
  hasCurator: boolean,
): AddresseeRole {
  const addressee = parseAddressee(current);
  switch (addressee.kind) {
    case 'orchestrator':
      return type === 'needs_input' && hasCurator ? 'curator' : 'operator';
    case 'operator':
    case 'curator':
    case 'worker':
      return 'operator';
    default:
      return assertNever(addressee);
  }
}

/** The steps a block took from `original` to `current`, or none if `current` is not on that path. */
export function priorAddressees(
  original: AddresseeRole,
  current: AddresseeRole,
  type: BlockType,
  hasCurator: boolean,
): AddresseeRole[] {
  const path: AddresseeRole[] = [];
  let step = original;
  while (step !== current) {
    const next = nextAddressee(step, type, hasCurator);
    if (next === step) return [];
    path.push(step);
    step = next;
  }
  return path;
}

export function escalateBlock(
  block: CurrentBlock,
  hasCurator = false,
): { addressee: AddresseeRole; changed: boolean } {
  requireOpen(block);
  const addressee = nextAddressee(block.addressee, block.type, hasCurator);
  return { addressee, changed: block.addressee !== addressee };
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
    | { mode: 'withdraw'; isAuthor: boolean; reason: string },
): { outcome: 'done' | 'reason' | 'withdrawn'; outcomeReason: string | null } {
  requireOpen(block);
  if (input.mode === 'withdraw') {
    if (block.type !== 'needs_input' || !input.isAuthor) {
      throw new BlockRuleError('forbidden', 'Only the question author can withdraw it.');
    }
    return { outcome: 'withdrawn', outcomeReason: input.reason };
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
