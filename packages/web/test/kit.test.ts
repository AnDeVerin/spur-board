import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
// Every file under dir with a hash of its bytes, so two snapshots compare byte for byte.
const snapshot = (dir: string) =>
  Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry): [string, string] => {
        const file = join(entry.parentPath, entry.name);
        return [
          file.slice(dir.length),
          createHash('sha256').update(readFileSync(file)).digest('hex'),
        ];
      })
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );

const runKit = (out: string, ...args: string[]) =>
  spawnSync(process.execPath, ['kit/build.ts', '--out', out, ...args], {
    cwd: webDir,
    encoding: 'utf8',
  });

function buildKit(out: string, ...args: string[]): void {
  const result = runKit(out, ...args);
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

describe('design system kit output guard', () => {
  // Each case returns the --out path; its listing must stay the same.
  it.each<[string, () => string, RegExp]>([
    ['the repo root', () => repoDir, /it is or contains /],
    ['design/', () => join(repoDir, 'design'), /it is or contains /],
    ['design/prototypes', () => join(repoDir, 'design/prototypes'), /it is or contains /],
    ['packages/web', () => webDir, /it is or contains /],
    [
      'a non-empty directory that is not a kit',
      () => {
        const dir = join(tempDir, 'unrelated');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'sentinel.txt'), 'keep');
        return dir;
      },
      /not empty and holds no BUILD\.json/,
    ],
  ])('refuses %s without deleting anything', (_label, target, reason) => {
    const out = target();
    const before = readdirSync(out).sort();
    const result = runKit(out);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/kit build: refusing to write to /);
    expect(result.stderr).toMatch(reason);
    expect(readdirSync(out).sort()).toEqual(before);
  });

  it('rebuilds into a previous kit directory', () => {
    buildKit(second);
    expect(readFileSync(join(second, 'ds.js')).equals(readFileSync(join(first, 'ds.js')))).toBe(
      true,
    );
  }, 120_000);

  it('keeps the previous kit when a step fails, then builds once the step is fixed', () => {
    const out = join(tempDir, 'kept');
    const prototypes = join(tempDir, 'prototypes');
    const app = join(prototypes, '_sample/app.jsx');
    cpSync(join(repoDir, 'design/prototypes/_sample'), join(prototypes, '_sample'), {
      recursive: true,
    });
    buildKit(out, '--prototypes', prototypes);
    const kit = snapshot(out);
    const source = readFileSync(app, 'utf8');
    writeFileSync(app, `${source}\n<broken`);
    const result = runKit(out, '--prototypes', prototypes);
    expect(result.status).not.toBe(0);
    expect(snapshot(out)).toEqual(kit);
    expect(existsSync(`${out}.partial`)).toBe(false);
    writeFileSync(app, source);
    buildKit(out, '--prototypes', prototypes);
    expect(snapshot(out)).toEqual(kit);
  }, 180_000);
});
