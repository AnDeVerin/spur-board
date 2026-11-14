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

/** Reports a JSON column value of the wrong shape that a lenient read skipped. */
export type WarnSkipped = (
  table: keyof Tables,
  column: string,
  row: string | number,
  error: z.ZodError,
) => void;

/**
 * Builds a reporter that calls `warn` once per table, column and row for its own lifetime, so
 * repeated ticks and transaction replays log one line. Without `warn` it reports nothing.
 */
export function warnSkippedOnce(
  warn: ((fields: SkippedRow, message: string) => void) | undefined,
): WarnSkipped {
  const seen = new Set<string>();
  return (table, column, row, error) => {
    if (warn === undefined) return;
    const key = JSON.stringify([table, column, String(row)]);
    if (seen.has(key)) return;
    seen.add(key);
    warn(
      {
        table,
        column,
        row: String(row),
        issues: error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          code: issue.code,
        })),
      },
      'stored JSON does not match its schema',
    );
  };
}
