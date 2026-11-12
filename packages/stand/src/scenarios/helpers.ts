// Helpers the scenario files share; kept apart from `index.ts`, which imports every scenario.
import type { ScenarioFakes, Settled } from './index.ts';

const STAND_REPO = 'stand-org/board';

/** The open GitHub issue `number` of the stand project, as the board stores its task key. */
export const issueKey = (number: number): string => `${STAND_REPO}#${String(number)}`;

/**
 * The same task in the short form `link.add` takes. It resolves its key through the project's
 * tracker, and the full key also matches the stand's Jira project, whose key `STAND` prefixes
 * `stand-org/...`, so the board finds no unique project. Operations that look the task up by
 * key, like `block.ask` and `task.get`, take the full key.
 */
export const issueRef = (number: number): string => `board#${String(number)}`;

/** Opens issues 1..count, titled by `title`, in the fake. */
export async function openIssues(
  fakes: ScenarioFakes,
  count: number,
  title: (number: number) => string = (number) => `Stand issue ${String(number)}`,
): Promise<void> {
  for (let number = 1; number <= count; number += 1)
    await fakes.github('issue-open', { repo: STAND_REPO, number, title: title(number) });
}

/** Settled when `problems` is empty; otherwise its lines are the diagnostics. */
export function settledUnless(problems: readonly string[]): Settled {
  return problems.length === 0 ? { ok: true } : { ok: false, diagnostics: problems };
}
