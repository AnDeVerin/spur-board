import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createShellQaServer, shellFixture, shellScenarios } from './web-shell-qa.ts';
import { statusOutputSchema } from '../packages/contracts/src/browser.ts';

const root = join(import.meta.dirname, '../packages/web');
const read = (file: string) => readFileSync(join(root, file), 'utf8');
const tokens = read('src/ds/tokens.css');
function declarations(block: string): Record<string, string> {
  return Object.fromEntries(
    [...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1] ?? '', m[2] ?? '']),
  );
}
const dark = declarations(tokens.split(':root {')[1]?.split('}')[0] ?? '');
const light = {
  ...dark,
  ...declarations(tokens.split(":root[data-theme='light'] {")[1]?.split('}')[0] ?? ''),
};
function luminance(hex: string): number {
  const rgb = (hex.match(/[\da-f]{2}/gi) ?? [])
    .map((value) => parseInt(value, 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return (rgb[0] ?? 0) * 0.2126 + (rgb[1] ?? 0) * 0.7152 + (rgb[2] ?? 0) * 0.0722;
}
function rawColor(source: string): boolean {
  return /#[\da-f]{3,8}\b|\brgba?\s*\(/i.test(source);
}
describe('web design assets and policy', () => {
  it('preserves every prototype token and inherited scale byte for byte', () => {
    expect(tokens).toBe(
      readFileSync(join(import.meta.dirname, '../design/prototypes/board-v1/tokens.css'), 'utf8'),
    );
    expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort());
    for (const theme of [dark, light])
      for (const [key, value] of Object.entries(theme)) {
        expect(value, key).not.toBe('');
        expect(value, key).not.toContain('var(');
      }
  });
  it.each([
    ['dark', dark],
    ['light', light],
  ] as const)('%s primary/secondary/status text meets 4.5 on base and elevated', (_name, theme) => {
    for (const fg of [
      '--color-text-primary',
      '--color-text-secondary',
      '--color-status-working',
      '--color-status-ready',
      '--color-status-attention',
      '--color-status-error',
    ]) {
      for (const bg of ['--color-bg-base', '--color-bg-elevated']) {
        const a = luminance(theme[fg] ?? '');
        const b = luminance(theme[bg] ?? '');
        expect(
          (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
          `${fg} on ${bg}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it('rejects raw color literals outside the token file, including negative fixtures', () => {
    for (const invalid of ['color: #abc;', 'color: #123456;', 'rgb(0, 0, 0)', 'rgba(1,2,3,.5)'])
      expect(rawColor(invalid)).toBe(true);
    for (const file of readdirSync(join(root, 'src'), { recursive: true, encoding: 'utf8' }).filter(
      (file) => /\.(?:css|ts|tsx)$/.test(file) && file !== 'ds/tokens.css',
    ))
      expect(rawColor(read(`src/${file}`)), file).toBe(false);
  });
  it('ships only local hashed fonts with the original bytes and license', () => {
    const assets = readdirSync(join(root, 'dist/assets'));
    const css = assets
      .filter((file) => file.endsWith('.css'))
      .map((file) => read(`dist/assets/${file}`))
      .join('\n');
    expect(css).not.toMatch(/https?:|fonts\.google/i);
    for (const weight of ['Regular', 'Medium', 'Bold']) {
      const font = assets.find((file) =>
        new RegExp(`^JetBrainsMono-${weight}-[\\w-]{8,}\\.woff2$`).test(file),
      );
      expect(font).toBeDefined();
      expect(css).toContain(font);
      expect(readFileSync(join(root, 'dist/assets', font ?? 'missing'))).toEqual(
        readFileSync(
          join(
            import.meta.dirname,
            `../design/prototypes/board-v1/fonts/JetBrainsMono-${weight}.woff2`,
          ),
        ),
      );
    }
    expect(read('OFL.txt').replace(/[ \t]+$/gm, '')).toBe(
      readFileSync(
        join(import.meta.dirname, '../design/prototypes/board-v1/fonts/OFL.txt'),
        'utf8',
      ).replace(/[ \t]+$/gm, ''),
    );
    expect(existsSync(join(root, 'dist/index.html'))).toBe(true);
  });
});
describe('shell QA scenarios', () => {
  it.each(shellScenarios)('%s fixture conforms to the production status shape', (name) => {
    expect(statusOutputSchema.safeParse(shellFixture(name)).success).toBe(true);
  });
  it('provides empty, mixed-health long-name and recovery data', () => {
    expect(shellFixture('empty').tasks).toHaveLength(0);
    const mixed = shellFixture('mixed').sources;
    expect(mixed).toHaveLength(12);
    expect(mixed.some((source) => source.blindReason !== null)).toBe(true);
    expect(mixed.some((source) => !source.stale && source.blindReason === null)).toBe(true);
    expect(shellFixture('recovered').tasks).toHaveLength(2);
  });
});

it('serves built assets and controlled status/error/recovery fixtures on loopback', async () => {
  const server = createShellQaServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const origin = `http://127.0.0.1:${String(address.port)}`;
    expect((await fetch(origin)).status).toBe(200);
    for (const name of ['empty', 'mixed', 'read-error', 'recovered']) {
      expect((await fetch(`${origin}/__qa/scenario/${name}`, { method: 'POST' })).status).toBe(204);
      const response = await fetch(`${origin}/v1/ops/status.get`, { method: 'POST' });
      if (name === 'read-error') expect(response.status).toBe(500);
      else {
        const body = (await response.json()) as { value: unknown };
        expect(statusOutputSchema.parse(body.value)).toEqual(
          shellFixture(name === 'empty' ? 'empty' : name === 'mixed' ? 'mixed' : 'recovered'),
        );
      }
    }
    await fetch(`${origin}/__qa/scenario/stream-drop`, { method: 'POST' });
    expect((await fetch(`${origin}/v1/stream`)).status).toBe(502);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});
