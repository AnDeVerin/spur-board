import type { z } from 'zod';
import type { Tables } from './schema.ts';

/** Parses a JSON column and checks it against `schema`. Throws on bad JSON or a bad value. */
export function parseJson<S extends z.ZodType>(schema: S, text: string): z.output<S> {
  return schema.parse(JSON.parse(text));
}

/** Checks `value` against `schema` and serializes the parsed value for a JSON column. */
export function toJson<S extends z.ZodType>(schema: S, value: z.input<S>): string {
  return JSON.stringify(schema.parse(value));
}

/** A stored JSON value a lenient read skipped: where it is and how it failed, never its content. */
export interface SkippedRow {
  table: string;
  column: string;
  row: string;
  issues: { path: string; code: string }[];
}

/**
 * Logs one skipped row. It returns `undefined`, not `void`, so an async function does not
 * type-check here: its rejection would escape the reporter's catch.
 */
export type WarnSkippedRow = (fields: SkippedRow, message: string) => undefined;

/** Reports a JSON column value of the wrong shape that a lenient read skipped. */
export type WarnSkipped = (
  table: keyof Tables,
  column: string,
  row: string | number,
  error: z.ZodError,
) => void;

/**
 * Builds a reporter that calls `warn` once per table, column and row for its own lifetime, so
 * repeated ticks and transaction replays log one line. Without `warn` it reports nothing. A `warn`
 * that throws is swallowed, so reporting never fails the caller's transaction.
 */
export function warnSkippedOnce(warn: WarnSkippedRow | undefined): WarnSkipped {
  const seen = new Set<string>();
  return (table, column, row, error) => {
    if (warn === undefined) return;
    const key = JSON.stringify([table, column, String(row)]);
    if (seen.has(key)) return;
    const fields: SkippedRow = {
      table,
      column,
      row: String(row),
      issues: error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        code: issue.code,
      })),
    };
    try {
      warn(fields, 'stored JSON does not match its schema');
    } catch {
      // `warn` is an injected port called inside the caller's transaction. A diagnostic about a
      // skipped row must never roll that transaction back, so a failing `warn` is swallowed here
      // and the row is not marked seen: the next read tries to report it again.
      return;
    }
    seen.add(key);
  };
}
