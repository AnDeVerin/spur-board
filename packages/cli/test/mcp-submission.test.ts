import { ERRORS, renderHttpProblem } from '@spur-board/contracts';
import { describe, expect, it } from 'vitest';
import { fakeDaemon, withClient } from './support/mcp.ts';

describe('submission provenance over MCP', () => {
  it.each(['submit_basis_invalid', 'submit_source_not_tested'] as const)(
    'preserves %s refusal guidance and advertises provenance fields',
    async (code) => {
      const daemon = await fakeDaemon((_request, response) => {
        response.writeHead(409, { 'content-type': 'application/problem+json' });
        response.end(JSON.stringify(renderHttpProblem({ code, requestId: 'req-basis' }).body));
      });
      await withClient(
        { BOARD_DAEMON_URL: daemon.url, SPUR_SESSION: 'worker-1' },
        async (client) => {
          const { tools } = await client.listTools();
          const schema = tools.find((tool) => tool.name === 'task_submit')?.inputSchema;
          expect(schema?.properties).toHaveProperty('basis');
          expect(schema?.properties).toHaveProperty('from');
          expect(schema?.properties).toHaveProperty('reason');
          const result = await client.callTool({
            name: 'task_submit',
            arguments: {
              turn: 'T4',
              sha: 'b'.repeat(40),
              basis: 'carried',
              from: 'a'.repeat(40),
              reason: 'Same work',
              idempotencyKey: 'basis-1',
            },
          });
          expect(result.isError).toBe(true);
          expect(result.structuredContent).toMatchObject({
            code,
            hint: ERRORS[code].hint,
            recovery: ERRORS[code].recovery,
          });
          const malformed = await client.callTool({
            name: 'task_submit',
            arguments: {
              turn: 'T4',
              sha: 'b'.repeat(40),
              basis: 'unknown',
              idempotencyKey: 'basis-2',
            },
          });
          expect(malformed.structuredContent).toMatchObject({ code: 'usage' });
          expect(daemon.requests).toHaveLength(1);
        },
      );
    },
  );
});
