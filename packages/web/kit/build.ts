// Builds the design system kit: `node kit/build.ts [--out <dir>]` (default `<repo>/design/kit`).
// Outputs ds.js (global DS with React bundled), ds.css (fonts inlined), gallery/,
// prototypes/<slice>/app.js and BUILD.json. No timestamps, so two builds of a commit match.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { build, transformWithOxc, type CSSOptions, type Rolldown } from 'vite';

const webDir = resolve(import.meta.dirname, '..');
const repoDir = resolve(webDir, '../..');
const { values } = parseArgs({ options: { out: { type: 'string' } } });
const outDir = resolve(values.out ?? join(repoDir, 'design/kit'));

// Readable, stable class names, so prototypes and the gallery can be inspected by name.
const css: CSSOptions = {
  modules: {
    generateScopedName: (name: string, file: string) =>
      `ds-${basename(file.replace(/\?.*$/, ''), '.module.css')}-${name}`,
  },
};

function outputs(result: Awaited<ReturnType<typeof build>>): Rolldown.RolldownOutput[] {
  if (Array.isArray(result)) return result;
  if ('output' in result) return [result];
  throw new Error('Vite returned a watcher; the kit build does not watch.');
}

async function buildLibrary(): Promise<string[]> {
  const result = await build({
    configFile: false,
    root: webDir,
    logLevel: 'warn',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    css,
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: false,
      lib: {
        entry: join(webDir, 'kit/entry.ts'),
        name: 'DS',
        formats: ['iife'],
        fileName: () => 'ds.js',
        cssFileName: 'ds',
      },
    },
  });
  const entry = outputs(result)
    .flatMap((output) => output.output)
    .find((item): item is Rolldown.OutputChunk => item.type === 'chunk' && item.isEntry);
  if (!entry || entry.exports.length === 0)
    throw new Error('The kit entry chunk lists no exports.');
  return [...entry.exports].sort();
}

async function buildGallery(): Promise<void> {
  await build({
    configFile: false,
    root: join(webDir, 'gallery'),
    base: './',
    logLevel: 'warn',
    css,
    build: { outDir: join(outDir, 'gallery'), emptyOutDir: true, sourcemap: false },
  });
}

// Prototype JSX calls the kit's React, so prototypes need no React of their own.
async function compilePrototypes(): Promise<void> {
  const prototypesDir = join(repoDir, 'design/prototypes');
  const slices = existsSync(prototypesDir)
    ? readdirSync(prototypesDir).filter((slice) =>
        existsSync(join(prototypesDir, slice, 'app.jsx')),
      )
    : [];
  for (const slice of slices.sort()) {
    const file = join(prototypesDir, slice, 'app.jsx');
    const result = await transformWithOxc(readFileSync(file, 'utf8'), file, {
      lang: 'jsx',
      jsx: {
        runtime: 'classic',
        pragma: 'DS.React.createElement',
        pragmaFrag: 'DS.React.Fragment',
      },
    });
    mkdirSync(join(outDir, 'prototypes', slice), { recursive: true });
    writeFileSync(join(outDir, 'prototypes', slice, 'app.js'), result.code);
  }
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
}

const exports = await buildLibrary();
await buildGallery();
await compilePrototypes();
const info = {
  commit: git('rev-parse', 'HEAD'),
  commitDate: git('show', '-s', '--format=%cI', 'HEAD'),
  dirty: git('status', '--porcelain') !== '',
  exports,
};
writeFileSync(join(outDir, 'BUILD.json'), `${JSON.stringify(info, null, 2)}\n`);
console.log(`Design system kit written to ${outDir}`);
