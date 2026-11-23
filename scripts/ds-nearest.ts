// `pnpm ds:nearest '<hex>' ['<light hex>'] | <n>px | <number> --family <name>`: the nearest design
// token per theme and an in/out verdict. Colours are compared by CIEDE2000 (sRGB, IEC 61966-2-1,
// to CIELAB under D65, no chromatic adaptation); sizes by the absolute px difference; a unitless
// value by the difference to the unitless tokens of its family (`--<name>-*`). Exit 0 for any
// computed result, 2 for a value the script refuses. Thresholds, reason codes and routes:
// docs/contributing/design-system-decisions.md.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A colour is `in` when ΔE00 to the nearest token is at most this (inclusive). */
export const COLOUR_LIMIT = 5;
/** A size is `in` when the px difference to the nearest token is at most this (inclusive). */
export const SIZE_LIMIT_PX = 1;
/**
 * A unitless value is `in` when its difference to the nearest token of its family is at most
 * this (inclusive). A family not listed here matches only an equal token.
 */
export const UNITLESS_LIMITS: Readonly<Record<string, number>> = {
  leading: 0.05,
  opacity: 0.05,
  stroke: 0.05,
};

const TOKENS = join(import.meta.dirname, '../packages/web/src/ds/tokens.css');
const DOC = 'docs/contributing/design-system-decisions.md';
const DARK_BLOCK = ':root {';
const LIGHT_BLOCK = ":root[data-theme='light'] {";
const TIE = 1e-9;

const USAGE =
  "usage: pnpm ds:nearest '<hex>' ['<light hex>'] | <n>px | <number> --family <name> - quote a hex: an unquoted # starts a shell comment";
const ALPHA = `alpha colours are not compared - check the alpha \`--color-*\` tokens of each theme by hand and name the family in the evidence: an equal token is \`nearest token\`, none is \`new token\`, or \`operator decision\` to keep it (${DOC})`;
const COMPOSITE = `composite value - run each colour or px part on its own; keywords and \`var()\` parts need no check (${DOC})`;
const NOT_FINITE = `not a finite number - ${USAGE}`;
const NO_SCALE = `no scale for this unit - keep a \`structural literal\`; otherwise check the value's family in tokens.css by hand and name it in the evidence: an equal token is \`nearest token\`, none is \`new token\`, or \`operator decision\` to keep the literal (${DOC})`;
const FAMILY_FLAG = '--family';

type Lab = readonly [number, number, number];
type Theme = 'dark' | 'light';

export type NearestResult = { ok: true; lines: string[] } | { ok: false; error: string };

const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** CIEDE2000 colour difference (kL = kC = kH = 1), after Sharma, Wu and Dalal (2005). */
export function deltaE2000(lab1: Lab, lab2: Lab): number {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;
  const cBar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const hue = (b: number, ap: number) =>
    b === 0 && ap === 0 ? 0 : (deg(Math.atan2(b, ap)) + 360) % 360;
  const h1p = hue(b1, a1p);
  const h2p = hue(b2, a2p);

  const dLp = L2 - L1;
  const dCp = c2p - c1p;
  let dhp = 0;
  if (c1p * c2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin(rad(dhp / 2));

  const lBarP = (L1 + L2) / 2;
  const cBarP = (c1p + c2p) / 2;
  let hBarP = h1p + h2p;
  if (c1p * c2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hBarP /= 2;
    else hBarP = h1p + h2p < 360 ? (hBarP + 360) / 2 : (hBarP - 360) / 2;
  }
  const t =
    1 -
    0.17 * Math.cos(rad(hBarP - 30)) +
    0.24 * Math.cos(rad(2 * hBarP)) +
    0.32 * Math.cos(rad(3 * hBarP + 6)) -
    0.2 * Math.cos(rad(4 * hBarP - 63));
  const dTheta = 30 * Math.exp(-(((hBarP - 275) / 25) ** 2));
  const rC = 2 * Math.sqrt(cBarP ** 7 / (cBarP ** 7 + 25 ** 7));
  const sL = 1 + (0.015 * (lBarP - 50) ** 2) / Math.sqrt(20 + (lBarP - 50) ** 2);
  const sC = 1 + 0.045 * cBarP;
  const sH = 1 + 0.015 * cBarP * t;
  const rT = -Math.sin(rad(2 * dTheta)) * rC;
  return Math.sqrt(
    (dLp / sL) ** 2 + (dCp / sC) ** 2 + (dHp / sH) ** 2 + rT * (dCp / sC) * (dHp / sH),
  );
}

/** `#rgb` or `#rrggbb` to CIELAB: sRGB (IEC 61966-2-1) -> XYZ -> Lab, D65 white. */
function hexToLab(hex: string): Lab {
  const digits = hex.slice(1);
  const full = digits.length === 3 ? digits.replace(/./g, '$&$&') : digits;
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (v: number) => (v > 216 / 24389 ? Math.cbrt(v) : ((24389 / 27) * v + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

function declarations(block: string): [string, string][] {
  return [...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [
    m[1] ?? '',
    (m[2] ?? '').trim(),
  ]);
}

function themeTokens(css: string): Record<Theme, [string, string][]> | undefined {
  const dark = css.split(DARK_BLOCK)[1]?.split('}')[0];
  const light = css.split(LIGHT_BLOCK)[1]?.split('}')[0];
  if (dark === undefined || light === undefined) return undefined;
  const darkTokens = declarations(dark);
  const overrides = new Map(declarations(light));
  const lightTokens = darkTokens.map(([name, value]): [string, string] => [
    name,
    overrides.get(name) ?? value,
  ]);
  for (const [name, value] of overrides) {
    if (!darkTokens.some(([n]) => n === name)) lightTokens.push([name, value]);
  }
  return { dark: darkTokens, light: lightTokens };
}

const OPAQUE_HEX = /^#(?:[\da-f]{3}|[\da-f]{6})$/i;
const ALPHA_HEX = /^#(?:[\da-f]{4}|[\da-f]{8})$/i;
// A CSS <number>: sign, digits or a leading-dot fraction, exponent. `PX` adds `px`, any case.
const NUMBER_SOURCE = String.raw`[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?`;
const PX = new RegExp(`^(${NUMBER_SOURCE})px$`, 'i');
const NUMBER = new RegExp(`^${NUMBER_SOURCE}$`, 'i');
const NEGATIVE_NOTE =
  'a negative value is compared by its size; write it as calc(-1 * var(--token))';

/** The px value of a CSS length such as `1.2e1px`, or undefined when it is not one. */
function pxValue(value: string): number | undefined {
  const match = PX.exec(value);
  return match === null ? undefined : Number(match[1]);
}

/** The value of a bare CSS number such as `0.4`, or undefined when it is not one. */
function unitlessValue(value: string): number | undefined {
  return NUMBER.test(value) ? Number(value) : undefined;
}

/** Whether a token name belongs to `family`: `--<family>` or `--<family>-*`. */
const inFamily = (name: string, family: string) =>
  name === `--${family}` || name.startsWith(`--${family}-`);

/** Families (first name segment) of the unitless tokens, in file order. */
function unitlessFamilies(tokens: Record<Theme, [string, string][]>): string[] {
  const families = [...tokens.dark, ...tokens.light].flatMap(([name, value]) =>
    unitlessValue(value) === undefined ? [] : [name.slice(2).split('-')[0] ?? ''],
  );
  return [...new Set(families)];
}

/** Refusal for one argument, or undefined when it is an opaque hex, a px size or a number. */
function refusal(arg: string): string | undefined {
  if (ALPHA_HEX.test(arg) || /^rgba\s*\(/i.test(arg)) return ALPHA;
  if (/\s/.test(arg)) return COMPOSITE;
  if (OPAQUE_HEX.test(arg)) return undefined;
  const unitless = unitlessValue(arg);
  if (unitless !== undefined) return Number.isFinite(unitless) ? undefined : NOT_FINITE;
  const px = pxValue(arg);
  if (px === undefined) return NO_SCALE;
  return Number.isFinite(px) ? undefined : NOT_FINITE;
}

interface ThemeMatch {
  theme: Theme;
  input: string;
  names: string[];
  values: string[];
  distance: number;
  within: boolean;
}

function closest(
  candidates: [string, string][],
  distanceTo: (value: string) => number,
  limit: number,
): Omit<ThemeMatch, 'theme' | 'input'> {
  let best = Infinity;
  let set: [string, string][] = [];
  for (const [name, value] of candidates) {
    const d = distanceTo(value);
    if (d < best - TIE) {
      best = d;
      set = [[name, value]];
    } else if (Math.abs(d - best) <= TIE) {
      set.push([name, value]);
    }
  }
  return {
    names: set.map(([n]) => n),
    values: set.map(([, v]) => v),
    distance: best,
    within: best <= limit,
  };
}

/** The nearest tokens per theme for `args` against the text of tokens.css, as printable lines. */
export function nearest(tokensCss: string, args: readonly string[]): NearestResult {
  const trimmed = args.map((a) => a.trim());
  const flags = trimmed.flatMap((a, i) => (a === FAMILY_FLAG ? [i] : []));
  if (flags.length > 1) return { ok: false, error: `${FAMILY_FLAG} given twice - ${USAGE}` };
  const flagAt = flags[0];
  const family = flagAt === undefined ? undefined : trimmed[flagAt + 1];
  if (flagAt !== undefined && (family === undefined || family === '')) {
    return { ok: false, error: `${FAMILY_FLAG} needs a name - ${USAGE}` };
  }
  const positional =
    flagAt === undefined ? trimmed : trimmed.filter((_, i) => i !== flagAt && i !== flagAt + 1);
  const [first, second, ...rest] = positional;
  if (first === undefined || first === '') return { ok: false, error: USAGE };
  if (rest.length > 0) return { ok: false, error: `too many arguments - ${USAGE}` };
  for (const arg of [first, second]) {
    const refused = arg === undefined ? undefined : refusal(arg);
    if (refused !== undefined) return { ok: false, error: refused };
  }
  const isUnitless = [first, second].some((a) => a !== undefined && NUMBER.test(a));
  if (isUnitless && second !== undefined) {
    return { ok: false, error: `a unitless value takes one argument - ${USAGE}` };
  }
  if (!isUnitless && family !== undefined) {
    return { ok: false, error: `${FAMILY_FLAG} applies only to a unitless value - ${USAGE}` };
  }
  const isColour = OPAQUE_HEX.test(first);
  if (!isColour && second !== undefined) {
    return { ok: false, error: `a size takes one argument - ${USAGE}` };
  }
  if (isColour && second !== undefined && !OPAQUE_HEX.test(second)) {
    return { ok: false, error: `the light value must be a hex colour - ${USAGE}` };
  }
  const tokens = themeTokens(tokensCss);
  if (tokens === undefined) {
    return {
      ok: false,
      error: `tokens.css lacks the \`${DARK_BLOCK}\` or \`${LIGHT_BLOCK}\` block`,
    };
  }
  if (isUnitless) {
    const families = unitlessFamilies(tokens).join(', ');
    if (family === undefined) {
      return {
        ok: false,
        error: `a unitless value needs ${FAMILY_FLAG} <name>, one of: ${families} - keep a \`structural literal\` (\`0\` that places a box, \`1\` or \`-1\` as a multiplier) without a check (${DOC})`,
      };
    }
    if (!unitlessFamilies(tokens).includes(family)) {
      return {
        ok: false,
        error: `unknown family ${family} - ${FAMILY_FLAG} takes one of: ${families}`,
      };
    }
  }
  const unitlessLimit = family === undefined ? 0 : (UNITLESS_LIMITS[family] ?? 0);

  const matches: ThemeMatch[] = (['dark', 'light'] as const).map((theme) => {
    const input = theme === 'light' && second !== undefined ? second : first;
    if (family !== undefined) {
      const value = Number(input);
      const candidates = tokens[theme].filter(
        ([name, v]) => inFamily(name, family) && Number.isFinite(unitlessValue(v)),
      );
      return {
        theme,
        input,
        ...closest(
          candidates,
          (v) => Math.abs((unitlessValue(v) ?? NaN) - value),
          unitlessLimit + TIE,
        ),
      };
    }
    if (isColour) {
      const lab = hexToLab(input);
      const candidates = tokens[theme].filter(([, v]) => OPAQUE_HEX.test(v));
      return {
        theme,
        input,
        ...closest(candidates, (v) => deltaE2000(lab, hexToLab(v)), COLOUR_LIMIT),
      };
    }
    const px = Math.abs(pxValue(input) ?? NaN);
    const candidates = tokens[theme].flatMap(([name, v]): [string, string][] => {
      const tokenPx = pxValue(v);
      return tokenPx !== undefined && Number.isFinite(tokenPx) ? [[name, v]] : [];
    });
    return {
      theme,
      input,
      ...closest(candidates, (v) => Math.abs((pxValue(v) ?? NaN) - px), SIZE_LIMIT_PX),
    };
  });

  const [dark, light] = matches as [ThemeMatch, ThemeMatch];
  const both = dark.within && light.within ? dark.names.filter((n) => light.names.includes(n)) : [];
  const header =
    family !== undefined
      ? `unitless difference within --${family}-*; in when Δ ≤ ${String(unitlessLimit)} in both themes`
      : isColour
        ? `CIEDE2000, sRGB to CIELAB D65; in when ΔE00 ≤ ${String(COLOUR_LIMIT)} in both themes`
        : `px difference; in when ≤ ${String(SIZE_LIMIT_PX)}px in both themes`;
  const lines = [
    header,
    ...matches.map((m) => {
      const set = m.names.map((n, i) => `${n} ${m.values[i] ?? ''}`).join(', ');
      const distance =
        family !== undefined
          ? `Δ ${String(Number(m.distance.toFixed(4)))}`
          : isColour
            ? `ΔE00 ${m.distance.toFixed(2)}`
            : `Δ ${String(m.distance)}px`;
      const negative = !isColour && (pxValue(m.input) ?? 0) < 0 ? ` (${NEGATIVE_NOTE})` : '';
      return `${m.theme.padEnd(5)} ${m.input}: ${set} - ${distance} - ${m.within ? 'in' : 'out'}${negative}`;
    }),
    both.length > 0 ? `verdict: in ${both.join(', ')}` : 'verdict: out',
  ];
  return { ok: true, lines };
}

if (import.meta.main) {
  const result = nearest(readFileSync(TOKENS, 'utf8'), process.argv.slice(2));
  if (result.ok) {
    for (const line of result.lines) console.log(line);
  } else {
    console.error(`ds:nearest: ${result.error}`);
    process.exitCode = 2;
  }
}
