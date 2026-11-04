import { z } from 'zod';
import { ERRORS, EXIT_CODES } from '../errors.ts';
import { GRANTS, type Operation } from './define.ts';

/**
 * The catalog as plain JSON: grants, exit codes, errors, and every operation with its JSON
 * Schemas. Inputs are stored in input mode and also converted in output mode, so a
 * `.transform` anywhere in an input or output throws here.
 */
export function catalogSnapshotBody(operations: readonly Operation[]) {
  return {
    grants: GRANTS,
    exitCodes: EXIT_CODES,
    errors: Object.fromEntries(
      Object.entries(ERRORS).map(([code, spec]) => [
        code,
        { ...spec, context: z.toJSONSchema(spec.context, { io: 'output' }) },
      ]),
    ),
    operations: operations.map((op) => {
      z.toJSONSchema(op.input, { io: 'output' });
      return {
        id: op.id,
        kind: op.kind,
        description: op.description,
        grants: op.grants,
        preconditions: op.preconditions,
        errors: op.errors,
        cli: op.cli,
        mcp: op.mcp,
        slack: op.slack,
        examples: op.examples,
        input: z.toJSONSchema(op.input, { io: 'input' }),
        output: z.toJSONSchema(op.output, { io: 'output' }),
      };
    }),
  };
}

function sortKeys(_key: string, value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The catalog version: sha256 hex of the body as JSON with sorted keys. */
export async function catalogVersion(body: unknown): Promise<string> {
  const json = JSON.stringify(body, sortKeys);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The versioned catalog served by the API and committed as ops.snapshot.json. */
export async function buildCatalogSnapshot(operations: readonly Operation[]) {
  const body = catalogSnapshotBody(operations);
  return { version: await catalogVersion(body), ...body };
}
