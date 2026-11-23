// A prepare plugin release.config.cjs runs right before @semantic-release/changelog writes
// CHANGELOG.md: it drops the entries a release committed but never tagged (#867).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface ChangelogContext {
  cwd: string;
  branch: { tags: Array<{ version: string }> };
  logger: { log(...args: unknown[]): void };
}

// A section starts at a `## ` line; `###` subsections never start or end one.
const SECTION = /^## /gm;
// `## [1.2.3](compare-url) (date)` with a compare link, else `## 1.2.3 (date)`.
const VERSION_HEADING = /^## \[?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?(?:[ (]|$)/;

/**
 * Removes the leading version entries whose version has no tag on the branch. A release whose
 * branch push landed and whose tag push failed leaves such an entry; the next release's notes
 * cover every commit since the last tag, so they replace it. Pruning stops at the first tagged
 * version or the first `## ` heading that is not a version, such as the upgrade notes.
 */
export function prepare(pluginConfig: { file: string }, context: ChangelogContext): void {
  const path = join(context.cwd, pluginConfig.file);
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  const starts = [...text.matchAll(SECTION)].map((match) => match.index);
  const tagged = new Set(context.branch.tags.map((tag) => tag.version));
  const removed: string[] = [];
  let end = 0;
  for (const [index, start] of starts.entries()) {
    const heading = text.slice(start).split('\n', 1)[0] ?? '';
    const version = VERSION_HEADING.exec(heading)?.[1];
    if (version === undefined || tagged.has(version)) break;
    removed.push(version);
    end = starts[index + 1] ?? text.length;
  }
  if (removed.length === 0) return;
  writeFileSync(path, text.slice(0, starts[0]) + text.slice(end));
  context.logger.log('Dropped untagged %s entries: %s', pluginConfig.file, removed.join(', '));
}
