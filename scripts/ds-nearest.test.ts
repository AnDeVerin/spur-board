import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COLOUR_LIMIT, SIZE_LIMIT_PX, deltaE2000, nearest } from './ds-nearest.ts';

const SCRIPT = join(import.meta.dirname, 'ds-nearest.ts');
const DOC = readFileSync(join(import.meta.dirname, '../docs/design-system-decisions.md'), 'utf8');
// Pinned to the live tokens on purpose: a token change that moves these results also moves the
// examples in docs/design-system-decisions.md.
const TOKENS = readFileSync(join(import.meta.dirname, '../packages/web/src/ds/tokens.css'), 'utf8');

function lines(args: string[]): string[] {
  const result = nearest(TOKENS, args);
  if (!result.ok) throw new Error(result.error);
  return result.lines;
}

function refused(args: string[], css = TOKENS): string {
  const result = nearest(css, args);
  if (result.ok) throw new Error(`expected a refusal, got ${result.lines.join(' | ')}`);
  return result.error;
}

const NEGATIVE_NOTE =
  'in (a negative value is compared by its size; write it as calc(-1 * var(--token)))';
const line = (all: string[], theme: 'dark' | 'light') =>
  all.find((l) => l.startsWith(`${theme} `)) ?? '';

describe('deltaE2000', () => {
  it('matches the Sharma, Wu and Dalal test pairs 1 and 17', () => {
    expect(deltaE2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 4);
    expect(deltaE2000([50, 2.5, 0], [73, 25, -18])).toBeCloseTo(27.1492, 4);
  });

  it('is zero for one colour', () => {
    expect(deltaE2000([60, 10, -20], [60, 10, -20])).toBe(0);
  });
});

describe('nearest colour', () => {
  it('puts #5aa8ff in on dark and out on light, so the verdict is out', () => {
    const out = lines(['#5aa8ff']);
    expect(line(out, 'dark')).toBe(
      'dark  #5aa8ff: --color-status-working #58a6ff - ΔE00 0.58 - in',
    );
    expect(line(out, 'light')).toBe(
      'light #5aa8ff: --color-text-tertiary #818b98 - ΔE00 18.64 - out',
    );
    expect(out.at(-1)).toBe('verdict: out');
  });

  it('puts #7a7a80 out on dark at 5.99', () => {
    expect(line(lines(['#7a7a80']), 'dark')).toBe(
      'dark  #7a7a80: --color-text-tertiary #6b6b70 - ΔE00 5.99 - out',
    );
  });

  it('lists every token at the minimum distance on a tie', () => {
    expect(line(lines(['#3a7bd5']), 'light')).toBe(
      'light #3a7bd5: --color-accent #0969da, --color-status-working #0969da - ΔE00 6.36 - out',
    );
  });

  it('compares a second colour against the light theme', () => {
    const out = lines(['#5aa8ff', '#0969da']);
    expect(line(out, 'light')).toContain('light #0969da:');
    expect(out.at(-1)).toBe('verdict: in --color-status-working');
  });

  it('accepts #rgb in any case', () => {
    expect(line(lines(['#FFF']), 'dark')).toContain('--color-accent #ffffff - ΔE00 0.00 - in');
  });

  it('states the colour space and threshold in the header', () => {
    expect(lines(['#5aa8ff'])[0]).toContain(`D65; in when ΔE00 ≤ ${String(COLOUR_LIMIT)}`);
  });
});

describe('nearest size', () => {
  it('puts 13px in with the three 12px tokens on each theme', () => {
    const out = lines(['13px']);
    for (const theme of ['dark', 'light'] as const) {
      const themeLine = line(out, theme);
      for (const name of ['--size-icon', '--space-3', '--text-body']) {
        expect(themeLine).toContain(`${name} 12px`);
      }
      expect(themeLine).toMatch(/Δ 1px - in$/);
    }
    expect(out.at(-1)).toBe('verdict: in --text-body, --space-3, --size-icon');
  });

  it('puts 34px out against --size-control at 6px', () => {
    const out = lines(['34px']);
    expect(line(out, 'dark')).toBe('dark  34px: --size-control 28px - Δ 6px - out');
    expect(out.at(-1)).toBe('verdict: out');
  });

  it(`counts ${String(SIZE_LIMIT_PX)}px as in and a little more as out`, () => {
    expect(lines(['29px']).at(-1)).toBe('verdict: in --size-control');
    expect(lines(['29.5px']).at(-1)).toBe('verdict: out');
  });

  it.each([
    ['12px', 'in'],
    ['12PX', 'in'],
    ['12.0px', 'in'],
    ['+12px', 'in'],
    ['1.2e1px', 'in'],
    ['1.2E1px', 'in'],
    ['-12px', 'in'],
    ['.5px', 'out'],
    ['12', 'no scale for this unit'],
    ['12 px', 'composite value'],
    ['1e', 'no scale for this unit'],
    ['px', 'no scale for this unit'],
    ['12pxx', 'no scale for this unit'],
    ['--12px', 'no scale for this unit'],
    ['1e999px', 'not a finite number'],
  ])('reads %s as a CSS px length: %s', (value, expected) => {
    const result = nearest(TOKENS, [value]);
    if (expected === 'in' || expected === 'out') {
      if (!result.ok) throw new Error(result.error);
      const verdict =
        expected === 'in' ? 'verdict: in --text-body, --space-3, --size-icon' : 'verdict: out';
      expect(result.lines.at(-1)).toBe(verdict);
      expect(
        line(result.lines, 'dark').endsWith(value.startsWith('-') ? NEGATIVE_NOTE : expected),
      ).toBe(true);
    } else {
      expect(result.ok ? result.lines : result.error).toContain(expected);
    }
  });

  it('refuses a second argument after a size', () => {
    expect(refused(['13px', '14px'])).toContain('a size takes one argument');
  });
});

describe('refused values', () => {
  it.each(['#5aa8ff80', '#fff8', 'rgba(0,0,0,.5)', 'rgba(0, 0, 0, 0.5)'])(
    'routes alpha %s to new token, not to the composite rule',
    (value) => {
      const error = refused([value]);
      expect(error).toContain('alpha colours are not compared');
      expect(error).toContain('`new token`');
      expect(error).not.toContain('each colour or px part');
    },
  );

  it('routes an alpha light colour to new token', () => {
    expect(refused(['#5aa8ff', '#0969da80'])).toContain('`new token`');
  });

  it.each(['0.02em', '0', '50%'])('routes %s to new token', (value) => {
    expect(refused([value])).toContain('no scale for this unit - decide it as `new token`');
  });

  it('asks to split a composite value into its parts', () => {
    expect(refused(['1px dashed var(--color-border-strong)'])).toContain(
      'run each colour or px part on its own',
    );
  });

  it('asks to quote the hex when no argument is given', () => {
    expect(refused([])).toContain('quote a hex');
  });

  it('refuses tokens.css without a light block', () => {
    const darkOnly = TOKENS.split(":root[data-theme='light'] {")[0] ?? '';
    expect(refused(['#5aa8ff'], darkOnly)).toContain('lacks the');
  });
});

describe('ds:nearest CLI', () => {
  const run = (args: string[]) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

  it.each([['#5aa8ff'], ['13px'], ['34px']])('exits 0 for %s', (value) => {
    const result = run([value]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^verdict: (in|out)/m);
  });

  it('exits 2 with the message on stderr for a refused value', () => {
    const result = run(['0.02em']);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('`new token`');
  });

  it('exits 2 without an argument', () => {
    const result = run([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('quote');
  });
});

describe('docs/design-system-decisions.md', () => {
  it('states both thresholds and the review rule', () => {
    expect(DOC).toContain(`ΔE00 ≤ ${String(COLOUR_LIMIT)}`);
    expect(DOC).toContain(`≤ ${String(SIZE_LIMIT_PX)}px`);
    expect(DOC).toContain(
      'The reviewer accepts or rejects each row; a difference missing from the section is a finding.',
    );
  });
});
