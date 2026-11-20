// Shared by the Turn section tests: board-task-turn, board-task-turn-send and board-task-turn-reread.
import { act } from 'react';
import {
  config,
  daemon,
  envelope,
  orchestratorTaskGet,
  row,
  type Daemon,
} from './board-fixtures.ts';
import { mount, press, serve, settle } from './board-harness.ts';

export const HEAD = 'a'.repeat(40);
export const SOURCE = 'b'.repeat(40);
export const AT = '2026-11-15T13:00:00.000Z';
const reviewConfig = {
  ...config,
  projects: config.projects.map((entry, index) =>
    index === 0
      ? {
          ...entry,
          // Review, then QA before Done: a passing Review submit moves the task to QA.
          columns: entry.columns.flatMap((column) =>
            column.id === 'review'
              ? [
                  { ...column, executor: { kind: 'orchestrator', name: 'rev-bot' } },
                  { id: 'qa', executor: { kind: 'orchestrator', name: 'qa-bot' } },
                ]
              : [column],
          ),
        }
      : entry,
  ),
};
const prFacts = (headSha: string) => ({
  repo: 'ex/repo',
  number: 7,
  url: 'https://github.com/ex/repo/pull/7',
  title: 'Fix login',
  author: 'dev',
  headSha,
  headBranch: 'fix-login',
  state: 'open',
  draft: false,
  mergeable: 'mergeable',
  mergeState: 'clean',
  requiredChecks: [],
  checks: [],
  reviews: [],
  reviewThreads: [],
  reviewRequests: [],
  ticketKeys: [],
  updatedAt: AT,
});
/** A closed `task.get` turn as detail lists it. */
export const closedTurn = (outcome: string, by: string | null = 'agent:qa/qa-1') => ({
  ...orchestratorTaskGet().turn,
  taken: by === null ? null : { by, at: AT },
  closed: { at: AT, outcome },
});

type Call = { op: string; input: Record<string, unknown>; key: string | undefined };
/**
 * Opens ex/repo#7 on a fake daemon; `rows` are the chosen project's status rows (by default #7 in
 * Review with one open PR at `HEAD`).
 */
export async function open(
  answer: unknown = orchestratorTaskGet(),
  rows: unknown[] = [row('ex/repo#7', 'review', { prs: [prFacts(HEAD)] })],
) {
  const d = daemon();
  const calls: Call[] = [];
  serve(d, rows, reviewConfig);
  setTask(d, answer);
  history.replaceState(null, '', '/?open=ex%2Frepo%237');
  mount({
    ...d,
    fetcher: (url, init) => {
      const path = url instanceof Request ? url.url : url.toString();
      if (path.startsWith('/v1/ops/') && !path.endsWith('.get') && !path.endsWith('.operator')) {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
          input: Record<string, unknown>;
          key?: string;
        };
        calls.push({ op: path.slice('/v1/ops/'.length), input: body.input, key: body.key });
      }
      return d.fetcher(url, init);
    },
  });
  await settle();
  return { d, calls, writes: () => calls.filter((call) => call.op !== 'task.history') };
}
export function setTask(d: Daemon, answer: unknown) {
  d.routes['task.get'] = () => Promise.resolve(envelope(answer));
}
export async function reread(d: Daemon, answer: unknown) {
  setTask(d, answer);
  d.send('event: reset\ndata: {}\n\n');
  await settle();
}
export const dialog = () => {
  const found = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!found) throw new Error('no task view');
  return found;
};
export const section = () =>
  [...dialog().querySelectorAll('section')].find(
    (candidate) => candidate.querySelector('[id$="-title"]')?.textContent === 'Turn',
  );
export const turnSection = () => {
  const found = section();
  if (!found) throw new Error('no Turn section');
  return found;
};
export const buttons = () => [...turnSection().querySelectorAll('button')];
export const button = (label: string) => {
  const found = buttons().find((candidate) => candidate.textContent === label);
  if (!found) throw new Error(`no ${label} button`);
  return found;
};
export const form = () => {
  const found = turnSection().querySelector('form');
  if (!found) throw new Error('no turn form');
  return found;
};
export const text = () => turnSection().textContent;
export const summary = () =>
  turnSection().querySelector('[id$="-title"]')?.nextElementSibling?.textContent;
export const commit = () => {
  const found = turnSection().querySelector<HTMLInputElement>('input[aria-label="Commit"]');
  if (!found) throw new Error('no Commit field');
  return found;
};
export const source = () => {
  const found = turnSection().querySelector<HTMLInputElement>('input[aria-label="Carried from"]');
  if (!found) throw new Error('no Carried from field');
  return found;
};
export const reason = () => {
  const found = turnSection().querySelector('textarea');
  if (!found) throw new Error('no Reason field');
  return found;
};
export function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
export async function send() {
  act(() => {
    form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await settle();
}
export async function choose(basis: string) {
  const tab = [...turnSection().querySelectorAll('[role="tab"]')].find(
    (candidate) => candidate.textContent === basis,
  );
  if (!tab) throw new Error(`no ${basis} tab`);
  press(tab, 'click');
  await settle();
}
export async function click(label: string) {
  press(button(label), 'click');
  await settle();
}
/** The primary button of the open form and the paragraph right before it. */
export function confirmation() {
  const primary = form().querySelector<HTMLButtonElement>('button[type="submit"]');
  const line = primary?.parentElement?.previousElementSibling;
  return { primary, line: line?.tagName === 'P' ? line.textContent : undefined };
}
