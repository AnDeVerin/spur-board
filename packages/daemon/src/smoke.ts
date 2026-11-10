import { homedir } from 'node:os';
import { runSmoke, type SmokeProbes } from '@spur-board/adapters/smoke';
import { entityRefSchema } from '@spur-board/contracts';
import { ConfigError, loadConfig, resolvePaths } from './config.ts';

export interface SmokeCliOptions {
  args: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  writeOut: (line: string) => void;
  writeErr: (line: string) => void;
  /** The wall clock; only the process entry below binds `Date.now`. */
  now: () => number;
  fetch?: typeof fetch;
}

function probesFromArgs(args: readonly string[]): SmokeProbes {
  const prs: SmokeProbes['prs'][number][] = [];
  const tickets: SmokeProbes['tickets'][number][] = [];
  const sessions: SmokeProbes['sessions'][number][] = [];
  for (const arg of args) {
    if (arg.startsWith('--pr=')) {
      const match = /^([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)#([1-9]\d*)$/.exec(arg.slice(5));
      if (match === null) throw new Error('Expected --pr=owner/repo#number');
      const ref = entityRefSchema.parse({ kind: 'pr', repo: match[1], number: Number(match[2]) });
      if (ref.kind !== 'pr') throw new Error('Invalid PR probe');
      prs.push(ref);
    } else if (arg.startsWith('--ticket=')) {
      const value = arg.slice(9);
      const separator = value.indexOf('::');
      if (separator < 1) throw new Error('Expected --ticket=tracker-id::key');
      const ref = entityRefSchema.parse({
        kind: 'ticket',
        trackerId: value.slice(0, separator),
        key: value.slice(separator + 2),
      });
      if (ref.kind !== 'ticket') throw new Error('Invalid ticket probe');
      tickets.push(ref);
    } else if (arg.startsWith('--session=')) {
      const ref = entityRefSchema.parse({ kind: 'session', id: arg.slice(10) });
      if (ref.kind !== 'session') throw new Error('Invalid session probe');
      sessions.push(ref);
    } else {
      throw new Error(`Unknown smoke option ${arg}`);
    }
  }
  return { prs, tickets, sessions };
}

/** A separate process entrypoint: it uses normal config files but starts no daemon or store. */
export async function main(options: SmokeCliOptions): Promise<number> {
  if (options.args.includes('--help')) {
    options.writeOut(
      'Usage: pnpm --filter @spur-board/daemon smoke [--pr=owner/repo#number] [--ticket=tracker-id::key] [--session=id]\n',
    );
    return 0;
  }
  try {
    const probes = probesFromArgs(options.args);
    const { config, secrets } = loadConfig(resolvePaths(options.env, options.home));
    return await runSmoke(config, secrets, {
      probes,
      now: options.now,
      writeOut: options.writeOut,
      writeErr: options.writeErr,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  } catch (error) {
    // Config diagnostics identify fields and files. Other startup errors stay generic so no
    // unexpected exception can print credential material before the smoke redactor exists.
    options.writeErr(
      `${error instanceof ConfigError ? error.message : 'Smoke could not start; check options and configuration'}\n`,
    );
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main({
    args: process.argv.slice(2),
    env: process.env,
    home: homedir(),
    writeOut: (line) => process.stdout.write(line),
    writeErr: (line) => process.stderr.write(line),
    now: () => Date.now(),
  });
}
