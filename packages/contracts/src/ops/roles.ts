import { type Grant, type Operation } from './define.ts';
import { SCHEMA_ROLES } from './schemas.ts';

export type SchemaRole = (typeof SCHEMA_ROLES)[number];

const ROLE_GRANTS: Record<SchemaRole, ReadonlySet<Grant>> = {
  operator: new Set(['operator', 'block-addressee', 'block-author']),
  worker: new Set(['project-agent', 'task-worker', 'block-addressee', 'block-author']),
  orchestrator: new Set([
    'project-agent',
    'column-orchestrator',
    'block-addressee',
    'block-author',
  ]),
};

/** Whether a role has at least one catalog grant for an operation or a particular input mode. */
export function roleCanUseOperation(
  operation: Pick<Operation, 'grants'>,
  role: SchemaRole,
  mode?: string,
): boolean {
  return (
    operation.grants === 'any' ||
    operation.grants.some(
      (rule) =>
        ROLE_GRANTS[role].has(rule.grant) &&
        (mode === undefined || rule.mode === undefined || rule.mode === mode),
    )
  );
}
