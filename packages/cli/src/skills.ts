import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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
  copySkill?: (source: string, destination: string) => Promise<void>;
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

async function targetDirectory(path: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Skill install target must be a directory, not a symlink: ${path}`);
    }
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function checkTarget(home: string, agent: string, destination: string): Promise<boolean> {
  const parent = join(home, agent, 'skills');
  await targetDirectory(home);
  await targetDirectory(join(home, agent));
  await targetDirectory(parent);
  return targetDirectory(destination);
}

export async function installSkills(
  options: InstallSkillsOptions = {},
): Promise<SkillInstallResult[]> {
  const packageRoot = resolve(
    options.packageRoot ?? fileURLToPath(new URL('../', import.meta.url)),
  );
  const home = resolve(options.home ?? homedir());
  const version = await packageVersion(packageRoot);
  // Check all assets before changing an existing installation.
  await Promise.all(
    skills.map((skill) => requireSource(join(packageRoot, 'skills', skill.source))),
  );

  // Reject all redirected targets before changing any of the four installed skills.
  for (const agent of agents) {
    for (const skill of skills) {
      await checkTarget(home, agent, join(home, agent, 'skills', skill.name));
    }
  }

  const installedAt = (options.now ?? (() => new Date()))().toISOString();
  const results: SkillInstallResult[] = [];
  for (const agent of agents) {
    const parent = join(home, agent, 'skills');
    for (const skill of skills) {
      const destination = join(parent, skill.name);
      const changed = !(await currentVersion(destination, version));
      if (changed) {
        await mkdir(parent, { recursive: true });
        await checkTarget(home, agent, destination);
        const staged = await mkdtemp(join(parent, `.${skill.name}-stage-`));
        try {
          const source = join(packageRoot, 'skills', skill.source);
          if (options.copySkill) await options.copySkill(source, staged);
          else await cp(source, staged, { recursive: true });
          const stamp: InstallStamp = { version, installedAt };
          await writeFile(join(staged, stampName), `${JSON.stringify(stamp, null, 2)}\n`);

          const existing = await checkTarget(home, agent, destination);
          if (existing) {
            const backup = join(parent, `.${skill.name}-backup-${randomUUID()}`);
            await rename(destination, backup);
            try {
              await rename(staged, destination);
            } catch (error) {
              await rename(backup, destination);
              throw error;
            }
            await rm(backup, { recursive: true });
          } else {
            await rename(staged, destination);
          }
        } finally {
          await rm(staged, { recursive: true, force: true });
        }
      }
      results.push({ agent: agent === '.claude' ? 'claude' : 'codex', skill: skill.name, changed });
    }
  }
  return results;
}
