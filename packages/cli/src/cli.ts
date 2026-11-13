import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Command, CommanderError, type CommandUnknownOpts } from '@commander-js/extra-typings';
import { ERRORS, OPERATIONS, requestHashOf, roleCanUseOperation } from '@spur-board/contracts';
import { z } from 'zod';
import { fetchTokenStatus, requestOperation, requestTokenEnrollment } from './client.ts';
import {
  configFile,
  loadClientConfig,
  loadEnrollmentConfig,
  tokenInFolder,
  type ClientConfig,
} from './config.ts';
import { CliError, errorExitCode, renderCliError } from './exit-codes.ts';
import { loadSlackManifestDefaults, renderSlackManifest } from './manifest.ts';
import { renderDoctor, runDoctor, type DoctorPorts } from './doctor.ts';
import {
  installService,
  restartService,
  serviceName,
  statusService,
  uninstallService,
  type ServiceOptions,
} from './service.ts';
import { installSkills, type InstallSkillsOptions } from './skills.ts';
import { escapeTerminalControls } from './terminal.ts';
import { rollbackPackage, updatePackage, type UpdatePorts } from './update.ts';
import {
  checkCatalog,
  cliPackageVersion,
  fileVerdictCache,
  memoryVerdictCache,
} from './version.ts';

type CatalogOperation = (typeof OPERATIONS)[number];
type InputObject = z.ZodObject<z.ZodRawShape>;

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  isTTY: boolean;
}

export interface CliOptions {
  env?: NodeJS.ProcessEnv;
  io?: CliIo;
  clientConfig?: ClientConfig;
  sendOperation?: typeof requestOperation;
  home?: string;
  setup?: InstallSkillsOptions & Omit<ServiceOptions, 'env'>;
  doctor?: Partial<DoctorPorts>;
  update?: Partial<UpdatePorts>;
}

const processIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  isTTY: process.stdout.isTTY,
};

function branches(input: CatalogOperation['input']): InputObject[] {
  if (input instanceof z.ZodDiscriminatedUnion) return [...input.options] as InputObject[];
  return [input as InputObject];
}

function fieldSchema(op: CatalogOperation, name: string): z.ZodType | undefined {
  for (const branch of branches(op.input)) {
    if (name in branch.shape) return branch.shape[name] as z.ZodType;
  }
  return undefined;
}

function bareSchema(schema: z.ZodType): z.ZodType {
  return schema instanceof z.ZodOptional ? (schema.unwrap() as z.ZodType) : schema;
}

function revisionEntryArray(schema: z.ZodType | undefined): boolean {
  if (schema === undefined) return false;
  const bare = bareSchema(schema);
  if (!(bare instanceof z.ZodArray)) return false;
  const shapes = bare.element instanceof z.ZodUnion ? bare.element.options : [bare.element];
  return shapes.some(
    (shape) =>
      shape instanceof z.ZodObject && Object.keys(shape.shape).sort().join(',') === 'id,revision',
  );
}

function positionalInput(op: CatalogOperation, field: string, value: unknown): unknown {
  if (!revisionEntryArray(fieldSchema(op, field)) || !Array.isArray(value)) return value;
  return value.map((item: unknown) => {
    if (typeof item !== 'string') return item;
    if (!item.includes('@')) return { id: item };
    const match = /^([^@]+)@([1-9][0-9]*)$/.exec(item);
    const id = match?.[1];
    const rawRevision = match?.[2];
    if (id === undefined || rawRevision === undefined) return item;
    const revision = Number(rawRevision);
    return Number.isSafeInteger(revision) ? { id, revision } : item;
  });
}

function positionalExample(op: CatalogOperation, field: string, value: unknown): string[] {
  const values: unknown[] = Array.isArray(value) ? value : [value];
  const isEntryArray = revisionEntryArray(fieldSchema(op, field));
  return values.map((item) => {
    if (
      isEntryArray &&
      item !== null &&
      typeof item === 'object' &&
      'id' in item &&
      'revision' in item
    ) {
      return shellValue(`${String(item.id)}@${String(item.revision)}`);
    }
    if (isEntryArray && item !== null && typeof item === 'object' && 'id' in item)
      return shellValue(item.id);
    return shellValue(item);
  });
}

function optionName(field: string): string {
  return `--${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

function optionField(flag: string): string {
  return flag.slice(2).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function shellValue(value: unknown): string {
  const text = String(value);
  return /^[A-Za-z0-9_./#:@-]+$/.test(text) ? text : JSON.stringify(text);
}

/** The identity an operation in the selected input mode needs, when only one kind of caller can run it. */
function identityHint(op: CatalogOperation, mode: string | undefined): string | undefined {
  const flag = op.cli.modes?.find((item) => item.mode === mode)?.flag;
  const command = `\`board ${op.cli.command}${flag ? ` ${flag}` : ''}\``;
  if (!roleCanUseOperation(op, 'worker', mode) && !roleCanUseOperation(op, 'orchestrator', mode)) {
    return `${command} needs operator identity: run it in a Spur session of a project whose spurProjects role is operator, or run \`board token create --name <name> --into <folder>\` and ask the operator to approve the request in Slack.`;
  }
  if (!roleCanUseOperation(op, 'operator', mode)) {
    return `${command} needs an agent identity: run it in a Spur session of a project listed in config.yaml.`;
  }
  return undefined;
}

function loadOperationConfig(
  op: CatalogOperation,
  input: unknown,
  env: NodeJS.ProcessEnv,
): ClientConfig {
  try {
    return loadClientConfig(env);
  } catch (error) {
    const mode =
      typeof input === 'object' &&
      input !== null &&
      'mode' in input &&
      typeof input.mode === 'string'
        ? input.mode
        : undefined;
    const hint = identityHint(op, mode);
    if (error instanceof CliError && error.code === 'identity_missing' && hint) {
      throw new CliError(error.code, error.context, error.requestId, hint);
    }
    throw error;
  }
}

export function exampleCommand(op: CatalogOperation, input: Record<string, unknown>): string {
  const words = ['board', op.cli.command];
  for (const arg of op.cli.args) {
    const value = input[arg];
    if (value !== undefined) words.push(...positionalExample(op, arg, value));
  }
  const mode = op.cli.modes?.find((item) => item.mode === input['mode']);
  if (mode) {
    words.push(mode.flag);
    if (mode.value && input[mode.value] !== undefined) words.push(shellValue(input[mode.value]));
  }
  for (const [field, value] of Object.entries(input)) {
    if (op.cli.args.includes(field) || field === 'mode' || mode?.value === field) continue;
    words.push(optionName(field));
    if (Array.isArray(value)) words.push(...value.map(shellValue));
    else if (typeof value !== 'boolean') words.push(shellValue(value));
  }
  return words.join(' ');
}

function formatHuman(value: unknown, indent = 0): string {
  const prefix = ' '.repeat(indent);
  if (Array.isArray(value))
    return value
      .map((item) => `${prefix}- ${formatHuman(item, indent + 2).trimStart()}`)
      .join('\n');
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.entries(object)
      .map(([key, item]) => {
        if (key === 'text' && object['untrusted'] === true && typeof item === 'string') {
          return `${prefix}${escapeTerminalControls(key)}:\n${item
            .split('\n')
            .map((line) => `${prefix}> ${escapeTerminalControls(line)}`)
            .join('\n')}`;
        }
        if (item && typeof item === 'object')
          return `${prefix}${escapeTerminalControls(key)}:\n${formatHuman(item, indent + 2)}`;
        return `${prefix}${escapeTerminalControls(key)}: ${escapeTerminalControls(String(item))}`;
      })
      .join('\n');
  }
  return `${prefix}${escapeTerminalControls(String(value))}`;
}

function commandFor(root: CommandUnknownOpts, path: string): CommandUnknownOpts {
  let parent: CommandUnknownOpts = root;
  for (const segment of path.split(' ')) {
    let child = parent.commands.find((item) => item.name() === segment);
    if (!child) child = parent.command(segment);
    parent = child;
  }
  return parent;
}

function registerOptions(command: CommandUnknownOpts, op: CatalogOperation): void {
  for (const arg of op.cli.args) {
    const schema = fieldSchema(op, arg);
    if (!schema) throw new Error(`Catalog argument ${arg} is missing from ${op.id}.`);
    command.argument(bareSchema(schema) instanceof z.ZodArray ? `<${arg}...>` : `<${arg}>`);
  }

  const modeValues = new Set(op.cli.modes?.flatMap((mode) => (mode.value ? [mode.value] : [])));
  const fields = new Map<string, z.ZodType>();
  for (const branch of branches(op.input)) {
    for (const [name, schema] of Object.entries(branch.shape))
      fields.set(name, schema as z.ZodType);
  }
  for (const [field, schema] of fields) {
    if (op.cli.args.includes(field) || field === 'mode' || modeValues.has(field)) continue;
    const bare = bareSchema(schema);
    const flag = optionName(field);
    const description = schema.description ?? field;
    if (bare instanceof z.ZodBoolean) command.option(flag, description);
    else if (bare instanceof z.ZodArray) command.option(`${flag} <values...>`, description);
    else if (bare instanceof z.ZodNumber)
      command.option(`${flag} <value>`, description, (value: string) => Number(value));
    else if (
      bare instanceof z.ZodString ||
      bare instanceof z.ZodEnum ||
      bare instanceof z.ZodLiteral
    )
      command.option(`${flag} <value>`, description);
    else throw new Error(`Unsupported CLI field ${field} in ${op.id}.`);
  }
  for (const mode of op.cli.modes ?? []) {
    if (mode.value === null) {
      const branch = branches(op.input).find(
        (item) => (item.shape.mode as z.ZodType | undefined)?.safeParse(mode.mode).success,
      );
      command.option(
        mode.flag,
        (branch?.shape.mode as z.ZodType | undefined)?.description ?? mode.mode,
      );
    } else {
      const schema = fieldSchema(op, mode.value);
      if (!schema) throw new Error(`Catalog mode value ${mode.value} is missing from ${op.id}.`);
      const value = schema instanceof z.ZodOptional ? `[${mode.value}]` : `<${mode.value}>`;
      const description = schema.description ?? bareSchema(schema).description ?? mode.value;
      command.option(`${mode.flag} ${value}`, description);
    }
  }
  if (op.kind === 'mutation') command.option('--key <key>', 'Idempotency key for this action.');
  command.option('--json', 'Print JSON output or a JSON error.');
}

function buildInput(
  op: CatalogOperation,
  args: unknown[],
  options: Record<string, unknown>,
): unknown {
  const input: Record<string, unknown> = {};
  for (const [index, field] of op.cli.args.entries())
    input[field] = positionalInput(op, field, args[index]);
  for (const branch of branches(op.input)) {
    for (const field of Object.keys(branch.shape)) {
      if (field === 'mode' || field in input) continue;
      const flag = optionField(optionName(field));
      if (options[flag] !== undefined) input[field] = options[flag];
    }
  }
  const selected = op.cli.modes?.filter((mode) => options[optionField(mode.flag)] !== undefined);
  if (selected && selected.length !== 1)
    throw new CliError(
      'usage',
      undefined,
      undefined,
      `Pass exactly one of ${(op.cli.modes ?? []).map((mode) => mode.flag).join(', ')}.`,
    );
  if (selected?.[0]) {
    input['mode'] = selected[0].mode;
    if (selected[0].value) {
      const value = options[optionField(selected[0].flag)];
      if (value !== true) input[selected[0].value] = value;
    }
  }
  const parsed = op.input.safeParse(input);
  if (!parsed.success)
    throw new CliError('usage', undefined, undefined, z.prettifyError(parsed.error));
  return parsed.data;
}

function registerSetupCommands(
  program: CommandUnknownOpts,
  options: CliOptions,
  io: CliIo,
  env: NodeJS.ProcessEnv,
): void {
  const serviceOptions = { ...options.setup, env };
  const print = (value: unknown): void => {
    io.stdout(
      `${program.opts()['json'] || !io.isTTY ? JSON.stringify(value) : formatHuman(value)}\n`,
    );
  };
  const runSetup = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (error instanceof Error) throw new CliError('config', undefined, undefined, error.message);
      throw error;
    }
  };

  const doctor = commandFor(program, 'doctor');
  doctor.description('Check whether the installation is ready and show exact fixes.');
  doctor.option('--offline', 'Validate config only, without network or process checks.');
  doctor.option('--json', 'Print the check list as JSON.');
  doctor.action(async () => {
    const checks = await runDoctor({
      env,
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(doctor.opts()['offline'] ? { offline: true } : {}),
      ...(options.doctor === undefined ? {} : { ports: options.doctor }),
    });
    const json = Boolean(doctor.opts()['json'] || program.opts()['json']);
    io.stdout(`${renderDoctor(checks, json)}\n`);
    if (checks.some((check) => check.blocking))
      throw new CommanderError(1, 'board.error', 'Doctor found blocking failures.');
  });

  commandFor(program, 'skills install')
    .description('Install bundled skills for Claude Code and Codex.')
    .action(async () => {
      print(await runSetup(() => installSkills({ ...options.setup, env })));
    });

  commandFor(program, 'service install')
    .description('Install and start the systemd user service.')
    .action(async () => {
      print(await runSetup(() => installService(serviceOptions)));
    });
  commandFor(program, 'service restart')
    .description('Restart the systemd user service.')
    .action(async () => {
      await runSetup(() => restartService(serviceOptions));
      print({ unit: serviceName, restarted: true });
    });
  commandFor(program, 'service status')
    .description('Show the service state and whether lingering is enabled.')
    .action(async () => {
      print({ unit: serviceName, ...(await runSetup(() => statusService(serviceOptions))) });
    });
  commandFor(program, 'service uninstall')
    .description('Stop and remove the systemd user service.')
    .action(async () => {
      print({ unit: serviceName, ...(await runSetup(() => uninstallService(serviceOptions))) });
    });

  const updateOptions = () => ({
    env,
    home: options.home ?? homedir(),
    stdoutIsTTY: io.isTTY,
    progress: io.stderr,
    ports: options.update,
  });
  commandFor(program, 'update')
    .description(
      'Update the package, service and skills, and roll back if the new version is unhealthy.',
    )
    .argument('[version]', 'Version to install, such as 1.2.3; the latest when omitted.')
    .action(async (...parts: unknown[]) => {
      const version = parts[0];
      if (version !== undefined && typeof version !== 'string') throw new CliError('usage');
      print(await runSetup(() => updatePackage(updateOptions(), version)));
    });
  const rollback = commandFor(program, 'rollback');
  rollback.description('Return to the version before the last update.');
  rollback.option('--yes', 'Roll back without asking; required when not at a terminal.');
  rollback.action(async () => {
    const yes = rollback.opts()['yes'] === true;
    print(await runSetup(() => rollbackPackage(updateOptions(), yes)));
  });

  commandFor(program, 'mcp')
    .summary('Start the MCP server for an agent on standard input and output.')
    .description(
      [
        'Start the MCP server for an agent on standard input and output. Stdout carries only JSON-RPC.',
        '',
        'Each tool call finds the caller: `SPUR_SESSION` inside a Spur session, otherwise `BOARD_TOKEN`, otherwise the first `.spur-board/token` found walking upward from the directory the agent starts it in, stopping at the root of its git worktree, or at home outside git; home itself is never searched.',
        '',
        'It reaches the daemon at `BOARD_DAEMON_URL`, otherwise at `http.port` from `config.yaml`; with neither set nor a valid config, each call fails with `config` before any request.',
        '',
        "A `version_mismatch` answer means the server and the daemon have different catalogs: restart the agent session so `board mcp` loads the daemon's catalog; if it remains, run `board service restart`.",
        '',
        'Register it with Claude Code: `claude mcp add spur-board -- board mcp`. With Codex: `codex mcp add spur-board -- board mcp`.',
      ].join('\n'),
    )
    .action(() => {
      // bin.mjs starts the server for a bare `board mcp` without loading this CLI.
      throw new CliError(
        'usage',
        undefined,
        undefined,
        'Run `board mcp` with no other arguments or flags.',
      );
    });

  const manifest = commandFor(program, 'slack manifest');
  manifest.description('Print a Slack app manifest.');
  manifest.option('--app-name <name>', 'Slack app name.');
  manifest.option('--command <command>', 'Slash command, including the leading slash.');
  manifest.action(() => {
    const appName = manifest.opts()['appName'];
    const command = manifest.opts()['command'];
    if (
      (appName !== undefined && typeof appName !== 'string') ||
      (command !== undefined && typeof command !== 'string')
    ) {
      throw new CliError('usage');
    }
    const defaults =
      appName === undefined || command === undefined
        ? loadSlackManifestDefaults(env, options.home ?? homedir())
        : {};
    io.stdout(
      renderSlackManifest({
        ...defaults,
        ...(appName === undefined ? {} : { appName }),
        ...(command === undefined ? {} : { command }),
      }),
    );
  });
}

export function createProgram(options: CliOptions = {}): CommandUnknownOpts {
  const io = options.io ?? processIo;
  const env = options.env ?? process.env;
  const program: CommandUnknownOpts = new Command();
  program.name('board').description('Use the board from a shell.');
  program.option('--json', 'Print JSON output or a JSON error.');
  program.configureOutput({
    writeOut: (text) => {
      io.stdout(text);
    },
    writeErr: () => {},
  });
  program.exitOverride();

  registerSetupCommands(program, options, io, env);

  for (const op of OPERATIONS) {
    const command = commandFor(program, op.cli.command);
    command.description(op.description);
    registerOptions(command, op);
    command.addHelpText(
      'after',
      `\nExamples:\n${op.examples.map((example) => `  ${exampleCommand(op, example.input as Record<string, unknown>)} — ${example.summary}`).join('\n')}\n`,
    );
    command.action(async (...parts: unknown[]) => {
      const invoked = parts.at(-1) as CommandUnknownOpts;
      const json = Boolean(invoked.opts()['json'] || program.opts()['json']);
      const input = buildInput(op, parts.slice(0, -1), invoked.opts());
      const keyOption = invoked.opts()['key'];
      if (keyOption !== undefined && (typeof keyOption !== 'string' || keyOption === ''))
        throw new CliError(
          'usage',
          undefined,
          undefined,
          'Pass a nonempty --key, or omit it to have one generated.',
        );
      if (keyOption !== undefined && escapeTerminalControls(keyOption) !== keyOption)
        throw new CliError(
          'usage',
          undefined,
          undefined,
          'The idempotency key must contain only printable characters.',
        );
      const config = options.clientConfig ?? loadOperationConfig(op, input, env);
      const key = op.kind === 'mutation' ? keyOption || randomUUID() : undefined;
      if (key) io.stderr(`key: ${escapeTerminalControls(key)}\n`);
      let instance: string | undefined;
      let outcome: { value: unknown } | { error: unknown };
      try {
        outcome = {
          value: await (options.sendOperation ?? requestOperation)(
            op,
            input,
            key,
            config,
            (seen) => {
              instance = seen;
            },
          ),
        };
      } catch (error) {
        outcome = { error };
      }
      // The daemon already reported the mismatch with its own hint; do not warn twice.
      const reportedMismatch =
        'error' in outcome &&
        outcome.error instanceof CliError &&
        outcome.error.code === 'version_mismatch';
      if (instance !== undefined && !reportedMismatch) {
        const cliVersion = cliPackageVersion();
        const cache =
          cliVersion === undefined
            ? memoryVerdictCache()
            : fileVerdictCache(
                join(dirname(configFile(env, options.home ?? homedir())), 'version-check.json'),
                cliVersion,
              );
        const verdict = await checkCatalog(config, instance, cache);
        if (verdict !== undefined && !verdict.matches) {
          io.stderr(
            `warning: the daemon catalog ${verdict.serverVersion.slice(0, 12)} differs from this CLI's ${verdict.clientVersion.slice(0, 12)}. ${ERRORS.version_mismatch.hint}\n`,
          );
        }
      }
      try {
        if ('error' in outcome) throw outcome.error;
        const result = outcome.value;
        io.stdout(`${json || !io.isTTY ? JSON.stringify(result) : formatHuman(result)}\n`);
      } catch (error) {
        if (error instanceof CliError) {
          io.stderr(`${renderCliError(error, json, key)}\n`);
          throw new CommanderError(errorExitCode(error), 'board.error', error.message);
        }
        throw error;
      }
    });
  }
  const create = commandFor(program, 'token create');
  create.description('Request approval for a new token in a chosen folder.');
  create.requiredOption(
    '--name <name>',
    'Unique token name: 1-64 letters, digits, ".", "_" or "-".',
  );
  create.requiredOption('--into <dir>', 'Existing folder to hold the token file.');
  create.option('--json', 'Print JSON output or a JSON error.');
  create.action(async (...parts: unknown[]) => {
    const invoked = parts.at(-1) as CommandUnknownOpts;
    const flags = invoked.opts();
    const json = Boolean(flags['json'] || program.opts()['json']);
    const name = flags['name'];
    const into = flags['into'];
    if (typeof name !== 'string' || !name.trim() || typeof into !== 'string') {
      throw new CliError('usage');
    }
    const config = loadEnrollmentConfig(env);
    let folder: string;
    try {
      folder = realpathSync(resolve(into));
      if (folder === realpathSync(options.home ?? homedir())) {
        throw new CliError(
          'usage',
          undefined,
          undefined,
          'Choose a folder below home, not home itself.',
        );
      }
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError('usage', undefined, undefined, 'Choose an existing folder.');
    }
    const tokenFolder = join(folder, '.spur-board');
    const file = join(tokenFolder, 'token');
    const secret = randomBytes(32).toString('base64url');
    const exclusiveFailure = () =>
      new CliError(
        'config',
        undefined,
        undefined,
        'The token file could not be created exclusively.',
      );
    try {
      mkdirSync(tokenFolder, { recursive: true, mode: 0o700 });
      const directory = lstatSync(tokenFolder);
      if (
        !directory.isDirectory() ||
        directory.uid !== process.getuid?.() ||
        (directory.mode & 0o077) !== 0 ||
        realpathSync(tokenFolder) !== tokenFolder
      ) {
        throw new Error('Token directory must be owned by the caller and private.');
      }
    } catch {
      throw exclusiveFailure();
    }
    const lock = join(tokenFolder, 'token.lock');
    try {
      closeSync(openSync(lock, 'wx', 0o600));
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'EEXIST'
      ) {
        throw new CliError(
          'config',
          undefined,
          undefined,
          `Another \`board token create\` is running for this folder: ${lock} exists. Wait for it to finish, or delete ${lock} if no such run is active, then run again.`,
        );
      }
      throw exclusiveFailure();
    }
    // Held across the probe, the replacement and the enrollment cleanup so that a concurrent run
    // cannot delete this run's new token file; removed only by this run.
    try {
      const existing = tokenInFolder(folder, () => {});
      if (existing !== undefined) await replaceStaleToken(file, existing, config);
      let created = false;
      let descriptor: number | undefined;
      try {
        descriptor = openSync(file, 'wx', 0o600);
        created = true;
        writeFileSync(descriptor, `${secret}\n`);
        closeSync(descriptor);
        descriptor = undefined;
        chmodSync(file, 0o600);
      } catch {
        if (descriptor !== undefined) closeSync(descriptor);
        if (created) {
          try {
            unlinkSync(file);
          } catch {
            throw new CliError(
              'config',
              undefined,
              undefined,
              'The new token file could not be secured or removed.',
            );
          }
        }
        throw exclusiveFailure();
      }
      const hash = createHash('sha256').update(secret).digest('hex');
      try {
        const result = {
          ...(await requestTokenEnrollment({ name, folder, host: hostname(), hash }, config)),
          requestHash: requestHashOf(hash),
        };
        io.stdout(`${json || !io.isTTY ? JSON.stringify(result) : formatHuman(result)}\n`);
      } catch (error) {
        if (error instanceof CliError && error.code === 'outcome_unknown') {
          throw new CliError(
            'outcome_unknown',
            undefined,
            error.requestId,
            'The request may have reached the daemon. Keep the new token file and check the approval request before retrying.',
          );
        }
        try {
          unlinkSync(file);
        } catch {
          throw new CliError(
            'config',
            undefined,
            undefined,
            'Registration failed and the new token file could not be removed. Remove it before retrying.',
          );
        }
        throw error;
      }
    } finally {
      try {
        unlinkSync(lock);
      } catch {
        // A lock left behind is named by the next run's hint.
      }
    }
  });
  return program;
}

/**
 * Deletes a token file the daemon reports as expired or denied; refuses every other state. Only
 * the hash of the old token is sent.
 */
async function replaceStaleToken(file: string, token: string, config: ClientConfig): Promise<void> {
  const refuse = (hint: string) => new CliError('config', undefined, undefined, hint);
  const { status } = await fetchTokenStatus(
    createHash('sha256').update(token).digest('hex'),
    config,
  ).catch((error: unknown) => {
    if (error instanceof CliError && error.code === 'not_found') {
      throw refuse(
        `The daemon cannot report the state of ${file}: it is older than this CLI. Ask the operator to run \`board service restart\`, then run again.`,
      );
    }
    throw error;
  });
  switch (status) {
    case 'expired':
    case 'denied':
      try {
        unlinkSync(file);
      } catch {
        throw refuse(`Delete ${file} by hand, then run again.`);
      }
      return;
    case 'approved':
      throw refuse(
        `${file} holds an approved token. Use it from this folder, or ask the operator to revoke it with \`board token revoke\`, then delete the file and run again; or choose another --into folder.`,
      );
    case 'pending':
      throw refuse(
        `${file} holds a token request still awaiting approval. Ask the operator to approve or deny it, or wait until it expires, then run again; or choose another --into folder.`,
      );
    case 'revoked':
      throw refuse(
        `${file} holds a revoked token. Delete the file, then run again with another --name.`,
      );
    case 'unknown':
      throw refuse(
        `This daemon does not know the token in ${file}; it may belong to another board, or its request ended over 7 days ago and was deleted. Check BOARD_DAEMON_URL (or http.port in config.yaml) first; if it names this board, delete the file and run again.`,
      );
  }
}

export async function runCli(argv: string[], options: CliOptions = {}): Promise<number> {
  const io = options.io ?? processIo;
  try {
    await createProgram(options).parseAsync(argv, { from: 'user' });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError && error.code === 'board.error') return error.exitCode;
    if (error instanceof CommanderError && error.exitCode === 0) return 0;
    const cliError =
      error instanceof CliError
        ? error
        : error instanceof CommanderError
          ? new CliError('usage', undefined, undefined, error.message)
          : new CliError('unexpected');
    io.stderr(`${renderCliError(cliError, argv.includes('--json'))}\n`);
    return errorExitCode(cliError);
  }
}
