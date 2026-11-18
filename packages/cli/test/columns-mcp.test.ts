import type { JsonSchemaType } from '@modelcontextprotocol/server';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { OPERATIONS } from '@spur-board/contracts';
import { expect, it } from 'vitest';
import { fakeDaemon, withClient } from './support/mcp.ts';

it('returns the column policy unchanged as structured content and validates its shared schema', async () => {
  const operation = OPERATIONS.find((operation) => operation.id === 'columns.describe');
  if (!operation) throw new Error('missing columns operation');
  const value = operation.examples[0].output;
  const daemon = await fakeDaemon((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, requestId: 'req-columns', value }));
  });
  await withClient({ BOARD_DAEMON_URL: daemon.url, BOARD_TOKEN: 'token' }, async (client) => {
    const result = await client.callTool({
      name: 'columns_describe',
      arguments: { project: 'web' },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(value);
    expect(
      JSON.parse(result.content.find((entry) => entry.type === 'text')?.text ?? 'null'),
    ).toEqual(value);
    const { tools } = await client.listTools();
    const schema = tools.find((tool) => tool.name === 'columns_describe')?.outputSchema;
    if (!schema) throw new Error('missing columns output schema');
    const validate = new AjvJsonSchemaValidator().getValidator(schema as JsonSchemaType);
    expect(validate(value).valid).toBe(true);
    expect(validate({ projects: [{ id: 'web', credential: 'unexpected' }] }).valid).toBe(false);
  });
  expect(daemon.requests).toHaveLength(1);
  expect(daemon.requests[0]?.body).toMatchObject({ input: { project: 'web' } });
});
