import { describe, expect, it } from 'vitest';
import { validateTarball } from './package.ts';

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
});
