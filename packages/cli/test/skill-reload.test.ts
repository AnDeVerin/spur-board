import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/cli.ts';

interface Recorded {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

const servers: Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    }),
  );
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

/** A loopback daemon stand-in; config-driven addresses dial 127.0.0.1, so it listens there. */
async function daemon(
  status = 200,
  body: unknown = { ok: true, requestId: 'req-1', value: { version: '1.2.3', queued: 2 } },
): Promise<{ port: number; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = createServer((request, response) => {
    let text = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      text += chunk;
    });
    request.on('end', () => {
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: text,
      });
      response.writeHead(status, {
        'content-type': status === 200 ? 'application/json' : 'application/problem+json',
      });
      response.end(JSON.stringify(body));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP port.');
  return { port: address.port, requests };
}

async function fixture(): Promise<{ root: string; home: string; packageRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'board-skill-reload-'));
  directories.push(root);
  const home = join(root, 'home');
  const packageRoot = join(root, 'package');
  await mkdir(home);
  await mkdir(join(packageRoot, 'skills', 'spur-board'), { recursive: true });
  await mkdir(join(packageRoot, 'skills', 'setup'), { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  await writeFile(join(packageRoot, 'skills', 'spur-board', 'SKILL.md'), 'Board skill\n');
  await writeFile(join(packageRoot, 'skills', 'setup', 'SKILL.md'), 'Setup skill\n');
  return { root, home, packageRoot };
}

/** The schema-valid config template of exit-codes.test.ts with an http.port line. */
const configYaml = (port: number) =>
  `projects:\n  - id: board\n    tracker: { type: github-issues, repo: example/board, label: board }\n    repos: [example/board]\n    operatorGithubLogin: operator\noperator: { slack: U0000000000 }\ndigest: { tz: UTC }\nhttp: { port: ${String(port)} }\n`;

async function install(env: NodeJS.ProcessEnv, home: string, packageRoot: string) {
  const output = { stdout: '', stderr: '' };
  const io: CliIo = {
    isTTY: false,
    stdout: (text) => {
      output.stdout += text;
    },
    stderr: (text) => {
      output.stderr += text;
    },
  };
  const exitCode = await runCli(['skills', 'install'], { env, io, setup: { home, packageRoot } });
  return {
    exitCode,
    results: JSON.parse(output.stdout) as { changed: boolean }[],
    stderr: output.stderr,
  };
}

const notAsked = 'Running sessions were not asked to re-read the spur-board skill';

describe('skills install asks running sessions to re-read the skill', () => {
  it('posts the version once, anonymously, and not again for the same version', async () => {
    const { home, packageRoot } = await fixture();
    const { port, requests } = await daemon();
    const env = {
      BOARD_DAEMON_URL: `http://127.0.0.1:${String(port)}`,
      SPUR_SESSION: 'agent-session',
      BOARD_TOKEN: 'must-not-send',
    };

    const first = await install(env, home, packageRoot);
    expect(first.exitCode).toBe(0);
    expect(first.results).toHaveLength(4);
    expect(first.stderr).toBe('Asked 2 running session(s) to re-read the spur-board skill.\n');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: '/v1/skills/reload',
      body: '{"version":"1.2.3"}',
    });
    expect(requests[0]?.headers).not.toHaveProperty('x-board-session');
    expect(requests[0]?.headers).not.toHaveProperty('authorization');

    const second = await install(env, home, packageRoot);
    expect(second.exitCode).toBe(0);
    expect(second.results.every((entry) => !entry.changed)).toBe(true);
    expect(second.stderr).toBe('');
    expect(requests).toHaveLength(1);
  });

  it('prints nothing when the daemon queued no message', async () => {
    const { home, packageRoot } = await fixture();
    const { port, requests } = await daemon(200, {
      ok: true,
      requestId: 'req-1',
      value: { version: '1.2.3', queued: 0 },
    });
    const result = await install(
      { BOARD_DAEMON_URL: `http://127.0.0.1:${String(port)}` },
      home,
      packageRoot,
    );
    expect(result.exitCode).toBe(0);
    expect(requests).toHaveLength(1);
    expect(result.stderr).toBe('');
  });

  it('keeps the install successful when the daemon runs another version', async () => {
    const { home, packageRoot } = await fixture();
    const hint =
      'The daemon runs 1.2.2. Run `board service restart` to start the installed version.';
    const { port } = await daemon(409, {
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      code: 'version_mismatch',
      hint,
      requestId: 'req-2',
    });
    const result = await install(
      { BOARD_DAEMON_URL: `http://127.0.0.1:${String(port)}` },
      home,
      packageRoot,
    );
    expect(result.exitCode).toBe(0);
    expect(result.results).toHaveLength(4);
    expect(result.stderr).toBe(
      `${notAsked}: ${hint.replace(/\.$/, '')}. \`board doctor\` lists them under sessions.stale.\n`,
    );
  });

  it('keeps the install successful when the daemon is down', async () => {
    const { home, packageRoot } = await fixture();
    const { port } = await daemon();
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) =>
            server.close(() => {
              resolve();
            }),
          ),
      ),
    );
    const result = await install(
      { BOARD_DAEMON_URL: `http://127.0.0.1:${String(port)}` },
      home,
      packageRoot,
    );
    expect(result.exitCode).toBe(0);
    expect(result.results).toHaveLength(4);
    expect(result.stderr).toContain(`${notAsked}: `);
    expect(result.stderr).toContain('`board doctor` lists them under sessions.stale.');
  });

  it('reaches the daemon on the configured port without BOARD_DAEMON_URL', async () => {
    const { root, home, packageRoot } = await fixture();
    const { port, requests } = await daemon();
    await writeFile(join(root, 'config.yaml'), configYaml(port));
    const result = await install({ BOARD_HOME: root }, home, packageRoot);
    expect(result.exitCode).toBe(0);
    expect(requests).toHaveLength(1);
    expect(result.stderr).toBe('Asked 2 running session(s) to re-read the spur-board skill.\n');
  });

  it.each([
    ['http.port is 0', configYaml(0)],
    ['there is no config file', undefined],
  ] as const)('sends nothing and prints nothing when %s', async (_case, config) => {
    const { root, home, packageRoot } = await fixture();
    const { requests } = await daemon();
    if (config !== undefined) await writeFile(join(root, 'config.yaml'), config);
    const result = await install({ BOARD_HOME: root }, home, packageRoot);
    expect(result.exitCode).toBe(0);
    expect(result.results).toHaveLength(4);
    expect(requests).toHaveLength(0);
    expect(result.stderr).toBe('');
  });
});
