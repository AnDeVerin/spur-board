import { createHash } from 'node:crypto';

export interface ItemCandidate {
  key: string;
  taskId: number | null;
  summary: string;
  factAt: string | null;
  source: string | null;
  priority: number;
  revision?: string | null;
}

export function fingerprint(candidate: ItemCandidate): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        candidate.key,
        candidate.summary,
        candidate.source,
        candidate.revision ?? null,
      ]),
    )
    .digest('hex');
}

/** Stable ordering within priority, then by item identity. */
export function orderItems(items: readonly ItemCandidate[]): ItemCandidate[] {
  return [...items].sort(
    (left, right) => left.priority - right.priority || left.key.localeCompare(right.key),
  );
}
