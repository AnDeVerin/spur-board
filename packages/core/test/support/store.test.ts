import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterAll, afterEach, describe, expect, it, onTestFinished } from 'vitest';
import type { Store } from '../../src/index.ts';
import { openTempStore } from './store.ts';

describe('openTempStore cleanup', () => {
  let opened: Store | undefined;
  afterEach(async () => {
    await opened?.close();
    opened = undefined;
  });

  it('removes the directory of a store opened in a test after afterEach', () => {
    let dir = '';
    onTestFinished(() => {
      expect(existsSync(dir), dir).toBe(false);
    });
    const { store, file } = openTempStore('core-cleanup-');
    opened = store;
    dir = dirname(file);
    expect(existsSync(file)).toBe(true);
  });
});

describe('openTempStore at describe scope', () => {
  let dir = '';
  afterAll(() => {
    expect(existsSync(dir), dir).toBe(false);
  });
  const { store, file } = openTempStore('core-cleanup-suite-');
  dir = dirname(file);
  afterAll(async () => {
    await store.close();
  });

  it('keeps the directory while the suite runs', () => {
    expect(existsSync(file)).toBe(true);
  });
});
