import { describe, expect, it } from 'vitest';
import { createTheme, type ThemePreference } from '../src/lib/theme.ts';
function harness(saved: string | null = null, throws?: 'acquire' | 'read' | 'write') {
  const listeners = new Set<() => void>();
  const applied: [string, ThemePreference][] = [];
  let matches = false;
  const theme = createTheme({
    storage: () => {
      if (throws === 'acquire') throw new Error('denied');
      return {
        getItem() {
          if (throws === 'read') throw new Error('denied');
          return saved;
        },
        setItem(_key, value) {
          if (throws === 'write') throw new Error('denied');
          saved = value;
        },
      };
    },
    media: {
      get matches() {
        return matches;
      },
      addEventListener(_type, callback) {
        listeners.add(callback);
      },
      removeEventListener(_type, callback) {
        listeners.delete(callback);
      },
    },
    apply: (value, selected) => {
      applied.push([value, selected]);
    },
  });
  return {
    theme,
    applied,
    listeners,
    change(value: boolean) {
      matches = value;
      for (const listener of listeners) listener();
    },
    saved: () => saved,
  };
}
describe('theme preference', () => {
  it.each([null, 'invalid', 'dark', 'light', 'auto'])('restores %s with dark fallback', (value) => {
    const h = harness(value);
    expect(h.theme.preference).toBe(value === 'light' || value === 'auto' ? value : 'dark');
    h.theme.dispose();
  });
  it.each(['acquire', 'read', 'write'] as const)('survives storage %s throwing', (where) => {
    const h = harness('light', where);
    h.theme.set('auto');
    h.change(true);
    expect(h.applied.at(-1)).toEqual(['light', 'auto']);
    h.theme.dispose();
  });
  it('tracks media only for auto, persists selection and removes its listener', () => {
    const h = harness('auto');
    h.change(true);
    expect(h.applied.at(-1)).toEqual(['light', 'auto']);
    h.theme.set('dark');
    h.change(true);
    expect(h.applied.at(-1)).toEqual(['dark', 'dark']);
    expect(h.saved()).toBe('dark');
    const count = h.applied.length;
    h.theme.dispose();
    h.change(false);
    h.theme.set('light');
    expect(h.applied).toHaveLength(count);
    expect(h.listeners.size).toBe(0);
  });
});
