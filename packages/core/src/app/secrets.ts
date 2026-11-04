import { AsyncLocalStorage } from 'node:async_hooks';
import { lintSource } from '@secretlint/core';
import {
  creator as recommend,
  rules as recommendedRules,
} from '@secretlint/secretlint-rule-preset-recommend';
import type { Kysely } from 'kysely';
import type { Tables } from '../store/schema.ts';
import type { Store } from '../store/store.ts';

const MAX_STRINGS = 4096;
const MAX_PASSES = 32;
type ScanContext = {
  known: ReadonlyMap<string, string | null>;
  unseen: Set<string>;
};
const receipts = new AsyncLocalStorage<ScanContext>();
export const SCAN_PENDING = Symbol('gateway scan pending');
// Gateway text is untrusted input: an author must not disable scanning with an inline directive.
const scannerRules = recommendedRules.filter(
  (rule) => rule.meta.id !== '@secretlint/secretlint-rule-filter-comments',
);
const scannerPreset = {
  ...recommend,
  rules: scannerRules,
  create(context: Parameters<typeof recommend.create>[0]) {
    scannerRules.forEach((rule) => {
      context.registerRule(rule);
    });
  },
};

class ScanNeeded extends Error {
  readonly strings: readonly string[];
  constructor(strings: readonly string[]) {
    super('Gateway text requires a secret scan');
    this.strings = strings;
  }
}

/** Return a rule ID, never a finding message or a copy of the matched text. */
export async function scanSecret(text: string): Promise<string | null> {
  const result = await lintSource({
    source: { content: text, filePath: 'board.txt', contentType: 'text' },
    options: {
      noPhysicFilePath: true,
      maskSecrets: true,
      config: {
        rules: [{ id: '@secretlint/secretlint-rule-preset-recommend', rule: scannerPreset }],
      },
    },
  });
  return result.messages[0]?.ruleId ?? null;
}

/** Used by the common outbox insertion point before it issues SQL. */
export function checkGatewayStrings(
  strings: readonly string[],
): string | null | typeof SCAN_PENDING {
  const context = receipts.getStore();
  if (context === undefined) throw new Error('Gateway outbox requires a secret scan transaction');
  const { known, unseen } = context;
  for (const value of strings) {
    if (!known.has(value)) unseen.add(value);
  }
  if (unseen.size > 0) return SCAN_PENDING;
  for (const value of strings) {
    const rule = known.get(value);
    if (rule !== undefined && rule !== null) return rule;
  }
  return null;
}

/** Replays database-only work after scanning exact strings outside the write transaction. */
export async function scanTransaction<T>(
  store: Store,
  fn: (trx: Kysely<Tables>) => Promise<T>,
): Promise<T> {
  const known = new Map<string, string | null>();
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const context: ScanContext = { known, unseen: new Set() };
    try {
      return await receipts.run(context, () =>
        store.transaction(async (trx) => {
          let result: T;
          try {
            result = await fn(trx);
          } catch (error) {
            if (context.unseen.size > 0) throw new ScanNeeded([...context.unseen]);
            throw error;
          }
          if (context.unseen.size > 0) throw new ScanNeeded([...context.unseen]);
          return result;
        }),
      );
    } catch (error) {
      if (!(error instanceof ScanNeeded)) throw error;
      const unseen = error.strings.filter((value) => !known.has(value));
      if (unseen.length === 0 || known.size + unseen.length > MAX_STRINGS) {
        throw new Error('Gateway secret scan limit exceeded');
      }
      let scanned: (string | null)[];
      try {
        scanned = await Promise.all(unseen.map(scanSecret));
      } catch {
        throw new Error('Gateway secret scan failed');
      }
      unseen.forEach((value, index) => known.set(value, scanned[index] ?? null));
    }
  }
  throw new Error('Gateway secret scan replay limit exceeded');
}
