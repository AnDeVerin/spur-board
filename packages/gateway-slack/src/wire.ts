import { z } from 'zod';

/**
 * Readers for untrusted Slack payloads. Each keeps the string semantics its callers had:
 * `textOf` rejects `''`, while `messageTs` accepts it, so a ref anchor of `''` still matches.
 */

const fieldsWire = z.record(z.string(), z.unknown());
const itemsWire = z.array(z.unknown());
const textWire = z.string().min(1);
const messageTsWire = z.object({ ts: z.string() });

/** A non-empty string, else undefined. */
export function textOf(value: unknown): string | undefined {
  return textWire.safeParse(value).data;
}

/** The `ts` string of a message, `''` included, else undefined. */
export function messageTs(value: unknown): string | undefined {
  return messageTsWire.safeParse(value).data?.ts;
}

/** A plain object's fields, else null; arrays are not objects here. */
export function fieldsOf(value: unknown): Record<string, unknown> | null {
  return fieldsWire.safeParse(value).data ?? null;
}

/** An array's items, else null. */
export function itemsOf(value: unknown): unknown[] | null {
  return itemsWire.safeParse(value).data ?? null;
}
