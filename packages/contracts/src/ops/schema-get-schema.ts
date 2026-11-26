import { z } from 'zod';
import { OPERATION_KINDS, cliModeSchema, grantRuleSchema } from './define.ts';

// The schema.get output: the operation catalog as callers read it.

/** Roles `schema.get` can filter the catalog for. */
export const SCHEMA_ROLES = ['operator', 'worker', 'orchestrator'] as const;

const jsonSchemaPayload = (what: string) =>
  z.record(z.string(), z.unknown()).describe(`JSON Schema of the ${what}.`);

export const schemaGetOutputSchema = z
  .strictObject({
    version: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .describe('Catalog version: sha256 hex of ops.snapshot.json; examples use a placeholder.'),
    operations: z
      .array(
        z
          .strictObject({
            id: z.string().describe('Operation ID, e.g. task.get.'),
            kind: z.enum(OPERATION_KINDS).describe('query reads; mutation changes state.'),
            description: z.string().describe('What the operation does.'),
            grants: z
              .union([z.literal('any'), z.array(grantRuleSchema).min(1)])
              .describe('Who may call it: any identified caller, or the listed rules.'),
            errors: z.array(z.string()).describe('Error codes the operation can return.'),
            explicitKeyModes: z
              .array(z.string())
              .optional()
              .describe(
                'Modes requiring a caller-chosen idempotency key, including for operators.',
              ),
            cli: z
              .strictObject({
                command: z.string().describe('CLI command after `board`.'),
                defaultMode: z
                  .string()
                  .optional()
                  .describe('Input mode used when no mode flag is supplied.'),
                args: z.array(z.string()).describe('Input fields given as positional arguments.'),
                modes: z
                  .array(cliModeSchema)
                  .min(1)
                  .nullable()
                  .describe('Flags that pick a branch of a union input; null for a plain input.'),
                key: z
                  .literal('--key')
                  .nullable()
                  .describe('Idempotency key flag; null for a query.'),
                view: z
                  .strictObject({
                    when: z
                      .string()
                      .describe('Boolean input field that turns the terminal view on.'),
                    lead: z
                      .strictObject({
                        label: z.string().describe('Label of the first output line.'),
                        path: z
                          .array(z.string())
                          .min(1)
                          .describe('Output path of the text the first line shows.'),
                      })
                      .describe('The line printed before the result.'),
                    hide: z
                      .strictObject({
                        path: z
                          .array(z.string())
                          .min(1)
                          .describe('Output path of the array whose entries may be left out.'),
                        field: z
                          .string()
                          .describe('Boolean entry field; entries where it is false are left out.'),
                        flag: z.string().describe('CLI flag that keeps every entry.'),
                        description: z.string().describe('Help text of the flag.'),
                      })
                      .describe('Entries left out of the terminal view.'),
                  })
                  .optional()
                  .describe(
                    'How a terminal shows the output; absent for the plain view. JSON is never shaped.',
                  ),
              })
              .describe('CLI binding.'),
            mcp: z
              .strictObject({
                name: z.string().describe('MCP tool name.'),
                key: z
                  .literal('idempotencyKey')
                  .nullable()
                  .describe('Idempotency key argument; null for a query.'),
                whenToUse: z.string().min(1).describe('When this MCP tool is appropriate.'),
                whenNotToUse: z.string().min(1).describe('When to use a neighboring tool instead.'),
                destructive: z
                  .boolean()
                  .describe(
                    'MCP destructiveHint: false only for a mutation that writes only new rows.',
                  ),
              })
              .describe('MCP binding.'),
            inputSchema: jsonSchemaPayload('input'),
            outputSchema: jsonSchemaPayload('output'),
          })
          .describe('One operation.'),
      )
      .describe('Operations the caller may use.'),
  })
  .describe('The operation catalog.');
