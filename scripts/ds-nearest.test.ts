import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COLOUR_LIMIT, SIZE_LIMIT_PX, UNITLESS_LIMITS, deltaE2000, nearest } from './ds-nearest.ts';

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
  it('puts 13px in with the three 12px tokens and --text-lead on each theme', () => {
    const out = lines(['13px']);
    for (const theme of ['dark', 'light'] as const) {
      const themeLine = line(out, theme);
      for (const name of ['--size-icon', '--space-3', '--text-body']) {
        expect(themeLine).toContain(`${name} 12px`);
      }
      expect(themeLine).toContain('--text-lead 14px');
      expect(themeLine).toMatch(/Δ 1px - in$/);
    }
    expect(out.at(-1)).toBe('verdict: in --text-body, --text-lead, --space-3, --size-icon');
  });

  it('puts 30px out against the 32px and 28px tokens at 2px', () => {
    const out = lines(['30px']);
    expect(line(out, 'dark')).toBe(
      'dark  30px: --space-8 32px, --size-section-header 32px, --size-control 28px - Δ 2px - out',
    );
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
    ['.5e2px', 'out'],
    ['12', 'a unitless value needs --family'],
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

describe('nearest unitless', () => {
  const FAMILIES = 'weight, leading, stroke, opacity, lines, z, radius';

  it('puts an exact font weight in with its token', () => {
    expect(lines(['500', '--family', 'weight'])).toEqual([
      'unitless difference within --weight-*; in when Δ ≤ 0 in both themes',
      'dark  500: --weight-medium 500 - Δ 0 - in',
      'light 500: --weight-medium 500 - Δ 0 - in',
      'verdict: in --weight-medium',
    ]);
  });

  it(`puts a line height ${String(UNITLESS_LIMITS.leading)} away in and further out`, () => {
    const near = lines(['1.45', '--family', 'leading']);
    expect(line(near, 'dark')).toBe('dark  1.45: --leading-title 1.4 - Δ 0.05 - in');
    expect(near.at(-1)).toBe('verdict: in --leading-title');
    expect(lines(['1.5', '--family', 'leading']).at(-1)).toBe('verdict: out');
  });

  it('compares only tokens of the given family', () => {
    const leading = lines(['1.6', '--family', 'leading']);
    expect(leading.at(-1)).toBe('verdict: out');
    expect(leading.join('\n')).not.toContain('--stroke-icon');
    const weight = lines(['400', '--family', 'weight']);
    expect(line(weight, 'dark')).toMatch(/Δ 100 - out$/);
    expect(weight.at(-1)).toBe('verdict: out');
  });

  it('compares the sign and matches the unitless radius', () => {
    expect(lines(['-1', '--family', 'z']).at(-1)).toBe('verdict: out');
    expect(lines(['0', '--family', 'radius']).at(-1)).toBe('verdict: in --radius');
  });

  it('reads the families from tokens.css', () => {
    const css = TOKENS.replace(':root {', ':root {\n  --foo-bar: 3;');
    const result = nearest(css, ['3', '--family', 'foo']);
    if (!result.ok) throw new Error(result.error);
    expect(result.lines.at(-1)).toBe('verdict: in --foo-bar');
  });

  it('refuses a unitless value without a known family', () => {
    const missing = refused(['500']);
    expect(missing).toContain('--family');
    expect(missing).toContain(FAMILIES);
    expect(refused(['500', '--family', 'text'])).toContain(
      `unknown family text - --family takes one of: ${FAMILIES}`,
    );
  });

  it.each([
    [['13px', '--family', 'space'], '--family applies only to a unitless value'],
    [['500', '--family'], '--family needs a name'],
    [['500', '--family', 'weight', '--family', 'weight'], '--family given twice'],
    [['1', '2', '--family', 'z'], 'a unitless value takes one argument'],
  ])('refuses %j', (args, expected) => {
    expect(refused(args)).toContain(expected);
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

  it.each(['0.02em', '50%'])('routes %s to a family check by hand', (value) => {
    const error = refused([value]);
    expect(error).toContain('no scale for this unit - keep a `structural literal`');
    expect(error).toContain('by hand');
    expect(error).toContain('`nearest token`');
    expect(error).toContain('`new token`');
  });

  it('routes a bare 0 to the structural literal before any family check', () => {
    const error = refused(['0']);
    expect(error).toContain('a unitless value needs --family');
    expect(error).toContain('keep a `structural literal`');
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

  it.each([['#5aa8ff'], ['13px'], ['30px']])('exits 0 for %s', (value) => {
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

  it('exits 0 for a unitless value with its family', () => {
    const result = run(['500', '--family', 'weight']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^verdict: in --weight-medium$/m);
  });

  it('exits 2 for a unitless value without --family', () => {
    const result = run(['500']);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('--family');
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

  it('states every unitless limit and routes an equal token to nearest token', () => {
    for (const [family, limit] of Object.entries(UNITLESS_LIMITS)) {
      expect(DOC).toContain(`\`${family}\` Δ ≤ ${String(limit)}`);
    }
    expect(DOC).toContain('any other family Δ ≤ 0 (exact)');
    expect(DOC).not.toContain('or a refusal from the script.');
    expect(DOC).toContain('pnpm ds:nearest 500 --family weight');
    expect(DOC).toContain('pnpm ds:nearest 0 --family radius');
    for (const output of lines(['500', '--family', 'weight'])) expect(DOC).toContain(output);
  });
});
