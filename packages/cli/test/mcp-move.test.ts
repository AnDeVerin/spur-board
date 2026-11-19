import type { JsonSchemaType } from '@modelcontextprotocol/server';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { OPERATIONS } from '@spur-board/contracts';
import { expect, it } from 'vitest';
import { fakeDaemon, withClient } from './support/mcp.ts';

it('requires a manual key for operators while correction still generates one', async () => {
  const op = OPERATIONS.find((entry) => entry.id === 'task.move');
  if (!op) throw new Error('Missing task.move');
  const daemon = await fakeDaemon((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, requestId: 'req-move', value: op.examples[0].output }));
  });
  await withClient(
    { BOARD_DAEMON_URL: daemon.url, BOARD_TOKEN: 'operator-token' },
    async (client) => {
      const input = {
        mode: 'manual',
        task: 'PROJ-123',
        column: 'todo',
        reason: '  Ready\nnow  ',
      };
      for (const extra of [{}, { idempotencyKey: '' }, { idempotencyKey: '   ' }]) {
        expect(
          (await client.callTool({ name: 'task_move', arguments: { ...input, ...extra } })).isError,
        ).toBe(true);
      }
      expect(daemon.requests).toHaveLength(0);
      expect(
        (
          await client.callTool({
            name: 'task_move',
            arguments: { ...input, idempotencyKey: 'manual-1' },
          })
        ).isError,
      ).not.toBe(true);
      expect(
        (await client.callTool({ name: 'task_move', arguments: { ...input, mode: 'correct' } }))
          .isError,
      ).not.toBe(true);
      expect(daemon.requests).toHaveLength(2);
    },
  );
});

it('advertises a required key and a valid example for every agent mutation', async () => {
  await withClient({ SPUR_SESSION: 'session-1' }, async (client) => {
    const { tools } = await client.listTools();
    for (const [index, tool] of tools.entries()) {
      const op = OPERATIONS[index];
      if (!op || op.kind !== 'mutation') continue;
      const schemas = Array.isArray(tool.inputSchema.oneOf)
        ? (tool.inputSchema.oneOf as Record<string, unknown>[])
        : [tool.inputSchema];
      for (const schema of schemas) {
        expect(schema.required).toContain('idempotencyKey');
      }
      const exampleLine = tool.description?.split('Example: ')[1]?.split('\n')[0];
      if (!exampleLine) throw new Error(`missing example for ${tool.name}`);
      const example = JSON.parse(exampleLine) as Record<string, unknown>;
      const validate = new AjvJsonSchemaValidator().getValidator(
        tool.inputSchema as JsonSchemaType,
      );
      expect(validate(example).valid).toBe(true);
      const withoutKey = { ...example };
      delete withoutKey['idempotencyKey'];
      expect(validate(withoutKey).valid).toBe(false);
    }
  });
});
