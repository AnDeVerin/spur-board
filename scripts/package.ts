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

/** The favicon, app icons and manifest the web build emits (`packages/web/build/app-icons.ts`). */
const APP_FILES = [
  'manifest.webmanifest',
  'favicon.svg',
  'favicon-32.png',
  'apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-512-maskable.png',
] as const;
const APP_FILE =
  'manifest[.]webmanifest|favicon[.]svg|favicon-32[.]png|apple-touch-icon[.]png|icons/icon-(?:192|512|512-maskable)[.]png';
const WEB_FILE = new RegExp(
  `^(?:index[.]html|${APP_FILE}|assets/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}[.](?:js|css|woff2))$`,
);

/** The icon `src` values of a web app manifest; throws on invalid JSON or no `icons` array. */
export function manifestIcons(source: string): string[] {
  const manifest: unknown = JSON.parse(source);
  const icons =
    typeof manifest === 'object' && manifest !== null && 'icons' in manifest
      ? manifest.icons
      : undefined;
  if (!Array.isArray(icons)) throw new Error('Web app manifest has no icons array.');
  return icons.map((icon: unknown) => {
    if (
      typeof icon !== 'object' ||
      icon === null ||
      !('src' in icon) ||
      typeof icon.src !== 'string'
    )
      throw new Error('Web app manifest icon has no src.');
    return icon.src;
  });
}

/** Verify the installed web graph, including CSS font and manifest icon references. */
export function verifyWebAssets(webRoot: string, license: string): void {
  if (!existsSync(license)) throw new Error('Web font license OFL.txt is missing.');
  const pending = ['index.html'];
  const seen = new Set<string>();
  for (const file of pending) {
    if (seen.has(file)) continue;
    seen.add(file);
    if (!WEB_FILE.test(file)) throw new Error(`Unexpected web reference: ${file}`);
    const path = join(webRoot, file);
    if (!existsSync(path)) throw new Error(`Missing web asset: ${file}`);
    if (file === 'manifest.webmanifest') {
      for (const icon of manifestIcons(readFileSync(path, 'utf8')))
        pending.push(icon.startsWith('/') ? icon.slice(1) : icon);
      continue;
    }
    if (!/[.](html|css)$/.test(file)) continue;
    const source = readFileSync(path, 'utf8');
    const references =
      file === 'index.html'
        ? [...source.matchAll(/(?:src|href)=['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '')
        : [...source.matchAll(/url\((?:['"])?([^)'"\s]+)(?:['"])?\)/g)].map(
            (match) => match[1] ?? '',
          );
    for (const reference of references)
      pending.push(
        reference.startsWith('/')
          ? reference.slice(1)
          : file === 'index.html'
            ? reference
            : `assets/${reference.replace(/^\.\//, '')}`,
      );
  }
  if (
    ![...seen].some((file) => file.endsWith('.js')) ||
    ![...seen].some((file) => file.endsWith('.css')) ||
    ![...seen].some((file) => file.endsWith('.woff2'))
  )
    throw new Error('Web output must reference JS, CSS and local fonts.');
  if (!seen.has('manifest.webmanifest'))
    throw new Error('Web output must reference the web app manifest manifest.webmanifest.');
}

/** Copy only after the CLI clean build, replacing any old web assets. */
export function assembleWeb(
  source = join(root, 'packages/web/dist'),
  destination = join(packageRoot, 'dist/web'),
  license = join(packageRoot, 'OFL.txt'),
): void {
  verifyWebAssets(source, join(root, 'packages/web/OFL.txt'));
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
  cpSync(join(root, 'packages/web/OFL.txt'), license);
  verifyWebAssets(destination, license);
}

export function buildPackage(): void {
  run('pnpm', ['--filter', '@spur-board/web', 'build']);
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
} else if (argv.length === 3 && argv[0] === 'copy-database') {
  const { copyDatabaseMain } = await import('./daemon.mjs');
  process.exitCode = copyDatabaseMain(argv.slice(1));
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
  assembleWeb();
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
    'package/OFL.txt',
    'package/dist/web/index.html',
    ...APP_FILES.map((file) => `package/dist/web/${file}`),
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
      /^package\/dist\/(?:bin|cli|client|daemon|mcp|chunk-[A-Za-z0-9_-]{8})\.mjs$/.test(entry);
    const web = entry.startsWith('package/dist/web/') && WEB_FILE.test(entry.slice(17));
    const migration = /^package\/dist\/migrations\/\d{4}_[a-z0-9_]+\.sql$/.test(entry);
    if (
      entry !== 'package/package.json' &&
      entry !== 'package/README.md' &&
      entry !== 'package/LICENSE' &&
      entry !== 'package/OFL.txt' &&
      !web &&
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
