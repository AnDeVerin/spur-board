import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);

type Rule = Record<string, unknown> & {
  groupName?: string;
  semanticCommitType?: string;
  matchPackageNames?: string[];
};

type Manifest = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const RUNTIME_GROUP = 'runtime dependencies';
const DEV_GROUP = 'dev dependencies';
const UPDATE_TYPES = ['patch', 'minor', 'major'] as const;

// Third-party dependencies of the shipped closure that the published package neither installs
// nor inlines. The staleness guard below keeps each entry honest.
const NOT_SHIPPED: Record<string, { reason: string; importers: string[] }> = {
  ws: {
    reason: 'only the ./testing export uses it; the stand imports that, tsdown never reaches it',
    importers: ['packages/gateway-slack/src/testing.ts'],
  },
};

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const readJson = (path: string): unknown => JSON.parse(read(path));

const renovate = readJson('renovate.json') as { packageRules: Rule[] };
const catalog = Object.keys(
  (parse(read('pnpm-workspace.yaml')) as { catalog: Record<string, string> }).catalog,
);

const releaseConfig = require('../release.config.cjs') as {
  plugins: Array<string | [string, { releaseRules?: Array<{ type?: string; release?: string }> }]>;
};
const releasingTypes = releaseConfig.plugins
  .flatMap((plugin) => (Array.isArray(plugin) ? (plugin[1].releaseRules ?? []) : []))
  .filter((rule) => rule.type !== undefined && rule.release !== undefined)
  .map((rule) => rule.type);

const packageDirs = readdirSync(join(ROOT, 'packages')).filter((dir) =>
  existsSync(join(ROOT, 'packages', dir, 'package.json')),
);
const manifests = new Map<string, Manifest>(
  packageDirs.map((dir) => [dir, readJson(`packages/${dir}/package.json`) as Manifest]),
);
const dirByName = new Map(
  [...manifests].flatMap(([dir, manifest]) => (manifest.name ? [[manifest.name, dir]] : [])),
);

type Dep = { packageName: string; updateType: string };
const DEP_CONTEXT = { manager: 'npm', depType: 'pnpm.catalog.default', datasource: 'npm' };

function exactNames(patterns: string[]): string[] {
  for (const pattern of patterns) {
    if (pattern === '*') continue;
    if (/[*?{}[\]!]/.test(pattern) || /^\/.*\/[a-z]*$/.test(pattern)) {
      throw new Error(`unmodelled matchPackageNames pattern: ${pattern}`);
    }
  }
  return patterns;
}

// A subset of Renovate's packageRules matching: the matchers this repo uses, exact names or `*`.
// Anything else throws so the evaluator cannot silently drift from Renovate.
function matches(rule: Rule, dep: Dep): boolean {
  for (const [key, value] of Object.entries(rule)) {
    if (!key.startsWith('match') && !key.startsWith('exclude')) continue;
    const list = value as string[];
    switch (key) {
      case 'matchManagers':
        if (!list.includes(DEP_CONTEXT.manager)) return false;
        break;
      case 'matchDepTypes':
        if (!list.includes(DEP_CONTEXT.depType)) return false;
        break;
      case 'matchDatasources':
        if (!list.includes(DEP_CONTEXT.datasource)) return false;
        break;
      case 'matchUpdateTypes':
        if (!list.includes(dep.updateType)) return false;
        break;
      case 'matchPackageNames': {
        const names = exactNames(list);
        if (!names.includes('*') && !names.includes(dep.packageName)) return false;
        break;
      }
      default:
        throw new Error(`unmodelled packageRules matcher: ${key}`);
    }
  }
  return true;
}

function resolve(dep: Dep): { groupName?: string; semanticCommitType?: string } {
  const result: { groupName?: string; semanticCommitType?: string } = {};
  for (const rule of renovate.packageRules) {
    if (!matches(rule, dep)) continue;
    if (rule.groupName !== undefined) result.groupName = rule.groupName;
    if (rule.semanticCommitType !== undefined) result.semanticCommitType = rule.semanticCommitType;
  }
  return result;
}

// Packages tsdown bundles into the published binary: cli itself and the `../<dir>/src/` entries.
function rootDirs(): string[] {
  const config = read('packages/cli/tsdown.config.ts');
  const entries = [...config.matchAll(/'\.\.\/([\w-]+)\/src\//g)].map((match) => match[1] ?? '');
  expect(entries.length).toBeGreaterThan(0);
  return ['cli', ...entries];
}

function closure(): { dirs: Set<string>; thirdParty: Set<string> } {
  const seen = new Set<string>();
  const thirdParty = new Set<string>();
  const queue = rootDirs();
  for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const manifest = manifests.get(dir);
    if (!manifest) throw new Error(`no package.json for packages/${dir}`);
    const follow = (deps: Record<string, string> | undefined, collect: boolean) => {
      for (const [name, spec] of Object.entries(deps ?? {})) {
        if (spec.startsWith('workspace:')) {
          const target = dirByName.get(name);
          if (!target) throw new Error(`unknown workspace package ${name}`);
          queue.push(target);
        } else if (collect) {
          thirdParty.add(name);
        }
      }
    };
    follow(manifest.dependencies, true);
    // tsdown inlines every @spur-board/* package (alwaysBundle), so cli's workspace devDependencies
    // ship too; its third-party devDependencies do not.
    if (dir === 'cli') follow(manifest.devDependencies, false);
  }
  return { dirs: seen, thirdParty };
}

function shippedSet(): string[] {
  const { thirdParty } = closure();
  return [...thirdParty].filter((name) => !(name in NOT_SHIPPED)).sort();
}

function sourceFiles(dirs: Set<string>): string[] {
  return [...dirs].flatMap((dir) => {
    const src = join(ROOT, 'packages', dir, 'src');
    if (!existsSync(src)) return [];
    return readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .map((file) => `packages/${dir}/src/${file.split('\\').join('/')}`);
  });
}

describe('renovate.json', () => {
  it('reads the releasing commit types from release.config.cjs', () => {
    expect(releasingTypes).toContain('fix');
    expect(releasingTypes).not.toContain('chore');
  });

  it('groups every shipped dependency as a releasing runtime update', () => {
    for (const packageName of shippedSet()) {
      for (const updateType of UPDATE_TYPES) {
        const result = resolve({ packageName, updateType });
        expect(result.groupName, `${packageName} ${updateType}`).toBe(RUNTIME_GROUP);
        expect(releasingTypes, `${packageName} ${updateType}`).toContain(result.semanticCommitType);
      }
    }
  });

  it('keeps every other catalog entry in the dev group with chore commits', () => {
    const shipped = new Set(shippedSet());
    const others = catalog.filter((name) => !shipped.has(name));
    expect(others).toContain('ws');
    for (const packageName of others) {
      for (const updateType of UPDATE_TYPES) {
        expect(resolve({ packageName, updateType }), `${packageName} ${updateType}`).toEqual({
          groupName: DEV_GROUP,
          semanticCommitType: 'chore',
        });
      }
    }
  });

  it('lists exactly the shipped third-party dependencies in the last rule', () => {
    const runtimeRules = renovate.packageRules.filter((rule) => rule.groupName === RUNTIME_GROUP);
    expect(runtimeRules).toHaveLength(1);
    const rule = renovate.packageRules.at(-1);
    expect(rule).toBe(runtimeRules[0]);
    const names = exactNames(rule?.matchPackageNames ?? []);
    expect([...names].sort()).toEqual(shippedSet());

    const allManifests: Manifest[] = [readJson('package.json') as Manifest, ...manifests.values()];
    for (const name of names) {
      expect(catalog, name).toContain(name);
      for (const manifest of allManifests) {
        for (const field of [
          'dependencies',
          'devDependencies',
          'peerDependencies',
          'optionalDependencies',
        ] as const) {
          const spec = manifest[field]?.[name];
          if (spec !== undefined)
            expect(spec, `${manifest.name ?? 'root'} ${field} ${name}`).toBe('catalog:');
        }
      }
    }
  });

  it('keeps each NOT_SHIPPED entry true to its importers', () => {
    const { dirs, thirdParty } = closure();
    const files = sourceFiles(dirs);
    for (const [name, { importers }] of Object.entries(NOT_SHIPPED)) {
      expect(thirdParty, name).toContain(name);
      const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      const pattern = new RegExp(`(?:from\\s+|import\\()\\s*'${escaped}(?:\\/[^']*)?'`);
      expect(files.filter((file) => pattern.test(read(file))).sort(), name).toEqual(
        [...importers].sort(),
      );
    }
    const testingImport =
      /(?:from\s+|import\()\s*'(?:(?:\.\.?\/)+testing(?:\.[jt]s)?|@spur-board\/gateway-slack\/testing)'/;
    expect(files.filter((file) => testingImport.test(read(file)))).toEqual([]);
  });
});
