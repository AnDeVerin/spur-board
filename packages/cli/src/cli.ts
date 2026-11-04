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
import { join, resolve } from 'node:path';
import { Command, CommanderError, type CommandUnknownOpts } from '@commander-js/extra-typings';
import { OPERATIONS } from '@spur-board/contracts';
import { z } from 'zod';
import { requestOperation, requestTokenEnrollment } from './client.ts';
import { loadClientConfig, loadEnrollmentConfig, type ClientConfig } from './config.ts';
import { CliError, errorExitCode, renderCliError } from './exit-codes.ts';
import { escapeTerminalControls } from './terminal.ts';

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
  home?: string;
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
    if (/^B[1-9][0-9]*$/.test(item)) return { id: item };
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

function exampleCommand(op: CatalogOperation, input: Record<string, unknown>): string {
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
      command.option(mode.flag);
    } else {
      const schema = fieldSchema(op, mode.value);
      if (!schema) throw new Error(`Catalog mode value ${mode.value} is missing from ${op.id}.`);
      const value = schema instanceof z.ZodOptional ? `[${mode.value}]` : `<${mode.value}>`;
      command.option(`${mode.flag} ${value}`);
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
  if (selected && selected.length !== 1) throw new CliError('usage');
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
      if (keyOption !== undefined && typeof keyOption !== 'string') throw new CliError('usage');
      if (keyOption === '') throw new CliError('usage');
      if (keyOption !== undefined && escapeTerminalControls(keyOption) !== keyOption)
        throw new CliError(
          'usage',
          undefined,
          undefined,
          'The idempotency key must contain only printable characters.',
        );
      if (op.kind === 'mutation' && env['SPUR_SESSION'] && !keyOption) throw new CliError('usage');
      const config = options.clientConfig ?? loadClientConfig(env);
      const key = op.kind === 'mutation' ? keyOption || randomUUID() : undefined;
      if (key) io.stderr(`key: ${escapeTerminalControls(key)}\n`);
      try {
        const result = await requestOperation(op, input, key, config);
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
  create.requiredOption('--name <name>', 'Unique token name.');
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
    let created = false;
    let descriptor: number | undefined;
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
      throw new CliError(
        'config',
        undefined,
        undefined,
        'The token file could not be created exclusively.',
      );
    }
    try {
      const result = await requestTokenEnrollment(
        {
          name,
          folder,
          host: hostname(),
          hash: createHash('sha256').update(secret).digest('hex'),
        },
        config,
      );
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
  });
  return program;
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
