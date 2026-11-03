import type { z } from 'zod';

/** Parses a JSON column and checks it against `schema`. Throws on bad JSON or a bad value. */
export function parseJson<S extends z.ZodType>(schema: S, text: string): z.output<S> {
  return schema.parse(JSON.parse(text));
}

/** Checks `value` against `schema` and serializes the parsed value for a JSON column. */
export function toJson<S extends z.ZodType>(schema: S, value: z.input<S>): string {
  return JSON.stringify(schema.parse(value));
}
