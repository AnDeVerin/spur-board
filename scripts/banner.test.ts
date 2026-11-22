import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = join(import.meta.dirname, '../packages/web/src');

describe('Banner color bindings', () => {
  it.each([
    [".root[data-variant='error']", 'color', '--color-status-error'],
    [".root[data-variant='warning']", 'color', '--color-status-attention'],
    [".root[data-variant='info']", 'color', '--color-text-secondary'],
    [".root[data-variant='warning'] .main", 'color', '--color-text-attention'],
    [".root[data-variant='info'] .main", 'color', '--color-text-primary'],
    ['.detail', 'color', '--color-text-secondary'],
    [".root[data-variant='error']", 'background', '--color-fill-error'],
    [".root[data-variant='warning']", 'background', '--color-fill-attention'],
    [".root[data-variant='info']", 'background', '--color-bg-surface'],
  ])('%s binds %s to %s', (selector, property, token) => {
    const css = readFileSync(join(sourceRoot, 'ds/Banner/Banner.module.css'), 'utf8');
    const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const values = rules
      .filter((rule) => rule[1]?.trim() === selector)
      .flatMap((rule) => (rule[2] ?? '').split(';'))
      .map((declaration) => declaration.trim())
      .filter((declaration) => declaration.startsWith(`${property}:`))
      .map((declaration) => declaration.slice(property.length + 1).trim());
    expect(values).toEqual([`var(${token})`]);
  });

  it('keeps warning main text and the task wait strip as the only attention text token consumers', () => {
    const consumers = readdirSync(sourceRoot, { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.(css|tsx?)$/.test(file))
      .flatMap((file) => {
        const source = readFileSync(join(sourceRoot, file), 'utf8');
        const references = source.match(/var\(\s*--color-text-attention(?=\s*[,)]\s*)/g) ?? [];
        return references.map(() => file);
      });
    // The binding table requires the warning main color; #825 adds the wait strip's text on the
    // same attention fill, which needs the same AA contrast.
    expect(consumers).toEqual(['board/TaskWait.module.css', 'ds/Banner/Banner.module.css']);
  });
});
