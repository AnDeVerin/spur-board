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

  it('pins the 18 codes in order, with HTTP status and exit code', () => {
    const table = Object.entries(ERRORS).map(([code, { status, exit }]) => [code, status, exit]);
    expect(table).toEqual([
      ['usage', 400, 2],
      ['wrong_id_kind', 400, 2],
      ['forbidden', 403, 1],
      ['not_found', 404, 1],
      ['not_implemented', 501, 1],
      ['block_not_open', 409, 1],
      ['wrong_block_type', 409, 1],
      ['stale_comment_revision', 409, 1],
      ['task_archived', 409, 1],
      ['retry_not_applicable', 409, 1],
      ['idempotency_key_mismatch', 409, 1],
      ['identity_unavailable', 503, 3],
      ['starting', 503, 3],
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

  it.each(Object.entries(ERRORS))('%s has complete recovery and a docs path', (code, entry) => {
    expect(entry.docs).toBe(`docs/errors.md#${code}`);
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

  it('guides callers through unavailable identity and daemon recovery', () => {
    const identity = ERRORS.identity_unavailable;
    expect(identity.hint).toContain('Ask in your own session');
    expect(identity.recovery.action).toContain('existing idempotency key if it has one');
    expect(identity.recovery.maxRetries).toBeGreaterThan(0);
    expect(identity.recovery.retryTiming).toContain('identity is available');

    const daemon = ERRORS.daemon_unavailable;
    expect(daemon.hint).toContain('Ask in your own session');
    expect(daemon.hint).toContain('operator can run `board service start`');
    expect(daemon.recovery.action).toContain('existing idempotency key if it has one');
    expect(daemon.recovery.retryTiming).toContain('daemon is available');
  });

  it('marks startup as not applied and recoverable after readiness', () => {
    expect(ERRORS.starting.status).toBe(503);
    expect(ERRORS.starting.exit).toBe(EXIT_CODES.notApplied);
    expect(ERRORS.starting.recovery.sideEffects).toBe('none');
    expect(ERRORS.starting.hint).toContain('daemon is ready');
    expect(renderHttpProblem({ code: 'starting', requestId: 'req-start' }).status).toBe(503);
  });

  it('marks an unavailable operation as refused without side effects or retries', () => {
    const entry = ERRORS.not_implemented;
    expect(entry.status).toBe(501);
    expect(entry.exit).toBe(EXIT_CODES.refused);
    expect(entry.hint).toContain('update the daemon');
    expect(entry.recovery).toMatchObject({ sideEffects: 'none', maxRetries: 0 });
    expect(renderHttpProblem({ code: 'not_implemented', requestId: 'req-missing' })).toMatchObject({
      status: 501,
      body: { code: 'not_implemented', requestId: 'req-missing' },
    });
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

  it.each([
    ['wrong_id_kind', 'Pass the expected ID kind.'],
    ['forbidden', 'Use an allowed role or ask the operator for access.'],
    ['not_found', 'Check the ID and locate the object.'],
    ['block_not_open', 'Read the current blocks before choosing another action.'],
    ['wrong_block_type', 'Use the operation for the current block type.'],
    ['task_archived', 'Add the task to the board again if work continues.'],
    ['retry_not_applicable', 'Read the item and close it if no retry is needed.'],
    ['idempotency_key_mismatch', 'Use a new key for new input or repeat the original input.'],
    [
      'identity_unavailable',
      'Ask in your own session, then retry the same command with its existing idempotency key if it has one.',
    ],
  ] as const)('%s gives recovery for its own cause', (code, action) => {
    expect(ERRORS[code].recovery.action).toBe(action);
  });
});

describe('error representations', () => {
  it('keeps an outcome-unknown retry key in structured MCP errors', () => {
    const result = renderMcpError({
      code: 'outcome_unknown',
      requestId: 'req-1',
      context: { idempotencyKey: 'ask-PROJ-123-retry-0930' },
    });
    expect(result.structuredContent.context).toEqual({
      idempotencyKey: 'ask-PROJ-123-retry-0930',
    });
    expect(errorContextSchema.parse(result.structuredContent.context)).toEqual(
      result.structuredContent.context,
    );
  });
  it('rejects client-side errors from the HTTP formatter', () => {
    expect(renderHttpProblem({ code: 'identity_unavailable', requestId: 'req-1' }).status).toBe(
      503,
    );
    expect(() =>
      Reflect.apply(renderHttpProblem, null, [{ code: 'config', requestId: 'req-1' }]),
    ).toThrow(/client-side/);
  });
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
    expect(renderStderrError(input)).toContain('trace: req-42 in daemon log');
  });

  it('gives unexpected failures recovery for reads and same-key mutations', () => {
    const { recovery } = ERRORS.unexpected;
    expect(recovery.action).toContain('read-only request can be repeated');
    expect(recovery.action).toContain('mutation, retry with the same idempotency key');
    expect(recovery.outcomeCheck).toContain('before retrying a mutation');
    expect(recovery.outcomeCheck).not.toContain('board task');
    expect(renderHttpProblem({ code: 'unexpected', requestId: 'req-42' }).body.type).toBe(
      'https://spur-board.dev/docs/errors.md#unexpected',
    );
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
        code: 'identity_unavailable' as const,
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
        expect(value.code).toBe('identity_unavailable');
        expect(value.hint).toBe(ERRORS.identity_unavailable.hint);
        expect(value.requestId).toBe('req-77');
      }
      expect(stderr).toContain('error: identity_unavailable:');
      expect(stderr).toContain(`fix: ${ERRORS.identity_unavailable.hint}`);
      expect(stderr).toContain('side effects: none (the command was not applied)');
      expect(stderr).toContain('docs: docs/errors.md#identity_unavailable');
      expect(stderr).toContain('requestId: req-77');
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
      expect(section).toContain(`"docs": "docs/errors.md#${code}"`);
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
