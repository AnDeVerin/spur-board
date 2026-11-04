import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, errorEnvelopeSchema } from '@spur-board/contracts';
import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../../cli/src/cli.ts';
import {
  createApiServer,
  createSchemaQuery,
  listenApiServer,
  openStore,
  type Query,
} from '../../src/index.ts';

function capture() {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    isTTY: false,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  };
  return {
    io,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

describe('CLI against the real HTTP API', () => {
  it('parses query success, unavailable operation and startup without an unknown outcome', async () => {
    const home = mkdtempSync(join(tmpdir(), 'board-api-cli-'));
    let store: ReturnType<typeof openStore> | undefined;
    let app: Awaited<ReturnType<typeof createApiServer>> | undefined;
    try {
      store = openStore(join(home, 'board.db'));
      let ready = true;
      const statuses: number[] = [];
      const statusGet: Query<'status.get'> = {
        id: 'status.get',
        resolveTargets() {
          return Promise.resolve([
            {
              kind: 'found' as const,
              value: { project: 'board', task: null, block: null, workers: [] },
            },
          ]);
        },
        run() {
          return Promise.resolve({ tasks: [] });
        },
      };
      const options = {
        store,
        config: configSchema.parse({
          projects: [
            {
              id: 'board',
              tracker: { type: 'github-issues', repo: 'o/r', milestone: 'M1' },
              repos: ['o/r'],
              operatorGithubLogin: 'operator',
              spurProjects: [{ name: 'worker', role: 'worker' }],
            },
          ],
          operator: { slack: 'operator' },
          digest: { tz: 'UTC' },
        }),
        port: 0,
        ready: () => ready,
        clock: { now: () => Date.parse('2026-11-04T08:00:00.000Z') },
        lookupSession: () => Promise.resolve({ project: 'worker', status: 'running' as const }),
        verifyToken: () => Promise.resolve(false),
        registry: { 'status.get': statusGet, 'schema.get': createSchemaQuery() },
        logRequest: ({ status }: { status: number }) => {
          statuses.push(status);
        },
      };
      app = await createApiServer(options);
      await listenApiServer(app, 0);
      const address = app.server.address();
      if (address === null || typeof address === 'string') throw new Error('Expected a TCP port.');
      options.port = address.port;
      const clientConfig = {
        address: new URL(`http://127.0.0.1:${String(address.port)}`),
        session: 'session-1',
        token: undefined,
        connectTimeoutMs: 2_000,
        responseTimeoutMs: 2_000,
      };

      const success = capture();
      expect(await runCli(['status', '--json'], { clientConfig, io: success.io })).toBe(0);
      expect(JSON.parse(success.stdout)).toEqual({ tasks: [] });
      expect(success.stderr).toBe('');

      const schema = capture();
      expect(await runCli(['schema', '--json'], { clientConfig, io: schema.io })).toBe(0);
      const schemaValue = JSON.parse(schema.stdout) as { version: string; operations: unknown[] };
      expect(schemaValue.version).toMatch(/^[0-9a-f]{64}$/);
      expect(Array.isArray(schemaValue.operations)).toBe(true);
      expect(schema.stderr).toBe('');

      const unavailable = capture();
      expect(
        await runCli(['task', 'PROJ-123', '--json'], { clientConfig, io: unavailable.io }),
      ).toBe(1);
      expect(unavailable.stdout).toBe('');
      expect(errorEnvelopeSchema.parse(JSON.parse(unavailable.stderr))).toMatchObject({
        ok: false,
        error: {
          code: 'not_implemented',
          recovery: { sideEffects: 'none', maxRetries: 0 },
        },
      });

      ready = false;
      const starting = capture();
      expect(await runCli(['status', '--json'], { clientConfig, io: starting.io })).toBe(3);
      expect(starting.stdout).toBe('');
      expect(errorEnvelopeSchema.parse(JSON.parse(starting.stderr))).toMatchObject({
        ok: false,
        error: { code: 'daemon_unavailable', recovery: { sideEffects: 'none' } },
      });
      expect(statuses).toEqual([200, 200, 501, 503]);
    } finally {
      try {
        await app?.close();
      } finally {
        try {
          await store?.close();
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      }
    }
  });
});
