import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderErrorsDocs } from '../../../scripts/gen-errors-docs.ts';
import {
  ERRORS,
  EXIT_CODES,
  errorContextSchema,
  errorEnvelopeSchema,
  recoverySchema,
  successEnvelopeSchema,
  renderHttpProblem,
  renderJsonError,
  renderMcpError,
  renderStderrError,
  type Result,
  err,
  ok,
} from '../src/index.ts';

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

  it('pins the 15 codes in order, with HTTP status and exit code', () => {
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
      ['version_mismatch', 409, 3],
      ['daemon_unavailable', null, 3],
      ['config', null, 4],
      ['outcome_unknown', null, 5],
      ['unexpected', 500, 5],
    ]);
  });

  it.each(Object.entries(ERRORS))('%s has a printable ASCII message and hint', (_, entry) => {
    expect(entry.message).toMatch(/^[\x20-\x7e]+$/);
    expect(entry.hint).toMatch(/^[\x20-\x7e]+$/);
  });

  it.each(Object.entries(ERRORS))('%s has complete recovery and a docs anchor', (code, entry) => {
    expect(entry.docs).toBe(`#${code}`);
    expect(entry.hint.length).toBeGreaterThan(0);
    expect(entry.recovery.action.length).toBeGreaterThan(0);
    expect(['none', 'applied', 'unknown']).toContain(entry.recovery.sideEffects);
    expect(entry.recovery.maxRetries).toBeGreaterThanOrEqual(0);
    expect(entry.recovery.retryTiming.length).toBeGreaterThan(0);
    if (entry.recovery.sideEffects === 'unknown') {
      expect(entry.recovery.outcomeCheck).toContain('before retry');
      expect(entry.recovery.action).toContain('same idempotency key');
    }
    expect(entry.context).toBe(errorContextSchema);
    expect(typeof entry.exit).toBe('number');
    expect(entry.status === null || Number.isInteger(entry.status)).toBe(true);
  });

  it('pins version mismatch as certainly not applied', () => {
    expect(ERRORS.version_mismatch.status).toBe(409);
    expect(ERRORS.version_mismatch.exit).toBe(3);
    expect(ERRORS.version_mismatch.recovery.sideEffects).toBe('none');
    expect(ERRORS.version_mismatch.hint).toContain('board service restart');
  });

  it('rejects incomplete recovery metadata', () => {
    expect(
      recoverySchema.safeParse({ sideEffects: 'none', maxRetries: 0, retryTiming: 'Later.' })
        .success,
    ).toBe(false);
    expect(
      recoverySchema.safeParse({
        action: 'Retry.',
        sideEffects: 'unknown',
        maxRetries: 1,
        retryTiming: 'Later.',
      }).success,
    ).toBe(false);
    for (const entry of Object.values(ERRORS))
      expect(recoverySchema.safeParse(entry.recovery).success).toBe(true);
  });
});

describe('error representations', () => {
  it('requires request IDs in success and error envelopes', () => {
    expect(successEnvelopeSchema.safeParse({ ok: true, value: 1 }).success).toBe(false);
    expect(errorEnvelopeSchema.safeParse({ ok: false, error: { code: 'usage' } }).success).toBe(
      false,
    );
    expect(
      successEnvelopeSchema.safeParse({ ok: true, requestId: 'req-1', value: 1 }).success,
    ).toBe(true);
    expect(
      errorEnvelopeSchema.safeParse(renderJsonError({ code: 'usage', requestId: 'req-1' })).success,
    ).toBe(true);
  });

  it('renders a safe unexpected trace without a stack', () => {
    const input = {
      code: 'unexpected' as const,
      requestId: 'req-42',
      context: { causeLabel: 'storage_unavailable' as const },
    };
    const output = renderJsonError(input);
    expect(output.error.trace).toEqual({ requestId: 'req-42', logLocation: 'daemon log' });
    expect(JSON.stringify(output)).not.toContain('stack');
    expect(renderStderrError(input)).toContain('Trace: req-42 in daemon log');
  });

  it('matches the identity unavailable stderr fixture', () => {
    const fixture = readFileSync(
      fileURLToPath(new URL('./fixtures/identity-unavailable.txt', import.meta.url)),
      'utf8',
    );
    expect(
      renderStderrError({
        code: 'identity_unavailable',
        requestId: 'req-example-123',
        context: { environmentVariable: 'SPUR_SESSION' },
      }),
    ).toBe(fixture);
  });

  it('keeps secrets out and common fields equal across four forms', () => {
    const secret = 'fake-secret-do-not-print-789';
    process.env.SPUR_TEST_SECRET = secret;
    try {
      const input = {
        code: 'config' as const,
        requestId: 'req-77',
        context: { environmentVariable: 'SPUR_TEST_SECRET' },
      };
      const http = renderHttpProblem(input).body;
      const mcp = renderMcpError(input).structuredContent;
      const json = renderJsonError(input).error;
      const stderr = renderStderrError(input);
      for (const value of [http, mcp, json, stderr])
        expect(JSON.stringify(value)).not.toContain(secret);
      for (const value of [http, mcp, json]) {
        expect(value.code).toBe('config');
        expect(value.hint).toBe(ERRORS.config.hint);
        expect(value.requestId).toBe('req-77');
      }
      expect(stderr).toContain('Error config:');
      expect(stderr).toContain(`Fix: ${ERRORS.config.hint}`);
      expect(stderr).toContain('Request ID: req-77');
    } finally {
      delete process.env.SPUR_TEST_SECRET;
    }
  });
});

describe('generated error documentation', () => {
  it('matches the committed file and documents every code', () => {
    const rendered = renderErrorsDocs();
    const committed = readFileSync(
      fileURLToPath(new URL('../../../docs/errors.md', import.meta.url)),
      'utf8',
    );
    expect(committed).toBe(rendered);
    for (const [code, spec] of Object.entries(ERRORS)) {
      const section = rendered.split(`## ${code}\n`)[1]?.split('\n\n## ')[0];
      expect(section).toBeDefined();
      expect(section).toContain(spec.message);
      expect(section).toContain(`HTTP: ${String(spec.status ?? 'client-side')}`);
      expect(section).toContain(`Exit code: ${String(spec.exit)}`);
      expect(section).toContain(spec.recovery.action);
      expect(section).toContain(`Side effects: ${spec.recovery.sideEffects}`);
      expect(section).toContain(`Retry: maximum ${String(spec.recovery.maxRetries)}`);
      expect(section).toContain('req-example-123');
      expect(section).toContain('```json');
    }
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
