// The long task card of the board prototype (`/?state=long`): one Dev row with a long title, the
// worker's taken turn, the operator's and the worker's blocks, a return with findings and two
// pull requests, the first conflicting with changes requested.
import { randomUUID } from 'node:crypto';
import { awaitTurn, entities, flow, ISSUE, PR, REPO, take, toReview } from './dispatcher.ts';
import { settledUnless } from './helpers.ts';
import type { Scenario } from './index.ts';

/** About 130 characters, so the card clamps it to three lines. */
const LONG_TITLE =
  'Retry the GitHub poll after a secondary rate limit without losing the cursor, and report the wait on the status bar and in History';
const FINDINGS = 5;
const SECOND_PR = `${REPO}#2`;

export const cardLong: Scenario = {
  name: 'card-long',
  summary: `${ISSUE} in Dev with a long title, the worker's taken turn, a block to the operator, a return with ${String(FINDINGS)} findings and two PRs, the first conflicting.`,
  config: flow(),
  async seed(board, fakes) {
    // PR 1 is mergeable here: a conflict would fail the Dev gate before Review.
    const review = await toReview(board, fakes, {}, LONG_TITLE);
    await take(board, 'orchestrator', review.id);
    const { block: code } = await board.call(
      'orchestrator',
      'task.return',
      { turn: review.id, reason: 'Fix the five review findings.', findings: FINDINGS },
      randomUUID(),
    );
    const dev = await awaitTurn(board, 'worker', 'dev: no_submit_on_head');
    await take(board, 'worker', dev.id);
    const { block: question } = await board.call(
      'worker',
      'block.ask',
      { task: ISSUE, text: 'Should the wait show in seconds or as a time?' },
      randomUUID(),
    );
    await fakes.github('review', {
      repo: REPO,
      number: 1,
      state: 'CHANGES_REQUESTED',
      threads: 3,
    });
    await fakes.github('conflict', { repo: REPO, number: 1 });
    // Linked after PR 1 by its branch, so the row lists it second.
    await fakes.github('create', { repo: REPO, number: 2, seed: { headRefName: 'stand-1' } });
    await board.poll();
    return entities(board, {
      prs: { flow: PR, second: SECOND_PR },
      blocks: { code: code.id, question: question.id },
    });
  },
  async settled({ board }) {
    const { tasks } = await board.call('operator', 'status.get', {
      project: 'stand',
      detail: true,
    });
    const row = tasks.find(({ key }) => key === ISSUE);
    if (row === undefined) return settledUnless([`no row ${ISSUE}`]);
    const problems: string[] = [];
    if ((row.ticket?.title.length ?? 0) <= 100) problems.push('the title is not long');
    if (row.turn?.addressee !== 'worker' || row.turn.taken === null)
      problems.push(`turn ${JSON.stringify(row.turn)}, not the worker's taken turn`);
    if (row.returned?.findings !== FINDINGS)
      problems.push(`returned ${JSON.stringify(row.returned)}, not ${String(FINDINGS)} findings`);
    const addressees = row.blocks.map(({ addressee }) => addressee);
    if (!addressees.includes('operator') || !addressees.includes('worker'))
      problems.push(`blocks to ${addressees.join(', ')}, not the operator and the worker`);
    const prs = row.prSummary ?? [];
    if (prs.length !== 2) problems.push(`${String(prs.length)} PR summaries, not 2`);
    if (prs[0]?.mergeable !== 'conflicting')
      problems.push(`PR ${String(prs[0]?.number)} is ${prs[0]?.mergeable ?? 'missing'}`);
    return settledUnless(problems);
  },
};
