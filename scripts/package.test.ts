import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, inject, it } from 'vitest';
import type {} from '../packages/testkit/src/global-setup.ts';
import { assembleSkills, assembleWeb, verifyWebAssets, validateTarball } from './package.ts';

const manifest = {
  name: 'spur-board',
  version: '0.1.0',
  license: 'MIT',
  bin: { board: './dist/bin.mjs' },
  dependencies: { 'better-sqlite3': '^13.0.3' },
};
const files = [
  'package/package.json',
  'package/README.md',
  'package/LICENSE',
  'package/OFL.txt',
  'package/dist/web/index.html',
  'package/dist/web/assets/index-abcdefgh.js',
  'package/dist/web/assets/index-abcdefgh.css',
  'package/dist/web/assets/JetBrainsMono-Regular-abcdefgh.woff2',
  'package/dist/bin.mjs',
  'package/dist/cli.mjs',
  'package/dist/mcp.mjs',
  'package/dist/chunk-BD4dc3-F.mjs',
  'package/dist/chunk-BJE5kDof.mjs',
  'package/dist/migrations/0001_init.sql',
  'package/skills/spur-board/SKILL.md',
  'package/skills/setup/SKILL.md',
];

describe('package tarball allowlist', () => {
  it('accepts built code and migrations', () => {
    expect(() => {
      validateTarball(files, manifest);
    }).not.toThrow();
  });

  it('rejects a test file even under dist', () => {
    expect(() => {
      validateTarball([...files, 'package/dist/cli.test.mjs'], manifest);
    }).toThrow(/forbidden file/);
  });

  it.each([
    'package/dist/web/assets/index-abcdefgh.js.map',
    'package/dist/web/credentials.pem',
    'package/dist/web/assets/index-short.js',
    'package/dist/web/assets/random.txt',
    'package/dist/credentials.pem',
    'package/dist/cli.mjs.map',
    'package/dist/migrations/seed.sql',
    'package/dist/migrations/0001_init.sql.map',
    'package/dist/urls-DAMwWWmT.mjs',
    'package/dist/chunk-short.mjs',
  ])('rejects unexpected dist member %s', (file) => {
    expect(() => {
      validateTarball([...files, file], manifest);
    }).toThrow(/outside the allowlist/);
  });

  it.each([
    'package/design/README.md',
    'package/design/prototypes/_sample/index.html',
    'package/design/kit/ds.js',
    'package/dist/web/ds.js',
    'package/dist/web/ds.css',
    'package/dist/web/BUILD.json',
    'package/dist/web/gallery/index.html',
    'package/dist/web/gallery/assets/index-abcdefgh.js',
    'package/dist/web/prototypes/_sample/app.js',
  ])('rejects design and kit output %s', (file) => {
    expect(() => {
      validateTarball([...files, file], manifest);
    }).toThrow(/outside the allowlist/);
  });

  it('rejects a missing board binary', () => {
    expect(() => {
      validateTarball(
        files.filter((file) => file !== 'package/dist/bin.mjs'),
        manifest,
      );
    }).toThrow(/missing the board binary/);
  });

  it('rejects a missing product skill', () => {
    expect(() => {
      validateTarball(
        files.filter((file) => file !== 'package/skills/spur-board/SKILL.md'),
        manifest,
      );
    }).toThrow(/missing package\/skills\/spur-board\/SKILL.md/);
  });

  it('rejects a missing setup skill', () => {
    expect(() => {
      validateTarball(
        files.filter((file) => file !== 'package/skills/setup/SKILL.md'),
        manifest,
      );
    }).toThrow(/missing package\/skills\/setup\/SKILL.md/);
  });

  it('rejects workspace-only dependencies', () => {
    expect(() => {
      validateTarball(files, { ...manifest, dependencies: { '@spur-board/core': '0.0.0' } });
    }).toThrow(/workspace-only dependency/);
  });

  it('rejects unresolved catalog dependencies', () => {
    expect(() => {
      validateTarball(files, { ...manifest, dependencies: { fastify: 'catalog:' } });
    }).toThrow(/workspace-only dependency/);
  });
});

describe('product skill assembly', () => {
  it('copies named skills and removes stale build output', () => {
    const root = mkdtempSync(join(tmpdir(), 'board-skills-'));
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    mkdirSync(join(source, 'example', 'references'), { recursive: true });
    mkdirSync(join(source, 'test'), { recursive: true });
    mkdirSync(join(destination, 'old'), { recursive: true });
    writeFileSync(join(source, 'example', 'SKILL.md'), '# Example\n');
    writeFileSync(join(source, 'example', 'references', 'detail.md'), '# Detail\n');
    writeFileSync(join(source, 'test', 'skill-sync.test.ts'), '// Test only\n');
    assembleSkills(source, destination);
    expect(readFileSync(join(destination, 'example', 'SKILL.md'), 'utf8')).toBe('# Example\n');
    expect(readFileSync(join(destination, 'example', 'references', 'detail.md'), 'utf8')).toBe(
      '# Detail\n',
    );
    expect(existsSync(join(destination, 'old'))).toBe(false);
    expect(existsSync(join(destination, 'test'))).toBe(false);
    assembleSkills(join(root, 'absent'), destination);
    expect(existsSync(destination)).toBe(false);
  });

  it('fails for a product skill without SKILL.md', () => {
    const root = mkdtempSync(join(tmpdir(), 'board-skills-'));
    const source = join(root, 'source');
    mkdirSync(join(source, 'incomplete'), { recursive: true });
    expect(() => {
      assembleSkills(source, join(root, 'destination'));
    }).toThrow('has no SKILL.md');
  });
});

describe('web assembly', () => {
  it('fails when output is absent, and replaces old assets after a clean build', () => {
    const root = mkdtempSync(join(tmpdir(), 'board-web-'));
    expect(() => {
      assembleWeb(join(root, 'absent'), join(root, 'target'), join(root, 'OFL.txt'));
    }).toThrow(/Missing web asset/);
    const target = join(root, 'target');
    mkdirSync(target);
    writeFileSync(join(target, 'stale.js'), 'old');
    assembleWeb(inject('webAssetsRoot'), target, join(root, 'OFL.txt'));
    expect(existsSync(join(target, 'stale.js'))).toBe(false);
    expect(() => {
      verifyWebAssets(target, join(root, 'OFL.txt'));
    }).not.toThrow();
    const build = readFileSync(new URL('./package.ts', import.meta.url), 'utf8');
    expect(build.indexOf("run('pnpm', ['build'], packageRoot)")).toBeLessThan(
      build.indexOf('  assembleWeb();'),
    );
  });
});
