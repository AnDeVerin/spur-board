import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/server';
import { OPERATIONS } from '@spur-board/contracts';
import { it, expect } from 'vitest';
import { fakeDaemon, withClient } from './support/mcp.ts';

it.each(['2026-11-04T08:00:00.000Z', null])(
  'retains column entry %s in status text, structured output and schema',
  async (columnEnteredAt) => {
    const status = OPERATIONS.find((op) => op.id === 'status.get');
    if (!status) throw new Error('Missing status operation.');
    const value = {
      ...status.examples[0].output,
      tasks: status.examples[0].output.tasks.map((task) => ({ ...task, columnEnteredAt })),
    };
    const daemon = await fakeDaemon((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, requestId: 'req-status', value }));
    });
    await withClient({ BOARD_DAEMON_URL: daemon.url, BOARD_TOKEN: 'token' }, async (client) => {
      const result = await client.callTool({ name: 'status_get', arguments: { detail: true } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(value);
      expect(
        JSON.parse(result.content.find((content) => content.type === 'text')?.text ?? 'null'),
      ).toEqual(value);
      const { tools } = await client.listTools();
      const schema = tools.find((tool) => tool.name === 'status_get')?.outputSchema;
      if (!schema) throw new Error('Missing status output schema');
      const validate = new AjvJsonSchemaValidator().getValidator(schema as JsonSchemaType);
      expect(validate(value).valid).toBe(true);
      const [row] = value.tasks;
      if (!row) throw new Error('Missing example status row');
      const { columnEnteredAt: omitted, ...task } = row;
      expect(omitted).toBe(columnEnteredAt);
      expect(validate({ ...value, tasks: [task] }).valid).toBe(false);
      expect(JSON.stringify(schema)).toContain('original add');
    });
  },
);
