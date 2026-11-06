// Parses an untrusted vendor response with its zod wire schema.
import { AdapterError } from '@spur-board/contracts';
import type { z } from 'zod';

/**
 * Returns the parsed value or throws a transient `AdapterError` naming the first failing path
 * (`<label> at <dot.path>`). `at` prefixes the path when the value sits inside a larger
 * response. The error carries no cause, so no raw wire value reaches logs or smoke output.
 */
export function parseWire<S extends z.ZodType>(
  schema: S,
  value: unknown,
  label: string,
  at: readonly (string | number)[] = [],
): z.output<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const path = [...at, ...(parsed.error.issues[0]?.path ?? [])].map(String).join('.');
  throw new AdapterError('transient', `${label} at ${path || '(root)'}`);
}
