import { AsyncLocalStorage } from 'node:async_hooks';
import { lintSource } from '@secretlint/core';
import { secretLintProfiler } from '@secretlint/profiler';
import type { Config, RichText, RichTextInline } from '@spur-board/contracts';
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
  config: Config;
  known: ReadonlyMap<string, string | null>;
  unseen: Set<string>;
};
const receipts = new AsyncLocalStorage<ScanContext>();
// The profiler is on by default and keeps every performance mark of every scan for the life of
// the process; the board never reads it.
secretLintProfiler.setEnabled(false);
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

function lintGatewayText(text: string) {
  return lintSource({
    source: { content: text, filePath: 'board.txt', contentType: 'text' },
    options: {
      noPhysicFilePath: true,
      maskSecrets: true,
      config: {
        rules: [{ id: '@secretlint/secretlint-rule-preset-recommend', rule: scannerPreset }],
      },
    },
  });
}

/** Return a rule ID, never a finding message or a copy of the matched text. */
export async function scanSecret(text: string): Promise<string | null> {
  const result = await lintGatewayText(text);
  return result.messages[0]?.ruleId ?? null;
}

/** Replace each detected span while preserving the rest of a private reply. */
export async function redactSecretMatches(text: string): Promise<string> {
  const result = await lintGatewayText(text);
  const matches = result.messages
    .map(({ range, ruleId }) => ({ start: range[0], end: range[1], ruleId }))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const regions: { start: number; end: number; ruleId: string }[] = [];
  for (const match of matches) {
    if (
      !Number.isInteger(match.start) ||
      !Number.isInteger(match.end) ||
      match.start < 0 ||
      match.end <= match.start ||
      match.end > text.length
    ) {
      throw new Error('Invalid gateway secret scan range');
    }
    const previous = regions.at(-1);
    if (previous !== undefined && match.start < previous.end) {
      previous.end = Math.max(previous.end, match.end);
    } else {
      regions.push({ ...match });
    }
  }
  let safe = '';
  let offset = 0;
  for (const { start, end, ruleId } of regions) {
    safe += `${text.slice(offset, start)}[redacted: ${ruleId}]`;
    offset = end;
  }
  return safe + text.slice(offset);
}

function visibleInline(value: RichTextInline): string {
  switch (value.kind) {
    case 'text':
    case 'emphasis':
    case 'code':
    case 'strike':
      return value.text;
    case 'link':
      return `${value.text} (${value.url})`;
    case 'mention':
      return `<@${value.user}>`;
  }
}

/** Scan the exact text the Slack private-reply renderer will display. */
export async function redactPrivateReply(body: RichText): Promise<RichText> {
  return Promise.all(
    body.map(async (block) => {
      if (block.kind === 'code_block') {
        return { kind: 'code_block', text: await redactSecretMatches(block.text) };
      }
      const text = block.children.map(visibleInline).join('');
      return {
        kind: block.kind,
        children: [{ kind: 'text', text: await redactSecretMatches(text) }],
      };
    }),
  );
}

const NO_SCAN = 'Gateway outbox requires a secret scan transaction';

/** The config of the running scan transaction; gateway producers read task links from it. */
export function scanConfig(): Config {
  const context = receipts.getStore();
  if (context === undefined) throw new Error(NO_SCAN);
  return context.config;
}

/** Used by the common outbox insertion point before it issues SQL. */
export function checkGatewayStrings(
  strings: readonly string[],
): string | null | typeof SCAN_PENDING {
  const context = receipts.getStore();
  if (context === undefined) throw new Error(NO_SCAN);
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

/**
 * Replays database-only work after scanning exact strings outside the write transaction.
 * `fn` must build the same gateway strings on every pass. Read a time that lands in one, such as
 * an outbox payload, before the call, or capture it once on the first pass, after the write lock,
 * and reuse it on every replay, as `runTick` in `sender.ts` does with the send-time token expiry.
 * A fresh time read on each pass makes a new string each pass and the replay never ends. A time
 * kept only in the database may be read inside.
 */
export async function scanTransaction<T>(
  store: Store,
  config: Config,
  fn: (trx: Kysely<Tables>) => Promise<T>,
): Promise<T> {
  const known = new Map<string, string | null>();
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const context: ScanContext = { config, known, unseen: new Set() };
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
