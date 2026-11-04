import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, openSync } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
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
  await targetDirectory(join(home, agent));
  await targetDirectory(parent);
  return targetDirectory(destination);
}

async function withInstallLock<T>(home: string, action: () => Promise<T>): Promise<T> {
  const file = join(home, '.spur-board-skills-install.lock');
  const fd = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    // flock locks the open file description shared by this process and its short-lived child.
    await new Promise<void>((resolveLock, reject) => {
      const child = spawn('flock', ['-x', '-w', '30', '3'], {
        stdio: ['ignore', 'ignore', 'pipe', fd],
      });
      let stderr = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.once('error', (error) => {
        reject(
          new Error(`flock from util-linux is required for skill installation: ${error.message}`),
        );
      });
      child.once('close', (code) => {
        if (code === 0) resolveLock();
        else
          reject(
            new Error(
              `Could not lock skill installation: ${stderr.trim() || `exit ${String(code)}`}`,
            ),
          );
      });
    });
    return await action();
  } finally {
    closeSync(fd);
  }
}

async function recoverSkill(parent: string, destination: string, name: string): Promise<void> {
  if (!(await targetDirectory(parent))) return;
  const entries = await readdir(parent);
  const backupPrefix = `.${name}-backup-`;
  const backupId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const backups = entries.filter(
    (entry) => entry.startsWith(backupPrefix) && backupId.test(entry.slice(backupPrefix.length)),
  );
  for (const entry of backups) await targetDirectory(join(parent, entry));

  const exists = await targetDirectory(destination);
  if (!exists && backups.length > 1) {
    throw new Error(`Multiple interrupted backups exist for ${destination}`);
  }
  if (!exists && backups[0]) await rename(join(parent, backups[0]), destination);
  else if (exists) {
    for (const backup of backups) await rm(join(parent, backup), { recursive: true });
  }
}

async function installIntoHome(
  home: string,
  packageRoot: string,
  version: string,
  options: InstallSkillsOptions,
): Promise<SkillInstallResult[]> {
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
      await recoverSkill(parent, destination, skill.name);
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

export async function installSkills(
  options: InstallSkillsOptions = {},
): Promise<SkillInstallResult[]> {
  const packageRoot = resolve(
    options.packageRoot ?? fileURLToPath(new URL('../', import.meta.url)),
  );
  const home = await realpath(resolve(options.home ?? homedir()));
  const version = await packageVersion(packageRoot);
  // Check all assets before changing an existing installation.
  await Promise.all(
    skills.map((skill) => requireSource(join(packageRoot, 'skills', skill.source))),
  );

  return withInstallLock(home, () => installIntoHome(home, packageRoot, version, options));
}
