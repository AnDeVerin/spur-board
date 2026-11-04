import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const stampName = '.spur-board-install.json';
const skills = [
  { source: 'spur-board', name: 'spur-board' },
  { source: 'setup', name: 'spur-board-setup' },
] as const;
const agents = ['.claude', '.codex'] as const;

export interface InstallSkillsOptions {
  home?: string;
  packageRoot?: string;
  now?: () => Date;
}

export interface SkillInstallResult {
  agent: 'claude' | 'codex';
  skill: 'spur-board' | 'spur-board-setup';
  changed: boolean;
}

interface InstallStamp {
  version: string;
  installedAt: string;
}

async function packageVersion(packageRoot: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (typeof manifest.version !== 'string' || !manifest.version) {
    throw new Error('The spur-board package has no version.');
  }
  return manifest.version;
}

async function requireSource(path: string): Promise<void> {
  try {
    const source = await stat(path);
    const skillFile = await stat(join(path, 'SKILL.md'));
    if (source.isDirectory() && skillFile.isFile()) return;
  } catch {
    // A missing or unreadable bundled skill is reported with the same actionable error.
  }
  throw new Error(`Bundled skill is missing or invalid: ${path}`);
}

async function currentVersion(path: string, version: string): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(join(path, stampName), 'utf8');
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'EISDIR')
    ) {
      return false;
    }
    throw error;
  }
  try {
    const stamp = JSON.parse(content) as Partial<InstallStamp>;
    return (
      stamp.version === version &&
      typeof stamp.installedAt === 'string' &&
      new Date(stamp.installedAt).toISOString() === stamp.installedAt
    );
  } catch {
    return false;
  }
}

export async function installSkills(
  options: InstallSkillsOptions = {},
): Promise<SkillInstallResult[]> {
  const packageRoot = resolve(
    options.packageRoot ?? fileURLToPath(new URL('../', import.meta.url)),
  );
  const home = resolve(options.home ?? homedir());
  const version = await packageVersion(packageRoot);
  const sources = skills.map((skill) => join(packageRoot, 'skills', skill.source));

  // Check all assets before changing an existing installation.
  await Promise.all(sources.map(requireSource));

  const installedAt = (options.now ?? (() => new Date()))().toISOString();
  const results: SkillInstallResult[] = [];
  for (const agent of agents) {
    const parent = join(home, agent, 'skills');
    for (const [index, skill] of skills.entries()) {
      const destination = join(parent, skill.name);
      const changed = !(await currentVersion(destination, version));
      if (changed) {
        await mkdir(parent, { recursive: true });
        await rm(destination, { recursive: true, force: true });
        const source = sources[index];
        if (!source) throw new Error('Bundled skill mapping is incomplete.');
        await cp(source, destination, { recursive: true });
        const stamp: InstallStamp = { version, installedAt };
        await writeFile(join(destination, stampName), `${JSON.stringify(stamp, null, 2)}\n`);
      }
      results.push({ agent: agent === '.claude' ? 'claude' : 'codex', skill: skill.name, changed });
    }
  }
  return results;
}
