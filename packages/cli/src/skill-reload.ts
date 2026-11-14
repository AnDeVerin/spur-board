import { ERRORS } from '@spur-board/contracts';
import { requestSkillReload } from './client.ts';
import { readConfiguredPort, resolveDaemonAddress, type ClientConfig } from './config.ts';
import { CliError } from './exit-codes.ts';
import { escapeTerminalControls } from './terminal.ts';

interface SkillReloadOptions {
  env: NodeJS.ProcessEnv;
  home: string;
  version: string;
  stderr: (text: string) => void;
}

function reasonOf(error: unknown): string {
  const reason =
    error instanceof CliError
      ? (error.hint ?? ERRORS[error.code].message)
      : error instanceof Error
        ? error.message
        : 'unexpected error';
  return escapeTerminalControls(reason).replace(/\.$/, '');
}

/**
 * Asks the daemon to message running sessions about a new skill version. It never throws: the
 * install has already succeeded, and `board doctor` still lists the sessions that were not told.
 */
export async function askSessionsToReload(options: SkillReloadOptions): Promise<void> {
  const { env, home, version, stderr } = options;
  if (env['BOARD_DAEMON_URL'] === undefined) {
    const port = readConfiguredPort(env, home);
    // Without a discoverable daemon the board is not set up yet; nobody runs a session to tell.
    if (port === undefined || port === 0) return;
  }
  try {
    const config: ClientConfig = {
      address: resolveDaemonAddress(env, home),
      session: undefined,
      token: undefined,
      connectTimeoutMs: 2_000,
      responseTimeoutMs: 10_000,
    };
    const { queued } = await requestSkillReload(version, config);
    if (queued > 0) {
      stderr(`Asked ${String(queued)} running session(s) to re-read the spur-board skill.\n`);
    }
  } catch (error) {
    stderr(
      `Running sessions were not asked to re-read the spur-board skill: ${reasonOf(error)}. \`board doctor\` lists them under sessions.stale.\n`,
    );
  }
}
