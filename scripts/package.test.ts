import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assembleSkills, validateTarball } from './package.ts';

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
  'package/dist/bin.mjs',
  'package/dist/cli.mjs',
  'package/dist/mcp.mjs',
  'package/dist/client-BD4dc3-F.mjs',
  'package/dist/config-BJE5kDof.mjs',
  'package/dist/migrations/0001_init.sql',
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
    'package/dist/credentials.pem',
    'package/dist/cli.mjs.map',
    'package/dist/migrations/seed.sql',
    'package/dist/migrations/0001_init.sql.map',
  ])('rejects unexpected dist member %s', (file) => {
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
    mkdirSync(join(destination, 'old'), { recursive: true });
    writeFileSync(join(source, 'example', 'SKILL.md'), '# Example\n');
    writeFileSync(join(source, 'example', 'references', 'detail.md'), '# Detail\n');
    assembleSkills(source, destination);
    expect(readFileSync(join(destination, 'example', 'SKILL.md'), 'utf8')).toBe('# Example\n');
    expect(readFileSync(join(destination, 'example', 'references', 'detail.md'), 'utf8')).toBe(
      '# Detail\n',
    );
    expect(existsSync(join(destination, 'old'))).toBe(false);
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
