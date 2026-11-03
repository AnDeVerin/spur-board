import { describe, expect, it } from 'vitest';
import { ERRORS, EXIT_CODES, type Result, err, ok } from '../src/index.ts';

describe('error catalog', () => {
  it('pins the exit codes', () => {
    expect(EXIT_CODES).toEqual({
      ok: 0,
      refused: 1,
      usage: 2,
      notApplied: 3,
      config: 4,
      outcomeUnknown: 5,
    });
  });

  it('pins the 13 codes in order, with HTTP status and exit code', () => {
    const table = Object.entries(ERRORS).map(([code, { status, exit }]) => [code, status, exit]);
    expect(table).toEqual([
      ['usage', 400, 2],
      ['wrong_id_kind', 400, 2],
      ['forbidden', 403, 1],
      ['not_found', 404, 1],
      ['block_not_open', 409, 1],
      ['wrong_block_type', 409, 1],
      ['task_archived', 409, 1],
      ['retry_not_applicable', 409, 1],
      ['idempotency_key_mismatch', 409, 1],
      ['identity_unavailable', 503, 3],
      ['daemon_unavailable', null, 3],
      ['config', null, 4],
      ['outcome_unknown', null, 5],
    ]);
  });

  it.each(Object.entries(ERRORS))('%s has a printable ASCII message and hint', (_, entry) => {
    expect(entry.message).toMatch(/^[\x20-\x7e]+$/);
    expect(entry.hint).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe('Result', () => {
  it('builds success and failure values', () => {
    const results: Result<number, 'usage'>[] = [ok(1), err('usage')];
    expect(results).toEqual([
      { ok: true, value: 1 },
      { ok: false, error: 'usage' },
    ]);
  });
});
