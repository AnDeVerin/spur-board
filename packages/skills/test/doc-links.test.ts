import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SPUR_MIN_VERSION } from '../../contracts/src/index.ts';

function withoutFences(text: string): string {
  return text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '');
}

function headingSlugs(text: string): Set<string> {
  const slugs = new Set<string>();
  for (const match of withoutFences(text).matchAll(/^#{1,6} (.+)$/gm)) {
    const heading = match[1] ?? '';
    if (/[<>]/.test(heading)) {
      throw new Error(`Unsupported HTML or angle brackets in heading: ${heading}`);
    }
    const base = heading
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '')
      .trim()
      .toLowerCase()
      .replace(/\s/g, '-');
    let slug = base;
    let duplicate = 0;
    while (slugs.has(slug)) slug = `${base}-${String(++duplicate)}`;
    slugs.add(slug);
  }
  return slugs;
}

function localLinks(source: string, text: string) {
  const errors: string[] = [];
  let files = 0;
  let fragments = 0;
  const prose = withoutFences(text).replace(/(`+)[\s\S]*?\1/g, '');
  for (const match of prose.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
    const href = match[1] ?? '';
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) continue;
    const [file = '', fragment] = href.split('#');
    const target = file === '' ? source : resolve(dirname(source), decodeURIComponent(file));
    if (file !== '') files++;
    if (!existsSync(target)) {
      errors.push(`Missing file: ${href}`);
    } else if (fragment !== undefined && fragment !== '') {
      fragments++;
      if (!headingSlugs(readFileSync(target, 'utf8')).has(decodeURIComponent(fragment))) {
        errors.push(`Missing fragment: ${href}`);
      }
    }
  }
  return { errors, files, fragments };
}

function markdownFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name);
    return statSync(path).isDirectory() ? markdownFiles(path) : path.endsWith('.md') ? [path] : [];
  });
}

describe('documentation local links', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));

  it('resolves local files and heading fragments throughout docs, product skills and root guides', () => {
    let fragments = 0;
    const guides = [
      'README.md',
      'CONTRIBUTING.md',
      'SECURITY.md',
      'SETUP.md',
      'TROUBLESHOOTING.md',
      'AGENTS.md',
      'design/README.md',
      'examples/minimal/README.md',
      'packages/gateway-testkit/README.md',
    ];
    const trees: [string, string[]][] = [
      ['docs', markdownFiles(resolve(root, 'docs'))],
      ['packages/skills', markdownFiles(resolve(root, 'packages/skills'))],
      ['root guides', guides.map((name) => resolve(root, name))],
    ];
    for (const [tree, paths] of trees) {
      expect(paths.length).toBeGreaterThan(0);
      let files = 0;
      for (const path of paths) {
        const result = localLinks(path, readFileSync(path, 'utf8'));
        expect(result.errors, path).toEqual([]);
        files += result.files;
        fragments += result.fragments;
      }
      expect(files, tree).toBeGreaterThan(0);
    }
    expect(fragments).toBeGreaterThan(0);
  });

  it('rejects missing files and fragments', () => {
    const source = resolve(root, 'docs/how-board-works.md');
    expect(localLinks(source, '[missing](missing-guide.md)').errors).toEqual([
      'Missing file: missing-guide.md',
    ]);
    expect(localLinks(source, '[missing](#missing-heading)').errors).toEqual([
      'Missing fragment: #missing-heading',
    ]);
  });

  it.each(['<em>Hello</em>', '<scr<script>ipt>', '<script', 'Hello >'])(
    'rejects unsupported angle-bracket heading syntax: %s',
    (heading) => {
      expect(() => headingSlugs(`# ${heading}`)).toThrow(
        'Unsupported HTML or angle brackets in heading',
      );
    },
  );

  it('handles formatted and duplicate headings, decoded fragments and code exclusions', () => {
    expect([...headingSlugs('# **Hello** `world`\n## Hello world\n## Hello world\n')]).toEqual([
      'hello-world',
      'hello-world-1',
      'hello-world-2',
    ]);
    const source = resolve(root, 'docs/how-board-works.md');
    expect(localLinks(source, '[entry](#how%2Dthe-board-works)').errors).toEqual([]);
    expect(
      localLinks(
        source,
        '`[inline](missing.md)`\n```md\n[fenced](missing.md)\n```\n~~~md\n[tilde](missing.md)\n~~~',
      ).files,
    ).toBe(0);
    expect([...headingSlugs('```md\n# Hidden\n```\n# Visible')]).toEqual(['visible']);
  });
});

describe('newcomer entry points', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
  const blob = 'https://github.com/AnDeVerin/spur-board/blob/main/';
  /** The text under `heading` up to the next `##` or `#` heading; `###` stays inside. */
  const section = (text: string, heading: string) => {
    const rest = text.split(`${heading}\n`)[1];
    expect(rest, heading).toBeDefined();
    return rest?.split(/\n#{1,2} /)[0] ?? '';
  };
  const targets = (text: string) =>
    [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => ({
      at: match.index,
      target: (match[1] ?? '').split('#')[0] ?? '',
    }));
  const entries = ['docs/overview.md', 'docs/quickstart.md', 'SETUP.md', 'docs/configuration.md'];
  const npmReadme = read('packages/cli/README.md');

  it('points newcomers to requirements, then overview, quickstart, setup and configuration', () => {
    const engines = (JSON.parse(read('packages/cli/package.json')) as { engines: { node: string } })
      .engines.node;
    expect(engines).toBe('^24.12.0 || ^26.0.0');
    for (const text of [read('README.md'), npmReadme]) {
      const needs = section(text, '## What it needs')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\s+/g, ' ');
      for (const phrase of [
        'Linux with systemd user services',
        '`flock` (util-linux)',
        'Node 24.12+ (24.x) or 26.x',
        `Spur ${SPUR_MIN_VERSION} or newer`,
        'a GitHub token',
        'optionally a Slack app',
        'optional web console',
      ])
        expect(needs).toContain(phrase);
      const heading = text.indexOf('## What it needs\n');
      const links = targets(text).map(({ at, target }) => ({
        at,
        target: target.startsWith(blob) ? target.slice(blob.length) : target,
      }));
      const first = entries.map((entry) => links.find((link) => link.target === entry)?.at ?? -1);
      for (const at of first) expect(at).toBeGreaterThan(heading);
      expect([...first].sort((a, b) => a - b)).toEqual(first);
    }
  });

  it('links the npm README only to absolute URLs of existing repo files', () => {
    for (const { target } of targets(npmReadme)) {
      expect(target).toMatch(/^https:\/\//);
      if (target.startsWith(blob))
        expect(existsSync(resolve(root, target.slice(blob.length))), target).toBe(true);
    }
    for (const entry of [...entries, 'TROUBLESHOOTING.md', 'docs/README.md'])
      expect(npmReadme).toContain(`](${blob}${entry})`);
  });

  it('indexes the docs for users in reading order and for contributors', () => {
    const index = read('docs/README.md');
    const users = targets(section(index, '## For users')).map(({ target }) => target);
    const order = [
      'overview.md',
      'quickstart.md',
      '../SETUP.md',
      'configuration.md',
      '../TROUBLESHOOTING.md',
      'errors.md',
    ].map((target) => users.indexOf(target));
    for (const at of order) expect(at).toBeGreaterThanOrEqual(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(users.filter((target) => target.startsWith('contributing/'))).toEqual([]);
    const contributors = targets(section(index, '## For contributors')).map((link) => link.target);
    const contributing = readdirSync(resolve(root, 'docs/contributing'));
    expect(contributing.length).toBeGreaterThan(0);
    for (const name of contributing) expect(contributors).toContain(`contributing/${name}`);
    const all = targets(index).map(({ target }) => target);
    const topLevel = readdirSync(resolve(root, 'docs')).filter(
      (name) => name.endsWith('.md') && !/^(README|how-board-works-|web-ui-)/.test(name),
    );
    expect(topLevel.length).toBeGreaterThan(5);
    for (const name of topLevel) expect(all, name).toContain(name);
    expect(read('README.md')).toContain('(docs/README.md)');
  });
});
