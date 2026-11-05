import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const packageRoot = join(root, 'packages/cli');
const manifestPath = join(packageRoot, 'package.json');

interface PackageManifest {
  name: string;
  version: string;
  license: string;
  bin: { board: string };
  dependencies?: Record<string, string>;
}

function run(command: string, args: string[], cwd = root): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

/** Copy product skill directories into the publishable package, replacing stale build output. */
export function assembleSkills(
  source = join(root, 'packages/skills'),
  destination = join(packageRoot, 'skills'),
): void {
  rmSync(destination, { recursive: true, force: true });
  if (!existsSync(source)) return;
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'test') continue;
    const skill = join(source, entry.name);
    if (!existsSync(join(skill, 'SKILL.md'))) {
      throw new Error(`Product skill ${entry.name} has no SKILL.md.`);
    }
    cpSync(skill, join(destination, entry.name), { recursive: true });
  }
}

export function buildPackage(): void {
  run('pnpm', ['build'], packageRoot);
  const dist = join(packageRoot, 'dist');
  const source = readFileSync(join(packageRoot, 'src/bin.mjs'), 'utf8');
  const developmentEntry = `} else if (argv.length === 1 && argv[0] === 'mcp') {
  const { startMcp } = await import('./mcp.ts');
  startMcp();
} else {
  const { runCli } = await import('./cli.ts');
  process.exitCode = await runCli(argv);
}`;
  const packageEntry = `} else if (argv.length === 1 && argv[0] === 'mcp') {
  const { startMcp } = await import('./mcp.mjs');
  startMcp();
} else if (argv.length === 1 && argv[0] === 'daemon') {
  const { main } = await import('./daemon.mjs');
  await main();
} else {
  const { runCli } = await import('./cli.mjs');
  process.exitCode = await runCli(argv);
}`;
  const packed = source.replace(developmentEntry, packageEntry);
  if (packed === source)
    throw new Error('The source binary entry changed; update the package entry.');
  writeFileSync(join(dist, 'bin.mjs'), packed);
  cpSync(join(root, 'packages/core/src/store/migrations'), join(dist, 'migrations'), {
    recursive: true,
  });
  assembleSkills();
}

/** Fail closed on every member, including misplaced tests under otherwise allowed folders. */
export function validateTarball(entries: readonly string[], manifest: PackageManifest): void {
  if (manifest.name !== 'spur-board' || manifest.license !== 'MIT') {
    throw new Error('Expected the MIT-licensed spur-board package.');
  }
  const files = new Set(entries.map((entry) => entry.replace(/^\.\//, '').replace(/\/$/, '')));
  const binary = `package/${manifest.bin.board.replace(/^\.\//, '')}`;
  if (!files.has(binary)) throw new Error('Tarball is missing the board binary.');
  for (const required of [
    'package/README.md',
    'package/LICENSE',
    'package/package.json',
    'package/skills/spur-board/SKILL.md',
    'package/skills/setup/SKILL.md',
  ]) {
    if (!files.has(required)) throw new Error(`Tarball is missing ${required}.`);
  }
  for (const entry of files) {
    if (
      !entry.startsWith('package/') ||
      entry.includes('..') ||
      /(?:^|\/)(?:test|tests|fixtures?)(?:\/|$)|\.(?:test|spec)\.|(?:^|\/)\.env(?:\.|$)|\.ts$/.test(
        entry,
      )
    ) {
      throw new Error(`Tarball contains a forbidden file: ${entry}`);
    }
    const runtime =
      /^package\/dist\/(?:bin|cli|client|daemon|mcp|(?:src|client|config|mcp)-[A-Za-z0-9_-]{8})\.mjs$/.test(
        entry,
      );
    const migration = /^package\/dist\/migrations\/\d{4}_[a-z0-9_]+\.sql$/.test(entry);
    if (
      entry !== 'package/package.json' &&
      entry !== 'package/README.md' &&
      entry !== 'package/LICENSE' &&
      !runtime &&
      !migration &&
      !entry.startsWith('package/skills/')
    ) {
      throw new Error(`Tarball contains a file outside the allowlist: ${entry}`);
    }
  }
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    if (name.startsWith('@spur-board/') || /^(?:workspace|catalog):/.test(version)) {
      throw new Error(`Tarball has a workspace-only dependency: ${name}`);
    }
  }
}

export function checkTarball(tarball: string, expectedVersion?: string): void {
  const entries = run('tar', ['-tzf', tarball]).trim().split('\n');
  const manifest = JSON.parse(
    run('tar', ['-xOf', tarball, 'package/package.json']),
  ) as PackageManifest;
  if (expectedVersion !== undefined && manifest.version !== expectedVersion) {
    throw new Error(`Tarball version ${manifest.version} differs from release ${expectedVersion}.`);
  }
  validateTarball(entries, manifest);
}

export function packPackage(destination: string): string {
  buildPackage();
  mkdirSync(destination, { recursive: true });
  run('pnpm', ['pack', '--pack-destination', destination], packageRoot);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest;
  const tarball = join(destination, `${manifest.name}-${manifest.version}.tgz`);
  if (!existsSync(tarball)) throw new Error('pnpm pack did not produce the expected tarball.');
  checkTarball(tarball);
  return tarball;
}

if (import.meta.main) {
  const command = process.argv[2];
  if (command === 'build') buildPackage();
  else if (command === 'pack')
    process.stdout.write(`${packPackage(resolve(process.argv[3] ?? '.'))}\n`);
  else if (command === 'check' && process.argv[3] !== undefined) checkTarball(process.argv[3]);
  else throw new Error('Usage: node scripts/package.ts build|pack [destination]|check <tarball>');
}
