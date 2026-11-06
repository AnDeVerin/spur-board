// `pnpm agents:sync [--check]` and `pnpm lint:agents`. Sync generates `.claude/agents/*.md`,
// `.codex/agents/*.toml`, the `.claude/skills` link and the AGENTS.md skills and roles table from
// the tracked `.agents/` sources; `--check` reports drift without writing. Lint checks agent files
// against the skill-writer rules, then runs the drift check.
// Reads only files tracked in the git index. Imports only `node:` builtins.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** The `sandbox_mode` of each role's `.codex/agents/<role>.toml`. A new role needs a line here. */
const ROLE_SANDBOX: Record<string, 'read-only' | 'workspace-write'> = {
  architect: 'read-only',
  critic: 'read-only',
  designer: 'read-only',
  developer: 'workspace-write',
  researcher: 'read-only',
  reviewer: 'workspace-write',
  'spec-critic': 'read-only',
  tester: 'workspace-write',
};

/** Code spans in `.agents/skills/manager/**` that have the shape of a name but name no agent. */
const NOT_AGENT_NAMES = new Set(['add', 'gh', 'main', 'pnpm', 'read-only', 'workspace-write']);

/** Bare file names cited in agent files that are not repo files (runtime files of a user). */
const NOT_REPO_FILES = new Set(['config.yaml']);

/** A code span without `/` that names a file: a known extension, so `ctx.log` is not a file. */
const BARE_FILE =
  /^\.?[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:json|jsonc|ya?ml|toml|[cm]?[jt]sx?|md|sh|lock)$/;

/** Output directories; each must be a real directory, so sync never writes through a link. */
const OUTPUT_DIRS = ['.claude', '.claude/agents', '.codex', '.codex/agents'];

const NAME = '[a-z0-9]+(?:-[a-z0-9]+)*';
const NAME_ONLY = new RegExp(`^${NAME}$`);
const LINK = '.claude/skills';
const LINK_TARGET = '../.agents/skills';
const BEGIN = '<!-- BEGIN GENERATED SKILLS AND ROLES: pnpm agents:sync -->';
const END = '<!-- END GENERATED SKILLS AND ROLES -->';
const SKILL_KEYS = ['name', 'description'];
const ROLE_KEYS = ['name', 'description', 'model', 'effort', 'tools'];
const BUDGET = { skill: 5120, reference: 8192, role: 4096, agents: 32768 };
const DESCRIPTION_LIMIT = 300;
const HINT = 'run pnpm agents:sync';

class UsageError extends Error {}

const USAGE = 'usage: node scripts/agents.ts sync [--check] | lint';

interface Finding {
  file: string;
  line?: number;
  message: string;
  /** Sync cannot render the outputs while this finding stands. */
  blocks: boolean;
}

interface Field {
  value: string;
  line: number;
}

interface Frontmatter {
  fields: Map<string, Field>;
  /** The text after the closing `---` and one blank line; null without the blank line. */
  body: string | null;
  errors: { line: number; message: string }[];
}

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`);
  }
  return result.stdout;
}

const nulList = (text: string): string[] => text.split('\0').filter((entry) => entry !== '');

function lstat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** A flat `key: value` frontmatter block, or the first structural error. */
function parseFrontmatter(text: string): Frontmatter | { line: number; message: string } {
  if (!text.startsWith('---\n')) return { line: 1, message: 'frontmatter must start with ---' };
  const lines = text.split('\n');
  const fields = new Map<string, Field>();
  const errors: { line: number; message: string }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const number = i + 1;
    if (line === '---') {
      const rest = lines.slice(i + 1).join('\n');
      return { fields, errors, body: rest.startsWith('\n') ? rest.slice(1) : null };
    }
    const match = /^([a-z]+): (.*)$/.exec(line);
    if (!match) return { line: number, message: 'frontmatter line is not "key: value"' };
    const key = match[1] ?? '';
    const value = match[2] ?? '';
    if (fields.has(key)) errors.push({ line: number, message: `duplicate key ${key}` });
    else fields.set(key, { value, line: number });
    if (value.trim() === '') errors.push({ line: number, message: `empty value for ${key}` });
    else if (value !== value.trim()) {
      errors.push({ line: number, message: `value of ${key} has surrounding whitespace` });
    }
    if (value.includes(': ') || value.includes(' #')) {
      errors.push({ line: number, message: `value of ${key} contains ": " or " #"` });
    }
    if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(value)) {
      errors.push({ line: number, message: `value of ${key} starts with a YAML indicator` });
    }
  }
  return { line: 1, message: 'frontmatter has no closing ---' };
}

interface Item {
  line: number;
  text: string;
}

/**
 * Markdown split into items, with frontmatter and fenced code removed: an item starts after a
 * blank line or fence, or at a list item, heading or table row; other lines join the item.
 */
function items(text: string): Item[] {
  const out: Item[] = [];
  let current: Item | null = null;
  let fence = false;
  let frontmatter = text.startsWith('---\n');
  text.split('\n').forEach((line, i) => {
    if (frontmatter) {
      if (i > 0 && line === '---') frontmatter = false;
      current = null;
      return;
    }
    if (/^[ \t]*```/.test(line)) {
      fence = !fence;
      current = null;
      return;
    }
    if (fence) return;
    if (line.trim() === '') {
      current = null;
      return;
    }
    if (current === null || /^\s*([-*+]|\d+\.)\s/.test(line) || /^#|^\|/.test(line)) {
      current = { line: i + 1, text: line.trim() };
      out.push(current);
    } else {
      current.text += ` ${line.trim()}`;
    }
  });
  return out;
}

const spans = (text: string): string[] =>
  [...text.matchAll(/(?<!`)`([^`]+)`(?!`)/g)].map((match) => match[1] ?? '');

const lineAt = (text: string, index: number): number => text.slice(0, index).split('\n').length;

const PRIVACY: { pattern: RegExp; label: (match: string) => string | null }[] = [
  { pattern: /\/home\//g, label: () => 'machine path /home/' },
  { pattern: /~\/\./g, label: () => 'machine path ~/.' },
  { pattern: /\bip-\d{1,3}(?:-\d{1,3}){3}\b/g, label: (match) => `hostname ${match}` },
  {
    pattern: /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:internal|local|lan)\b(?!\.)/g,
    label: (match) => `hostname ${match}`,
  },
  { pattern: /\.amazonaws\.com\b/g, label: (match) => `hostname ${match}` },
  {
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
    label: (match) => {
      const domain = match.slice(match.indexOf('@') + 1).toLowerCase();
      return /(^|\.)example\.(com|org|net)$/.test(domain) ? null : `email ${match}`;
    },
  },
];

const tomlString = (value: string): string =>
  `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

/** A table summary: the description before `cut`, trailing punctuation trimmed, `|` escaped. */
function summary(description: string, cut: string): string {
  const index = description.indexOf(cut);
  return (index < 0 ? description : description.slice(0, index))
    .replace(/[\s.,;:]+$/u, '')
    .replaceAll('|', '\\|');
}

interface Drift {
  file: string;
  role?: string;
  message: string;
  fix?: string;
}

interface State {
  root: string;
  skills: string[];
  roles: string[];
  findings: Finding[];
  /** Path -> expected text; null when a blocking finding stops the render. */
  expected: Map<string, string> | null;
  /** Tracked outputs on disk that have no source role. */
  stale: string[];
  /** Expected outputs on disk that git does not track and sync would change. */
  untracked: string[];
  /** Output directories that exist but are not real directories (a symlink or a file). */
  unsafeDirs: string[];
  link: 'ok' | 'missing' | { target: string } | 'not-symlink';
  indexMode: string | null;
}

function analyze(root: string): State {
  const tracked = new Set(nulList(git(root, ['ls-files', '-z'])));
  const dirs = new Set<string>();
  const top = new Set<string>();
  const basenames = new Set<string>();
  for (const path of tracked) {
    const parts = path.split('/');
    top.add(parts[0] ?? '');
    basenames.add(parts.at(-1) ?? '');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const sources = [...tracked].filter((path) => path.startsWith('.agents/')).sort();
  const skills = sources
    .map((path) => /^\.agents\/skills\/([^/]+)\/SKILL\.md$/.exec(path)?.[1])
    .filter((name) => name !== undefined)
    .sort();
  const roles = sources
    .map((path) => /^\.agents\/agents\/([^/]+)\.md$/.exec(path)?.[1])
    .filter((name) => name !== undefined)
    .sort();
  const skillSet = new Set(skills);
  const roleSet = new Set(roles);
  const findings: Finding[] = [];
  const add = (file: string, line: number | undefined, message: string, blocks = false) => {
    const skill = /^\.agents\/skills\/([^/]+)\//.exec(file)?.[1];
    const role = /^\.agents\/agents\/([^/]+)\.md$/.exec(file)?.[1];
    const owner =
      skill !== undefined && skillSet.has(skill)
        ? `skill ${skill}: `
        : role !== undefined
          ? `role ${role}: `
          : '';
    findings.push({
      file,
      ...(line === undefined ? {} : { line }),
      message: `${owner}${message}`,
      blocks,
    });
  };
  const budget = (path: string, text: string, limit: number) => {
    const size = Buffer.byteLength(text);
    if (size > limit)
      add(path, undefined, `${String(size)} bytes, over the ${String(limit)}-byte budget`);
  };
  const exists = (path: string): boolean => {
    const clean = path.replace(/\/+$/, '');
    return (tracked.has(clean) || dirs.has(clean)) && existsSync(join(root, clean));
  };

  const texts = new Map<string, string>();
  const read = (path: string, blocks: boolean): string | null => {
    const stats = lstat(join(root, path));
    if (stats === null) add(path, undefined, 'tracked but missing on disk', blocks);
    else if (!stats.isFile()) add(path, undefined, 'not a regular file', blocks);
    else {
      const text = readFileSync(join(root, path), 'utf8');
      texts.set(path, text);
      return text;
    }
    return null;
  };

  // Layout, then the full text of every tracked source.
  for (const path of sources) {
    const skill =
      /^\.agents\/skills\/([^/]+)\/(?:SKILL\.md|references\/[^/]+\.md|scripts\/[^/]+)$/.exec(
        path,
      )?.[1];
    const isRole = /^\.agents\/agents\/[^/]+\.md$/.test(path);
    if (!isRole && (skill === undefined || !skillSet.has(skill))) {
      add(
        path,
        undefined,
        'unexpected file - a skill holds SKILL.md, references/*.md and scripts/*; a role is .agents/agents/<role>.md',
      );
    }
    read(path, path.endsWith('/SKILL.md') || isRole);
  }
  const agentsTracked = tracked.has('AGENTS.md');
  const agentsText = agentsTracked ? read('AGENTS.md', true) : null;
  if (!agentsTracked) add('AGENTS.md', undefined, 'not tracked', true);

  // AGENTS.md markers.
  let region: { begin: number; end: number } | null = null;
  if (agentsText !== null) {
    const lines = agentsText.split('\n');
    const begins = lines.flatMap((line, i) => (line === BEGIN ? [i] : []));
    const ends = lines.flatMap((line, i) => (line === END ? [i] : []));
    const [begin] = begins;
    const [end] = ends;
    if (
      begins.length === 1 &&
      ends.length === 1 &&
      begin !== undefined &&
      end !== undefined &&
      begin < end
    ) {
      region = { begin, end };
    } else {
      add('AGENTS.md', undefined, `needs one "${BEGIN}" line before one "${END}" line`, true);
    }
    budget('AGENTS.md', agentsText, BUDGET.agents);
  }

  // Frontmatter, schema, triggers and budgets.
  const frontmatter = new Map<string, Frontmatter>();
  for (const [kind, names] of [
    ['skill', skills],
    ['role', roles],
  ] as const) {
    for (const name of names) {
      const path =
        kind === 'skill' ? `.agents/skills/${name}/SKILL.md` : `.agents/agents/${name}.md`;
      const text = texts.get(path);
      if (text === undefined) continue;
      budget(path, text, kind === 'skill' ? BUDGET.skill : BUDGET.role);
      const parsed = parseFrontmatter(text);
      if ('message' in parsed) {
        add(path, parsed.line, parsed.message, true);
        continue;
      }
      frontmatter.set(path, parsed);
      for (const error of parsed.errors) add(path, error.line, error.message);
      const keys = kind === 'skill' ? SKILL_KEYS : ROLE_KEYS;
      for (const key of keys) {
        if (!parsed.fields.has(key))
          add(path, 2, `missing key ${key}`, key !== 'model' && key !== 'tools');
      }
      for (const [key, field] of parsed.fields) {
        if (!keys.includes(key)) add(path, field.line, `unexpected key ${key}`);
      }
      const field = (key: string) => parsed.fields.get(key);
      const nameField = field('name');
      if (nameField !== undefined) {
        if (!NAME_ONLY.test(nameField.value))
          add(path, nameField.line, `name "${nameField.value}" is not lowercase-hyphenated`);
        else if (nameField.value !== name)
          add(
            path,
            nameField.line,
            `name "${nameField.value}" differs from the ${kind === 'skill' ? 'directory' : 'file'} name ${name}`,
          );
      }
      const description = field('description');
      if (description !== undefined) {
        const length = Array.from(description.value).length;
        if (length > DESCRIPTION_LIMIT) {
          add(
            path,
            description.line,
            `description is ${String(length)} characters, over ${String(DESCRIPTION_LIMIT)}`,
          );
        }
        const d = description.value;
        const useWhen = d.indexOf('Use when ');
        if (kind === 'skill' && (useWhen < 0 || d.indexOf("Don't use for ", useWhen) < 0)) {
          add(
            path,
            description.line,
            'description needs "Use when ..." followed by "Don\'t use for ..."',
          );
        }
        if (kind === 'role' && !d.includes('Use ')) {
          add(path, description.line, 'description needs "Use after <role>, before <role>."');
        }
      }
      if (kind === 'role') {
        const checks: [string, RegExp][] = [
          ['model', /^[a-z0-9.-]+$/],
          ['effort', /^[a-z]+$/],
          ['tools', /^[A-Z][A-Za-z]*(, [A-Z][A-Za-z]*)*$/],
        ];
        for (const [key, shape] of checks) {
          const value = field(key);
          if (value !== undefined && !shape.test(value.value))
            add(path, value.line, `${key} "${value.value}" does not match ${String(shape)}`);
        }
        if (parsed.body === null)
          add(path, undefined, 'needs a blank line after the closing ---', true);
        else {
          if (parsed.body.includes("'''"))
            add(path, undefined, "body contains ''' and cannot be a TOML literal string", true);
          if (!parsed.body.endsWith('\n'))
            add(path, undefined, 'body must end with a newline', true);
        }
        if (!(name in ROLE_SANDBOX)) {
          add(
            path,
            undefined,
            'missing from ROLE_SANDBOX in scripts/agents.ts - add its sandbox_mode there',
            true,
          );
        }
      }
    }
  }
  for (const path of sources) {
    if (/^\.agents\/skills\/[^/]+\/references\/[^/]+\.md$/.test(path)) {
      budget(path, texts.get(path) ?? '', BUDGET.reference);
    }
  }

  // Privacy, over the full text of every tracked source and AGENTS.md.
  for (const [path, text] of texts) {
    for (const { pattern, label } of PRIVACY) {
      for (const match of text.matchAll(pattern)) {
        const message = label(match[0]);
        if (message !== null) add(path, lineAt(text, match.index), message);
      }
    }
  }

  // Names in descriptions.
  for (const [path, parsed] of frontmatter) {
    const description = parsed.fields.get('description');
    if (description === undefined) continue;
    const d = description.value;
    const isRole = path.startsWith('.agents/agents/');
    for (const match of d.matchAll(new RegExp(`(?:^|[\\s(])[/$](${NAME})(?=[\\s.,;)]|$)`, 'g'))) {
      if (!skillSet.has(match[1] ?? ''))
        add(path, description.line, `unregistered skill \`${match[1] ?? ''}\``);
    }
    if (!isRole) {
      for (const match of d.matchAll(new RegExp(`\\(use (${NAME})\\)`, 'g'))) {
        if (!skillSet.has(match[1] ?? ''))
          add(path, description.line, `unregistered skill \`${match[1] ?? ''}\``);
      }
    } else {
      const flow = d.slice(Math.max(0, d.lastIndexOf('Use ')));
      for (const match of flow.matchAll(
        new RegExp(`\\b(?:after|before) (${NAME})(?=[,.;]|$)`, 'g'),
      )) {
        if (!roleSet.has(match[1] ?? ''))
          add(path, description.line, `unregistered role \`${match[1] ?? ''}\``);
      }
    }
  }

  // Paths, names and describe citations in the body text.
  for (const [path, raw] of texts) {
    if (!path.endsWith('.md')) continue;
    let text = raw;
    if (path === 'AGENTS.md' && region !== null) {
      const { begin, end } = region;
      text = raw
        .split('\n')
        .map((line, i) => (i >= begin && i <= end ? '' : line))
        .join('\n');
    }
    const skillDir = /^(\.agents\/skills\/[^/]+)\//.exec(path)?.[1];
    const manager = path.startsWith('.agents/skills/manager/');
    for (const item of items(text)) {
      const cited: string[] = [];
      const describes: string[] = [];
      for (const span of spans(item.text)) {
        if (span.includes('/') && !/[<>{}*\s]/.test(span)) {
          const cite = span.replace(/:\d+(?:-\d+)?$/, '');
          const relative = skillDir !== undefined && /^references\/[^/]/.test(cite);
          const resolved = relative ? `${skillDir}/${cite}` : cite;
          if (relative || top.has(cite.split('/')[0] ?? '')) {
            if (!exists(resolved)) add(path, item.line, `missing path ${cite}`);
            else if (/\.test\.tsx?$/.test(resolved)) cited.push(resolved);
          }
        } else if (!span.includes('/')) {
          const cite = span.replace(/:\d+(?:-\d+)?$/, '');
          if (BARE_FILE.test(cite) && !NOT_REPO_FILES.has(cite) && !basenames.has(cite))
            add(path, item.line, `missing file ${cite} - no tracked file has this name`);
        }
        const command = new RegExp(`^[/$](${NAME})(?: <[^>]+>)?$`).exec(span);
        if (command && !skillSet.has(command[1] ?? ''))
          add(path, item.line, `unregistered skill \`${command[1] ?? ''}\``);
        const describe = /^describe\((['"])(.+?)\1(,|\))?$/.exec(span);
        if (describe) describes.push(describe[2] ?? '');
        if (
          manager &&
          NAME_ONLY.test(span) &&
          !skillSet.has(span) &&
          !roleSet.has(span) &&
          !NOT_AGENT_NAMES.has(span)
        ) {
          add(
            path,
            item.line,
            `unregistered name \`${span}\` - name a tracked skill or role, or add it to NOT_AGENT_NAMES in scripts/agents.ts`,
          );
        }
      }
      for (const match of item.text.matchAll(new RegExp(`\`(${NAME})\` (skill|role)s?\\b`, 'g'))) {
        const name = match[1] ?? '';
        if (!(match[2] === 'skill' ? skillSet : roleSet).has(name))
          add(path, item.line, `unregistered ${match[2] ?? ''} \`${name}\``);
      }
      for (const match of item.text.matchAll(
        new RegExp(`\\bSkills?:\\s+((?:\`${NAME}\`(?:,\\s+|\\s+and\\s+)?)+)`, 'g'),
      )) {
        for (const named of (match[1] ?? '').matchAll(new RegExp(`\`(${NAME})\``, 'g'))) {
          if (!skillSet.has(named[1] ?? ''))
            add(path, item.line, `unregistered skill \`${named[1] ?? ''}\``);
        }
      }
      if (cited.length > 0) {
        for (const name of describes) {
          const found = cited.some((file) => {
            const test = readFileSync(join(root, file), 'utf8');
            return ["'", '"', '`'].some((quote) =>
              test.includes(`describe(${quote}${name}${quote}`),
            );
          });
          if (!found) add(path, item.line, `describe('${name}') is not in ${cited.join(', ')}`);
        }
      }
    }
  }

  // Render.
  const blocked = findings.some((finding) => finding.blocks);
  let expected: Map<string, string> | null = null;
  if (!blocked && agentsText !== null && region !== null) {
    expected = new Map();
    const rows: string[] = [];
    for (const name of skills) {
      const path = `.agents/skills/${name}/SKILL.md`;
      const d = frontmatter.get(path)?.fields.get('description')?.value ?? '';
      rows.push(`| [${name}](${path}) | skill | ${summary(d, ' Use when ')} |`);
    }
    for (const name of roles) {
      const path = `.agents/agents/${name}.md`;
      const parsed = frontmatter.get(path);
      const text = texts.get(path) ?? '';
      const value = (key: string) => parsed?.fields.get(key)?.value ?? '';
      rows.push(`| [${name}](${path}) | role | ${summary(value('description'), ' Use ')} |`);
      expected.set(`.claude/agents/${name}.md`, text);
      expected.set(
        `.codex/agents/${name}.toml`,
        [
          `name = ${tomlString(value('name'))}`,
          `description = ${tomlString(value('description'))}`,
          `model_reasoning_effort = ${tomlString(value('effort'))}`,
          `sandbox_mode = ${tomlString(ROLE_SANDBOX[name] ?? '')}`,
          `developer_instructions = '''`,
          `${parsed?.body ?? ''}'''`,
          '',
        ].join('\n'),
      );
    }
    const table = [
      BEGIN,
      '',
      '<!-- prettier-ignore-start -->',
      '',
      '| Name | Kind | Description |',
      '| --- | --- | --- |',
      ...rows,
      '',
      '<!-- prettier-ignore-end -->',
      '',
      END,
    ];
    const lines = agentsText.split('\n');
    expected.set(
      'AGENTS.md',
      [...lines.slice(0, region.begin), ...table, ...lines.slice(region.end + 1)].join('\n'),
    );
  }

  const outputs = nulList(git(root, ['ls-files', '-z', '--', '.claude/agents', '.codex/agents']));
  const stale = outputs.filter(
    (path) => !(expected?.has(path) ?? true) && lstat(join(root, path)) !== null,
  );
  const untracked = [...(expected?.entries() ?? [])]
    .filter(([path, text]) => {
      if (path === 'AGENTS.md' || tracked.has(path)) return false;
      const stats = lstat(join(root, path));
      return stats !== null && !(stats.isFile() && readFileSync(join(root, path), 'utf8') === text);
    })
    .map(([path]) => path);
  const unsafeDirs = OUTPUT_DIRS.filter((dir) => {
    const stats = lstat(join(root, dir));
    return stats !== null && !stats.isDirectory();
  });
  const linkStats = lstat(join(root, LINK));
  const target = linkStats?.isSymbolicLink() ? readlinkSync(join(root, LINK)) : null;
  const link: State['link'] =
    linkStats === null
      ? 'missing'
      : target === null
        ? 'not-symlink'
        : target === LINK_TARGET
          ? 'ok'
          : { target };
  let indexMode: string | null = null;
  for (const entry of nulList(git(root, ['ls-files', '-s', '-z', '--', LINK]))) {
    const match = /^(\d+) \S+ \d+\t(.*)$/s.exec(entry);
    if (match?.[2] === LINK && match[1] !== '120000') indexMode = match[1] ?? null;
    if (match?.[2]?.startsWith(`${LINK}/`)) indexMode = 'directory';
  }
  return { root, skills, roles, findings, expected, stale, untracked, unsafeDirs, link, indexMode };
}

const roleOf = (path: string): string | undefined =>
  /^\.(?:claude|codex)\/agents\//.test(path) ? basename(path).replace(/\.[^.]*$/, '') : undefined;

const DIR_FIX = 'replace it with a real directory and rerun pnpm agents:sync';
const UNTRACKED_FIX = 'git add or move it, then rerun pnpm agents:sync';

function drift(state: State): Drift[] {
  const out: Drift[] = [];
  for (const dir of state.unsafeDirs)
    out.push({ file: dir, message: 'not a directory', fix: DIR_FIX });
  for (const [path, text] of state.expected ?? []) {
    const stats = lstat(join(state.root, path));
    const role = roleOf(path);
    const base = role === undefined ? { file: path } : { file: path, role };
    if (stats === null) out.push({ ...base, message: 'missing' });
    else if (!stats.isFile() || readFileSync(join(state.root, path), 'utf8') !== text) {
      out.push({ ...base, message: 'out of date' });
    }
  }
  for (const path of state.stale) {
    const role = roleOf(path) ?? '';
    out.push({ file: path, role, message: `no source .agents/agents/${role}.md` });
  }
  if (state.link === 'missing') out.push({ file: LINK, message: 'missing' });
  else if (state.link === 'not-symlink') {
    out.push({ file: LINK, message: 'not a symlink', fix: 'remove it and rerun pnpm agents:sync' });
  } else if (state.link !== 'ok') {
    out.push({
      file: LINK,
      message: `out of date (link -> ${state.link.target}, want ${LINK_TARGET})`,
    });
  }
  if (state.indexMode !== null) {
    out.push({
      file: LINK,
      message: `tracked as ${state.indexMode === 'directory' ? 'a directory' : `mode ${state.indexMode}`}, want a symlink (mode 120000)`,
      fix: `${HINT} and git add ${LINK}`,
    });
  }
  return out;
}

const findingLine = (prefix: string, finding: Finding): string =>
  `${prefix}: ${finding.file}${finding.line === undefined ? '' : `:${String(finding.line)}`}: ${finding.message}`;

const driftLine = (prefix: string, entry: Drift): string =>
  `${prefix}: ${entry.file}: ${entry.role === undefined ? '' : `role ${entry.role}: `}${entry.message} - ${entry.fix ?? HINT}`;

function sync(root: string, check: boolean, log: (line: string) => void): number {
  const prefix = 'agents:sync';
  const state = analyze(root);
  const blockers = state.findings.filter((finding) => finding.blocks);
  if (blockers.length > 0 || state.expected === null) {
    for (const finding of blockers) log(findingLine(prefix, finding));
    return 1;
  }
  const entries = drift(state);
  if (check || state.link === 'not-symlink') {
    const shown = check ? entries : entries.filter((entry) => entry.file === LINK);
    for (const entry of shown) log(driftLine(prefix, entry));
    if (shown.length > 0) return 1;
    log(`${prefix}: up to date`);
    return 0;
  }
  // Refuse before any write: never write through a linked directory or over an untracked file.
  if (state.unsafeDirs.length > 0 || state.untracked.length > 0) {
    for (const dir of state.unsafeDirs)
      log(driftLine(prefix, { file: dir, message: 'not a directory', fix: DIR_FIX }));
    for (const path of state.untracked) {
      const role = roleOf(path);
      log(
        driftLine(prefix, {
          file: path,
          ...(role === undefined ? {} : { role }),
          message: 'untracked file would be overwritten',
          fix: UNTRACKED_FIX,
        }),
      );
    }
    return 1;
  }
  let written = 0;
  for (const [path, text] of state.expected) {
    const file = join(root, path);
    const stats = lstat(file);
    if (stats?.isFile() && readFileSync(file, 'utf8') === text) continue;
    if (stats !== null) rmSync(file);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    written++;
  }
  for (const path of state.stale) {
    rmSync(join(root, path));
    written++;
  }
  if (state.link !== 'ok') {
    const file = join(root, LINK);
    if (state.link !== 'missing') rmSync(file);
    mkdirSync(dirname(file), { recursive: true });
    symlinkSync(LINK_TARGET, file);
    written++;
  }
  log(written === 0 ? `${prefix}: up to date` : `${prefix}: wrote ${String(written)} file(s)`);
  return 0;
}

function lint(root: string, log: (line: string) => void): number {
  const prefix = 'lint:agents';
  const state = analyze(root);
  const lines = state.findings.map((finding) => findingLine(prefix, finding));
  if (state.expected !== null) lines.push(...drift(state).map((entry) => driftLine(prefix, entry)));
  for (const line of lines) log(line);
  if (lines.length > 0) {
    log(`${prefix}: FAIL - ${String(lines.length)} finding(s)`);
    return 1;
  }
  log(`${prefix}: OK - ${String(state.skills.length)} skills, ${String(state.roles.length)} roles`);
  return 0;
}

function run(argv: string[], log: (line: string) => void = console.log): number {
  const [command, ...rest] = argv;
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).replace(/\n$/, '');
  if (command === 'sync' && rest.length === 0) return sync(root, false, log);
  if (command === 'sync' && rest.length === 1 && rest[0] === '--check')
    return sync(root, true, log);
  if (command === 'lint' && rest.length === 0) return lint(root, log);
  throw new UsageError(USAGE);
}

if (import.meta.main) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`agents: ${message}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
