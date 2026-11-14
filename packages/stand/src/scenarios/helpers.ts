// Helpers the scenario files share; kept apart from `index.ts`, which imports every scenario.
import type { ScenarioFakes, Settled } from './index.ts';

const STAND_REPO = 'stand-org/board';

/**
 * The Spur projects of the stand project in the stand's base config. A scenario that sets
 * `stand.spurProjects` replaces the list, so it starts from this one.
 */
export const STAND_SPUR_PROJECTS = [
  { name: 'stand-worker', role: 'worker' },
  { name: 'stand-qa', role: 'worker' },
] as const;

/** The open GitHub issue `number` of the stand project, as the board stores its task key. */
export const issueKey = (number: number): string => `${STAND_REPO}#${String(number)}`;

/** Opens issues 1..count, titled by `title`, in the fake. */
export async function openIssues(
  fakes: ScenarioFakes,
  count: number,
  title: (number: number) => string = (number) => `Stand issue ${String(number)}`,
): Promise<void> {
  for (let number = 1; number <= count; number += 1)
    await fakes.github('issue-open', { repo: STAND_REPO, number, title: title(number) });
}

/** Ticket `number` of the stand-jira project's Jira project, as the board stores its task key. */
export const jiraKey = (number: number): string => `STAND-${String(number)}`;

/** Creates Jira tickets STAND-1..count, titled by `title`, in the fake. */
export async function openJiraIssues(
  fakes: ScenarioFakes,
  count: number,
  title: (number: number) => string = (number) => `Stand ticket ${String(number)}`,
): Promise<void> {
  for (let number = 1; number <= count; number += 1)
    await fakes.jira('issue', { key: jiraKey(number), title: title(number) });
}

/** Settled when `problems` is empty; otherwise its lines are the diagnostics. */
export function settledUnless(problems: readonly string[]): Settled {
  return problems.length === 0 ? { ok: true } : { ok: false, diagnostics: problems };
}
