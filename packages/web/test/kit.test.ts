import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { parseSync } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const webDir = join(import.meta.dirname, '..');
const repoDir = join(webDir, '../..');
let tempDir = '';
let first = '';
let second = '';
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
const read = (dir: string, file: string) => readFileSync(join(dir, file), 'utf8');

function buildKit(out: string): void {
  const result = spawnSync(process.execPath, ['kit/build.ts', '--out', out], {
    cwd: webDir,
    encoding: 'utf8',
  });
  if (result.status !== 0)
    throw new Error(`kit build exited ${String(result.status)}:\n${result.stderr}`);
}

// Runtime (non-type) names that ds/index.ts re-exports.
function runtimeExports(): string[] {
  const { program } = parseSync('index.ts', read(webDir, 'src/ds/index.ts'));
  return program.body.flatMap((node) =>
    node.type === 'ExportNamedDeclaration' && node.exportKind !== 'type'
      ? node.specifiers
          .filter((specifier) => specifier.exportKind !== 'type')
          .map((specifier) =>
            specifier.exported.type === 'Identifier'
              ? specifier.exported.name
              : specifier.exported.value,
          )
      : [],
  );
}

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'ds-kit-'));
  first = join(tempDir, 'first');
  second = join(tempDir, 'second');
  buildKit(first);
  buildKit(second);
}, 240_000);
afterAll(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe('design system kit build', () => {
  it('builds the kit files', () => {
    for (const file of ['ds.js', 'ds.css', 'gallery/index.html', 'BUILD.json'])
      expect(existsSync(join(first, file)), file).toBe(true);
    const info = JSON.parse(read(first, 'BUILD.json')) as Record<string, unknown>;
    expect(Object.keys(info)).toEqual(['commit', 'commitDate', 'dirty', 'exports']);
    expect(info['commit']).toBe(git('rev-parse', 'HEAD'));
    expect(info['commitDate']).toBe(git('show', '-s', '--format=%cI', 'HEAD'));
    expect(typeof info['dirty']).toBe('boolean');
  });

  it('two builds are byte-identical', () => {
    for (const file of ['ds.js', 'ds.css', 'BUILD.json', 'gallery/index.html'])
      expect(readFileSync(join(second, file)).equals(readFileSync(join(first, file))), file).toBe(
        true,
      );
  });

  it('exposes the design system and its React as the global DS', () => {
    // No MessageChannel: React's scheduler would hold the port open and keep the worker alive.
    const ds = runInNewContext(`${read(first, 'ds.js')};DS`, {
      setTimeout,
      clearTimeout,
      queueMicrotask,
    }) as Record<string, unknown> & {
      React: { createElement: unknown };
      ReactDOM: { createRoot: unknown };
    };
    const { exports } = JSON.parse(read(first, 'BUILD.json')) as { exports: string[] };
    expect(Object.keys(ds).sort()).toEqual(exports);
    const runtime = runtimeExports();
    expect(runtime.length).toBeGreaterThan(0);
    expect(exports.filter((name) => !runtime.includes(name))).toEqual(['React', 'ReactDOM']);
    expect(typeof ds.React.createElement).toBe('function');
    expect(typeof ds.ReactDOM.createRoot).toBe('function');
  });

  it('references nothing outside the kit', () => {
    const html = read(first, 'gallery/index.html');
    const refs = [...html.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((m) => m[1] ?? '');
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ref, ref).toMatch(/^\.\.?\//);
    const urls = (css: string) => [...css.matchAll(/url\(\s*['"]?([^'")]*)/g)].map((m) => m[1]);
    const kitUrls = urls(read(first, 'ds.css'));
    expect(kitUrls.length).toBeGreaterThan(0);
    for (const url of kitUrls) expect(url?.slice(0, 40)).toMatch(/^data:/);
    const assets = join(first, 'gallery/assets');
    for (const file of readdirSync(assets).filter((name) => name.endsWith('.css')))
      for (const url of urls(read(assets, file))) expect(url, file).toMatch(/^(?:data:|\.\.?\/)/);
  });

  it('compiles every prototype app.jsx against the kit React', () => {
    const prototypes = join(repoDir, 'design/prototypes');
    const slices = readdirSync(prototypes).filter((slice) =>
      existsSync(join(prototypes, slice, 'app.jsx')),
    );
    const built = existsSync(join(first, 'prototypes'))
      ? readdirSync(join(first, 'prototypes'))
      : [];
    expect(built.sort()).toEqual(slices.sort());
    for (const slice of slices)
      expect(read(first, `prototypes/${slice}/app.js`)).toContain('DS.React.createElement');
  });
});
