import { CliError } from './exit-codes.ts';

export interface ClientConfig {
  address: URL;
  session: string | undefined;
  token: string | undefined;
  connectTimeoutMs: number;
  responseTimeoutMs: number;
}

const CONNECT_TIMEOUT_MS = 2_000;
const RESPONSE_TIMEOUT_MS = 30_000;

export function loadClientConfig(env: NodeJS.ProcessEnv = process.env): ClientConfig {
  const rawAddress = env['BOARD_DAEMON_URL'];
  if (!rawAddress) {
    throw new CliError('config', { environmentVariable: 'BOARD_DAEMON_URL' });
  }

  let address: URL;
  try {
    address = new URL(rawAddress);
  } catch {
    throw new CliError('config', { environmentVariable: 'BOARD_DAEMON_URL' });
  }
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) {
    throw new CliError('config', { environmentVariable: 'BOARD_DAEMON_URL' });
  }

  const session = env['SPUR_SESSION'] || undefined;
  const token = session ? undefined : env['BOARD_TOKEN'] || undefined;
  if (!session && !token) {
    throw new CliError('config', { environmentVariable: 'BOARD_TOKEN' });
  }

  return {
    address,
    session,
    token,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    responseTimeoutMs: RESPONSE_TIMEOUT_MS,
  };
}
